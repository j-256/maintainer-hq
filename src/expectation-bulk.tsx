import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Location } from "react-router-dom";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import {
  EXPECTATION_BULK_LIMITS,
  EXPECTATION_KEYS,
  EXPECTATION_PRESETS,
  EXPECTATION_REVIEW_PARAM,
  changedExpectationFields,
  expectationBulkPlanInput,
  patchExpectations,
  type ExpectationBulkReview,
  type ExpectationBulkReceipt,
  type ExpectationBulkRow,
  type ExpectationPatch,
} from "../shared/expectation-bulk";
import {
  CLASSIFICATION_LABELS,
  REQUIREMENT_LABELS,
} from "../shared/presentation";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { BULK_FIELD_LABELS, ExpectationFields } from "./expectation-fields";
import { command, RequestError } from "./lib/api";
import { pendingReview } from "./lib/pending-review";
import { useDateTime } from "./date-time";
import "./expectation-bulk.css";

type Selection = Pick<
  Repository,
  "id" | "fullName" | "expectations" | "revision"
>;
const timeout = () =>
  AbortSignal.timeout(EXPECTATION_BULK_LIMITS.REQUEST_TIMEOUT_MS);
const repositoryLabel = (count: number) =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;
function ownReviewNavigation(current: Location, next: Location) {
  const a = new URLSearchParams(current.search);
  const b = new URLSearchParams(next.search);
  a.delete(EXPECTATION_REVIEW_PARAM);
  b.delete(EXPECTATION_REVIEW_PARAM);
  return current.pathname === next.pathname && a.toString() === b.toString();
}

function Changes({ row }: { row: ExpectationBulkRow }) {
  const { calendarDate } = useDateTime();
  const display = (key: (typeof row.changed)[number], value: string | null) =>
    key === "reviewDate"
      ? calendarDate(value)
      : value === ""
        ? "Empty note"
        : value === null
          ? "None"
          : (REQUIREMENT_LABELS[value as keyof typeof REQUIREMENT_LABELS] ??
            value);
  return row.changed.length ? (
    <dl className="expectation-diff">
      {row.changed.map((key) => (
        <div key={key}>
          <dt>{BULK_FIELD_LABELS[key]}</dt>
          <dd>
            <span className="expectation-before">
              <span className="sr-only">Before: </span>
              {display(key, row.before[key])}
            </span>
            <span aria-hidden="true"> to </span>
            <span className="sr-only">After: </span>
            <strong>{display(key, row.after[key])}</strong>
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="expectation-muted">
      Already matches. No change will be made.
    </p>
  );
}

export function ExpectationBulkEditor({
  snapshot,
  initialReviewId,
  onReview,
  onClose,
  returnFocus,
  projectId,
}: {
  snapshot: Snapshot;
  initialReviewId: string | null;
  onReview: (id: string | null) => void;
  onClose: () => void;
  returnFocus: HTMLButtonElement | null;
  projectId?: string;
}) {
  const workspaceId = snapshot.workspace.id;
  const pending = (planId: string, value?: boolean) =>
    pendingReview("expectations", workspaceId, planId, value);
  const [step, setStep] = useState<"select" | "configure" | "review">(
    initialReviewId ? "review" : "select",
  );
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [patch, setPatch] = useState<ExpectationPatch>({});
  const [exceptions, setExceptions] = useState<
    Record<string, ExpectationPatch>
  >({});
  const [search, setSearch] = useState("");
  const [tracking, setTracking] = useState("all");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<ExpectationBulkReview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const initialId = useRef(initialReviewId);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const cache = useQueryClient();
  const { dateTime } = useDateTime();
  const receipt = review?.receipt;
  const allowed = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const selected = Object.values(selection).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
  const guard = useCloseGuard(
    !receipt && (selected.length > 0 || Boolean(review) || busy || uncertain),
    onClose,
    ownReviewNavigation,
  );
  const candidates = snapshot.repositories
    .filter(
      (repo) =>
        (archived || repo.lifecycle === "active") &&
        (!projectId || repo.projectId === projectId) &&
        (tracking === "all" || repo.classification === tracking) &&
        repo.fullName.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const pageCount = Math.max(
    1,
    Math.ceil(candidates.length / EXPECTATION_BULK_LIMITS.PAGE_SIZE),
  );
  const visiblePage = Math.min(page, pageCount);
  const visible = candidates.slice(
    (visiblePage - 1) * EXPECTATION_BULK_LIMITS.PAGE_SIZE,
    visiblePage * EXPECTATION_BULK_LIMITS.PAGE_SIZE,
  );
  const roomForPage =
    selected.length + visible.filter((row) => !selection[row.id]).length <=
    EXPECTATION_BULK_LIMITS.REPOSITORIES;
  const roomForMatches =
    selected.length + candidates.filter((row) => !selection[row.id]).length <=
    EXPECTATION_BULK_LIMITS.REPOSITORIES;
  const selectedPreset = EXPECTATION_PRESETS.find((preset) =>
    EXPECTATION_KEYS.every(
      (key) => patch[key] === (preset.patch as ExpectationPatch)[key],
    ),
  );
  const changedSinceSelection = selected.some(
    (row) =>
      snapshot.repositories.find((repo) => repo.id === row.id)?.revision !==
      row.revision,
  );
  const expired = Boolean(review && Date.parse(review.expiresAt) <= now);
  const rows = selected.map((repo): ExpectationBulkRow => {
    const after = patchExpectations(repo.expectations, {
      ...patch,
      ...exceptions[repo.id],
    });
    return {
      repositoryId: repo.id,
      fullName: repo.fullName,
      revision: repo.revision,
      before: repo.expectations,
      after,
      changed: changedExpectationFields(repo.expectations, after),
    };
  });
  const fields = {
    workspaceId,
    repositories: selected.map((repo) => ({
      repositoryId: repo.id,
      revision: repo.revision,
      patch: { ...patch, ...exceptions[repo.id] },
    })),
  };
  const valid = expectationBulkPlanInput.safeParse(fields);
  const reviewChanged =
    review?.rows.filter((row) => row.changed.length).length ?? 0;

  function hydrate(next: ExpectationBulkReview) {
    setReview(next);
    setSelection(
      Object.fromEntries(
        next.rows.map((row) => [
          row.repositoryId,
          {
            id: row.repositoryId,
            fullName: row.fullName,
            expectations: row.before,
            revision: row.revision,
          },
        ]),
      ),
    );
    setPatch({});
    setExceptions(
      Object.fromEntries(
        next.fields.repositories.map((row) => [row.repositoryId, row.patch]),
      ),
    );
    setStep("review");
    setNow(Date.now());
    setUncertain(!next.receipt && (uncertain || pending(next.planId)));
    if (next.receipt) pending(next.planId, false);
  }
  useEffect(() => {
    if (!initialId.current) return;
    const abort = new AbortController();
    setBusy(true);
    command<ExpectationBulkReview>(
      "expectations_review",
      { workspaceId, planId: initialId.current },
      AbortSignal.any([abort.signal, timeout()]),
    )
      .then((next) => {
        if (!abort.signal.aborted) hydrate(next);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "The saved review could not be loaded. Try again.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [workspaceId]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    scroll.current?.scrollTo({ top: 0 });
  }, [step, Boolean(receipt)]);
  useEffect(() => {
    if (!review || receipt) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(review.expiresAt) - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [review, receipt]);

  function select(repo: Repository, checked: boolean) {
    setSelection((previous) => {
      const next = { ...previous };
      if (
        checked &&
        Object.keys(next).length < EXPECTATION_BULK_LIMITS.REPOSITORIES
      )
        next[repo.id] = repo;
      else if (!checked) delete next[repo.id];
      return next;
    });
  }
  function refreshWorkspace() {
    void cache.invalidateQueries({ queryKey: ["workspace", workspaceId] });
  }
  async function prepare() {
    if (busy || !valid.success) return;
    setBusy(true);
    setError("");
    try {
      const next = await command<ExpectationBulkReview>(
        "expectations_plan",
        valid.data,
        timeout(),
      );
      setReview(next);
      setStep("review");
      setNow(Date.now());
      onReview(next.planId);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The review could not be prepared. Your choices are still here.",
      );
      refreshWorkspace();
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    const id = review?.planId ?? initialId.current;
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await command<ExpectationBulkReview>(
        "expectations_review",
        { workspaceId, planId: id },
        timeout(),
      );
      hydrate(next);
      if (uncertain && !next.receipt)
        setError(
          "No receipt has arrived yet. Retry this same review or check again; an earlier Apply request may still finish.",
        );
      refreshWorkspace();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The saved receipt could not be checked. Keep this review open and retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    pending(review.planId, true);
    setUncertain(true);
    try {
      const saved = await command<ExpectationBulkReceipt>(
        "expectations_apply",
        {
          workspaceId,
          planId: review.planId,
          fingerprint: review.fingerprint,
        },
        timeout(),
      );
      setReview({ ...review, state: "applied", receipt: saved });
      pending(review.planId, false);
      setUncertain(false);
    } catch (error) {
      const rejected = error instanceof RequestError && error.status === 409;
      if (rejected) pending(review.planId, false);
      setUncertain(!rejected);
      setError(
        (error instanceof Error
          ? error.message
          : "The Apply response was interrupted.") +
          (!rejected
            ? " Check the saved receipt or retry this same review. Do not start another batch until its outcome is known."
            : ""),
      );
      if (rejected) setReview({ ...review, state: "stale" });
    } finally {
      setBusy(false);
      refreshWorkspace();
    }
  }
  function edit() {
    setReview(null);
    setError("");
    setStep("configure");
    onReview(null);
  }
  function updateBaselines() {
    setSelection((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, row]) => [
          id,
          snapshot.repositories.find((repo) => repo.id === id) ?? row,
        ]),
      ),
    );
    setError("");
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
          className="expectation-dialog"
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus?.isConnected) returnFocus.focus();
            else
              document.querySelector<HTMLElement>("main h1,main h2")?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle ref={heading} tabIndex={-1}>
              {receipt
                ? "Expectations updated"
                : step === "review"
                  ? "Review expectation changes"
                  : "Set expectations"}
            </DialogTitle>
            <DialogDescription>
              {receipt ? "Changes saved." : "Nothing changes until Apply."}
            </DialogDescription>
            {!receipt ? (
              <p className="expectation-steps">
                {step === "select"
                  ? "1. Select repositories"
                  : step === "configure"
                    ? "2. Choose changes and exceptions"
                    : "3. Review and apply"}
              </p>
            ) : null}
          </DialogHeader>
          <div className="expectation-scroll" ref={scroll} aria-busy={busy}>
            <fieldset
              className="expectation-content"
              disabled={busy || !allowed}
            >
              {error ? (
                <p role="alert" className="field-error">
                  {error}
                </p>
              ) : null}
              {!allowed ? (
                <p role="alert">
                  Your workspace access no longer permits expectation changes.
                  Your draft is preserved, but Apply is unavailable.
                </p>
              ) : null}
              {receipt ? (
                <section className="expectation-stack">
                  <p role="status">
                    {repositoryLabel(receipt.changedRepositoryIds.length)}{" "}
                    updated. {receipt.unchangedRepositoryIds.length} already
                    matched and were left unchanged.
                  </p>
                  <p>Applied {dateTime(receipt.appliedAt)}.</p>
                  <p className="expectation-muted">
                    This page URL reopens the saved review and receipt for the
                    same identity.
                  </p>
                  {review?.rows.map((row) => (
                    <article className="expectation-row" key={row.repositoryId}>
                      <h3>{row.fullName}</h3>
                      <Changes row={row} />
                    </article>
                  ))}
                </section>
              ) : step === "select" ? (
                <>
                  <div className="expectation-selection-controls">
                    <Input
                      aria-label="Find repositories to change"
                      placeholder="Find repositories..."
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setPage(1);
                      }}
                    />
                    <Select
                      value={tracking}
                      onValueChange={(value) => {
                        setTracking(value);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger aria-label="Select by tracking">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All tracking</SelectItem>
                        {Object.entries(CLASSIFICATION_LABELS).map(
                          ([id, label]) => (
                            <SelectItem key={id} value={id}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <div className="expectation-choice">
                      <Checkbox
                        id="bulk-archived"
                        checked={archived}
                        onCheckedChange={(value) => {
                          setArchived(value === true);
                          setPage(1);
                        }}
                      />
                      <label htmlFor="bulk-archived">Include archived</label>
                    </div>
                  </div>
                  <div className="expectation-actions">
                    <p role="status">
                      {selected.length} of{" "}
                      {EXPECTATION_BULK_LIMITS.REPOSITORIES} selected
                    </p>
                    <Button
                      variant="outline"
                      disabled={!visible.length || !roomForPage}
                      onClick={() =>
                        setSelection((previous) => ({
                          ...Object.fromEntries(
                            visible.map((repo) => [repo.id, repo]),
                          ),
                          ...previous,
                        }))
                      }
                    >
                      Select this page
                    </Button>
                    {candidates.length > visible.length &&
                    candidates.length <=
                      EXPECTATION_BULK_LIMITS.REPOSITORIES ? (
                      <Button
                        variant="outline"
                        disabled={!roomForMatches}
                        onClick={() =>
                          setSelection((previous) => ({
                            ...Object.fromEntries(
                              candidates.map((repo) => [repo.id, repo]),
                            ),
                            ...previous,
                          }))
                        }
                      >
                        Select all {candidates.length} matches
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={!selected.length}
                      onClick={() => setSelection({})}
                    >
                      Clear selection
                    </Button>
                  </div>
                  <ul
                    className="expectation-selection"
                    aria-label="Repositories to change"
                  >
                    {visible.map((repo) => (
                      <li key={repo.id}>
                        <Checkbox
                          id={"bulk-select-" + repo.id}
                          checked={Boolean(selection[repo.id])}
                          disabled={
                            !selection[repo.id] &&
                            selected.length ===
                              EXPECTATION_BULK_LIMITS.REPOSITORIES
                          }
                          onCheckedChange={(checked) =>
                            select(repo, checked === true)
                          }
                        />
                        <label htmlFor={"bulk-select-" + repo.id}>
                          <strong>{repo.fullName}</strong>
                          <span>
                            {CLASSIFICATION_LABELS[repo.classification]}
                            {repo.lifecycle === "archived" ? " / Archived" : ""}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {!visible.length ? (
                    <p>No repositories match these filters.</p>
                  ) : null}
                  <nav
                    className="expectation-actions"
                    aria-label="Selection pages"
                  >
                    <p>
                      Page {visiblePage} of {pageCount}
                    </p>
                    <Button
                      variant="outline"
                      disabled={visiblePage === 1}
                      onClick={() => setPage(visiblePage - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      disabled={visiblePage === pageCount}
                      onClick={() => setPage(visiblePage + 1)}
                    >
                      Next
                    </Button>
                  </nav>
                </>
              ) : step === "configure" ? (
                <>
                  <section
                    className="expectation-stack"
                    aria-labelledby="expectation-presets"
                  >
                    <h3 id="expectation-presets">Batch choices</h3>
                    <div className="expectation-actions">
                      <Select
                        value={selectedPreset?.id ?? ""}
                        onValueChange={(id) => {
                          const preset = EXPECTATION_PRESETS.find(
                            (preset) => preset.id === id,
                          );
                          if (preset) setPatch({ ...preset.patch });
                        }}
                      >
                        <SelectTrigger aria-label="Expectation preset">
                          <SelectValue placeholder="Choose a preset (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          {EXPECTATION_PRESETS.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {preset.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        disabled={!Object.keys(patch).length}
                        onClick={() => setPatch({})}
                      >
                        Clear batch choices
                      </Button>
                    </div>
                    <p className="expectation-muted">
                      {selectedPreset?.description ??
                        "Choose fields below or use a preset. Individual exceptions stay in place."}
                    </p>
                  </section>
                  <p className="expectation-muted">
                    Requirements are not health results. Optional and Not
                    managed here never mean healthy.
                  </p>
                  <section
                    className="expectation-stack"
                    aria-labelledby="bulk-fields"
                  >
                    <h3 id="bulk-fields">
                      Changes for {repositoryLabel(selected.length)}
                    </h3>
                    <ExpectationFields
                      id="batch"
                      patch={patch}
                      onChange={setPatch}
                    />
                  </section>
                  <section
                    className="expectation-stack"
                    aria-labelledby="bulk-exceptions"
                  >
                    <h3 id="bulk-exceptions">Repositories and exceptions</h3>
                    <p className="expectation-muted">
                      Exclude a repository or override an individual field.
                      Notes and review dates are kept unless selected.
                    </p>
                    {changedSinceSelection ? (
                      <div className="expectation-notice">
                        <p>
                          Some selected repositories changed or left this
                          workspace. Update their comparison values before
                          preparing another review. Your selected changes stay
                          intact.
                        </p>
                        <Button variant="outline" onClick={updateBaselines}>
                          Use latest repository versions
                        </Button>
                      </div>
                    ) : null}
                    {rows.map((row) => (
                      <article
                        className="expectation-row"
                        key={row.repositoryId}
                      >
                        <div className="expectation-actions">
                          <h4>{row.fullName}</h4>
                          <Button
                            variant="ghost"
                            aria-label={"Exclude " + row.fullName}
                            onClick={() =>
                              setSelection((previous) => {
                                const next = { ...previous };
                                delete next[row.repositoryId];
                                return next;
                              })
                            }
                          >
                            Exclude
                          </Button>
                        </div>
                        {!snapshot.repositories.some(
                          (repo) => repo.id === row.repositoryId,
                        ) ? (
                          <p className="field-error">
                            This repository left the workspace. Exclude it
                            before reviewing.
                          </p>
                        ) : null}
                        <Changes row={row} />
                        <details>
                          <summary>
                            Exceptions
                            {Object.keys(exceptions[row.repositoryId] ?? {})
                              .length
                              ? " (customized)"
                              : ""}
                          </summary>
                          <ExpectationFields
                            id={"exception-" + row.repositoryId}
                            exception
                            defaults={row.after}
                            patch={exceptions[row.repositoryId] ?? {}}
                            onChange={(patch) =>
                              setExceptions((previous) => ({
                                ...previous,
                                [row.repositoryId]: patch,
                              }))
                            }
                          />
                          <Button
                            variant="ghost"
                            disabled={
                              !Object.keys(exceptions[row.repositoryId] ?? {})
                                .length
                            }
                            onClick={() =>
                              setExceptions((previous) => ({
                                ...previous,
                                [row.repositoryId]: {},
                              }))
                            }
                          >
                            Use batch choices
                          </Button>
                        </details>
                      </article>
                    ))}
                    {!selected.length ? (
                      <p>
                        No repositories remain selected. Go back to choose
                        repositories.
                      </p>
                    ) : null}
                  </section>
                </>
              ) : review ? (
                <>
                  <p>
                    <strong>
                      {reviewChanged} of {review.rows.length}
                    </strong>{" "}
                    {review.rows.length === 1 ? "repository" : "repositories"}{" "}
                    will change in <strong>{review.workspaceName}</strong>.
                  </p>
                  <p className="expectation-muted">
                    Reviewed as {review.actor}. Expires{" "}
                    {dateTime(review.expiresAt)}.
                  </p>
                  <p>
                    Only the changes below will be saved. Descriptions,
                    projects, tracking, archived state, provider settings and
                    observed health are unchanged.
                  </p>
                  {expired || review.state === "stale" ? (
                    <p className="expectation-notice" role="status">
                      {expired
                        ? "This review expired."
                        : "This review is no longer current."}{" "}
                      {uncertain
                        ? "An earlier Apply may still finish. Check the saved receipt or retry this same review before preparing another."
                        : "Go back to your choices and prepare a fresh review."}
                    </p>
                  ) : null}
                  {review.rows.map((row) => (
                    <article className="expectation-row" key={row.repositoryId}>
                      <h3>{row.fullName}</h3>
                      <Changes row={row} />
                    </article>
                  ))}
                  {!reviewChanged ? (
                    <p role="status">
                      Everything already matches. There is nothing to apply.
                    </p>
                  ) : null}
                  <details>
                    <summary>Review reference</summary>
                    <p className="expectation-reference">{review.planId}</p>
                    <p className="expectation-reference">
                      {review.fingerprint}
                    </p>
                    <p>
                      The page URL preserves this review for receipt recovery.
                    </p>
                  </details>
                </>
              ) : (
                <p role="status">
                  {busy
                    ? "Loading saved review..."
                    : "The saved review is unavailable. Retry loading it or close this editor."}
                </p>
              )}
            </fieldset>
          </div>
          <div className="expectation-footer">
            {receipt ? (
              <Button onClick={guard.saved}>Done</Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={guard.requestClose}
                >
                  Cancel
                </Button>
                {step === "select" ? (
                  <Button
                    disabled={!selected.length || !allowed}
                    onClick={() => setStep("configure")}
                  >
                    Choose changes
                  </Button>
                ) : step === "configure" ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setStep("select")}
                    >
                      Back to selection
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        !valid.success ||
                        !allowed ||
                        changedSinceSelection
                      }
                      onClick={prepare}
                    >
                      {busy ? "Preparing review..." : "Review changes"}
                    </Button>
                  </>
                ) : (
                  <>
                    {review ? (
                      <Button
                        variant="outline"
                        disabled={busy || uncertain}
                        onClick={edit}
                      >
                        Back to choices
                      </Button>
                    ) : null}
                    {uncertain || !review ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={inspect}
                      >
                        Check saved receipt
                      </Button>
                    ) : null}
                    {review ? (
                      <Button
                        disabled={
                          busy ||
                          !allowed ||
                          (!uncertain &&
                            (expired ||
                              review.state !== "ready" ||
                              !reviewChanged))
                        }
                        onClick={apply}
                      >
                        {busy
                          ? "Confirming..."
                          : uncertain
                            ? "Retry same review"
                            : "Apply to " + repositoryLabel(reviewChanged)}
                      </Button>
                    ) : null}
                  </>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <DiscardDialog
        guard={guard}
        busy={busy}
        uncertain={uncertain}
        recoveryHref={uncertain ? window.location.href : undefined}
      />
    </>
  );
}
