import type { Query, QueryClient } from "@tanstack/react-query";
import type { PushTopic } from "../../shared/workspace-push";
import {
  GITHUB_REFRESH_STATES,
  githubRefreshActive,
} from "../../shared/github";
import { workspaceQueryMatches } from "./workspace-push";

export const QUERY_REFRESH_LIMITS = Object.freeze({
  LIVE_INTERVAL_MS: 500,
  SOURCE_INTERVAL_MS: 5000,
});
export const COORDINATED_QUERY_OPTIONS = Object.freeze({
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});
const SOURCE_QUERIES = new Set([
  "repository-releases",
  "repository-work",
  "repository-dependencies",
  "dependencies",
  "github-coverage",
  "github-refresh",
  "github-refreshes",
  "github-credentials",
  "publisher-credentials",
]);
const TERMINAL_REFRESH_STATUSES = new Set<string>(
  GITHUB_REFRESH_STATES.filter((status) => !githubRefreshActive(status)),
);

export function fixedWorkspaceQuery(query: Pick<Query, "queryKey" | "state">) {
  const key = query.queryKey;
  if (key[0] === "workspace")
    return (
      key[2] === "goal-activity" ||
      (key[2] === "activity-feed" && key[4] !== null)
    );
  if (key[0] !== "github-refresh" || !query.state.data) return false;
  const status = (query.state.data as { status?: string }).status;
  return status !== undefined && TERMINAL_REFRESH_STATUSES.has(status);
}

type Slot = {
  query: Query;
  dirty: boolean;
  running: boolean;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export function createWorkspaceQueryRefresh(
  cache: QueryClient,
  workspaceId: string,
  active: () => boolean,
) {
  const slots = new Map<string, Slot>();
  let disposed = false;
  const current = (slot: Slot) =>
    !disposed && slots.get(slot.query.queryHash) === slot;
  const usable = (slot: Slot) =>
    current(slot) &&
    active() &&
    slot.query.isActive() &&
    !slot.query.isDisabled();
  function remove(slot: Slot) {
    clearTimeout(slot.timer);
    if (current(slot)) slots.delete(slot.query.queryHash);
  }
  function schedule(slot: Slot) {
    if (!usable(slot)) {
      remove(slot);
      return;
    }
    if (slot.running) return;
    clearTimeout(slot.timer);
    const interval = SOURCE_QUERIES.has(String(slot.query.queryKey[0]))
      ? QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS
      : QUERY_REFRESH_LIMITS.LIVE_INTERVAL_MS;
    slot.timer = setTimeout(
      () => {
        slot.timer = undefined;
        if (!usable(slot) || !slot.dirty) {
          remove(slot);
          return;
        }
        flush(slot);
      },
      Math.max(0, slot.startedAt + interval - Date.now()),
    );
  }
  function flush(slot: Slot) {
    slot.dirty = false;
    slot.running = true;
    slot.startedAt = Date.now();
    const alreadyFetching = slot.query.state.fetchStatus !== "idle";
    void cache
      .refetchQueries(
        { predicate: (query) => query === slot.query, type: "active" },
        { cancelRefetch: false },
      )
      .finally(() => {
        if (!current(slot)) return;
        slot.running = false;
        // A read already in flight may have captured its state before this change
        slot.dirty ||= alreadyFetching;
        schedule(slot);
      });
  }
  return {
    enqueue(topics: readonly PushTopic[], recovery = false) {
      if (disposed) return;
      for (const slot of slots.values()) if (!usable(slot)) remove(slot);
      const queries = cache.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey[2] !== "view" &&
          workspaceQueryMatches(query.queryKey, workspaceId, topics) &&
          (!(recovery || !topics.includes("access")) ||
            !fixedWorkspaceQuery(query)),
      });
      for (const query of queries) {
        query.invalidate();
        if (!active() || !query.isActive() || query.isDisabled()) continue;
        let slot = slots.get(query.queryHash);
        if (!slot) {
          slot = {
            query,
            dirty: true,
            running: false,
            startedAt: -Infinity,
          };
          slots.set(query.queryHash, slot);
        } else slot.dirty = true;
        schedule(slot);
      }
    },
    pause() {
      for (const slot of slots.values()) clearTimeout(slot.timer);
      slots.clear();
    },
    stop() {
      this.pause();
      disposed = true;
    },
  };
}
