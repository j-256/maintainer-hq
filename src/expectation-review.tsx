import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import {
  EXPECTATION_REVIEW_LIMITS,
  type ExpectationReviewReceipt,
} from "../shared/expectation-review";
import { command, RequestError } from "./lib/api";
import { pendingReview } from "./lib/pending-review";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { HookError, HookTime } from "./hook-components";
import {
  DiscardDialog,
  useCloseGuard,
  SOURCE_REQUEST_TIMEOUT_MS,
} from "./source-editor";
import { ResolutionDialog, useResolutionNavigation } from "./expectation-flow";

type Request = {
  workspaceId: string;
  repositoryId: string;
  reviewId: string;
  revision: number;
  outcome: string;
  nextReviewDate: string | null;
};
export function RepositoryReviewResolution({
  repository,
  snapshot,
  onBack,
  onCompleted,
}: {
  repository: Repository;
  snapshot: Snapshot;
  onBack: () => void;
  onCompleted?: (receipt: ExpectationReviewReceipt) => void;
}) {
  const { params, navigate } = useResolutionNavigation();
  const workspaceId = snapshot.workspace.id;
  const reviewId = params.get("completedReview");
  const [outcome, setOutcome] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(() =>
    Boolean(
      reviewId && pendingReview("repository-review", workspaceId, reviewId),
    ),
  );
  const attempt = useRef<Request | null>(null);
  const reported = useRef<string | null>(null);
  const client = useQueryClient();
  const key = ["repository-review", workspaceId, repository.id, reviewId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<ExpectationReviewReceipt>(
        "expectation_review_get",
        { workspaceId, repositoryId: repository.id, reviewId },
        signal,
      ),
    enabled: Boolean(reviewId) && !busy,
    retry: false,
  });
  const guard = useCloseGuard(
    !query.data && (Boolean(outcome.trim() || date) || busy || uncertain),
    onBack,
    (current, next) => {
      if (current.pathname !== next.pathname) return false;
      const from = new URLSearchParams(current.search),
        to = new URLSearchParams(next.search);
      from.delete("completedReview");
      to.delete("completedReview");
      return from.toString() === to.toString();
    },
  );
  useEffect(() => {
    if (!query.data || reported.current === query.data.reviewId) return;
    reported.current = query.data.reviewId;
    pendingReview("repository-review", workspaceId, query.data.reviewId, false);
    setUncertain(false);
    setError(null);
    onCompleted?.(query.data);
  }, [query.data, onCompleted, workspaceId]);
  async function submit(retry = false) {
    if (busy) return;
    const fields = retry
      ? attempt.current
      : {
          workspaceId,
          repositoryId: repository.id,
          reviewId: crypto.randomUUID(),
          revision: repository.revision,
          outcome: outcome.trim(),
          nextReviewDate: date || null,
        };
    if (!fields) return;
    attempt.current = fields;
    setBusy(true);
    setError(null);
    setUncertain(true);
    pendingReview("repository-review", workspaceId, fields.reviewId, true);
    navigate({ completedReview: fields.reviewId });
    try {
      const receipt = await command<ExpectationReviewReceipt>(
        "expectation_review_complete",
        fields,
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(
        ["repository-review", workspaceId, repository.id, fields.reviewId],
        receipt,
      );
      pendingReview("repository-review", workspaceId, fields.reviewId, false);
      setUncertain(false);
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    } catch (failure) {
      setError(failure);
      if (
        failure instanceof RequestError &&
        [400, 403, 404, 409].includes(failure.status)
      ) {
        pendingReview("repository-review", workspaceId, fields.reviewId, false);
        setUncertain(false);
        navigate({ completedReview: null });
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ResolutionDialog
        kind="review"
        repository={repository}
        onBack={guard.requestClose}
        busy={busy}
      >
        {query.data ? (
          <section className="resolution-card">
            <h3>Review completed</h3>
            <p className="resolution-outcome">{query.data.outcome}</p>
            <p>
              Completed <HookTime value={query.data.completedAt} />.
            </p>
            <p>
              {query.data.nextReviewDate
                ? "Next review: " + query.data.nextReviewDate
                : "No next review scheduled."}
            </p>
            <p>
              The outcome is recorded in repository and project Activity. CI,
              security, hooks, and monitoring still use their own observed
              evidence.
            </p>
          </section>
        ) : (
          <>
            <p>
              Record what you checked and any follow-up work. Completing this
              review updates its date and keeps the outcome in Activity.
            </p>
            <p>
              Saved review date: {repository.expectations.reviewDate ?? "None"}
            </p>
            {reviewId ? (
              <section className="resolution-card">
                <h3>
                  {query.isPending
                    ? "Checking saved review..."
                    : "Completion not confirmed"}
                </h3>
                <p>
                  Keep this review URL to recover its result. An unavailable
                  receipt does not prove the request failed.
                </p>
                <div className="resolution-actions">
                  <Button
                    variant="outline"
                    disabled={busy || query.isFetching}
                    onClick={() => void query.refetch()}
                  >
                    Check saved review
                  </Button>
                  {attempt.current && uncertain ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void submit(true)}
                    >
                      Retry same review
                    </Button>
                  ) : null}
                </div>
                {query.error &&
                !(
                  query.error instanceof RequestError &&
                  query.error.status === 404
                ) ? (
                  <HookError error={query.error} />
                ) : null}
              </section>
            ) : null}
            <form
              className="hook-resolution-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <fieldset
                className="hook-resolution-stack"
                disabled={
                  busy ||
                  uncertain ||
                  Boolean(reviewId) ||
                  !snapshot.capabilities.includes(CAPABILITY.EDIT)
                }
              >
                <label className="resolution-field" htmlFor="review-outcome">
                  Review outcome
                  <Textarea
                    id="review-outcome"
                    required
                    maxLength={EXPECTATION_REVIEW_LIMITS.OUTCOME_CHARACTERS}
                    value={outcome}
                    onChange={(event) => setOutcome(event.target.value)}
                    placeholder="What was checked, decisions made, and follow-up work"
                  />
                </label>
                <label className="resolution-field" htmlFor="next-review-date">
                  Next review date (optional)
                  <Input
                    id="next-review-date"
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </label>
                <Button type="submit" disabled={!outcome.trim()}>
                  Complete review
                </Button>
              </fieldset>
              {!snapshot.capabilities.includes(CAPABILITY.EDIT) ? (
                <p>
                  Your workspace role can read reviews but cannot record an
                  outcome.
                </p>
              ) : null}
            </form>
          </>
        )}
        {error ? <HookError error={error} /> : null}
      </ResolutionDialog>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
