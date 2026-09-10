import {
  PUSH_CLOSE,
  PUSH_LIMITS,
  PUSH_TOPICS,
  pushFrameSchema,
  type PushTopic,
} from "../../shared/workspace-push";
import {
  SYNC_LIMITS,
  sameScope,
  type SyncScope,
  type SyncUpdate,
} from "../../shared/workspace-sync";

import {
  PUSH_DIAGNOSTIC_LIMITS,
  pushCloseReason,
  type PushDiagnostics,
  type PushReason,
  type PushStatus,
} from "./push-diagnostics";
export { PUSH_STATUS_LABEL, type PushStatus } from "./push-diagnostics";
const QUERY_TOPICS: Record<string, readonly PushTopic[]> = {
  secrets: ["workspace", "associations", "access", "operations"],
  "metadata-import": ["workspace"],
  hooks: ["hooks", "associations", "operations", "access"],
  "attention-hooks": ["hooks", "associations", "operations", "access"],
  "attention-monitoring": [
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  monitoring: ["monitoring", "associations", "operations", "access"],
  "resource-repositories": ["associations", "workspace", "access"],
  "repository-resources": ["associations", "workspace", "access"],
  "repository-context": ["associations", "access"],
  "repository-coverage": [
    "hooks",
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  "repository-coverage-cache": [
    "hooks",
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  "repository-access": ["access"],
  "project-resources": ["associations", "workspace", "access"],
  "resource-project": ["associations", "workspace", "access"],
  "departed-resource": ["workspace", "access"],
  "project-transfer-destinations": ["access"],
  "project-transfer-review": [
    "workspace",
    "access",
    "associations",
    "operations",
    "sources",
  ],
  "github-refreshes": ["sources", "access"],
  "github-refresh": ["sources", "access"],
  "github-credentials": ["sources", "access"],
  "github-coverage": ["workspace", "sources", "access"],
  "repository-releases": ["workspace", "sources", "associations", "access"],
  "repository-work": ["workspace", "sources", "associations", "access"],
  "repository-dependencies": ["workspace", "sources", "associations", "access"],
  dependencies: ["workspace", "sources", "associations", "access"],
  "dependency-review": ["workspace", "sources", "associations", "access", "operations"],
  "dependency-access": ["workspace", "access"],
  "dependency-operation": ["workspace", "access", "operations"],
  "dependency-history": ["workspace", "access", "operations"],
  "publisher-credentials": ["sources", "access"],
  "automation-credentials": ["access"],
  membership: ["access"],
};

export function workspaceQueryMatches(
  key: readonly unknown[],
  workspaceId: string,
  topics: readonly PushTopic[],
) {
  const prefix = String(key[0]);
  if (prefix === "session" || prefix === "account-invitations")
    return topics.includes("access");
  if (key[1] !== workspaceId) return false;
  if (prefix === "workspace") {
    if (key[2] === "view") return topics.includes("access");
    if (key.length === 2 || topics.includes("access")) return true;
    return (
      topics.includes("activity") &&
      key[2] === "activity-feed" &&
      key[4] === null
    );
  }
  return QUERY_TOPICS[prefix]?.some((topic) => topics.includes(topic)) ?? false;
}

type Options = {
  workspaceId: string;
  url: string;
  socket: (url: string) => WebSocket;
  visible: () => boolean;
  online: () => boolean;
  status: (state: PushStatus) => void;
  invalidate: (topics: PushTopic[]) => void;
  revoked: () => void;
  subscription?: {
    scope: SyncScope;
    cursor: () => number;
    memberRevision: () => number;
    update: (update: SyncUpdate) => void;
  };
  refresh?: () => void;
  connected?: () => void;
  random?: () => number;
};

export function createWorkspacePush(options: Options) {
  const startedAt = Date.now();
  const diagnostics: PushDiagnostics = {
    status: "connecting",
    statusSince: startedAt,
    startedAt,
    lastConnectedAt: null,
    lastMessageAt: null,
    expiresAt: null,
    nextRetryAt: null,
    nextRefreshAt: null,
    events: [],
  };
  function status(next: PushStatus) {
    if (diagnostics.status !== next) diagnostics.statusSince = Date.now();
    diagnostics.status = next;
    options.status(next);
  }
  function record(reason: PushReason, code?: number) {
    diagnostics.events.unshift({
      at: Date.now(),
      reason,
      ...(typeof code === "number" &&
      Number.isInteger(code) &&
      code >= PUSH_DIAGNOSTIC_LIMITS.CLOSE_CODE_MIN &&
      code <= PUSH_DIAGNOSTIC_LIMITS.CLOSE_CODE_MAX
        ? { code }
        : {}),
    });
    diagnostics.events.length = Math.min(
      diagnostics.events.length,
      PUSH_DIAGNOSTIC_LIMITS.EVENTS,
    );
  }
  let disposed = false;
  let socket: WebSocket | null = null;
  let ready = false;
  let revision = -1;
  let failures = 0;
  let fallbackActive = false;
  let renewing = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<PushTopic>();
  const active = () => !disposed && options.visible() && options.online();
  function queue(topics: readonly PushTopic[]) {
    if (!topics.length) return;
    for (const topic of topics) pending.add(topic);
    if (coalesceTimer !== undefined) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      const topics = [...pending];
      pending.clear();
      if (active()) options.invalidate(topics);
    }, PUSH_LIMITS.COALESCE_MS);
  }
  function disconnect() {
    clearTimeout(errorTimer);
    errorTimer = undefined;
    clearTimeout(handshakeTimer);
    clearTimeout(heartbeatTimer);
    clearTimeout(pongTimer);
    ready = false;
    diagnostics.expiresAt = null;
    if (!socket) return;
    const previous = socket;
    socket = null;
    previous.onopen =
      previous.onmessage =
      previous.onerror =
      previous.onclose =
        null;
    try {
      previous.close(1000, "Workspace observer disconnected");
    } catch {
      /* The handshake may already have failed */
    }
  }
  function fallback() {
    if (fallbackTimer !== undefined) return;
    diagnostics.nextRefreshAt = Date.now() + PUSH_LIMITS.FALLBACK_MS;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      diagnostics.nextRefreshAt = null;
      if (!active() || ready) return;
      fallbackActive = true;
      status("fallback");
      if (options.refresh) options.refresh();
      else queue(PUSH_TOPICS);
      fallback();
    }, PUSH_LIMITS.FALLBACK_MS);
  }
  function interrupted(reason: PushReason = "network", code?: number) {
    disconnect();
    if (!active()) return;
    if (code === PUSH_CLOSE.REVOKED) options.revoked();
    record(reason, code);
    renewing =
      reason === "authorization_renewal" ||
      reason === "connection_rotation" ||
      reason === "inactive_connection";
    failures += 1;
    status(
      fallbackActive ? "fallback" : renewing ? "renewing" : "reconnecting",
    );
    fallback();
    const backoff = Math.min(
      PUSH_LIMITS.RECONNECT_MAX_MS,
      PUSH_LIMITS.RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 16),
    );
    const delay = Math.min(
      PUSH_LIMITS.RECONNECT_MAX_MS,
      backoff * (1 + (options.random ?? Math.random)() * 0.25),
    );
    clearTimeout(retryTimer);
    diagnostics.nextRetryAt = Date.now() + delay;
    retryTimer = setTimeout(connect, delay);
  }
  function heartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (!socket || !ready || !active()) return;
      try {
        socket.send(PUSH_LIMITS.PING);
      } catch {
        interrupted();
        return;
      }
      pongTimer = setTimeout(
        () => interrupted("heartbeat_timeout"),
        PUSH_LIMITS.HEARTBEAT_TIMEOUT_MS,
      );
    }, PUSH_LIMITS.HEARTBEAT_MS);
  }
  function connect() {
    retryTimer = undefined;
    diagnostics.nextRetryAt = null;
    if (!active() || socket) return;
    status(
      fallbackActive
        ? "fallback"
        : renewing
          ? "renewing"
          : failures
            ? "reconnecting"
            : "connecting",
    );
    revision = -1;
    let current: WebSocket;
    try {
      const url = new URL(options.url);
      if (options.subscription) {
        url.searchParams.set("view", options.subscription.scope.view);
        url.searchParams.set("cursor", String(options.subscription.cursor()));
        url.searchParams.set(
          "memberRevision",
          String(options.subscription.memberRevision()),
        );
        if (options.subscription.scope.repositoryId)
          url.searchParams.set(
            "repositoryId",
            options.subscription.scope.repositoryId,
          );
      }
      current = options.socket(url.href);
      socket = current;
    } catch {
      interrupted();
      return;
    }
    handshakeTimer = setTimeout(
      () => interrupted("handshake_timeout"),
      PUSH_LIMITS.HANDSHAKE_MS,
    );
    current.onmessage = (event) => {
      if (socket !== current || !active()) return;
      if (event.data === PUSH_LIMITS.PONG && ready) {
        diagnostics.lastMessageAt = Date.now();
        clearTimeout(pongTimer);
        heartbeat();
        return;
      }
      if (
        typeof event.data !== "string" ||
        new TextEncoder().encode(event.data).byteLength >
          (options.subscription
            ? SYNC_LIMITS.FRAME_BYTES
            : PUSH_LIMITS.FRAME_BYTES)
      ) {
        interrupted(
          typeof event.data === "string" ? "frame_too_large" : "protocol",
        );
        return;
      }
      let parsed;
      try {
        parsed = pushFrameSchema.safeParse(JSON.parse(event.data));
      } catch {
        interrupted("protocol");
        return;
      }
      if (!parsed.success || parsed.data.workspaceId !== options.workspaceId) {
        interrupted("protocol");
        return;
      }
      const frame = parsed.data;
      if (
        options.subscription
          ? frame.version !== 2 ||
            !sameScope(frame.scope, options.subscription.scope)
          : frame.version !== 1
      ) {
        interrupted("protocol");
        return;
      }
      if (frame.type === "ready") {
        if (ready) {
          interrupted("protocol");
          return;
        }
        ready = true;
        revision = frame.revision;
        failures = 0;
        fallbackActive = false;
        renewing = false;
        clearTimeout(handshakeTimer);
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
        diagnostics.lastConnectedAt = diagnostics.lastMessageAt = Date.now();
        diagnostics.expiresAt = frame.expiresAt;
        diagnostics.nextRetryAt = diagnostics.nextRefreshAt = null;
        record("connected");
        status("live");
        if (frame.version === 2 && options.subscription) {
          options.subscription.update(frame.update);
          options.connected?.();
        } else queue(PUSH_TOPICS);
        heartbeat();
      } else {
        if (!ready) {
          interrupted("protocol");
          return;
        }
        diagnostics.lastMessageAt = Date.now();
        if (frame.revision <= revision) return;
        revision = frame.revision;
        if (frame.version === 2) options.subscription?.update(frame.update);
        queue(frame.topics);
      }
    };
    current.onerror = () => {
      if (socket !== current || errorTimer !== undefined) return;
      // Preserve the following close code, including an access revocation
      errorTimer = setTimeout(() => {
        errorTimer = undefined;
        if (socket === current) interrupted();
      }, PUSH_DIAGNOSTIC_LIMITS.ERROR_CLOSE_GRACE_MS);
    };
    current.onclose = (event) => {
      if (socket === current)
        interrupted(pushCloseReason(event.code), event.code);
    };
  }
  function pause() {
    disconnect();
    clearTimeout(retryTimer);
    clearTimeout(fallbackTimer);
    clearTimeout(coalesceTimer);
    retryTimer = fallbackTimer = coalesceTimer = undefined;
    diagnostics.nextRetryAt = diagnostics.nextRefreshAt = null;
    pending.clear();
  }
  function reconcile() {
    if (disposed) return;
    if (!active()) {
      pause();
      const next = options.online() ? "paused" : "offline";
      if (diagnostics.status !== next)
        record(next === "paused" ? "hidden" : "offline");
      status(next);
    } else if (!socket && retryTimer === undefined) connect();
  }
  reconcile();
  return {
    reconcile,
    diagnostics: (): PushDiagnostics => ({
      ...diagnostics,
      events: diagnostics.events.map((event) => ({ ...event })),
    }),
    stop() {
      disposed = true;
      pause();
    },
  };
}
