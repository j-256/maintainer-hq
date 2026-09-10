import { PUSH_CLOSE } from "../../shared/workspace-push";

export const PUSH_DIAGNOSTIC_LIMITS = Object.freeze({
  EVENTS: 8,
  ERROR_CLOSE_GRACE_MS: 100,
  DISPLAY_INTERVAL_MS: 1000,
  CLOSE_CODE_MIN: 1000,
  CLOSE_CODE_MAX: 4999,
});

export type PushStatus =
  | "connecting"
  | "live"
  | "renewing"
  | "reconnecting"
  | "fallback"
  | "offline"
  | "paused";
export const PUSH_STATUS_LABEL: Record<PushStatus, string> = {
  connecting: "Connecting live updates",
  live: "Live updates",
  renewing: "Renewing live updates",
  reconnecting: "Reconnecting",
  fallback: "Fallback refresh",
  offline: "Offline",
  paused: "Updates paused",
};

export const PUSH_REASON_LABEL = Object.freeze({
  connected: "Live connection established",
  network: "Connection interrupted; the browser supplied no specific cause",
  handshake_timeout: "The live connection did not become ready in time",
  heartbeat_timeout: "The live connection stopped answering heartbeats",
  authorization_renewal: "Scheduled live authorization renewal",
  connection_rotation: "Scheduled renewal after the connection's update limit",
  inactive_connection:
    "The service renewed a connection without recent heartbeats",
  access_changed: "Workspace access changed; checking your permissions",
  protocol: "An unexpected live message was rejected",
  frame_too_large: "A live message exceeded the allowed size",
  server_unavailable: "Live service temporarily unavailable",
  delivery_interrupted: "The service could not deliver a live update",
  hidden: "Updates paused while this tab is hidden",
  offline: "Updates paused while the browser reports no network",
});
export type PushReason = keyof typeof PUSH_REASON_LABEL;
export type PushEvent = { at: number; reason: PushReason; code?: number };
export type PushDiagnostics = {
  status: PushStatus;
  statusSince: number;
  startedAt: number;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  expiresAt: number | null;
  nextRetryAt: number | null;
  nextRefreshAt: number | null;
  events: PushEvent[];
};

export function pushCloseReason(code: number): PushReason {
  switch (code) {
    case PUSH_CLOSE.REAUTHENTICATE:
      return "authorization_renewal";
    case PUSH_CLOSE.ROTATE:
      return "connection_rotation";
    case PUSH_CLOSE.INACTIVE:
      return "inactive_connection";
    case PUSH_CLOSE.REVOKED:
      return "access_changed";
    case PUSH_CLOSE.PROTOCOL:
      return "protocol";
    case PUSH_CLOSE.TOO_LARGE:
      return "frame_too_large";
    case PUSH_CLOSE.TEMPORARY:
      return "server_unavailable";
    case PUSH_CLOSE.DELIVERY:
      return "delivery_interrupted";
    default:
      return "network";
  }
}
