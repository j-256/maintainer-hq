import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type Location } from "react-router-dom";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  FLEET_DISCOVERY_LIMITS as LIMITS,
  FLEET_REVIEW_PARAM,
  FLEET_REQUEST_INTERRUPTED,
  fleetReconciliationPlanInput,
  githubOwnerName,
  type FleetCandidate,
  type FleetDiscoveryResult,
  type FleetDiscoverySource,
  type FleetDiscoveryScope,
  type FleetReconciliationInput,
  type FleetReconciliationReceipt,
  type FleetReconciliationReview,
  type FleetSelection,
} from "../shared/fleet-discovery";
import { CLASSIFICATION_LABELS } from "../shared/presentation";
import {
  CONTEXT_READ_LABELS,
  githubRepositoryUrl,
} from "../shared/github-context";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
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
import { command, RequestError } from "./lib/api";
import { pendingReview } from "./lib/pending-review";
import { fleetAttempt } from "./lib/fleet-attempt";
import { useDateTime } from "./date-time";
import "./fleet-enrollment.css";

const CANDIDATE_LABELS = Object.freeze({
  new: "Not in HQ",
  changed: "Changes found",
  unchanged: "Matches HQ",
  conflict: "Needs a decision",
  unavailable: "Not verified",
});
const CONFLICT_REASONS = Object.freeze({
  identity_conflict:
    "The recorded GitHub identity does not match. Check the upstream repository and HQ record; do not merge them automatically.",
  name_conflict:
    "This GitHub name or identity already belongs to another HQ record. Review both records before making a change.",
  ambiguous_identity:
    "More than one identity or HQ record matches. Keep retained aliases separate until their ownership is resolved.",
});
const timeout = () => AbortSignal.timeout(LIMITS.CLIENT_TIMEOUT_MS);
const labelCount = (value: number) =>
  `${value} ${value === 1 ? "repository" : "repositories"}`;
function reviewNavigation(current: Location, next: Location) {
  const a = new URLSearchParams(current.search),
    b = new URLSearchParams(next.search);
  a.delete(FLEET_REVIEW_PARAM);
  b.delete(FLEET_REVIEW_PARAM);
  return current.pathname === next.pathname && a.toString() === b.toString();
}
function candidateSummary(candidate: FleetCandidate) {
  if (candidate.reason in CONFLICT_REASONS)
    return CONFLICT_REASONS[candidate.reason as keyof typeof CONFLICT_REASONS];
  if (!candidate.provider)
    return "This credential did not verify the repository. Unavailable evidence is not proof of deletion or an archive.";
  if (!candidate.repository)
    return "Choose tracking and collection membership before adding this repository.";
  const changes = [];
  if (candidate.repository.fullName !== candidate.provider.fullName)
    changes.push(
      "Name: " +
        candidate.repository.fullName +
        " to " +
        candidate.provider.fullName,
    );
  if (
    (candidate.repository.lifecycle === "archived") !==
    candidate.provider.archived
  )
    changes.push(
      candidate.provider.archived
        ? "GitHub is archived; HQ is active"
        : "GitHub is active; HQ is archived",
    );
  return (
    changes.join(". ") ||
    "Name and archive state match. You can still review collection membership."
  );
}

function EnrollmentDiff({
  review,
  projects,
}: {
  review: FleetReconciliationReview;
  projects: Snapshot["projects"];
}) {
  const { calendarDate } = useDateTime();
  return (
    <ul className="fleet-review-list" aria-label="Reviewed repository changes">
      {review.changes.map((change) => (
        <li key={change.repositoryId}>
          <h3>{change.after.fullName}</h3>
          <dl className="fleet-diff">
            <div>
              <dt>GitHub identity</dt>
              <dd>
                <code>{change.githubId}</code>
              </dd>
            </div>
            <div>
              <dt>HQ record</dt>
              <dd>
                {change.before ? "Keep existing repository" : "Add repository"}
              </dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>
                {change.before &&
                change.before.fullName !== change.after.fullName ? (
                  <>
                    <span>{change.before.fullName}</span> to{" "}
                    <strong>{change.after.fullName}</strong>
                  </>
                ) : (
                  change.after.fullName
                )}
              </dd>
            </div>
            <div>
              <dt>Archive state</dt>
              <dd>
                {change.before &&
                change.before.lifecycle !== change.after.lifecycle ? (
                  <>
                    {change.before.lifecycle} to{" "}
                    <strong>{change.after.lifecycle}</strong>
                  </>
                ) : (
                  change.after.lifecycle
                )}
              </dd>
            </div>
            <div>
              <dt>Collection</dt>
              <dd>
                {change.collectedBefore === change.collectedAfter ? (
                  change.collectedAfter ? (
                    "Keep collecting"
                  ) : (
                    "Keep outside collection"
                  )
                ) : (
                  <strong>
                    {change.collectedAfter
                      ? "Start collecting"
                      : "Stop collecting"}
                  </strong>
                )}
              </dd>
            </div>
            <div>
              <dt>Tracking</dt>
              <dd>
                {CLASSIFICATION_LABELS[change.after.classification]}
                {change.before ? " (preserved)" : ""}
              </dd>
            </div>
          </dl>
          <details>
            <summary>
              {change.before ? "Preserved settings" : "New repository settings"}
            </summary>
            <dl className="fleet-diff">
              <div>
                <dt>Description</dt>
                <dd>{change.after.description || "No description"}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>
                  {projects.find(
                    (project) => project.id === change.after.projectId,
                  )?.name ?? change.after.projectId}
                  {change.before ? " (preserved)" : ""}
                </dd>
              </div>
              <div>
                <dt>CI / security</dt>
                <dd>
                  {change.after.expectations.ci} /{" "}
                  {change.after.expectations.security}
                </dd>
              </div>
              <div>
                <dt>Hooks / monitoring</dt>
                <dd>
                  {change.after.expectations.hooks} /{" "}
                  {change.after.expectations.monitoring}
                </dd>
              </div>
              <div>
                <dt>Visibility expectation</dt>
                <dd>{change.after.expectations.visibility}</dd>
              </div>
              <div>
                <dt>Review date / note</dt>
                <dd>
                  {change.after.expectations.reviewDate
                    ? calendarDate(change.after.expectations.reviewDate)
                    : "No review date"}
                  ; {change.after.expectations.note || "no note"}
                </dd>
              </div>
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function FleetEnrollment({
  snapshot,
  initialReviewId,
  onReview,
  onClose,
  returnFocus,
}: {
  snapshot: Snapshot;
  initialReviewId: string | null;
  onReview: (id: string | null) => void;
  onClose: () => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const subject = snapshot.principal.subject;
  const allowed =
    snapshot.capabilities.includes(CAPABILITY.ADMIN) &&
    snapshot.capabilities.includes(CAPABILITY.EDIT);
  const sourceQuery = useQuery({
    queryKey: ["fleet-sources", workspaceId, subject],
    queryFn: ({ signal }) =>
      command<FleetDiscoverySource[]>(
        "fleet_sources",
        { workspaceId },
        AbortSignal.any([signal, timeout()]),
      ),
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const sources = sourceQuery.data ?? [];
  const [sourceId, setSourceId] = useState("");
  const [kind, setKind] = useState<"enrolled" | "owner">("enrolled");
  const [owner, setOwner] = useState("");
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<"browse" | "configure" | "review">(
    initialReviewId ? "review" : "browse",
  );
  const [result, setResult] = useState<FleetDiscoveryResult | null>(null);
  const [scopes, setScopes] = useState<FleetDiscoveryScope[]>([]);
  const [selection, setSelection] = useState<Record<string, FleetSelection>>(
    {},
  );
  const [review, setReview] = useState<FleetReconciliationReview | null>(null);
  const [attempt, setAttempt] = useState<FleetReconciliationInput | null>(() =>
    initialReviewId
      ? fleetAttempt(workspaceId, subject, initialReviewId)
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(() =>
    Boolean(
      initialReviewId && pendingReview("fleet", workspaceId, initialReviewId),
    ),
  );
  const [now, setNow] = useState(Date.now);
  const loading = useRef(false);
  const loadedId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const cache = useQueryClient();
  const { dateTime } = useDateTime();
  const source = sources.find((source) => source.id === sourceId);
  const rows = Object.values(selection).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
  const verifiedCandidates =
    result?.candidates.filter(
      (candidate) => candidate.provider && candidate.read.state === "observed",
    ).length ?? 0;
  const partialCoverage = Boolean(
    result?.evidence &&
      result.evidence.read.state !== "observed" &&
      verifiedCandidates > 0,
  );
  const receipt = review?.receipt;
  const expired = Boolean(review && Date.parse(review.expiresAt) <= now);
  const changedSource = Boolean(
    result && source && result.source.revision !== source.revision,
  );
  const pendingId = review?.planId ?? attempt?.reviewId ?? initialReviewId;
  const guard = useCloseGuard(
    !receipt && (rows.length > 0 || Boolean(pendingId) || busy || uncertain),
    onClose,
    reviewNavigation,
  );
  const href = pendingId
    ? new URL(
        "/repositories?" +
          new URLSearchParams({
            workspace: workspaceId,
            [FLEET_REVIEW_PARAM]: pendingId,
          }),
        window.location.origin,
      ).href
    : undefined;
  const valid = fleetReconciliationPlanInput.safeParse(
    attempt ?? {
      workspaceId,
      sourceId,
      sourceRevision: result?.source.revision ?? source?.revision,
      reviewId: draftId,
      selections: rows,
    },
  );
  const canScan =
    allowed &&
    Boolean(source?.enabled && source.configured) &&
    (kind !== "owner" || githubOwnerName.safeParse(owner.trim()).success);
  const locked = busy || rows.length > 0 || Boolean(attempt);
  const changedRows = rows.filter(
    (row) =>
      row.repositoryId &&
      snapshot.repositories.find((item) => item.id === row.repositoryId)
        ?.revision !== row.revision,
  );
  const changedProjects = rows.filter(
    (row) =>
      !row.repositoryId &&
      row.projectId &&
      snapshot.projects.find((item) => item.id === row.projectId)?.revision !==
        row.projectRevision,
  );
  const missingRepository = changedRows.some(
    (row) =>
      !snapshot.repositories.some((item) => item.id === row.repositoryId),
  );
  const missingProject = changedProjects.some(
    (row) => !snapshot.projects.some((item) => item.id === row.projectId),
  );

  function refreshWorkspace() {
    void cache.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    void cache.invalidateQueries({
      queryKey: ["fleet-sources", workspaceId, subject],
    });
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (loading.current || !allowed) return;
    loading.current = true;
    setBusy(true);
    setError("");
    controller.current = new AbortController();
    try {
      await action(AbortSignal.any([controller.current.signal, timeout()]));
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof Error
            ? error.message
            : "The request could not be completed. Your choices are still here.",
        );
    } finally {
      if (alive.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  function hydrate(next: FleetReconciliationReview) {
    if (!alive.current) return;
    setReview(next);
    setSourceId(next.source.id);
    setSelection(
      Object.fromEntries(
        next.fields.selections.map((row) => [row.githubId, row]),
      ),
    );
    setAttempt(null);
    fleetAttempt(workspaceId, subject, next.planId, null);
    loadedId.current = next.planId;
    setStep("review");
    setNow(Date.now());
    setUncertain(
      !next.receipt && pendingReview("fleet", workspaceId, next.planId),
    );
    if (next.receipt) pendingReview("fleet", workspaceId, next.planId, false);
  }
  async function inspect(id = pendingId) {
    if (!id) return;
    await run(async () => {
      const next = await fetchReview(id);
      hydrate(next);
      refreshWorkspace();
      if (!next.receipt && pendingReview("fleet", workspaceId, id))
        setError(
          "No committed receipt is available yet. Check again or retry this exact Apply. An earlier request may still finish.",
        );
    });
  }
  function fetchReview(id: string) {
    return cache.fetchQuery({
      queryKey: ["fleet-review", workspaceId, subject, id],
      queryFn: ({ signal }) =>
        command<FleetReconciliationReview>(
          "fleet_reconciliation_review",
          { workspaceId, planId: id },
          AbortSignal.any([signal, timeout()]),
        ),
      staleTime: 0,
      retry: false,
    });
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (
      initialReviewId &&
      initialReviewId !== loadedId.current &&
      !loading.current &&
      allowed
    ) {
      let active = true;
      loadedId.current = initialReviewId;
      loading.current = true;
      setBusy(true);
      setError("");
      setStep("review");
      void fetchReview(initialReviewId)
        .then((next) => {
          if (!active) return;
          hydrate(next);
          refreshWorkspace();
        })
        .catch((error: unknown) => {
          if (active)
            setError(
              error instanceof Error
                ? error.message
                : "This saved review could not be loaded. Retry its receipt lookup.",
            );
        })
        .finally(() => {
          if (active) {
            loading.current = false;
            setBusy(false);
          }
        });
      return () => {
        active = false;
        loadedId.current = null;
        loading.current = false;
      };
    }
  }, [initialReviewId, workspaceId, subject, allowed]);
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

  async function scan(
    scope?: FleetDiscoveryScope,
    direction: "first" | "next" | "previous" = "first",
  ) {
    if (!source || !canScan || (changedSource && rows.length)) return;
    const selectedScope =
      scope ??
      (kind === "owner"
        ? { kind: "owner", owner: owner.trim(), cursor: null }
        : { kind: "enrolled", cursor: null });
    await run(async (signal) => {
      const next = await command<FleetDiscoveryResult>(
        "fleet_discover",
        {
          workspaceId,
          sourceId,
          sourceRevision: source.revision,
          scope: selectedScope,
        },
        signal,
      );
      if (!alive.current) return;
      if (direction === "first") setScopes([]);
      if (direction === "next" && result)
        setScopes((previous) => [...previous, result.scope]);
      if (direction === "previous")
        setScopes((previous) => previous.slice(0, -1));
      setResult(next);
      if (direction !== "first") {
        heading.current?.focus({ preventScroll: true });
        scroll.current?.scrollTo({ top: 0 });
      }
    });
  }
  function select(candidate: FleetCandidate, checked: boolean) {
    if (
      !candidate.provider ||
      candidate.state === "conflict" ||
      candidate.state === "unavailable" ||
      busy
    )
      return;
    const provider = candidate.provider;
    setSelection((previous) => {
      const next = { ...previous };
      if (!checked) delete next[provider.githubId];
      else if (Object.keys(next).length < LIMITS.SELECTIONS)
        next[provider.githubId] = {
          githubId: provider.githubId,
          fullName: provider.fullName,
          lifecycle: provider.archived ? "archived" : "active",
          repositoryId: candidate.repository?.id ?? null,
          revision: candidate.repository?.revision ?? null,
          classification: null,
          projectId: null,
          projectRevision: null,
          collect: candidate.repository?.collected ?? false,
        };
      return next;
    });
  }
  function update(row: FleetSelection, patch: Partial<FleetSelection>) {
    setSelection((previous) => ({
      ...previous,
      [row.githubId]: { ...row, ...patch },
    }));
  }
  async function prepare() {
    if (!valid.success || busy || uncertain) return;
    const fields = attempt ?? valid.data;
    setAttempt(fields);
    fleetAttempt(workspaceId, subject, fields.reviewId, fields);
    loadedId.current = fields.reviewId;
    onReview(fields.reviewId);
    await run(async (signal) => {
      const next = await command<FleetReconciliationReview>(
        "fleet_reconciliation_plan",
        fields,
        signal,
      );
      hydrate(next);
    });
  }
  async function apply() {
    if (!review || review.state !== "ready" || expired || busy) return;
    const exact = review;
    pendingReview("fleet", workspaceId, exact.planId, true);
    setUncertain(true);
    await run(async (signal) => {
      try {
        const saved = await command<FleetReconciliationReceipt>(
          "fleet_reconciliation_apply",
          { workspaceId, planId: exact.planId, fingerprint: exact.fingerprint },
          signal,
        );
        pendingReview("fleet", workspaceId, exact.planId, false);
        hydrate({ ...exact, state: "applied", receipt: saved });
      } catch (error) {
        if (error instanceof RequestError && error.status === 409) {
          pendingReview("fleet", workspaceId, exact.planId, false);
          setUncertain(false);
          setReview({ ...exact, state: "stale" });
          throw error;
        }
        throw new Error(
          (error instanceof Error ? error.message + " " : "") +
            FLEET_REQUEST_INTERRUPTED,
        );
      } finally {
        refreshWorkspace();
      }
    });
  }
  function freshReview() {
    if (busy || uncertain) return;
    if (pendingId) fleetAttempt(workspaceId, subject, pendingId, null);
    setAttempt(null);
    setDraftId(crypto.randomUUID());
    setReview(null);
    setError("");
    loadedId.current = null;
    onReview(null);
    setStep("configure");
  }
  function reset() {
    if (busy || uncertain) return;
    if (pendingId) fleetAttempt(workspaceId, subject, pendingId, null);
    setSelection({});
    setDraftId(crypto.randomUUID());
    setAttempt(null);
    setReview(null);
    setResult(null);
    setScopes([]);
    setError("");
    loadedId.current = null;
    onReview(null);
    setStep("browse");
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
          className="fleet-dialog"
          showCloseButton={!busy}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle ref={heading} tabIndex={-1}>
              Review enrollment
            </DialogTitle>
            <DialogDescription>
              {receipt
                ? "The reviewed changes are saved in HQ."
                : "Discover repositories and review changes to your HQ inventory. GitHub is not changed."}
            </DialogDescription>
          </DialogHeader>
          <div className="fleet-scroll" ref={scroll}>
            {!allowed ? (
              <p role="alert">
                A workspace owner with metadata-write access can review
                enrollment. GitHub metadata access does not grant repository
                administration rights.
              </p>
            ) : (
              <>
                <p className="fleet-muted">
                  {receipt
                    ? "Complete"
                    : step === "browse"
                      ? "1. Discover"
                      : step === "configure"
                        ? "2. Choose settings"
                        : "3. Review and apply"}
                </p>
                {error ? (
                  <p className="fleet-notice" role="alert">
                    {error}
                  </p>
                ) : null}
                {busy ? (
                  <p role="status">
                    {step === "browse"
                      ? "Reading the selected GitHub scope..."
                      : "Checking the saved enrollment review..."}
                  </p>
                ) : null}
                {step === "browse" ? (
                  <>
                    {sourceQuery.isPending ? (
                      <p role="status">Loading GitHub sources...</p>
                    ) : sourceQuery.error ? (
                      <p role="alert">
                        {sourceQuery.error.message}{" "}
                        <Button
                          variant="outline"
                          onClick={() => void sourceQuery.refetch()}
                        >
                          Reload sources
                        </Button>
                      </p>
                    ) : null}
                    <fieldset className="fleet-fields" disabled={locked}>
                      <label>
                        GitHub source
                        <Select
                          value={sourceId}
                          onValueChange={(id) => {
                            setSourceId(id);
                            setResult(null);
                            setScopes([]);
                          }}
                        >
                          <SelectTrigger aria-label="Discovery GitHub source">
                            <SelectValue placeholder="Choose a source" />
                          </SelectTrigger>
                          <SelectContent>
                            {sources.map((source) => (
                              <SelectItem key={source.id} value={source.id}>
                                {source.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      <label>
                        Look for
                        <Select
                          value={kind}
                          onValueChange={(value) => {
                            setKind(value as typeof kind);
                            setResult(null);
                            setScopes([]);
                          }}
                        >
                          <SelectTrigger aria-label="Discovery scope">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="enrolled">
                              Changes to HQ repositories
                            </SelectItem>
                            <SelectItem value="owner">
                              Owner or organization catalog
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </label>
                      {kind === "owner" ? (
                        <label>
                          GitHub owner or organization
                          <Input
                            value={owner}
                            onChange={(event) => setOwner(event.target.value)}
                            placeholder="e.g. octocat"
                            maxLength={39}
                            autoComplete="off"
                          />
                        </label>
                      ) : null}
                    </fieldset>
                    {!sourceQuery.isPending &&
                    !sourceQuery.error &&
                    !sources.length ? (
                      <p className="fleet-notice">
                        Configure a GitHub source before discovering
                        repositories.{" "}
                        <Link
                          to={
                            "/settings/github?" +
                            new URLSearchParams({
                              workspace: workspaceId,
                            })
                          }
                        >
                          Open settings
                        </Link>
                      </p>
                    ) : source && !canScan ? (
                      <p className="fleet-notice">
                        {!source.enabled
                          ? "This source is disabled."
                          : !source.configured
                            ? "This source needs a configured read credential and valid settings."
                            : "Enter a GitHub owner or organization name, not a URL."}
                      </p>
                    ) : null}
                    <p className="fleet-muted">
                      {kind === "owner"
                        ? "This reads one catalog page visible to the chosen credential, not everything the account can access."
                        : "This checks HQ repositories, including those outside scheduled collection. Unavailable reads never remove a repository."}{" "}
                      Nothing is selected automatically.
                    </p>
                    <div className="fleet-actions">
                      <Button
                        variant="outline"
                        disabled={!canScan || busy || rows.length > 0}
                        onClick={() => void scan()}
                      >
                        Check GitHub
                      </Button>
                      {rows.length ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setSelection({})}
                        >
                          Clear selection
                        </Button>
                      ) : null}
                    </div>
                    {changedSource ? (
                      <p className="fleet-notice" role="alert">
                        Source settings changed. Clear this selection and check
                        GitHub again with the saved settings.
                      </p>
                    ) : null}
                    {result ? (
                      <>
                        <section
                          className="fleet-notice"
                          aria-label="Discovery coverage"
                        >
                          <h3>{result.source.name}</h3>
                          <p>
                            {result.scope.kind === "owner"
                              ? "Catalog: " + result.scope.owner
                              : "HQ inventory"}
                            {result.evidence?.total != null
                              ? " \u00b7 " +
                                labelCount(result.evidence.total) +
                                (result.scope.kind === "owner"
                                  ? " visible to this credential"
                                  : " enrolled in HQ")
                              : ""}
                          </p>
                          <p>
                            {result.evidence
                              ? (partialCoverage
                                  ? "Partially verified "
                                  : result.evidence.read.state === "observed"
                                    ? "Verified "
                                    : CONTEXT_READ_LABELS[
                                        result.evidence.read.state
                                      ] + ". Checked ") +
                                dateTime(result.evidence.observedAt)
                              : result.state === "collecting"
                                ? "Another read is in progress."
                                : result.state === "waiting"
                                  ? "The bounded read budget or provider cooldown is active."
                                  : "No provider evidence is available."}
                          </p>
                          {result.evidence &&
                          result.evidence.read.state !== "observed" ? (
                            <p>
                              {partialCoverage
                                ? `Verified ${verifiedCandidates} of ${result.candidates.length} repositories on this page. Review the unverified rows before changing their HQ records.`
                                : "Coverage is incomplete. " +
                                  result.evidence.read.reason.replaceAll(
                                    "_",
                                    " ",
                                  ) +
                                  ". Review individual rows or retry when the read window opens."}
                            </p>
                          ) : null}
                          {result.nextReadAt ? (
                            <p className="fleet-muted">
                              This scope can read GitHub again after{" "}
                              {dateTime(result.nextReadAt)}. Cached results keep
                              their original observation time.
                            </p>
                          ) : null}
                        </section>
                        {result.candidates.length ? (
                          <ul
                            className="fleet-candidates"
                            aria-label="Discovered repositories"
                          >
                            {result.candidates.map((candidate) => {
                              const selected = Boolean(
                                candidate.provider &&
                                  selection[candidate.provider.githubId],
                              );
                              const blocked =
                                !candidate.provider ||
                                candidate.state === "conflict" ||
                                candidate.state === "unavailable";
                              const name =
                                candidate.provider?.fullName ??
                                candidate.repository?.fullName ??
                                candidate.lookupFullName ??
                                "Unavailable repository";
                              return (
                                <li key={candidate.key}>
                                  <div className="fleet-candidate-heading">
                                    <Checkbox
                                      aria-label={"Select " + name}
                                      checked={selected}
                                      disabled={
                                        busy ||
                                        blocked ||
                                        changedSource ||
                                        (!selected &&
                                          rows.length >= LIMITS.SELECTIONS)
                                      }
                                      onCheckedChange={(checked) =>
                                        select(candidate, checked === true)
                                      }
                                    />
                                    <h3>{name}</h3>
                                    <Badge variant="outline">
                                      {CANDIDATE_LABELS[candidate.state]}
                                    </Badge>
                                  </div>
                                  <p>{candidateSummary(candidate)}</p>
                                  {candidate.provider ? (
                                    <p className="fleet-muted">
                                      {candidate.provider.private
                                        ? "Private"
                                        : "Public"}{" "}
                                      repository.{" "}
                                      {candidate.identity === "recorded"
                                        ? "Matched a recorded GitHub identity."
                                        : candidate.identity === "name_lookup"
                                          ? "Resolved through the HQ name. This does not prove earlier ownership of that name."
                                          : "Visible in the selected catalog."}
                                    </p>
                                  ) : null}
                                  {candidate.repository ? (
                                    <p className="fleet-muted">
                                      {
                                        CLASSIFICATION_LABELS[
                                          candidate.repository.classification
                                        ]
                                      }{" "}
                                      &middot;{" "}
                                      {candidate.repository.collected
                                        ? "Collected by this source"
                                        : "Outside this source's collection"}
                                    </p>
                                  ) : null}
                                  <div className="fleet-links">
                                    {candidate.provider ? (
                                      <a
                                        href={githubRepositoryUrl(
                                          candidate.provider.fullName,
                                        )}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        View on GitHub
                                      </a>
                                    ) : null}
                                    {candidate.repository ? (
                                      <Link
                                        to={
                                          "/repositories/" +
                                          candidate.repository.id +
                                          "?workspace=" +
                                          encodeURIComponent(workspaceId)
                                        }
                                      >
                                        View HQ record
                                      </Link>
                                    ) : null}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        ) : result.state === "ready" ? (
                          <p>
                            {result.evidence?.read.state === "observed"
                              ? "No repositories on this page."
                              : "No repository records could be verified on this page."}
                          </p>
                        ) : null}
                        {scopes.length || result.nextScope ? (
                          <nav
                            className="fleet-actions"
                            aria-label="Discovery pages"
                          >
                            <p>
                              Page {scopes.length + 1};{" "}
                              {labelCount(rows.length)} selected across pages
                            </p>
                            <Button
                              variant="outline"
                              disabled={busy || !scopes.length || changedSource}
                              onClick={() =>
                                void scan(scopes[scopes.length - 1], "previous")
                              }
                            >
                              Previous page
                            </Button>
                            <Button
                              variant="outline"
                              disabled={
                                busy || !result.nextScope || changedSource
                              }
                              onClick={() =>
                                void scan(result.nextScope!, "next")
                              }
                            >
                              Next page
                            </Button>
                          </nav>
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : null}
                {step === "configure" ? (
                  <>
                    <p>
                      Use the verified GitHub name and archive state for the
                      selected rows. Existing expectations, descriptions,
                      tracking, projects and resource links are preserved.
                      Choose whether the selected source should collect each
                      repository.
                    </p>
                    {changedRows.length ||
                    changedProjects.length ||
                    changedSource ? (
                      <section
                        className="fleet-notice"
                        aria-label="Changed HQ versions"
                      >
                        <p>
                          Saved HQ repository, project, or source settings
                          changed. Keep your requested GitHub names, archive
                          choices and collection membership, then prepare a
                          review against the updated HQ settings.
                        </p>
                        <Button
                          variant="outline"
                          disabled={
                            busy ||
                            Boolean(attempt) ||
                            missingRepository || missingProject
                          }
                          onClick={() => {
                            setSelection((previous) =>
                              Object.fromEntries(
                                Object.entries(previous).map(([key, row]) => [
                                  key,
                                  {
                                    ...row,
                                    revision: row.repositoryId
                                      ? (snapshot.repositories.find(
                                          (item) =>
                                            item.id === row.repositoryId,
                                          )?.revision ?? row.revision)
                                      : null,
                                    projectRevision:
                                      !row.repositoryId && row.projectId
                                        ? (snapshot.projects.find(
                                            (item) =>
                                              item.id === row.projectId,
                                          )?.revision ?? row.projectRevision)
                                        : null,
                                  },
                                ]),
                              ),
                            );
                            setResult(null);
                            setDraftId(crypto.randomUUID());
                          }}
                        >
                          Use updated HQ versions
                        </Button>
                        {missingRepository ? (
                          <p>
                            A selected HQ repository is no longer in this
                            workspace. Remove it from the selection; it will not
                            be recreated automatically.
                          </p>
                        ) : null}
                        {missingProject ? (
                          <p>
                            A selected project is no longer in this workspace.
                            Choose another project for the new repository.
                          </p>
                        ) : null}
                      </section>
                    ) : null}
                    {!rows.length ? (
                      <p>Return to discovery and select repositories first.</p>
                    ) : (
                      <ul className="fleet-settings-list">
                        {rows.map((row) => (
                          <li key={row.githubId}>
                            <h3>{row.fullName}</h3>
                            <p className="fleet-muted">
                              {row.repositoryId
                                ? "Existing HQ repository"
                                : "Add to HQ"}{" "}
                              &middot; {row.lifecycle}
                            </p>
                            {!row.repositoryId ? (
                              <>
                                <label>
                                  Owning project for {row.fullName}
                                  <Select
                                    value={row.projectId ?? ""}
                                    disabled={busy || Boolean(attempt)}
                                    onValueChange={(value) => {
                                      const project = snapshot.projects.find(
                                        (item) => item.id === value,
                                      );
                                      if (project)
                                        update(row, {
                                          projectId: project.id,
                                          projectRevision: project.revision,
                                        });
                                    }}
                                  >
                                    <SelectTrigger
                                      aria-label={
                                        "Owning project for " + row.fullName
                                      }
                                    >
                                      <SelectValue placeholder="Choose a project" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {snapshot.projects.map((project) => (
                                        <SelectItem
                                          key={project.id}
                                          value={project.id}
                                        >
                                          {project.name}
                                          {project.lifecycle === "archived"
                                            ? " (archived)"
                                            : ""}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </label>
                                <label>
                                  Tracking for {row.fullName}
                                  <Select
                                    value={row.classification ?? ""}
                                    disabled={busy || Boolean(attempt)}
                                    onValueChange={(value) =>
                                      update(row, {
                                        classification:
                                          value as FleetSelection["classification"],
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      aria-label={
                                        "Tracking for " + row.fullName
                                      }
                                    >
                                      <SelectValue placeholder="Choose tracking" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {Object.entries(
                                        CLASSIFICATION_LABELS,
                                      ).map(([key, value]) => (
                                        <SelectItem key={key} value={key}>
                                          {value}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </label>
                              </>
                            ) : null}
                            <label className="fleet-choice">
                              <Checkbox
                                checked={row.collect}
                                disabled={busy || Boolean(attempt)}
                                onCheckedChange={(checked) =>
                                  update(row, { collect: checked === true })
                                }
                              />
                              Collect {row.fullName} with{" "}
                              {source?.name ??
                                review?.source.name ??
                                "this source"}
                            </label>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || Boolean(attempt)}
                              onClick={() =>
                                setSelection((previous) => {
                                  const next = { ...previous };
                                  delete next[row.githubId];
                                  return next;
                                })
                              }
                            >
                              Remove {row.fullName} from selection
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="fleet-muted">
                      New records belong to the selected project, require CI
                      and security evidence, and leave hooks and monitoring
                      unmanaged. These are expectations, not proof of health or
                      provider administration rights.
                    </p>
                    {!snapshot.projects.length ? (
                      <p className="fleet-notice">
                        Create a project before adding a repository to HQ. Open
                        the{" "}
                        <Link
                          to={
                            "/projects?" +
                            new URLSearchParams({ workspace: workspaceId })
                          }
                        >
                          projects page,
                        </Link>{" "}
                        then return to discovery.
                      </p>
                    ) : null}
                    {attempt ? (
                      <p className="fleet-notice">
                        This preparation attempt has a stable review ID. Retry
                        it or inspect its saved review before changing the
                        choices.
                      </p>
                    ) : !valid.success && rows.length ? (
                      <p role="status">
                        Choose an owning project and tracking for every new
                        repository before preparing the review.
                      </p>
                    ) : null}
                  </>
                ) : null}
                {step === "review" ? (
                  review ? (
                    <>
                      <section
                        className="fleet-notice"
                        aria-label="Enrollment review status"
                      >
                        <h3>
                          {receipt
                            ? "Enrollment saved"
                            : review.state === "stale"
                              ? "Review needs updating"
                              : expired || review.state === "expired"
                                ? "Review expired"
                                : "Ready for your review"}
                        </h3>
                        <p>
                          {review.source.name}: {review.source.beforeCount} to{" "}
                          {review.source.afterCount} collection members.{" "}
                          {receipt
                            ? "Applied " + dateTime(receipt.appliedAt)
                            : "Verified " +
                              dateTime(review.observedAt) +
                              ". Review expires " +
                              dateTime(review.expiresAt)}
                          .
                        </p>
                        {uncertain ? (
                          <p>
                            Apply may still finish. Check the saved receipt or
                            retry only this exact review.
                          </p>
                        ) : null}
                        {receipt ? (
                          <p>
                            {labelCount(receipt.createdRepositoryIds.length)}{" "}
                            added;{" "}
                            {labelCount(receipt.updatedRepositoryIds.length)}{" "}
                            updated. {receipt.addedToSource.length} added to
                            collection; {receipt.removedFromSource.length}{" "}
                            removed from collection.
                          </p>
                        ) : (
                          <p>
                            Apply changes HQ only. It does not archive or rename
                            GitHub repositories, grant permissions, create
                            projects or rewrite provider history.
                          </p>
                        )}
                      </section>
                      <EnrollmentDiff
                        review={review}
                        projects={snapshot.projects}
                      />
                    </>
                  ) : (
                    <p>
                      {attempt
                        ? "The original preparation choices are saved in this browser. Inspect the review or retry preparation with the same ID."
                        : "Load this saved review to inspect its exact changes and receipt."}
                    </p>
                  )
                ) : null}
                {pendingId ? (
                  <label className="fleet-saved-url">
                    Saved review URL
                    <Input
                      readOnly
                      value={href}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </label>
                ) : null}
              </>
            )}
          </div>
          <div className="fleet-footer">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={receipt ? guard.saved : guard.requestClose}
            >
              {receipt ? "Done" : "Close"}
            </Button>
            {allowed && !receipt ? (
              <>
                {step === "browse" ? (
                  <Button
                    disabled={busy || !rows.length || changedSource}
                    onClick={() => setStep("configure")}
                  >
                    Configure {labelCount(rows.length)}
                  </Button>
                ) : null}
                {step === "configure" ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy || Boolean(attempt)}
                      onClick={() => setStep("browse")}
                    >
                      Back to discovery
                    </Button>
                    <Button
                      disabled={busy || !valid.success || uncertain}
                      onClick={() => void prepare()}
                    >
                      {attempt ? "Retry preparation" : "Prepare review"}
                    </Button>
                  </>
                ) : null}
                {pendingId ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void inspect()}
                  >
                    Check saved review
                  </Button>
                ) : null}
                {step === "review" && !review && attempt ? (
                  <Button
                    disabled={busy || uncertain}
                    onClick={() => void prepare()}
                  >
                    Retry preparation
                  </Button>
                ) : null}
                {review && !uncertain ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={freshReview}
                  >
                    Edit choices
                  </Button>
                ) : null}
                {review && review.state === "ready" && !expired ? (
                  <Button disabled={busy} onClick={() => void apply()}>
                    {uncertain ? "Retry exact Apply" : "Apply reviewed changes"}
                  </Button>
                ) : null}
                {!uncertain && !busy && step !== "browse" ? (
                  <Button variant="ghost" onClick={reset}>
                    Start discovery again
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <DiscardDialog
        guard={guard}
        busy={busy}
        uncertain={uncertain}
        recoveryHref={href}
      />
    </>
  );
}
