import {
  applyD1Migrations,
  env,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApplication } from "../worker/app";
import { flushWorkspacePush } from "../worker/workspace-push";
import { PUSH_CLOSE, PUSH_LIMITS } from "../shared/workspace-push";
import type { Env } from "../worker/types";
import { WorkspaceService } from "../worker/service";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import { viewFrameSchema } from "../shared/workspace-push";
import type { WorkspaceView } from "../shared/workspace-sync";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const app = createApplication(async () => ({
  subject: "owner",
  displayName: "Owner",
  expiresAt: Date.now() + 60000,
}));
const clients: WebSocket[] = [];
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM workspace_push_outbox"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date().toISOString(), new Date().toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('beta','other','Other','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
});
afterEach(() => {
  for (const socket of clients.splice(0)) socket.close();
  vi.restoreAllMocks();
});
function upgrade(workspaceId = "alpha", origin = "https://hq.example") {
  return new Request(
    "https://hq.example/api/events?workspaceId=" + workspaceId,
    { headers: { Upgrade: "websocket", Origin: origin } },
  );
}
function nextMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("Expected a socket message"));
    }, 2000);
    const listener = (event: MessageEvent) => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(String(event.data));
    };
    socket.addEventListener("message", listener);
  });
}
async function connect() {
  const response = await app.fetch(upgrade(), bindings);
  expect(response.status).toBe(101);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const socket = response.webSocket!;
  clients.push(socket);
  const ready = nextMessage(socket);
  socket.accept();
  expect(JSON.parse(await ready)).toMatchObject({
    version: 1,
    type: "ready",
    workspaceId: "alpha",
  });
  return socket;
}
it("authenticates upgrades, isolates workspaces, and rejects alternate origins and command channels", async () => {
  expect((await app.fetch(upgrade("beta"), bindings)).status).toBe(404);
  expect(
    (await app.fetch(upgrade("alpha", "https://outside.example"), bindings))
      .status,
  ).toBe(403);
  expect(
    (
      await app.fetch(
        new Request("https://hq.example/api/events?workspaceId=alpha"),
        bindings,
      )
    ).status,
  ).toBe(426);
  const reporter = createApplication(async () => ({
    subject: "owner",
    displayName: "Reporter",
    reporterId: "reporter",
    scopes: [],
  }));
  expect((await reporter.fetch(upgrade(), bindings)).status).toBe(403);
  const socket = await connect();
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  socket.send('{"command":"activity_add"}');
  expect(await closed).toBe(PUSH_CLOSE.PROTOCOL);
});
it("pushes committed command changes and keeps the hibernation heartbeat separate from provider health", async () => {
  const socket = await connect();
  const message = nextMessage(socket);
  const result = await app.fetch(
    new Request("https://hq.example/api/commands/activity_add", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://hq.example",
      },
      body: JSON.stringify({
        workspaceId: "alpha",
        eventId: "push-event",
        kind: "progress",
        title: "A committed update",
        summary: "Synthetic push verification",
        resourceId: null,
      }),
    }),
    bindings,
  );
  expect(result.status).toBe(200);
  expect(JSON.parse(await message)).toMatchObject({
    version: 1,
    type: "invalidate",
    workspaceId: "alpha",
    topics: expect.arrayContaining(["activity"]),
  });
  const pong = nextMessage(socket);
  socket.send(PUSH_LIMITS.PING);
  expect(await pong).toBe(PUSH_LIMITS.PONG);
  expect(
    await bindings.HQ_DB.prepare(
      "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id='alpha'",
    ).first(),
  ).toEqual({ pending_topics: 0 });
});
it("retains failed notifications and does not clear a newer revision during acknowledgement", async () => {
  let revision = 0;
  let fail = true;
  const namespace = {
    getByName: () => ({
      publish: async (change: { revision: number }) => {
        revision = change.revision;
        if (fail) throw new Error("Synthetic dispatch interruption");
        await bindings.HQ_DB.prepare(
          "UPDATE members SET display_name='Changed',revision=revision+1 WHERE workspace_id='alpha'",
        ).run();
      },
    }),
  } as unknown as NonNullable<Env["WORKSPACE_EVENTS"]>;
  await expect(
    flushWorkspacePush({ ...bindings, WORKSPACE_EVENTS: namespace }, "alpha"),
  ).rejects.toThrow("retained");
  expect(
    (await bindings.HQ_DB.prepare(
      "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id='alpha'",
    ).first<{ pending_topics: number }>())!.pending_topics,
  ).toBeGreaterThan(0);
  fail = false;
  await flushWorkspacePush(
    { ...bindings, WORKSPACE_EVENTS: namespace },
    "alpha",
  );
  const pending = await bindings.HQ_DB.prepare(
    "SELECT pending_topics,revision FROM workspace_push_outbox WHERE workspace_id='alpha'",
  ).first<{ pending_topics: number; revision: number }>();
  expect(pending!.pending_topics).toBeGreaterThan(0);
  expect(pending!.revision).toBeGreaterThan(revision);
});
it("revokes a connected observer before sending another change", async () => {
  const socket = await connect();
  const received: string[] = [];
  socket.addEventListener("message", (event) =>
    received.push(String(event.data)),
  );
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  await bindings.HQ_DB.prepare(
    "DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'",
  ).run();
  await flushWorkspacePush(bindings, "alpha");
  expect(await closed).toBe(PUSH_CLOSE.REVOKED);
  expect(received).toEqual([]);
});
it("resumes hibernated sockets from attachments and expires idle sessions through alarms", async () => {
  const socket = await connect();
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await evictDurableObject(stub);
  await bindings.HQ_DB.prepare(
    "UPDATE workspaces SET name='Changed' WHERE id='alpha'",
  ).run();
  const change = nextMessage(socket);
  await flushWorkspacePush(bindings, "alpha");
  expect(JSON.parse(await change)).toMatchObject({
    type: "invalidate",
    workspaceId: "alpha",
  });
  await runInDurableObject(stub, async (_instance, state) => {
    for (const socket of state.getWebSockets())
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        expiresAt: Date.now() - 1,
      });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await closed).toBe(PUSH_CLOSE.REAUTHENTICATE);
});
it("does not strand an overdue socket when another observer reschedules expiry", async () => {
  const socket = await connect();
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await runInDurableObject(stub, (_instance, state) => {
    for (const socket of state.getWebSockets())
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        expiresAt: Date.now() - 1,
      });
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  await connect();
  expect(await closed).toBe(PUSH_CLOSE.REAUTHENTICATE);
  expect(
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    ),
  ).toBeGreaterThan(Date.now());
});
it("bounds concurrent connections per subject and closes slow observers before unbounded fanout", async () => {
  const responses = await Promise.all(
    Array.from({ length: PUSH_LIMITS.SOCKETS_PER_SUBJECT + 2 }, () =>
      app.fetch(upgrade(), bindings),
    ),
  );
  expect(responses.filter((response) => response.status === 101)).toHaveLength(
    PUSH_LIMITS.SOCKETS_PER_SUBJECT,
  );
  expect(responses.filter((response) => response.status === 429)).toHaveLength(
    2,
  );
  for (const response of responses)
    if (response.webSocket) {
      clients.push(response.webSocket);
      response.webSocket.accept();
    }
  const socket = clients[0];
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await runInDurableObject(stub, (_instance, state) => {
    for (const socket of state.getWebSockets())
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        frames: PUSH_LIMITS.FRAMES_PER_CONNECTION,
      });
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  await bindings.HQ_DB.prepare(
    "UPDATE workspaces SET name='Changed' WHERE id='alpha'",
  ).run();
  await flushWorkspacePush(bindings, "alpha");
  expect(await closed).toBe(PUSH_CLOSE.ROTATE);
});

it("recovers abandoned slots on admission and preserves real hibernation heartbeats", async () => {
  const peers: WebSocket[] = [];
  for (let index = 0; index < PUSH_LIMITS.SOCKETS_PER_SUBJECT; index++)
    peers.push(await connect());
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await runInDurableObject(stub, (_instance, state) => {
    for (const socket of state.getWebSockets())
      socket.serializeAttachment({
        ...socket.deserializeAttachment(),
        connectedAt: Date.now() - PUSH_LIMITS.INACTIVE_MS - 1,
      });
  });
  const active = peers[0]!;
  const pong = nextMessage(active);
  active.send(PUSH_LIMITS.PING);
  expect(await pong).toBe(PUSH_LIMITS.PONG);
  await evictDurableObject(stub);
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state
          .getWebSockets()
          .filter(
            (socket) =>
              state.getWebSocketAutoResponseTimestamp(socket) !== null,
          ).length,
    ),
  ).toBe(1);
  const closed = peers.slice(1).map(
    (socket) =>
      new Promise<number>((resolve) =>
        socket.addEventListener("close", (event) => resolve(event.code), {
          once: true,
        }),
      ),
  );
  await connect();
  expect(await Promise.all(closed)).toEqual(
    Array(PUSH_LIMITS.SOCKETS_PER_SUBJECT - 1).fill(PUSH_CLOSE.INACTIVE),
  );
  expect(active.readyState).toBe(WebSocket.OPEN);
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
    ),
  ).toBe(2);
});

it("retains admission grace and legacy attachments without an invented heartbeat time", async () => {
  for (let index = 0; index < PUSH_LIMITS.SOCKETS_PER_SUBJECT; index++)
    await connect();
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await runInDurableObject(stub, (_instance, state) => {
    const sockets = state.getWebSockets();
    const legacy = sockets[0]!;
    const { connectedAt: _connectedAt, ...attachment } =
      legacy.deserializeAttachment();
    legacy.serializeAttachment(attachment);
  });
  expect((await app.fetch(upgrade(), bindings)).status).toBe(429);
});

it("classifies an oversized outbound frame separately from a connection rotation", async () => {
  const socket = await connect();
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    });
  });
  const stub = bindings.WORKSPACE_EVENTS!.getByName("alpha");
  await runInDurableObject(stub, (instance, state) => {
    const sender = instance as unknown as {
      send: (socket: WebSocket, frame: unknown) => void;
    };
    sender.send(state.getWebSockets()[0], {
      version: 1,
      type: "ready",
      workspaceId: "x".repeat(PUSH_LIMITS.FRAME_BYTES),
      revision: 0,
      expiresAt: Date.now() + PUSH_LIMITS.CONNECTION_MS,
    });
  });
  expect(await closed).toBe(PUSH_CLOSE.TOO_LARGE);
});

async function connectView(view: WorkspaceView) {
  const query = new URLSearchParams({
    workspaceId: "alpha",
    view: view.scope.view,
    cursor: String(view.cursor),
    memberRevision: String(view.memberRevision),
    ...(view.scope.repositoryId
      ? { repositoryId: view.scope.repositoryId }
      : {}),
  });
  const response = await app.fetch(
    new Request("https://hq.example/api/events?" + query, {
      headers: { Upgrade: "websocket", Origin: "https://hq.example" },
    }),
    bindings,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  clients.push(socket);
  const ready = nextMessage(socket);
  socket.accept();
  return { socket, ready: viewFrameSchema.parse(JSON.parse(await ready)) };
}

it("sends repository records directly and keeps Activity off a repository subscription", async () => {
  const service = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Owner",
  });
  const fields = {
    fullName: "example/push",
    description: "Original",
    projectId: "project",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
  const repo = await service.createRepository({
    workspaceId: "alpha",
    repository: fields,
  });
  const view = await service.workspaceView({
    workspaceId: "alpha",
    view: "repositories",
  });
  await flushWorkspacePush(bindings, "alpha");
  const { socket, ready } = await connectView(view);
  expect(ready.update).toMatchObject({
    type: "delta",
    from: view.cursor,
    cursor: view.cursor,
    upserts: {},
    removals: [],
  });
  const received: string[] = [];
  socket.addEventListener("message", (event) =>
    received.push(String(event.data)),
  );
  await service.addActivity({
    workspaceId: "alpha",
    eventId: "off-tab",
    kind: "note",
    title: "Activity only",
    summary: "Not repository content",
    resourceId: null,
  });
  await flushWorkspacePush(bindings, "alpha");
  const pong = nextMessage(socket);
  socket.send(PUSH_LIMITS.PING);
  await pong;
  expect(received.filter((message) => message !== PUSH_LIMITS.PONG)).toEqual(
    [],
  );
  const message = nextMessage(socket);
  await service.updateRepository({
    workspaceId: "alpha",
    repositoryId: repo.id,
    revision: repo.revision,
    repository: { ...fields, description: "Pushed record" },
  });
  await flushWorkspacePush(bindings, "alpha");
  const frame = viewFrameSchema.parse(JSON.parse(await message));
  expect(frame).toMatchObject({
    version: 2,
    type: "update",
    scope: { view: "repositories" },
    update: {
      type: "delta",
      upserts: {
        repositories: [{ id: repo.id, description: "Pushed record" }],
      },
    },
  });
  expect(JSON.stringify(frame)).not.toContain("Activity only");
  expect(frame.topics).not.toContain("activity");
  if (frame.update.type !== "delta") throw new Error("Expected delta");
  expect(Object.keys(frame.update.upserts)).toEqual(["repositories"]);
});

it("delivers metadata-only Secrets associations to repository overviews without a whole-view reset", async () => {
  const service = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Owner",
  });
  const repo = await service.createRepository({
    workspaceId: "alpha",
    repository: {
      fullName: "example/context",
      description: "",
      projectId: "project",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  const view = await service.workspaceView({
    workspaceId: "alpha",
    view: "repository",
    repositoryId: repo.id,
  });
  await flushWorkspacePush(bindings, "alpha");
  const { socket } = await connectView(view);
  const message = nextMessage(socket);
  await bindings.HQ_DB.prepare(
    "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES('alpha','secrets','Metadata only','cloudflare-workers','private-ref','[]',0,1,'initial')",
  ).run();
  await flushWorkspacePush(bindings, "alpha");
  const frame = viewFrameSchema.parse(JSON.parse(await message));
  expect(frame.topics).toContain("associations");
  expect(frame.update).toMatchObject({
    type: "delta",
    upserts: {},
    removals: [],
  });
  expect(JSON.stringify(frame)).not.toContain("private-ref");
});

it("closes the bootstrap race and resumes view deltas after hibernation", async () => {
  const service = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Owner",
  });
  const view = await service.workspaceView({
    workspaceId: "alpha",
    view: "repositories",
  });
  await service.createProject({
    workspaceId: "alpha",
    name: "Between bootstrap and connect",
    description: "Synthetic",
  });
  await flushWorkspacePush(bindings, "alpha");
  const { socket, ready } = await connectView(view);
  expect(ready.update).toMatchObject({
    type: "delta",
    upserts: { projects: [{ name: "Between bootstrap and connect" }] },
  });
  await evictDurableObject(bindings.WORKSPACE_EVENTS!.getByName("alpha"));
  const message = nextMessage(socket);
  await service.createProject({
    workspaceId: "alpha",
    name: "After hibernation",
    description: "Synthetic",
  });
  await flushWorkspacePush(bindings, "alpha");
  expect(viewFrameSchema.parse(JSON.parse(await message)).update).toMatchObject(
    {
      type: "delta",
      from: ready.update.cursor,
      upserts: { projects: [{ name: "After hibernation" }] },
    },
  );
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  await bindings.HQ_DB.prepare(
    "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
  ).run();
  await flushWorkspacePush(bindings, "alpha");
  expect(await closed).toBe(PUSH_CLOSE.REVOKED);
});

it("does not reuse a delta across different subscription authority revisions", async () => {
  const service = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Owner",
  });
  const view = await service.workspaceView({
    workspaceId: "alpha",
    view: "repositories",
  });
  await flushWorkspacePush(bindings, "alpha");
  const valid = await connectView(view);
  const outdated = await connectView({
    ...view,
    memberRevision: view.memberRevision + 1,
  });
  expect(outdated.ready.update).toMatchObject({
    type: "reset",
    reason: "authority_changed",
  });
  const validMessage = nextMessage(valid.socket);
  const outdatedMessage = nextMessage(outdated.socket);
  await service.createProject({
    workspaceId: "alpha",
    name: "Shared projection",
    description: "Synthetic authority isolation",
  });
  await flushWorkspacePush(bindings, "alpha");
  expect(
    viewFrameSchema.parse(JSON.parse(await validMessage)).update.type,
  ).toBe("delta");
  expect(
    viewFrameSchema.parse(JSON.parse(await outdatedMessage)).update,
  ).toMatchObject({ type: "reset", reason: "authority_changed" });
});
