import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import {
  dependabotChangeReviewSchema,
  type DependabotChangeReview,
} from "../shared/dependabot-changes";
import { dependabotOperationSchema } from "../shared/dependabot-operations";
import { dependencyWriteAccessSchema } from "../shared/dependency-changes";
import {
  dependabotScheduleLabel,
  type DependabotEdit,
  type DependabotInventoryRow,
} from "../shared/dependabot";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { DependencyOperationView } from "./dependency-operations";
import { scheduleMembers } from "./dependabot-editor";
import { useDateTime } from "./date-time";

export function DependabotPrepare({
  workspaceId,
  row,
  edits,
  onClose,
  onPrepared,
}: {
  workspaceId: string;
  row: DependabotInventoryRow;
  edits: DependabotEdit[];
  onClose: () => void;
  onPrepared: (review: DependabotChangeReview) => void;
}) {
  const [credentialId, setCredentialId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const access = useQuery({
    queryKey: ["dependency-access", workspaceId, row.repository.id],
    queryFn: async ({ signal }) =>
      dependencyWriteAccessSchema.parse(
        await command(
          "dependency_write_access",
          { workspaceId, repositoryId: row.repository.id },
          signal,
        ),
      ),
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const eligible =
    (access.error ? undefined : access.data)?.credentials.filter(
      (item) => item.writable && item.status === "available",
    ) ?? [];
  const selected =
    credentialId || (eligible.length === 1 ? eligible[0]!.id : "review-only");
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const e = row.result!.evidence!;
      onPrepared(
        dependabotChangeReviewSchema.parse(
          await command("dependabot_change_plan", {
            workspaceId,
            repositoryId: row.repository.id,
            sourceId: row.source!.id,
            headSha: e.headSha,
            fileDigest: e.file!.digest,
            edits,
            ...(selected !== "review-only" ? { credentialId: selected } : {}),
          }),
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The review could not be prepared. Your draft is preserved.",
      );
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
      <DialogContent className="schedule-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Review schedule changes</DialogTitle>
          <DialogDescription>
            {row.repository.fullName}. One pull request contains this
            repository's draft schedules.
          </DialogDescription>
        </DialogHeader>
        <ul className="schedule-change-list">
          {edits.map((edit) => {
            const entry = row.result!.evidence!.entries.find(
              (item) => item.id === edit.entryId,
            )!;
            return (
              <li key={edit.entryId}>
                <strong>{scheduleMembers(entry)}</strong>
                <p>Before: {dependabotScheduleLabel(entry.schedule)}</p>
                <p>After: {dependabotScheduleLabel(edit.schedule)}</p>
              </li>
            );
          })}
        </ul>
        <label>
          Repository write access
          <select
            value={selected}
            onChange={(event) => setCredentialId(event.target.value)}
            disabled={busy || access.isFetching}
          >
            <option value="review-only">Review only</option>
            {eligible.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {access.error ? (
          <p role="alert">
            Write access could not be checked. Retry before preparing a review
            with a writer.
          </p>
        ) : !access.isPending && !eligible.length ? (
          <p>
            No repository write credential is available. A workspace owner can
            configure scoped repository maintenance access. This review will not
            create a PR.
          </p>
        ) : null}
        <p className="dependency-meta">
          Overlaps are informational. Preparation verifies the exact file and
          saves an expiring review. GitHub is changed only after Create pull
          request.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="dependency-change-actions">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void prepare()}
            disabled={busy || access.isPending}
          >
            {busy ? "Preparing..." : "Prepare review"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function DependabotSavedReview({
  workspaceId,
  planId,
  now,
  overlaps,
  onSubmitted,
  repositoryName,
}: {
  workspaceId: string;
  planId: string;
  now: number;
  overlaps: (review: DependabotChangeReview) => string;
  onSubmitted: (repositoryId: string) => void;
  repositoryName: (repositoryId: string) => string | undefined;
}) {
  const [params, setParams] = useSearchParams();
  const cache = useQueryClient(),
    dates = useDateTime();
  const [busy, setBusy] = useState(false),
    [attempted, setAttempted] = useState(false),
    [error, setError] = useState("");
  const review = useQuery({
    queryKey: ["dependabot-review", workspaceId, planId],
    queryFn: async ({ signal }) =>
      dependabotChangeReviewSchema.parse(
        await command(
          "dependabot_change_review",
          { workspaceId, planId },
          signal,
        ),
      ),
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const operationKey = ["dependabot-operation", workspaceId, planId];
  const receipt = useQuery({
    queryKey: operationKey,
    queryFn: async ({ signal }) =>
      dependabotOperationSchema
        .nullable()
        .parse(
          await command(
            "dependabot_operation_get",
            { workspaceId, planId },
            signal,
          ),
        ),
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const r = review.error ? undefined : review.data,
    op = receipt.error ? undefined : receipt.data;
  const sharedReceipt = Boolean(
    !r &&
    op &&
    review.error instanceof RequestError &&
    review.error.status === 404,
  );
  const repository = op ? repositoryName(op.repositoryId) : undefined;
  async function apply() {
    if (busy || attempted || !r) return;
    setAttempted(true);
    setBusy(true);
    setError("");
    try {
      const result = dependabotOperationSchema.nullable().parse(
        await command("dependabot_change_apply", {
          workspaceId,
          planId,
          fingerprint: r.fingerprint,
        }),
      );
      cache.setQueryData(operationKey, result);
      if (result?.status === "succeeded") onSubmitted(r.basis.repository.id);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The response was lost. Check the saved receipt before another change.",
      );
      const recovered = await receipt.refetch();
      if (recovered.data?.status === "succeeded")
        onSubmitted(r.basis.repository.id);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      cache.setQueryData(
        operationKey,
        dependabotOperationSchema.nullable().parse(
          await command("dependabot_operation_reconcile", {
            workspaceId,
            planId,
          }),
        ),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The outcome could not be checked.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="schedule-review" aria-label="Saved schedule review">
      <div className="dependency-change-actions">
        <h2>Saved schedule review</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("scheduleReview");
            setParams(next);
          }}
        >
          Back to timeline
        </Button>
      </div>
      {review.isPending ? (
        <p role="status">Loading saved review...</p>
      ) : review.error ? (
        sharedReceipt ? (
          <p>
            Only the original identity can open this saved review. Its
            authorized operation receipt is shown below.
          </p>
        ) : (
          <p role="alert">{review.error.message}</p>
        )
      ) : null}
      {r ? (
        <>
          <h3>{r.basis.repository.fullName}</h3>
          <p>
            {r.basis.file.path} on {r.basis.branch}. Review expires{" "}
            {dates.dateTime(r.expiresAt)}.
          </p>
          <p className="dependency-meta">
            Base commit <code>{r.basis.headSha}</code>. Writer:{" "}
            {r.writer?.name ?? "Review only"}. Proposed YAML remains separate
            from observed schedules.
          </p>
          <ul className="schedule-change-list">
            {r.changes.map((change) => (
              <li key={change.before.id}>
                <strong>{scheduleMembers(change.before)}</strong>
                <p>Before: {dependabotScheduleLabel(change.before.schedule)}</p>
                <p>After: {dependabotScheduleLabel(change.after.schedule)}</p>
              </li>
            ))}
          </ul>
          <p role="status">{overlaps(r)}</p>
          {r.state !== "ready" || Date.parse(r.expiresAt) <= now ? (
            <p role="alert">
              This review is{" "}
              {Date.parse(r.expiresAt) <= now ? "expired" : r.state}. Refresh
              the schedules and prepare a fresh review.
            </p>
          ) : null}
          {!r.writer ? (
            <p>
              No write credential was selected. Prepare a new review with
              repository write access to create a PR.
            </p>
          ) : null}
          {receipt.isPending ? (
            <p role="status">Checking saved receipt...</p>
          ) : receipt.error ? (
            <p role="alert">
              The saved receipt could not be read. Check it before submitting.
            </p>
          ) : op ? (
            <DependencyOperationView
              label="Schedule operation outcome"
              operation={op}
              repository={r.basis.repository.fullName}
              now={now}
              busy={busy}
              onReconcile={() => void reconcile()}
            />
          ) : (
            <>
              <Button
                onClick={() => void apply()}
                disabled={
                  busy ||
                  attempted ||
                  !r.writer ||
                  r.state !== "ready" ||
                  Date.parse(r.expiresAt) <= now
                }
              >
                {busy ? "Submitting..." : "Create pull request"}
              </Button>
              {attempted ? (
                <p role="status">
                  Keep this review URL. Check the original receipt; do not start
                  another submission for an uncertain outcome.
                </p>
              ) : null}
            </>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void receipt.refetch()}
          >
            Check saved receipt
          </Button>
        </>
      ) : null}
      {sharedReceipt && op ? (
        <>
          {repository ? (
            <DependencyOperationView
              label="Schedule operation outcome"
              operation={op}
              repository={repository}
              now={now}
              busy={busy}
            />
          ) : (
            <p role="status">
              Recorded outcome: {op.status}. Operation reference: {op.id}. Open
              the workspace timeline to locate its repository links.
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => void receipt.refetch()}
            disabled={busy}
          >
            Check saved receipt
          </Button>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
const historySchema = z
  .object({
    items: z.array(dependabotOperationSchema).max(20),
    nextBefore: z.string().nullable(),
  })
  .strict();
export function DependabotHistory({
  workspaceId,
  repositoryId,
  onSelect,
}: {
  workspaceId: string;
  repositoryId: string;
  onSelect?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [params, setParams] = useSearchParams(),
    dates = useDateTime();
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: ["dependabot-history", workspaceId, repositoryId, before ?? null],
    queryFn: async ({ signal }) =>
      historySchema.parse(
        await command(
          "dependabot_operations_list",
          { workspaceId, repositoryId, ...(before ? { before } : {}) },
          signal,
        ),
      ),
    enabled: open,
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  return (
    <div className="schedule-history">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        PR history
      </Button>
      {open ? (
        <div>
          {query.isPending ? (
            <p role="status">Loading history...</p>
          ) : query.error ? (
            <p role="alert">{query.error.message}</p>
          ) : (
            <>
              <ul>
                {query.data?.items.map((op) => (
                  <li key={op.id}>
                    <Button
                      variant="link"
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        next.set("scheduleReview", op.planId);
                        onSelect?.();
                        setParams(next);
                      }}
                    >
                      {dates.dateTime(op.startedAt)}: {op.status}
                    </Button>
                  </li>
                ))}
              </ul>
              {!query.data?.items.length ? (
                <p>No schedule PR operations recorded.</p>
              ) : null}
              <div className="dependency-change-actions">
                <Button
                  variant="outline"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors((value) => value.slice(0, -1))}
                >
                  Previous history
                </Button>
                <Button
                  variant="outline"
                  disabled={!query.data?.nextBefore}
                  onClick={() =>
                    setCursors((value) => [...value, query.data!.nextBefore!])
                  }
                >
                  Next history
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
