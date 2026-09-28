import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import type { HookResolutionReview } from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import {
  HookError,
  HookTime,
  HOOK_RESOLUTION_LABELS,
  HOOK_REQUEST_TIMEOUT_MS,
  restoreHookFocus,
} from "./hook-components";

const UNCERTAIN = ["pending", "running", "indeterminate"];
export function HookDispositionReceipt({
  snapshot,
  planId,
  onClose,
  returnFocus,
}: {
  snapshot: Snapshot;
  planId: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const key = ["hooks", workspaceId, "disposition", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<HookResolutionReview>(
        "hooks_resolution_get",
        { workspaceId, planId },
        signal,
      ),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const data = query.data;
  const canReconcile =
    data?.actorMatches &&
    snapshot.capabilities.includes(CAPABILITY.OPERATE) &&
    data.operation &&
    UNCERTAIN.includes(data.operation.status);
  async function reconcile() {
    if (busy || !canReconcile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command<HookResolutionReview>(
        "hooks_resolution_reconcile",
        { workspaceId, planId },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(key, result);
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="hook-dialog hook-disposition-receipt"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreHookFocus(returnFocus);
        }}
      >
        <DialogHeader>
          <DialogTitle>Operational disposition receipt</DialogTitle>
          <DialogDescription>
            The reviewed acknowledgement preserves history. It does not send a
            message or verify delivery.
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? <p role="status">Loading receipt...</p> : null}
        {query.error ? <HookError error={query.error} /> : null}
        {error ? <HookError error={error} /> : null}
        {data ? (
          <>
            <dl className="hook-detail-grid">
              <div>
                <dt>Connection</dt>
                <dd>{data.connectionName}</dd>
              </div>
              <div>
                <dt>Disposition</dt>
                <dd>{HOOK_RESOLUTION_LABELS[data.reason]}</dd>
              </div>
              <div>
                <dt>Receipt state</dt>
                <dd>
                  {data.operation?.status === "succeeded"
                    ? "Accepted"
                    : (data.operation?.status ?? "Not applied")}
                </dd>
              </div>
              <div>
                <dt>Accepted at</dt>
                <dd>
                  <HookTime value={data.provider?.acceptedAt ?? null} />
                </dd>
              </div>
            </dl>
            <p>{data.note}</p>
            {data.operation ? (
              <p role="status">{data.operation.summary}</p>
            ) : null}
            <details className="hook-signals">
              <summary>Reviewed records ({data.targets.length})</summary>
              <ul>
                {data.targets.map((target) => (
                  <li key={JSON.stringify(target)}>
                    {target.kind === "signal" ? (
                      <>
                        <strong>Signal {target.fingerprint}</strong>
                        <p>
                          {target.occurrences} occurrences, last seen{" "}
                          <HookTime value={target.lastSeenAt} />.
                        </p>
                      </>
                    ) : (
                      <>
                        <strong>{target.eventId}</strong>
                        <p>
                          {target.sinkName}, generation {target.generation}.
                          Updated <HookTime value={target.updatedAt} />.
                        </p>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
        <div className="hook-dialog-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {canReconcile ? (
            <Button disabled={busy} onClick={() => void reconcile()}>
              {busy ? "Checking receipt..." : "Reconcile receipt"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
