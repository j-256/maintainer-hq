import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createWorkspacePush,
  workspaceQueryMatches,
} from "../src/lib/workspace-push";
import { PUSH_CLOSE, PUSH_LIMITS, PUSH_TOPICS } from "../shared/workspace-push";
import {
  PUSH_DIAGNOSTIC_LIMITS,
  pushCloseReason,
} from "../src/lib/push-diagnostics";

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  frame(data: unknown) {
    this.message(JSON.stringify(data));
  }
  ready(revision = 1) {
    this.frame({
      version: 1,
      type: "ready",
      workspaceId: "alpha",
      revision,
      expiresAt: Date.now() + PUSH_LIMITS.CONNECTION_MS,
    });
  }
  change(revision: number, topics = ["activity"]) {
    this.frame({
      version: 1,
      type: "invalidate",
      workspaceId: "alpha",
      revision,
      topics,
    });
  }
}
let visible = true;
it("refreshes permission guidance on access changes without GitHub progress or Activity chatter", () => {
  const key = ["repository-access", "alpha", "repo-a", 1];
  expect(workspaceQueryMatches(key, "alpha", ["access"])).toBe(true);
  expect(workspaceQueryMatches(key, "beta", ["access"])).toBe(false);
  for (const topic of [
    "sources",
    "activity",
    "operations",
    "hooks",
    "monitoring",
  ] as const)
    expect(workspaceQueryMatches(key, "alpha", [topic])).toBe(false);
});
it("keeps operational attention reads independent from GitHub progress and Activity", () => {
  const hooks = ["attention-hooks", "alpha", "hooks", 1];
  const monitoring = ["attention-monitoring", "alpha", "monitors", 1];
  for (const topic of ["sources", "activity", "workspace"] as const) {
    expect(workspaceQueryMatches(hooks, "alpha", [topic])).toBe(false);
    expect(workspaceQueryMatches(monitoring, "alpha", [topic])).toBe(false);
  }
  expect(workspaceQueryMatches(hooks, "alpha", ["hooks"])).toBe(true);
  expect(workspaceQueryMatches(monitoring, "alpha", ["hooks"])).toBe(false);
  expect(workspaceQueryMatches(monitoring, "alpha", ["monitoring"])).toBe(true);
  expect(workspaceQueryMatches(hooks, "beta", ["hooks"])).toBe(false);
  expect(workspaceQueryMatches(hooks, "alpha", ["access"])).toBe(true);
});
it("refreshes repository link metadata and its small Activity head independently", () => {
  const metadata = ["repository-context", "alpha", "repo-a", 1];
  const activity = [
    "workspace",
    "alpha",
    "activity-feed",
    { repositoryId: "repo-a", limit: 3 },
    null,
  ];
  for (const topic of [
    "workspace",
    "activity",
    "sources",
    "hooks",
    "monitoring",
    "operations",
  ] as const)
    expect(workspaceQueryMatches(metadata, "alpha", [topic])).toBe(false);
  expect(workspaceQueryMatches(metadata, "alpha", ["associations"])).toBe(true);
  expect(workspaceQueryMatches(metadata, "beta", ["associations"])).toBe(false);
  expect(workspaceQueryMatches(activity, "alpha", ["activity"])).toBe(true);
  expect(workspaceQueryMatches(activity, "alpha", ["associations"])).toBe(
    false,
  );
  expect(
    workspaceQueryMatches(["secrets", "alpha", "connections"], "alpha", [
      "associations",
    ]),
  ).toBe(true);
});
it("refreshes transfer context only for relevant workspace changes, never unrelated Activity", () => {
  const review = ["project-transfer-review", "alpha", "review-id"];
  expect(workspaceQueryMatches(review, "alpha", ["activity"])).toBe(false);
  expect(workspaceQueryMatches(review, "beta", ["workspace"])).toBe(false);
  for (const topic of [
    "workspace",
    "access",
    "associations",
    "operations",
    "sources",
  ] as const)
    expect(workspaceQueryMatches(review, "alpha", [topic])).toBe(true);
  const history = ["departed-resource", "alpha", "project", "project-id"];
  expect(workspaceQueryMatches(history, "alpha", ["workspace"])).toBe(true);
  expect(workspaceQueryMatches(history, "alpha", ["activity"])).toBe(false);
});
let online = true;
const controllers: ReturnType<typeof createWorkspacePush>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  visible = online = true;
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});
function fixture() {
  const sockets: Socket[] = [];
  const status = vi.fn();
  const invalidate = vi.fn();
  const revoked = vi.fn();
  const controller = createWorkspacePush({
    workspaceId: "alpha",
    url: "wss://hq.example/api/events?workspaceId=alpha",
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    visible: () => visible,
    online: () => online,
    status,
    invalidate,
    revoked,
    random: () => 0,
  });
  controllers.push(controller);
  return { controller, sockets, status, invalidate, revoked };
}
it("coalesces change topics, ignores duplicate revisions, and performs no idle HTTP refresh", () => {
  const test = fixture();
  test.sockets[0].ready();
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  expect(test.invalidate).toHaveBeenLastCalledWith(PUSH_TOPICS);
  test.invalidate.mockClear();
  test.sockets[0].change(2);
  test.sockets[0].change(3, ["sources"]);
  test.sockets[0].change(2, ["monitoring"]);
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  expect(test.invalidate).toHaveBeenCalledExactlyOnceWith([
    "activity",
    "sources",
  ]);
  test.invalidate.mockClear();
  for (let interval = 0; interval < 3; interval++) {
    vi.advanceTimersByTime(PUSH_LIMITS.HEARTBEAT_MS);
    expect(test.sockets[0].send).toHaveBeenLastCalledWith(PUSH_LIMITS.PING);
    test.sockets[0].message(PUSH_LIMITS.PONG);
  }
  expect(test.invalidate).not.toHaveBeenCalled();
  expect(test.status).toHaveBeenLastCalledWith("live");
});

it("uses view cursors on every reconnect and applies pushed records without a bootstrap invalidation", () => {
  const sockets: Socket[] = [];
  const urls: string[] = [];
  let cursor = 10;
  const update = vi.fn((value: { cursor: number }) => {
    cursor = value.cursor;
  });
  const invalidate = vi.fn();
  const connected = vi.fn();
  controllers.push(
    createWorkspacePush({
      workspaceId: "alpha",
      url: "wss://hq.example/api/events?workspaceId=alpha",
      socket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      visible: () => true,
      online: () => true,
      status: vi.fn(),
      invalidate,
      revoked: vi.fn(),
      connected,
      subscription: {
        scope: { view: "repositories" },
        cursor: () => cursor,
        memberRevision: () => 1,
        update,
      },
      random: () => 0,
    }),
  );
  const delta = {
    type: "delta",
    from: 10,
    cursor: 11,
    generatedAt: "2026-01-01",
    upserts: {},
    removals: [],
  };
  sockets[0].frame({
    version: 2,
    type: "ready",
    workspaceId: "alpha",
    revision: 100,
    expiresAt: Date.now() + 60000,
    scope: { view: "repositories" },
    topics: [],
    update: delta,
  });
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  expect(update).toHaveBeenCalledExactlyOnceWith(delta);
  expect(connected).toHaveBeenCalledOnce();
  expect(invalidate).not.toHaveBeenCalled();
  sockets[0].onclose?.({ code: 1001 });
  vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  expect(new URL(urls[0]).searchParams.get("cursor")).toBe("10");
  expect(new URL(urls[1]).searchParams.get("cursor")).toBe("11");
  expect(new URL(urls[1]).searchParams.get("view")).toBe("repositories");
});
it("catches up after reconnect and pauses every network timer while hidden or offline", () => {
  const test = fixture();
  test.sockets[0].ready();
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  visible = false;
  test.controller.reconcile();
  expect(test.sockets[0].close).toHaveBeenCalledOnce();
  test.invalidate.mockClear();
  vi.advanceTimersByTime(PUSH_LIMITS.FALLBACK_MS * 3);
  expect(test.sockets).toHaveLength(1);
  expect(test.invalidate).not.toHaveBeenCalled();
  visible = true;
  test.controller.reconcile();
  test.sockets[1].ready(100);
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  expect(test.invalidate).toHaveBeenCalledExactlyOnceWith(PUSH_TOPICS);
  online = false;
  test.controller.reconcile();
  expect(test.status).toHaveBeenLastCalledWith("offline");
  test.invalidate.mockClear();
  vi.advanceTimersByTime(PUSH_LIMITS.FALLBACK_MS * 3);
  expect(test.sockets).toHaveLength(2);
  expect(test.invalidate).not.toHaveBeenCalled();
});
it("uses bounded backoff and an explicit slow fallback when handshakes fail", () => {
  const test = fixture();
  vi.advanceTimersByTime(
    PUSH_LIMITS.HANDSHAKE_MS +
      PUSH_LIMITS.FALLBACK_MS +
      PUSH_LIMITS.COALESCE_MS,
  );
  expect(test.status).toHaveBeenLastCalledWith("fallback");
  expect(test.invalidate).toHaveBeenCalledExactlyOnceWith(PUSH_TOPICS);
  expect(test.sockets.length).toBeLessThan(8);
  vi.advanceTimersToNextTimer();
  test.sockets.at(-1)!.ready(12);
  vi.advanceTimersByTime(PUSH_LIMITS.COALESCE_MS);
  expect(test.status).toHaveBeenLastCalledWith("live");
  test.invalidate.mockClear();
  vi.advanceTimersByTime(PUSH_LIMITS.HEARTBEAT_MS);
  test.sockets.at(-1)!.message(PUSH_LIMITS.PONG);
  expect(test.invalidate).not.toHaveBeenCalled();
});
it("requires a valid workspace handshake, times out dead connections, and signals revocation", () => {
  const test = fixture();
  test.sockets[0].change(1);
  expect(test.sockets[0].close).toHaveBeenCalled();
  vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  test.sockets[1].frame({
    version: 1,
    type: "ready",
    workspaceId: "beta",
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
  expect(test.invalidate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS * 2);
  test.sockets[2].ready();
  vi.advanceTimersByTime(
    PUSH_LIMITS.HEARTBEAT_MS + PUSH_LIMITS.HEARTBEAT_TIMEOUT_MS,
  );
  expect(test.sockets[2].close).toHaveBeenCalled();
  vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  test.sockets[3].ready();
  test.sockets[3].onclose?.({ code: PUSH_CLOSE.REVOKED });
  expect(test.revoked).toHaveBeenCalledOnce();
});
it("preserves the close event after an error instead of dropping the access change", () => {
  const test = fixture();
  test.sockets[0].ready();
  test.sockets[0].onerror?.();
  test.sockets[0].onclose?.({ code: PUSH_CLOSE.REVOKED });
  expect(test.revoked).toHaveBeenCalledOnce();
  expect(test.controller.diagnostics().events[0]).toMatchObject({
    reason: "access_changed",
    code: PUSH_CLOSE.REVOKED,
  });
});
it("bounds the error grace when a browser never supplies a close event", () => {
  const test = fixture();
  test.sockets[0].onerror?.();
  test.sockets[0].onerror?.();
  vi.advanceTimersByTime(PUSH_DIAGNOSTIC_LIMITS.ERROR_CLOSE_GRACE_MS - 1);
  expect(test.sockets[0].close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(test.sockets[0].close).toHaveBeenCalledOnce();
  expect(test.controller.diagnostics().events[0]).toMatchObject({
    reason: "network",
  });
  vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  expect(test.sockets).toHaveLength(2);
});
it("clears pending error recovery when hidden or stopped", () => {
  const test = fixture();
  test.sockets[0].onerror?.();
  visible = false;
  test.controller.reconcile();
  vi.advanceTimersByTime(PUSH_LIMITS.FALLBACK_MS * 2);
  expect(test.sockets).toHaveLength(1);
  expect(test.controller.diagnostics()).toMatchObject({
    status: "paused",
    nextRetryAt: null,
    nextRefreshAt: null,
  });
  visible = true;
  test.controller.reconcile();
  test.sockets[1].onerror?.();
  test.controller.stop();
  vi.advanceTimersByTime(PUSH_LIMITS.FALLBACK_MS * 2);
  expect(test.sockets).toHaveLength(2);
});
it("distinguishes planned renewal from outages without relaxing retry bounds", () => {
  const test = fixture();
  for (const [code, reason] of [
    [PUSH_CLOSE.ROTATE, "connection_rotation"],
    [PUSH_CLOSE.INACTIVE, "inactive_connection"],
    [PUSH_CLOSE.REAUTHENTICATE, "authorization_renewal"],
  ] as const) {
    const socket = test.sockets.at(-1)!;
    socket.ready();
    socket.onclose?.({ code });
    expect(test.controller.diagnostics()).toMatchObject({
      status: "renewing",
      nextRetryAt: Date.now() + PUSH_LIMITS.RECONNECT_MIN_MS,
      nextRefreshAt: Date.now() + PUSH_LIMITS.FALLBACK_MS,
      expiresAt: null,
    });
    expect(test.controller.diagnostics().events[0]).toMatchObject({
      reason,
      code,
    });
    vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  }
  test.sockets.at(-1)!.ready();
  expect(test.controller.diagnostics()).toMatchObject({
    status: "live",
    nextRetryAt: null,
    nextRefreshAt: null,
  });
});
it("records only bounded safe reasons and timestamps, never frame bodies or raw errors", () => {
  const test = fixture();
  for (let index = 0; index < PUSH_DIAGNOSTIC_LIMITS.EVENTS + 3; index++) {
    const socket = test.sockets.at(-1)!;
    socket.ready();
    socket.message("private-value-must-not-be-retained");
    vi.advanceTimersByTime(PUSH_LIMITS.RECONNECT_MIN_MS);
  }
  const diagnostics = test.controller.diagnostics();
  expect(diagnostics.events).toHaveLength(PUSH_DIAGNOSTIC_LIMITS.EVENTS);
  expect(JSON.stringify(diagnostics)).not.toContain("private-value");
  expect(diagnostics.events[0].reason).toBe("protocol");
  diagnostics.events.length = 0;
  expect(test.controller.diagnostics().events).toHaveLength(
    PUSH_DIAGNOSTIC_LIMITS.EVENTS,
  );
  const socket = test.sockets.at(-1)!;
  socket.ready();
  const connected = Date.now();
  const statusCalls = test.status.mock.calls.length;
  vi.advanceTimersByTime(PUSH_LIMITS.HEARTBEAT_MS);
  socket.message(PUSH_LIMITS.PONG);
  expect(test.controller.diagnostics()).toMatchObject({
    lastConnectedAt: connected,
    lastMessageAt: Date.now(),
  });
  expect(test.status).toHaveBeenCalledTimes(statusCalls);
});
it("classifies bounded close codes without guessing at unknown network failures", () => {
  for (const [code, reason] of [
    [PUSH_CLOSE.REVOKED, "access_changed"],
    [PUSH_CLOSE.PROTOCOL, "protocol"],
    [PUSH_CLOSE.TOO_LARGE, "frame_too_large"],
    [PUSH_CLOSE.DELIVERY, "delivery_interrupted"],
    [PUSH_CLOSE.TEMPORARY, "server_unavailable"],
    [1006, "network"],
    [4999, "network"],
  ] as const)
    expect(pushCloseReason(code)).toBe(reason);
});
it("targets caches without leaking across workspaces or requerying unrelated providers", () => {
  expect(
    workspaceQueryMatches(["secrets", "alpha", "connections"], "alpha", [
      "workspace",
    ]),
  ).toBe(true);
  expect(
    workspaceQueryMatches(["secrets", "alpha", "inventory"], "alpha", [
      "activity",
    ]),
  ).toBe(false);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "activity-feed", {}, null],
      "alpha",
      ["activity"],
    ),
  ).toBe(true);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "goal-activity", {}, "goal", "fixed-cursor"],
      "alpha",
      ["activity"],
    ),
  ).toBe(false);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "activity-feed", {}, "fixed-cursor"],
      "alpha",
      ["activity"],
    ),
  ).toBe(false);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "goal-activity", {}, "goal", "fixed-cursor"],
      "alpha",
      PUSH_TOPICS,
    ),
  ).toBe(true);
  expect(
    workspaceQueryMatches(["workspace", "alpha"], "alpha", ["sources"]),
  ).toBe(true);
  expect(
    workspaceQueryMatches(["hooks", "alpha", "snapshot"], "alpha", [
      "activity",
    ]),
  ).toBe(false);
  expect(
    workspaceQueryMatches(["github-refresh", "alpha"], "alpha", ["sources"]),
  ).toBe(true);
  for (const topic of ["workspace", "sources", "access"] as const)
    expect(
      workspaceQueryMatches(["github-coverage", "alpha"], "alpha", [topic]),
    ).toBe(true);
  expect(
    workspaceQueryMatches(["github-coverage", "alpha"], "alpha", ["activity"]),
  ).toBe(false);
  expect(
    workspaceQueryMatches(["github-coverage", "beta"], "alpha", PUSH_TOPICS),
  ).toBe(false);
  expect(
    workspaceQueryMatches(["monitoring", "alpha", "review"], "alpha", [
      "operations",
    ]),
  ).toBe(true);
  expect(workspaceQueryMatches(["session"], "alpha", ["access"])).toBe(true);
  expect(
    workspaceQueryMatches(["workspace", "beta"], "alpha", PUSH_TOPICS),
  ).toBe(false);
});
