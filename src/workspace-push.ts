import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PUSH_TOPICS } from "../shared/workspace-push";
import {
  VIEW_TOPICS,
  viewQueryKey,
  type SyncScope,
} from "../shared/workspace-sync";
import {
  applyViewUpdate,
  sortView,
  type CachedWorkspaceView,
} from "./lib/workspace-sync";
import {
  createWorkspacePush,
  workspaceQueryMatches,
  type PushStatus,
} from "./lib/workspace-push";
import { createWorkspaceQueryRefresh } from "./lib/workspace-query-refresh";
import type { PushDiagnostics } from "./lib/push-diagnostics";

export function useWorkspacePush(
  workspaceId: string | undefined,
  enabled: boolean,
  scope: SyncScope,
  memberRevision: number | undefined,
) {
  const cache = useQueryClient();
  const scopeKey = JSON.stringify(scope);
  const diagnosticsRef = useRef<{
    workspaceId: string;
    scopeKey: string;
    memberRevision: number | undefined;
    read: () => PushDiagnostics;
  } | null>(null);
  const readDiagnostics = useCallback(() => {
    const current = diagnosticsRef.current;
    return enabled &&
      current !== null &&
      current.workspaceId === workspaceId &&
      current.scopeKey === scopeKey &&
      current.memberRevision === memberRevision
      ? current.read()
      : null;
  }, [enabled, workspaceId, scopeKey, memberRevision]);
  const [state, setState] = useState<{
    workspaceId: string;
    view: string;
    status: PushStatus;
    memberRevision: number | undefined;
  }>();
  useEffect(() => {
    if (!workspaceId || !enabled) return;
    const url = new URL("/api/events", window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspaceId", workspaceId);
    const key = viewQueryKey(workspaceId, scope);
    const refresh = () => {
      void cache.invalidateQueries(
        { queryKey: key, exact: true },
        { cancelRefetch: false },
      );
    };
    const active = () =>
      document.visibilityState === "visible" && navigator.onLine;
    const auxiliary = createWorkspaceQueryRefresh(cache, workspaceId, active);
    const refreshAuxiliary = () =>
      auxiliary.enqueue(VIEW_TOPICS[scope.view], true);
    const connection = createWorkspacePush({
      workspaceId,
      url: url.href,
      socket: (url) => new WebSocket(url),
      visible: () => document.visibilityState === "visible",
      online: () => navigator.onLine,
      status: (status) =>
        setState({
          workspaceId,
          view: JSON.stringify(scope),
          memberRevision,
          status,
        }),
      subscription: {
        scope,
        cursor: () => cache.getQueryData<CachedWorkspaceView>(key)?.cursor ?? 0,
        memberRevision: () =>
          cache.getQueryData<CachedWorkspaceView>(key)?.memberRevision ?? 1,
        update: (update) => {
          cache.setQueryData<CachedWorkspaceView>(key, (prior) => {
            if (!prior) return prior;
            const next = applyViewUpdate(prior, scope, update);
            return next === prior ? prior : sortView(next);
          });
          if (cache.getQueryData<CachedWorkspaceView>(key)?.resync) refresh();
        },
      },
      refresh: () => {
        refresh();
        refreshAuxiliary();
      },
      connected: refreshAuxiliary,
      invalidate: (topics) => auxiliary.enqueue(topics),
      revoked: () => {
        auxiliary.pause();
        const filters = {
          predicate: (query: { queryKey: readonly unknown[] }) =>
            query.queryKey[1] === workspaceId &&
            workspaceQueryMatches(query.queryKey, workspaceId, PUSH_TOPICS),
        };
        void cache
          .cancelQueries(filters)
          .then(() => cache.resetQueries(filters));
        void cache.invalidateQueries({ queryKey: ["session"] });
      },
    });
    diagnosticsRef.current = {
      workspaceId,
      scopeKey: JSON.stringify(scope),
      memberRevision,
      read: connection.diagnostics,
    };
    const reconcile = () => {
      if (!active()) auxiliary.pause();
      connection.reconcile();
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("online", reconcile);
    window.addEventListener("offline", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("offline", reconcile);
      auxiliary.stop();
      connection.stop();
      diagnosticsRef.current = null;
    };
  }, [
    workspaceId,
    enabled,
    cache,
    scope.view,
    scope.repositoryId,
    memberRevision,
  ]);
  const status: PushStatus =
    enabled &&
    state &&
    state.workspaceId === workspaceId &&
    state.view === scopeKey &&
    state.memberRevision === memberRevision
      ? state.status
      : "connecting";
  return { status, diagnostics: readDiagnostics };
}
