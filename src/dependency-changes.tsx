import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  dependencyChangeReviewSchema,
  dependencyWriteAccessSchema,
  type DependencyChangeReview,
} from "../shared/dependency-changes";
import type { DependencyResult } from "../shared/dependencies";
import type { DependencyFinding } from "../shared/dependency-policy";
import { useDateTime } from "./date-time";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { dependencyOperationSchema } from "../shared/dependency-operations";
import { DependencyOperationView } from "./dependency-operations";

export function DependencyChangeEditor({
  workspaceId,
  result,
  finding,
  onClose,
  onPrepared,
  returnFocus,
}: {
  workspaceId: string;
  result: DependencyResult;
  finding: DependencyFinding;
  onClose: () => void;
  onPrepared: (review: DependencyChangeReview) => void;
  returnFocus: HTMLElement | null;
}) {
  const kind = finding.status === "unused" ? "remove" : "renew";
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState(finding.rule.owner);
  const [days, setDays] = useState("14");
  const [credentialId, setCredentialId] = useState("");
  const access = useQuery({
    queryKey: ["dependency-access", workspaceId, result.repository.id],
    queryFn: async ({ signal }) =>
      dependencyWriteAccessSchema.parse(
        await command(
          "dependency_write_access",
          { workspaceId, repositoryId: result.repository.id },
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prepared = useRef(false);
  const guard = useCloseGuard(
    Boolean(
      reason ||
      owner !== finding.rule.owner ||
      days !== "14" ||
      credentialId ||
      busy,
    ),
    onClose,
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    setBusy(true);
    setError("");
    try {
      const review = dependencyChangeReviewSchema.parse(
        await command("dependency_change_plan", {
          workspaceId,
          repositoryId: result.repository.id,
          sourceId: result.source.id,
          ...(result.evidence!.pullNumber
            ? { pullNumber: result.evidence!.pullNumber }
            : {}),
          headSha: result.evidence!.headSha,
          policyDigest: result.evidence!.report!.policyDigest,
          overrideId: finding.rule.id,
          ...(selected !== "review-only" ? { credentialId: selected } : {}),
          change:
            kind === "remove"
              ? { kind, reason }
              : { kind, reason, owner, reviewDays: Number(days) },
        }),
      );
      prepared.current = true;
      guard.saved();
      onPrepared(review);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The review could not be prepared. Your draft is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="dependency-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!prepared.current) returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {kind === "remove"
                ? "Review override cleanup"
                : "Review override renewal"}
            </DialogTitle>
            <DialogDescription>
              {finding.rule.package} through {finding.rule.parent}. Preparing
              this review does not change the repository.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="dependency-change-form">
            <fieldset disabled={busy}>
              <label>
                Reason for {kind === "remove" ? "removing" : "keeping"} this
                override
                <Textarea
                  required
                  minLength={20}
                  maxLength={800}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={
                    kind === "remove"
                      ? "Explain the adopted upstream change and why this override is no longer needed"
                      : "Explain why the repository still needs this override"
                  }
                />
              </label>
              <div className="dependency-source">
                <label htmlFor="dependency-writer">
                  Repository write access
                </label>
                <Select
                  value={selected}
                  onValueChange={setCredentialId}
                  disabled={busy || access.isPending}
                >
                  <SelectTrigger id="dependency-writer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="review-only">
                      Prepare review only
                    </SelectItem>
                    {eligible.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {access.isPending ? (
                  <p role="status">Checking repository write access...</p>
                ) : selected === "review-only" ? (
                  <p className="dependency-meta">
                    This review cannot submit a PR. A workspace owner can{" "}
                    <a
                      className="quiet-link"
                      target="_blank"
                      rel="noreferrer"
                      href={
                        "/dependencies?" +
                        new URLSearchParams({
                          workspace: workspaceId,
                          view: "access",
                        })
                      }
                    >
                      set up dedicated write access
                    </a>
                    .
                  </p>
                ) : (
                  <p className="dependency-meta">
                    The next screen confirms this credential and exact change
                    before creating a new branch and PR. Nothing is merged.
                  </p>
                )}
                {access.error ? (
                  <p role="alert">
                    Write access could not be loaded. You can still prepare a
                    review without submission.
                  </p>
                ) : null}
              </div>
              {kind === "renew" ? (
                <>
                  <label>
                    Responsible maintainer
                    <Input
                      required
                      maxLength={80}
                      value={owner}
                      onChange={(event) => setOwner(event.target.value)}
                    />
                  </label>
                  <label>
                    Review again in days
                    <Input
                      required
                      type="number"
                      min={1}
                      max={30}
                      value={days}
                      onChange={(event) => setDays(event.target.value)}
                    />
                  </label>
                  <p className="dependency-meta">
                    The review window cannot exceed 30 days. The confirmation
                    shows the exact deadline in your preferred time zone.
                  </p>
                </>
              ) : (
                <p>
                  The cleanup removes only this exact npm override and marks its
                  policy record removed. The advisory guard remains in CI.
                </p>
              )}
            </fieldset>
            {error ? <p role="alert">{error}</p> : null}
            <div className="dependency-change-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || access.isPending}>
                {busy ? "Preparing..." : "Prepare review"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
export function DependencyReviewPanel({
  workspaceId,
  repositoryId,
  repositoryName,
  planId,
  now,
  onClose,
}: {
  workspaceId: string;
  repositoryId: string;
  repositoryName: string;
  planId: string;
  now: number;
  onClose: () => void;
}) {
  const dates = useDateTime();
  const cache = useQueryClient();
  const operationKey = ["dependency-operation", workspaceId, planId];
  const mutation = useMutation({
    mutationFn: async (request: {
      name: "dependency_change_apply" | "dependency_operation_reconcile";
      input: { workspaceId: string; planId: string; fingerprint?: string };
    }) =>
      dependencyOperationSchema
        .nullable()
        .parse(await command(request.name, request.input)),
    onMutate: async (request) => {
      await cache.cancelQueries({
        queryKey: [
          "dependency-operation",
          request.input.workspaceId,
          request.input.planId,
        ],
      });
    },
    onSuccess: (data, request) => {
      cache.setQueryData(
        [
          "dependency-operation",
          request.input.workspaceId,
          request.input.planId,
        ],
        data,
      );
      void cache.invalidateQueries({
        queryKey: ["dependency-history", request.input.workspaceId],
      });
    },
  });
  const operationQuery = useQuery({
    queryKey: operationKey,
    queryFn: async ({ signal }) =>
      dependencyOperationSchema
        .nullable()
        .parse(
          await command(
            "dependency_operation_get",
            { workspaceId, planId },
            signal,
          ),
        ),
    enabled: !mutation.isPending,
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const operation =
    operationQuery.error || operationQuery.data?.repositoryId !== repositoryId
      ? undefined
      : operationQuery.data;
  const verifiedEmpty =
    operationQuery.isSuccess && operationQuery.data === null && !mutation.error;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [planId]);
  const query = useQuery({
    queryKey: ["dependency-review", workspaceId, planId],
    queryFn: async ({ signal }) =>
      dependencyChangeReviewSchema.parse(
        await command(
          "dependency_change_review",
          { workspaceId, planId },
          signal,
        ),
      ),
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const hidden =
    query.error instanceof RequestError &&
    [401, 403, 404, 409].includes(query.error.status);
  const review =
    !hidden && query.data?.basis.repository.id === repositoryId
      ? query.data
      : undefined;
  const expired =
    review &&
    (review.state === "expired" || Date.parse(review.expiresAt) <= now);
  return (
    <section
      className="dependency-finding"
      aria-label="Dependency change review"
    >
      <div className="dependency-toolbar">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Dependency change review
          </h2>
          <p>
            {operation
              ? "Saved repository operation and outcome."
              : verifiedEmpty
                ? "Prepared change, not submitted to GitHub."
                : "Submission state is not verified. Reload the saved outcome before taking action."}
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" />
          Dependencies
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Loading your saved review...</p>
      ) : null}
      {query.error ? (
        <p role="alert">
          {query.error instanceof Error
            ? query.error.message
            : "Review unavailable"}
        </p>
      ) : null}
      {operationQuery.error || mutation.error ? (
        <p role="alert">
          {String(
            (operationQuery.error ?? mutation.error)?.message ??
              "Operation unavailable",
          )}{" "}
          Check the saved outcome before repeating an action.
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={operationQuery.isFetching || mutation.isPending}
        onClick={async () => {
          const result = await operationQuery.refetch();
          if (!result.error) mutation.reset();
        }}
      >
        Reload saved outcome
      </Button>
      {query.data && !hidden && !review ? (
        <p role="alert">
          This review belongs to a different repository. Open it from the
          original repository.
        </p>
      ) : null}
      {review ? (
        <>
          <Badge
            variant={
              !operation && (expired || review.state === "stale")
                ? "destructive"
                : "outline"
            }
          >
            {operation
              ? "Submitted review"
              : expired
                ? "Review expired"
                : review.state === "stale"
                  ? "Access or source changed"
                  : "Ready for confirmation"}
          </Badge>
          <dl className="dependency-facts">
            <div>
              <dt>Write access</dt>
              <dd>
                {review.writer
                  ? review.writer.name + " / revision " + review.writer.revision
                  : "Review only, no repository write access"}
              </dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>{review.basis.repository.fullName}</dd>
            </div>
            <div>
              <dt>Base commit</dt>
              <dd>
                <code title={review.basis.headSha}>
                  {review.basis.headSha.slice(0, 12)}
                </code>{" "}
                on {review.basis.branch}
                {review.basis.pullNumber
                  ? " (PR #" + review.basis.pullNumber + " head branch)"
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Prepared by</dt>
              <dd>{review.actor}</dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>{dates.dateTime(review.expiresAt)}</dd>
            </div>
          </dl>
          <h3>
            {review.change.kind === "remove" ? "Remove" : "Renew"}{" "}
            {review.before.package} override
          </h3>
          <div className="dependency-diff">
            <div>
              <h4>Before</h4>
              <p>{review.before.reason}</p>
              <p>{review.before.owner}</p>
              <p>Review by {dates.dateTime(review.before.reviewBy)}</p>
              <Badge variant="outline">{review.before.lifecycle}</Badge>
            </div>
            <div>
              <h4>After</h4>
              <p>{review.after.reason}</p>
              <p>{review.after.owner}</p>
              {review.after.lifecycle === "active" ? (
                <p>Review by {dates.dateTime(review.after.reviewBy)}</p>
              ) : (
                <p>
                  Remove the version-scoped override. Keep the advisory
                  regression check.
                </p>
              )}
              <Badge variant="outline">{review.after.lifecycle}</Badge>
            </div>
          </div>
          <p className="dependency-meta">
            {operation
              ? "A PR is not an adopted fix. Check its CI and merge outcome, then inspect the destination branch again."
              : verifiedEmpty
                ? "Preparing this review has not changed repository files, package versions, or CI results."
                : "A submission may have succeeded even if its response was lost. Inspect the same saved operation."}
          </p>
          {!operation && review.writer ? (
            <div>
              <p className="dependency-meta">
                Creates a new branch from the reviewed commit and a pull request
                targeting {review.basis.branch}. It does not merge, install
                packages, run repository scripts, or grant additional
                permissions.
              </p>
              <Button
                disabled={
                  expired ||
                  review.state !== "ready" ||
                  query.isFetching ||
                  operationQuery.isPending ||
                  Boolean(operationQuery.error) ||
                  !verifiedEmpty ||
                  mutation.isPending
                }
                onClick={() =>
                  mutation.mutate({
                    name: "dependency_change_apply",
                    input: {
                      workspaceId,
                      planId,
                      fingerprint: review.fingerprint,
                    },
                  })
                }
              >
                {mutation.isPending ? "Submitting..." : "Create pull request"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {operation ? (
        <DependencyOperationView
          operation={operation}
          repository={repositoryName}
          now={now}
          busy={mutation.isPending}
          onReconcile={
            review
              ? () =>
                  mutation.mutate({
                    name: "dependency_operation_reconcile",
                    input: { workspaceId, planId },
                  })
              : undefined
          }
        />
      ) : null}
    </section>
  );
}
