import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  type MonitorReview,
  type MonitorDefaults,
  type MonitorTarget,
} from "../shared/monitoring";
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
  MonitorError,
  MonitorTime,
  MonitorTargetFacts,
} from "./monitoring-components";
import { restoreHookFocus } from "./hook-components";
import { RESOURCE_REQUEST_TIMEOUT_MS } from "./resource-repositories";

export function MonitorDefaultsFacts({ value }: { value: MonitorDefaults }) {
  return (
    <dl className="monitor-target-facts">
      <div>
        <dt>Probe interval</dt>
        <dd>Every {value.probeIntervalMinutes} minutes</dd>
      </div>
      <div>
        <dt>New target method</dt>
        <dd>{value.method}</dd>
      </div>
      <div>
        <dt>Failure / recovery threshold</dt>
        <dd>
          {value.failureThreshold} / {value.recoveryThreshold}
        </dd>
      </div>
      <div>
        <dt>Default timeout</dt>
        <dd>{value.timeoutMilliseconds / 1000} seconds</dd>
      </div>
    </dl>
  );
}
export function MonitoringReview({
  snapshot,
  planId,
  onClose,
  returnFocus,
  onOperation,
}: {
  snapshot: Snapshot;
  planId: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  onOperation?: (id: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const result = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["monitoring", workspaceId, "review", planId],
    queryFn: ({ signal }) =>
      command<MonitorReview>(
        "monitoring_review",
        { workspaceId, planId },
        signal,
      ),
  });
  const data = query.data;
  const operationId = data?.operation?.id;
  useEffect(() => {
    if (operationId) result.current?.focus();
  }, [operationId]);
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const uncertain = Boolean(
    data?.operation &&
    ["pending", "running", "indeterminate"].includes(data.operation.status),
  );
  const expired = Boolean(
    data &&
    (Date.parse(data.expiresAt) <= Date.now() ||
      (data.provider && Date.parse(data.provider.expiresAt) <= Date.now())),
  );
  async function act(reconcile: boolean) {
    if (busy || !data) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await command<MonitorReview>(
        reconcile ? "monitoring_reconcile" : "monitoring_apply",
        {
          workspaceId,
          planId,
          ...(reconcile ? {} : { fingerprint: data.fingerprint }),
        },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(
        ["monitoring", workspaceId, "review", planId],
        updated,
      );
      void client.invalidateQueries({ queryKey: ["monitoring", workspaceId] });
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      if (updated.operation) onOperation?.(planId);
    } catch (failure) {
      setError(failure);
      const latest = await query.refetch();
      if (latest.data?.operation) onOperation?.(planId);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        result.current?.focus();
        result.current?.scrollIntoView({ block: "start" });
      });
    }
  }
  return (
    <AlertDialog open>
      <AlertDialogContent
        className="monitor-review-dialog"
        onOpenAutoFocus={(event) => {
          if (result.current) {
            event.preventDefault();
            result.current.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreHookFocus(returnFocus);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {data?.operation
              ? "Monitoring operation receipt"
              : "Review monitoring change"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Review the exact effect before confirming. Provider acceptance is
            separate from endpoint health and notification delivery.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div
          className="monitor-review-body"
          role="region"
          aria-label="Monitoring review details"
          tabIndex={0}
        >
          {query.isPending ? <p role="status">Loading review...</p> : null}
          {query.error || error ? (
            <>
              <MonitorError error={error ?? query.error} />
              <Button
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => {
                  setError(null);
                  void query.refetch();
                }}
              >
                Reload receipt
              </Button>
            </>
          ) : null}
          {data ? (
            <>
              {data.operation ? (
                <div
                  className="hook-notice"
                  role="status"
                  aria-label="Monitoring operation result"
                  ref={result}
                  tabIndex={-1}
                >
                  <strong>
                    {data.operation.status === "succeeded"
                      ? "Accepted"
                      : data.operation.status === "failed"
                        ? "Not accepted"
                        : "Needs reconciliation"}
                  </strong>
                  <p>{data.operation.summary}</p>
                  <MonitorTime value={data.operation.updatedAt} />
                </div>
              ) : null}
              <p className="hook-muted">
                {data.connectionName}. Review expires{" "}
                <MonitorTime value={data.expiresAt} />.
              </p>
              {data.change ? (
                <div className="monitor-review-comparison">
                  <section>
                    <h3>Before</h3>
                    {data.before ? (
                      data.change.kind === "defaults" ? (
                        <MonitorDefaultsFacts
                          value={data.before as MonitorDefaults}
                        />
                      ) : (
                        <MonitorTargetFacts
                          target={data.before as MonitorTarget}
                        />
                      )
                    ) : (
                      <p>No target configured</p>
                    )}
                  </section>
                  <section>
                    <h3>
                      {data.change.kind === "target" &&
                      data.change.action === "remove"
                        ? "After removal"
                        : "After confirmation"}
                    </h3>
                    {data.change.kind === "defaults" ? (
                      <MonitorDefaultsFacts value={data.change.defaults} />
                    ) : data.change.target ? (
                      <MonitorTargetFacts target={data.change.target} />
                    ) : (
                      <p>
                        This target will leave the executing configuration. Its
                        repository links and historical activity remain for
                        context.
                      </p>
                    )}
                  </section>
                </div>
              ) : null}
              {data.provider?.kind === "configuration" ? (
                <p className="hook-notice">
                  Configuration revision{" "}
                  {"expectedRevision" in data.provider.preview
                    ? data.provider.preview.expectedRevision
                    : ""}{" "}
                  will be checked again. Changes apply to future invocations,
                  not probes already running. Removing or changing a target can
                  suppress its old incident without establishing recovery.{" "}
                  {data.change?.kind === "defaults"
                    ? "The probe interval affects every target. Other defaults apply to new targets; existing explicit target settings remain unchanged."
                    : "Other target definitions remain unchanged."}
                </p>
              ) : null}
              {data.provider && "action" in data.provider.preview ? (
                <section className="hook-notice">
                  <h3>
                    {data.provider.preview.action === "acknowledged"
                      ? "Acknowledge incident"
                      : data.provider.preview.action === "snoozed"
                        ? "Snooze notifications"
                        : "Dismiss incident"}
                  </h3>
                  <p>
                    {data.provider.preview.targetId} /{" "}
                    {data.provider.preview.incidentId}
                  </p>
                  <p>
                    {data.provider.preview.action === "acknowledged"
                      ? "Record that this incident has your attention. Probes and notifications continue."
                      : data.provider.preview.action === "snoozed"
                        ? "Delay pending problem notifications. Probes continue, and sent messages cannot be retracted."
                        : "Resolve this incident by operator decision, not observed recovery. Persistent failures can open another incident."}
                  </p>
                  {data.provider.preview.until ? (
                    <p>
                      Until <MonitorTime value={data.provider.preview.until} />
                    </p>
                  ) : null}
                  {data.provider.preview.note ? (
                    <p>Note: {data.provider.preview.note}</p>
                  ) : null}
                </section>
              ) : null}
              {!data.operation && expired ? (
                <p className="permission-notice">
                  This review expired. Return to the form and prepare a new
                  review from saved provider state.
                </p>
              ) : null}
              {!data.operation && !data.provider ? (
                <p className="permission-notice">
                  The provider review did not finish. Keep the original form and
                  retry preparing it before confirmation.
                </p>
              ) : null}
              {!data.operation && !data.actorMatches ? (
                <p className="permission-notice">
                  Only the person and credential that prepared this review can
                  confirm it.
                </p>
              ) : null}
            </>
          ) : null}
          {!canOperate ? (
            <p className="permission-notice">
              Your role can inspect receipts but cannot confirm or reconcile
              provider operations.
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onClose}>
            {data?.operation
              ? "Close receipt"
              : onOperation
                ? "Back to form"
                : "Cancel"}
          </AlertDialogCancel>
          {canOperate && uncertain ? (
            <Button
              disabled={busy || query.isError}
              onClick={() => void act(true)}
            >
              {busy ? "Reconciling..." : "Reconcile with provider"}
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
              {busy ? "Submitting..." : "Confirm change"}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
