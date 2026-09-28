import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitHubCoverageSource } from "../shared/github-coverage";
import { GITHUB_REFRESH_LIMITS, type GitHubRefresh } from "../shared/github";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { SOURCE_REQUEST_TIMEOUT_MS } from "./source-editor";

export function GitHubCoverageRefresh({
  workspaceId,
  source,
  canOperate,
  onQueued,
}: {
  workspaceId: string;
  source: GitHubCoverageSource;
  canOperate: boolean;
  onQueued: (refreshId: string, returnFocus: HTMLElement) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ id: string; revision: number } | null>(null);
  const now = Date.now();
  const blocked = !canOperate
    ? "Owners and operators can refresh GitHub evidence."
    : !source.enabled ||
        !source.credentialConfigured ||
        !source.configurationValid
      ? "Configure and enable this connection before refreshing."
      : source.activeRefreshId
        ? "Collection is active. Open its receipt to follow progress."
        : (source.retryAt && Date.parse(source.retryAt) > now) ||
            (source.lastRefreshQueuedAt &&
              now - Date.parse(source.lastRefreshQueuedAt) <
                GITHUB_REFRESH_LIMITS.MANUAL_INTERVAL_MS)
          ? "Wait for the next allowed refresh shown in the connection details."
          : null;

  async function refresh(returnFocus: HTMLElement) {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    if (!request.current || request.current.revision !== source.revision)
      request.current = { id: crypto.randomUUID(), revision: source.revision };
    try {
      const result = await command<GitHubRefresh>(
        "github_refresh",
        {
          workspaceId,
          sourceId: source.id,
          revision: request.current.revision,
          refreshId: request.current.id,
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      request.current = null;
      onQueued(result.id, returnFocus);
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      void client.invalidateQueries({
        queryKey: ["github-coverage", workspaceId],
      });
    } catch (failure) {
      if (
        failure instanceof RequestError &&
        failure.status >= 400 &&
        failure.status < 500
      ) {
        request.current = null;
        setError(failure.message);
      } else {
        setError(
          "The response was interrupted. A refresh may already be queued. Retry will reuse the same request ID.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="github-coverage-refresh">
      <Button
        size="sm"
        disabled={busy || Boolean(blocked)}
        onClick={(event) => void refresh(event.currentTarget)}
      >
        {busy ? "Queuing collection..." : "Refresh GitHub evidence"}
      </Button>
      <p className="field-help">
        Refreshes every repository selected by this connection.
      </p>
      {blocked ? <p className="field-help">{blocked}</p> : null}
      {error ? (
        <p role="alert" className="source-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
