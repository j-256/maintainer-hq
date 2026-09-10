import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  HOOK_LIMITS,
  type HookConnection,
  type HookDelivery,
  type HookReview,
} from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import {
  HookError,
  HookStatus,
  HookTime,
  HOOK_REQUEST_TIMEOUT_MS,
  restoreHookFocus,
} from "./hook-components";
const REVIEW_CLOCK_TICK_MS = 1000;

export function HookDeliveryDetail({
  snapshot,
  connection,
  eventId,
  sinkName,
  onClose,
  onReview,
  returnFocus,
}: {
  snapshot: Snapshot;
  connection: HookConnection;
  eventId: string;
  sinkName: string;
  onClose: () => void;
  onReview: (planId: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const reviewAttempt = useRef<{ identity: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const detail = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "delivery",
      connection.id,
      connection.revision,
      eventId,
      sinkName,
    ],
    queryFn: ({ signal }) =>
      command<{ result: HookDelivery; capabilities: string[] }>(
        "hooks_delivery",
        { workspaceId, connectionId: connection.id, eventId, sinkName },
        signal,
      ),
    staleTime: 0,
    refetchInterval: HOOK_LIMITS.REFRESH_MS,
  });
  async function review() {
    if (!detail.data || busy) return;
    setBusy(true);
    setError(null);
    const identity = JSON.stringify([
      connection.revision,
      detail.data.result.generation,
      detail.data.result.updatedAt,
    ]);
    if (reviewAttempt.current?.identity !== identity)
      reviewAttempt.current = { identity, id: crypto.randomUUID() };
    try {
      const plan = await command<HookReview>(
        "hooks_retry_plan",
        {
          workspaceId,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          eventId,
          sinkName,
          generation: detail.data.result.generation,
          updatedAt: detail.data.result.updatedAt,
          reviewId: reviewAttempt.current.id,
        },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      onReview(plan.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const data = detail.data?.result;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="hook-dialog"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreHookFocus(returnFocus);
        }}
      >
        <DialogHeader>
          <DialogTitle>Delivery to {sinkName}</DialogTitle>
          <DialogDescription>
            Inspect provider-owned state before reviewing a retry. No raw event
            payload is exposed.
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? <p role="status">Loading delivery...</p> : null}
        {detail.error ? <HookError error={detail.error} /> : null}
        {error ? <HookError error={error} /> : null}
        {data ? (
          <>
            <div>
              <HookStatus status={data.status} />
            </div>
            <dl className="hook-detail-grid">
              <div>
                <dt>Event</dt>
                <dd>
                  <code>{data.eventId}</code>
                </dd>
              </div>
              <div>
                <dt>Subscription</dt>
                <dd>{data.subscription}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{data.attempts}</dd>
              </div>
              <div>
                <dt>Generation</dt>
                <dd>{data.generation}</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>
                  <HookTime value={data.receivedAt} />
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>
                  <HookTime value={data.updatedAt} />
                </dd>
              </div>
              {data.deliveredAt ? (
                <div>
                  <dt>Delivered</dt>
                  <dd>
                    <HookTime value={data.deliveredAt} />
                  </dd>
                </div>
              ) : null}
              {data.decisionReason ? (
                <div>
                  <dt>Filtering reason</dt>
                  <dd>
                    {data.decisionReason === "source-record-only"
                      ? "Recorded without notification"
                      : data.decisionReason.replaceAll("-", " ")}
                  </dd>
                </div>
              ) : null}
            </dl>
            {data.decisionReason === "source-record-only" ? (
              <p className="hook-notice">
                The source adapter recorded this event without requesting a
                notification, before subscription or sink filters were
                evaluated. This is not a delivery failure; changing subscription
                filters will not make this event notify.
              </p>
            ) : null}
            {data.status !== "exhausted" ? (
              <p className="hook-muted">
                Only exhausted deliveries can be reviewed for retry here.
                Pending and active deliveries remain under Hookrelay's queue
                recovery.
              </p>
            ) : null}
          </>
        ) : null}
        {!canOperate ? (
          <p className="permission-notice">
            Your role can inspect deliveries. An owner or operator must review
            retries.
          </p>
        ) : null}
        {canOperate &&
        detail.data &&
        !detail.data.capabilities.includes("retry") ? (
          <p className="permission-notice">
            This provider credential allows reads only. Its deployment owner
            must grant reviewed retry access.
          </p>
        ) : null}
        <div className="hook-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            disabled={busy || detail.isFetching}
            onClick={() => {
              reviewAttempt.current = null;
              void detail.refetch();
            }}
          >
            Refresh delivery
          </Button>
          {canOperate ? (
            <Button
              disabled={
                busy ||
                detail.isFetching ||
                detail.isError ||
                data?.status !== "exhausted" ||
                !detail.data?.capabilities.includes("retry")
              }
              onClick={() => void review()}
            >
              {busy ? "Preparing review..." : "Review retry"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function HookRetryReview({
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
  const key = ["hooks", workspaceId, "review", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<HookReview>("hooks_retry_get", { workspaceId, planId }, signal),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REVIEW_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const data = query.data;
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const expired = Boolean(data && Date.parse(data.expiresAt) <= now);
  const uncertain = Boolean(
    data?.operation &&
    ["pending", "running", "indeterminate"].includes(data.operation.status),
  );
  const accepted = data?.operation?.status === "succeeded";
  async function act(reconcile: boolean) {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command<HookReview>(
        reconcile ? "hooks_retry_reconcile" : "hooks_retry_apply",
        {
          workspaceId,
          planId,
          ...(!reconcile ? { fingerprint: data.fingerprint } : {}),
        },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(key, result);
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId] });
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    } catch (failure) {
      setError(failure);
      void query.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent
        className="hook-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreHookFocus(returnFocus);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {accepted
              ? "Retry accepted by Hookrelay"
              : data?.operation
                ? "Retry operation receipt"
                : "Confirm this hook retry"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {accepted
              ? "The retry is durably accepted. That is not a delivery confirmation; inspect the delivery for its later outcome."
              : "This can send a real notification to the selected sink. It does not change or resend other deliveries."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {query.isPending ? <p role="status">Loading saved review...</p> : null}
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
                <dt>Sink</dt>
                <dd>{data.sinkName}</dd>
              </div>
              <div>
                <dt>Event</dt>
                <dd>
                  <code>{data.eventId}</code>
                </dd>
              </div>
              <div>
                <dt>Reviewed generation</dt>
                <dd>{data.generation}</dd>
              </div>
              <div>
                <dt>Reviewed update</dt>
                <dd>
                  <HookTime value={data.updatedAt} />
                </dd>
              </div>
              <div>
                <dt>Review expires</dt>
                <dd>
                  <HookTime value={data.expiresAt} />
                </dd>
              </div>
            </dl>
            {data.operation ? (
              <div className="hook-notice" role="status">
                <strong>
                  {accepted
                    ? "Accepted"
                    : data.operation.status === "failed"
                      ? "Not accepted"
                      : "Needs reconciliation"}
                </strong>
                <p>{data.operation.summary}</p>
                <HookTime value={data.operation.updatedAt} />
              </div>
            ) : (
              <p className="hook-notice">
                Only this exhausted delivery is eligible. The exact reviewed
                generation must still match. Hookrelay uses its sink
                configuration at execution time, and at-least-once delivery can
                produce duplicates.
              </p>
            )}
            {!data.operation && (!data.provider || expired) ? (
              <p className="hook-notice">
                {expired
                  ? "This review has expired. Close it, refresh the delivery, and prepare a new review."
                  : "Provider review was not completed. Close this view and prepare the review again before confirming."}
              </p>
            ) : null}
            {!data.operation && !data.actorMatches ? (
              <p className="permission-notice">
                Only the person and credential that prepared this review can
                confirm it. You can inspect the delivery and prepare your own
                review.
              </p>
            ) : null}
          </>
        ) : null}
        {!canOperate ? (
          <p className="permission-notice">
            Your role can read this receipt but cannot confirm or reconcile
            retries.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {data?.operation ? "Close receipt" : "Cancel"}
          </AlertDialogCancel>
          {canOperate && uncertain ? (
            <Button
              disabled={busy || query.isError}
              onClick={() => void act(true)}
            >
              {busy ? "Reconciling..." : "Reconcile with Hookrelay"}
            </Button>
          ) : canOperate && data && !data.operation ? (
            <Button
              disabled={
                busy ||
                query.isError ||
                expired ||
                !data.provider ||
                !data.actorMatches
              }
              onClick={() => void act(false)}
            >
              {busy ? "Submitting..." : "Confirm retry"}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
