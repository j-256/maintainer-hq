import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import production from "../worker/index";
import development from "../worker/development";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const owner: Principal = { subject: "owner", displayName: "Test owner" };
const service = new WorkspaceService(bindings, owner);
const workspace = { workspaceId: "alpha" };
const note = {
  ...workspace,
  eventId: "note",
  kind: "note",
  title: "A recorded decision",
  summary: "No secret values.",
  resourceId: null,
};
const goal = {
  ...workspace,
  goalId: "goal-one",
  sourceId: "agent-one",
  objective: "  Keep my /goal verbatim.\nNo paraphrases or truncation.  ",
  status: "active",
  startedAt: "2026-01-01T00:00:00.000Z",
  reportedAt: "2026-01-01T00:00:01.000Z",
};
const repository = {
  fullName: "example/project",
  description: "A synthetic test repository",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  expectations: DEFAULT_EXPECTATIONS,
};

beforeAll(async () => {
  await applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM activity"),
    bindings.HQ_DB.prepare("DELETE FROM goals"),
    bindings.HQ_DB.prepare("DELETE FROM repositories"),
    bindings.HQ_DB.prepare("DELETE FROM projects"),
    bindings.HQ_DB.prepare("DELETE FROM credentials"),
    bindings.HQ_DB.prepare("DELETE FROM members"),
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('alpha', 'Alpha', '2026-01-01'), ('beta', 'Beta', '2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id, subject, display_name, role) VALUES ('alpha', 'owner', 'Test owner', 'owner'), ('alpha', 'viewer', 'Test viewer', 'viewer'), ('alpha', 'operator', 'Test operator', 'operator'), ('beta', 'other', 'Other owner', 'owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
});

describe("Workspace authorization", () => {
  it("isolates workspaces and denies viewers writes", async () => {
    await expect(
      service.snapshot({ workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    const viewer = new WorkspaceService(bindings, {
      subject: "viewer",
      displayName: "Viewer",
    });
    expect((await viewer.snapshot(workspace)).capabilities).toEqual([
      CAPABILITY.READ,
      CAPABILITY.PREFERENCES,
    ]);
    await expect(viewer.addActivity(note)).rejects.toMatchObject({
      status: 403,
    });
    await expect(viewer.syncGoal(goal)).rejects.toMatchObject({ status: 403 });
    await expect(
      viewer.createRepository({ ...workspace, repository }),
    ).rejects.toMatchObject({ status: 403 });
    const created = await service.createRepository({
      ...workspace,
      repository,
    });
    await expect(
      viewer.updateRepository({
        ...workspace,
        repositoryId: created.id,
        revision: created.revision,
        repository,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("intersects credential scopes with live membership", async () => {
    const reader = new WorkspaceService(bindings, {
      ...owner,
      scopes: [CAPABILITY.READ],
      workspaceId: "alpha",
    });
    await expect(reader.addActivity(note)).rejects.toMatchObject({
      status: 403,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role = 'viewer' WHERE subject = 'owner'",
    ).run();
    await expect(service.addActivity(note)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("Activity", () => {
  it("persists updates, retains attribution, and deduplicates repeated requests", async () => {
    const [a, b] = await Promise.all([
      service.addActivity(note),
      service.addActivity(note),
    ]);
    expect(a).toEqual(b);
    expect(a.actor).toBe(owner.displayName);
    expect(
      await new WorkspaceService(bindings, owner).activity(workspace),
    ).toHaveLength(1);
    await expect(
      service.addActivity({ ...note, title: "Different content" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects unknown properties, oversized notes, and cross-workspace resource IDs", async () => {
    await expect(
      service.addActivity({ ...note, actor: "Pretend owner" }),
    ).rejects.toThrow();
    await expect(
      service.addActivity({ ...note, summary: "x".repeat(2001) }),
    ).rejects.toThrow();
    await expect(
      service.addActivity({ ...note, resourceId: "unowned" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.activity(workspace)).toHaveLength(0);
  });
});

describe("Goal mirrors", () => {
  it("mirrors paused and cleared source states without completing unfinished work or guessing replacement", async () => {
    await service.syncGoal(goal);
    const pause = {
      ...goal,
      status: "paused",
      reportedAt: "2026-01-01T00:00:02Z",
    };
    const paused = await service.syncGoal(pause);
    expect(await service.syncGoal(pause)).toEqual(paused);
    expect(paused).toMatchObject({
      status: "paused",
      objective: goal.objective,
    });
    await service.syncGoal({
      ...pause,
      status: "active",
      reportedAt: "2026-01-01T00:00:03Z",
    });
    const clear = {
      ...goal,
      status: "cleared",
      reportedAt: "2026-01-01T00:00:04Z",
    };
    const cleared = await service.syncGoal(clear);
    expect(await service.syncGoal(clear)).toEqual(cleared);
    expect(cleared).toMatchObject({
      status: "cleared",
      objective: goal.objective,
    });
    await expect(service.syncGoal(pause)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.syncGoal({ ...clear, status: "complete" }),
    ).rejects.toMatchObject({ status: 409 });
    const events = await service.goalActivity({
      ...workspace,
      goalId: goal.goalId,
    });
    expect(events.events.map(({ type }) => type)).toEqual([
      "goal.cleared",
      "goal.active",
      "goal.paused",
      "goal.active",
    ]);
    expect(events.events.map(({ title }) => title)).toEqual([
      "Goal cleared",
      "Goal resumed",
      "Goal paused",
      "Goal started",
    ]);
    for (const event of events.events) {
      expect(event.summary).toBe(goal.objective);
      expect(event.goalId).toBe(goal.goalId);
    }
    expect((await service.goals(workspace))[0]).toEqual(cleared);
    expect(
      (await service.goals({ workspaceId: "alpha" })).some(
        ({ status }) => status === "complete",
      ),
    ).toBe(false);
  });
  it("orders reports by their instant rather than optional timestamp fractions", async () => {
    await service.syncGoal({
      ...goal,
      startedAt: "2026-01-01T00:00:00Z",
      reportedAt: "2026-01-01T00:00:01Z",
    });
    const completed = await service.syncGoal({
      ...goal,
      status: "complete",
      reportedAt: "2026-01-01T00:00:01.500Z",
    });
    expect(completed.status).toBe("complete");
    expect(completed.objective).toBe(goal.objective);
    await expect(
      service.syncGoal({ ...goal, reportedAt: "2026-01-01T00:00:01Z" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not freshen an old report when an identical heartbeat is retried", async () => {
    let now = Date.parse("2026-01-01T00:00:10Z");
    const source = new WorkspaceService(bindings, owner, false, () => now);
    const first = await source.syncGoal(goal);
    now += 60 * 1000;
    const repeated = await source.syncGoal(goal);
    expect(repeated).toEqual(first);
    const newer = await source.syncGoal({
      ...goal,
      reportedAt: "2026-01-01T00:01:00Z",
    });
    expect(Date.parse(newer.receivedAt)).toBe(now);
    expect(await source.activity(workspace)).toHaveLength(1);
  });
  it("keeps the objective byte-for-byte and journals transitions atomically", async () => {
    await Promise.all([service.syncGoal(goal), service.syncGoal(goal)]);
    expect((await service.goals(workspace))[0].objective).toBe(goal.objective);
    expect(await service.activity(workspace)).toHaveLength(1);
    const complete = {
      ...goal,
      status: "complete",
      reportedAt: "2026-01-01T00:00:02.000Z",
    };
    await Promise.all([service.syncGoal(complete), service.syncGoal(complete)]);
    expect((await service.goals(workspace))[0].status).toBe("complete");
    expect(await service.activity(workspace)).toHaveLength(2);
    await service.syncGoal({
      ...complete,
      reportedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(await service.activity(workspace)).toHaveLength(2);
  });
  it("rejects stale events, altered objectives, future clocks, and impersonated sources", async () => {
    await service.syncGoal(goal);
    await expect(
      service.syncGoal({ ...goal, objective: "Rewritten" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.syncGoal({ ...goal, reportedAt: goal.startedAt }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.syncGoal({ ...goal, reportedAt: "2099-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      new WorkspaceService(bindings, {
        subject: "operator",
        displayName: "Operator",
      }).syncGoal(goal),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.syncGoal({ ...goal, status: "complete" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps active goals ahead of completed history", async () => {
    await service.syncGoal(goal);
    await service.syncGoal({
      ...goal,
      goalId: "goal-two",
      status: "complete",
      startedAt: "2026-02-01T00:00:00Z",
      reportedAt: "2026-02-01T00:00:01Z",
    });
    expect((await service.goals(workspace))[0].id).toBe(goal.goalId);
    await service.syncGoal({
      ...goal,
      goalId: "cleared",
      status: "cleared",
      startedAt: "2026-03-01T00:00:00Z",
      reportedAt: "2026-03-01T00:00:01Z",
    });
    await service.syncGoal({
      ...goal,
      goalId: "paused",
      status: "paused",
      startedAt: "2026-01-02T00:00:00Z",
      reportedAt: "2026-01-02T00:00:01Z",
    });
    expect((await service.goals(workspace)).map(({ id }) => id)).toEqual([
      "paused",
      goal.goalId,
      "cleared",
      "goal-two",
    ]);
  });
});

describe("Repository saves", () => {
  it("handles concurrent renames as a normal conflict without false audit entries", async () => {
    const first = await service.createRepository({ ...workspace, repository });
    const second = await service.createRepository({
      ...workspace,
      repository: { ...repository, fullName: "example/another" },
    });
    const outcomes = await Promise.allSettled(
      [first, second].map((item) =>
        service.updateRepository({
          ...workspace,
          repositoryId: item.id,
          revision: item.revision,
          repository: { ...repository, fullName: "example/shared-name" },
        }),
      ),
    );
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409, code: "conflict" } });
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "repository.updated",
      ),
    ).toHaveLength(1);
  });
  it("deduplicates concurrent enrollment without extra audit entries", async () => {
    const results = await Promise.allSettled([
      service.createRepository({ ...workspace, repository }),
      service.createRepository({ ...workspace, repository }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
    expect(await service.repositories(workspace)).toHaveLength(1);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "repository.created",
      ),
    ).toHaveLength(1);
  });
  it("checks all required token scopes before enrollment can write", async () => {
    const writeOnly = new WorkspaceService(bindings, {
      ...owner,
      scopes: [CAPABILITY.EDIT],
    });
    await expect(
      writeOnly.createRepository({ ...workspace, repository }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await service.repositories(workspace)).toHaveLength(0);
  });
  it("keeps projects workspace-scoped and deduplicates concurrent project creation", async () => {
    const input = {
      ...workspace,
      name: "Shared project",
      description: "Synthetic",
    };
    const outcomes = await Promise.allSettled([
      service.createProject(input),
      service.createProject(input),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "project.created",
      ),
    ).toHaveLength(1);
    await expect(
      service.createRepository({
        ...workspace,
        repository: { ...repository, projectId: "unowned" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("requires a matching revision and produces only one journal entry for a concurrent save", async () => {
    const created = await service.createRepository({
      ...workspace,
      repository,
    });
    const input = {
      ...workspace,
      repositoryId: created.id,
      revision: created.revision,
      repository: { ...repository, description: "Edited" },
    };
    const results = await Promise.allSettled([
      service.updateRepository(input),
      service.updateRepository(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await service.repository({ ...workspace, repositoryId: created.id }))
        .revision,
    ).toBe(2);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "repository.updated",
      ),
    ).toHaveLength(1);
  });
});

describe("HTTP boundary", () => {
  const app = createApplication(async () => owner);
  function call(body: unknown, extra: HeadersInit = {}, path = "activity_add") {
    return app.fetch(
      new Request("https://hq.example/api/commands/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          ...extra,
        },
        body: JSON.stringify(body),
      }),
      bindings,
    );
  }
  it("blocks cross-origin mutations and bounds bodies before parsing", async () => {
    expect(
      (await call(note, { Origin: "https://elsewhere.example" })).status,
    ).toBe(403);
    expect((await call({ ...note, summary: "x".repeat(70000) })).status).toBe(
      413,
    );
    expect(await service.activity(workspace)).toHaveLength(0);
  });
  it("rejects unknown commands and sanitizes failures", async () => {
    expect((await call({}, {}, "constructor")).status).toBe(404);
    const response = await call({
      ...note,
      privateCredential: "synthetic-sensitive-marker",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("synthetic-sensitive-marker");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("never trusts development headers in production and rejects non-loopback dev hosts", async () => {
    const response = await production.fetch(
      new Request("https://hq.example/api/session", {
        headers: { "X-HQ-Client": "cli", "X-Dev-User": "owner" },
      }),
      bindings,
    );
    expect(response.status).toBe(503);
    expect(
      (
        await development.fetch(
          new Request("https://hq.example/api/session"),
          bindings,
        )
      ).status,
    ).toBe(403);
  });
  it("exposes the same goal and activity capabilities through MCP", async () => {
    const rpc = (method: string, params: unknown) =>
      app.fetch(
        new Request("https://hq.example/mcp", {
          method: "POST",
          headers: {
            Origin: "https://hq.example",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        bindings,
      );
    const list = await rpc("tools/list", {});
    expect(list.status).toBe(200);
    const discovery = (await list.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(discovery.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "goal_sync",
        "goals_list",
        "activity_add",
        "repository_update",
      ]),
    );
    const update = await rpc("tools/call", {
      name: "goal_sync",
      arguments: goal,
    });
    expect(JSON.stringify(await update.json())).toContain(
      "Keep my /goal verbatim",
    );
    expect((await service.goals(workspace))[0].objective).toBe(goal.objective);
    for (const [index, status] of ["paused", "cleared"].entries()) {
      const response = await rpc("tools/call", {
        name: "goal_sync",
        arguments: {
          ...goal,
          status,
          reportedAt: `2026-01-01T00:00:0${index + 2}Z`,
        },
      });
      expect(response.status).toBe(200);
      const data = JSON.stringify(await response.json());
      expect(data).not.toContain('"isError":true');
      expect((await service.goals(workspace))[0]).toMatchObject({
        status,
        objective: goal.objective,
      });
    }
  });
});
