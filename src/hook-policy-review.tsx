import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import type { HookPolicyReview } from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
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
  HookTime,
  HOOK_REQUEST_TIMEOUT_MS,
  restoreHookFocus,
} from "./hook-components";
import { HookPolicyIdentity, HookPolicySummary } from "./hook-policy-fields";

const REVIEW_CLOCK_TICK_MS = 1000;
const UNRESOLVED_STATES = ["pending", "running", "indeterminate"];

export function HookPolicyReviewDialog({
  snapshot,
  planId,
  onClose,
  onBack,
  returnFocus,
}: {
  snapshot: Snapshot;
  planId: string;
  onClose: () => void;
  onBack: (() => void) | null;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const key = ["hooks", workspaceId, "policy-review", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<HookPolicyReview>(
        "hooks_policy_get",
        { workspaceId, planId },
        signal,
      ),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const data = query.data;
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const provider = data?.provider;
  const accepted = data?.operation?.status === "succeeded";
  const hasOperation = Boolean(data?.operation);
  const uncertain = Boolean(
    data?.operation && UNRESOLVED_STATES.includes(data.operation.status),
  );
  const expired = Boolean(
    data &&
      Math.min(
        Date.parse(data.expiresAt),
        provider ? Date.parse(provider.expiresAt) : Infinity,
      ) <= now,
  );
  useEffect(() => {
    if (hasOperation || expired) return;
    const timer = setInterval(() => setNow(Date.now()), REVIEW_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [hasOperation, expired]);
  async function act(reconcile: boolean) {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command<HookPolicyReview>(
        reconcile ? "hooks_policy_reconcile" : "hooks_policy_apply",
        {
          workspaceId,
          planId,
          ...(!reconcile ? { fingerprint: data.fingerprint } : {}),
        },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(key, result);
      setInterrupted(false);
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId] });
      void client.invalidateQueries({
        queryKey: ["repository-coverage", workspaceId],
      });
    } catch (failure) {
      setError(failure);
      setInterrupted(true);
      void query.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function checkReceipt() {
    const result = await query.refetch();
    if (!result.isError) setInterrupted(false);
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent
        className="hook-dialog hook-policy-dialog"
        data-policy-review
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            !document.querySelector('[data-policy-editor][data-state="open"]')
          )
            restoreHookFocus(returnFocus);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {accepted
              ? "Routing changed in Hookrelay"
              : data?.operation
                ? "Routing operation receipt"
                : "Review routing changes"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {accepted
              ? "Hookrelay durably accepted this configuration. Notification delivery is a separate outcome."
              : "Apply changes how future events route through this subscription. It does not replay events, cancel queued deliveries, or edit the upstream webhook."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {query.isPending ? (
          <p role="status">Loading saved routing review...</p>
        ) : null}
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
                <dt>Subscription</dt>
                <dd>
                  {provider?.resourceName ?? "Provider review incomplete"}
                </dd>
              </div>
              <div>
                <dt>Reviewed revision</dt>
                <dd>{provider?.revision ?? "Not confirmed"}</dd>
              </div>
              <div>
                <dt>{provider?.receipt ? "Accepted at" : "Review expires"}</dt>
                <dd>
                  <HookTime
                    value={
                      provider?.receipt?.acceptedAt ??
                      (provider &&
                      Date.parse(provider.expiresAt) <
                        Date.parse(data.expiresAt)
                        ? provider.expiresAt
                        : data.expiresAt)
                    }
                  />
                </dd>
              </div>
            </dl>
            {provider ? (
              <HookPolicyIdentity
                resourceId={data.resourceId}
                authorityId={provider.authorityId}
              />
            ) : null}
            {!data.operation ? (
              <p className="hook-muted">
                This changes the subscription wherever it is used, not just one
                linked repository.
              </p>
            ) : null}
            {provider ? (
              <div className="hook-policy-columns hook-policy-comparison">
                <HookPolicySummary title="Before" policy={provider.before} />
                <HookPolicySummary title="After" policy={provider.after} />
              </div>
            ) : null}
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
            ) : null}
            {!data.operation &&
            (expired || !provider || provider.status !== "ready") ? (
              <p className="hook-notice">
                {expired
                  ? "This review expired. Return to the editor, load saved routing, and prepare a new review."
                  : "This review is not ready to apply. Return to the editor to prepare it again."}
              </p>
            ) : null}
            {!data.operation && !data.actorMatches ? (
              <p className="permission-notice">
                Only the person and credential that prepared this review can
                apply it. Open the subscription to prepare your own review.
              </p>
            ) : null}
            {interrupted && !data.operation ? (
              <p className="hook-notice">
                The response was interrupted. Check the saved operation before
                continuing. The same review always refers to one operation.
              </p>
            ) : null}
            {uncertain ? (
              <p className="hook-muted">
                Reconcile checks the original provider receipt without resending
                the change. You can reopen this receipt from Operations or this
                URL.
              </p>
            ) : null}
          </>
        ) : null}
        {!canOperate ? (
          <p className="permission-notice">
            Your role can inspect this review. An owner or operator must apply
            or reconcile routing changes.
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {data?.operation ? "Close receipt" : "Close review"}
          </AlertDialogCancel>
          {onBack && !data?.operation ? (
            <Button variant="outline" disabled={busy} onClick={onBack}>
              Back to editing
            </Button>
          ) : null}
          {query.isError || (interrupted && !data?.operation) ? (
            <Button
              variant="outline"
              disabled={busy || query.isFetching}
              onClick={() => void checkReceipt()}
            >
              Check saved operation
            </Button>
          ) : null}
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
                !data.actorMatches ||
                provider?.status !== "ready" ||
                interrupted
              }
              onClick={() => void act(false)}
            >
              {busy ? "Applying..." : "Apply routing"}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
