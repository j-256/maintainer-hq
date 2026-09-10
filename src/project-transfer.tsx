import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams, type Location } from "react-router-dom";
import { ArrowRight, CheckCheck, RefreshCw } from "lucide-react";
import { CAPABILITY, type Project, type Snapshot } from "../shared/domain";
import type {
  TransferDestinations,
  TransferFields,
  TransferPreview,
  TransferReceipt,
  TransferReview,
} from "../shared/project-transfers";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Checkbox } from "./components/ui/checkbox";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { HookError, restoreHookFocus } from "./hook-components";
import { useDateTime } from "./date-time";
import {
  IMPORTANCE_LABELS,
  PORTFOLIO_LABELS,
  projectHref,
} from "./project-inventory";
import "./project-transfer.css";

const REQUEST_MS = 15_000;
const UNMAPPED = ":unmapped";
const REVIEW_PARAM = "transfer";
type Choices = Pick<
  TransferFields,
  "destinationWorkspaceId" | "sourceBindings"
>;
function unavailableAuthority(error: unknown) {
  return (
    error instanceof RequestError && [401, 403, 404].includes(error.status)
  );
}
function onlyReviewNavigation(current: Location, next: Location) {
  const before = new URLSearchParams(current.search);
  const after = new URLSearchParams(next.search);
  before.delete(REVIEW_PARAM);
  after.delete(REVIEW_PARAM);
  return (
    current.pathname === next.pathname && before.toString() === after.toString()
  );
}
function choices(fields: Choices): Choices {
  return {
    destinationWorkspaceId: fields.destinationWorkspaceId,
    sourceBindings: fields.sourceBindings,
  };
}
function TransferFacts({ preview }: { preview: TransferPreview }) {
  const dates = useDateTime();
  const names = new Map(
    [preview.source, preview.destination].map((w) => [w.id, w.name]),
  );
  const sourceNames = new Map(
    preview.sources.map((source) => [source.id, source.name]),
  );
  const destinationSourceNames = new Map(
    preview.destinationSources.map((source) => [source.id, source.name]),
  );
  return (
    <>
      <section className="transfer-section" aria-labelledby="transfer-moving">
        <h3 id="transfer-moving">What moves</h3>
        <p>
          <strong>{preview.project.name}</strong> and{" "}
          {preview.repositories.length}{" "}
          {preview.repositories.length === 1 ? "repository" : "repositories"},
          with the same IDs and saved metadata.
        </p>
        <p className="transfer-muted">
          {IMPORTANCE_LABELS[preview.project.importance]} importance /
          Portfolio: {PORTFOLIO_LABELS[preview.project.portfolio.status]} /{" "}
          {preview.project.lifecycle}
        </p>
        <details>
          <summary>Project identity and saved description</summary>
          <p>{preview.project.description || "No description"}</p>
          <code>{preview.project.id}</code>
          <p>
            Revision {preview.project.revision}. Portfolio and Importance notes
            stay with the project.
          </p>
        </details>
        {preview.repositories.length ? (
          <details>
            <summary>
              Repositories included ({preview.repositories.length})
            </summary>
            <ul>
              {preview.repositories.map((r) => (
                <li key={r.id}>
                  <strong>{r.fullName}</strong>
                  <span className="transfer-muted">
                    Revision {r.revision} / <code>{r.id}</code>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      <section className="transfer-section" aria-labelledby="transfer-access">
        <h3 id="transfer-access">Who can access the project</h3>
        <p>
          Destination membership applies to the moved metadata. Membership
          itself does not change.
        </p>
        <div className="transfer-table-wrap">
          <table className="transfer-access">
            <caption className="sr-only">
              Project access before and after the move
            </caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {preview.access.map((person) => (
                <tr key={person.subject}>
                  <th scope="row">
                    <span>{person.displayName}</span>
                    <small>
                      {person.effect === "gain"
                        ? "Gains access"
                        : person.effect === "lose"
                          ? "Loses current access"
                          : person.effect === "change"
                            ? "Role changes"
                            : "Keeps access"}
                    </small>
                  </th>
                  <td>{person.sourceRole ?? "No access"}</td>
                  <td>{person.destinationRole ?? "No access"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview.invitations.length ? (
          <details>
            <summary>
              Pending invitations ({preview.invitations.length})
            </summary>
            <p>
              These people can gain workspace access by accepting an unexpired
              invitation.
            </p>
            <ul>
              {preview.invitations.map((invitation) => (
                <li key={invitation.workspaceId + invitation.email}>
                  <strong>{invitation.email}</strong>
                  <span>
                    {names.get(invitation.workspaceId)} / {invitation.role} /
                    Expires {dates.dateTime(invitation.expiresAt)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <details>
          <summary>
            Workspace credentials ({preview.credentials.length})
          </summary>
          <p>
            Credentials stay in their own workspace with their existing scopes
            and expiry. Destination readers can see newly enrolled metadata;
            source credentials do not travel.
          </p>
          {preview.credentials.length ? (
            <ul>
              {preview.credentials.map((credential, index) => (
                <li key={credential.workspaceId + index}>
                  <strong>{credential.name}</strong>
                  <span>
                    {names.get(credential.workspaceId)} /{" "}
                    {credential.profile ?? "Scoped credential"}
                  </span>
                  <span>Scopes: {credential.scopes.join(", ")}</span>
                  <span>
                    Owner:{" "}
                    {preview.access.find((p) => p.subject === credential.owner)
                      ?.displayName ?? credential.owner}
                  </span>
                  {credential.sourceId ? (
                    <span>
                      Source:{" "}
                      {(credential.workspaceId === preview.source.id
                        ? sourceNames
                        : destinationSourceNames
                      ).get(credential.sourceId) ?? credential.sourceId}
                    </span>
                  ) : null}
                  <span>Expires {dates.dateTime(credential.expiresAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No active credentials were recorded in either workspace.</p>
          )}
        </details>
      </section>
      <section className="transfer-section" aria-labelledby="transfer-stays">
        <h3 id="transfer-stays">What stays in {preview.source.name}</h3>
        <p>
          Provider connections, credentials, existing observations, and earlier
          Activity stay here. The destination must collect its own fresh
          evidence.
        </p>
        <p>
          People who lose current access can still read this workspace's
          historical Activity. Destination-only members cannot read that
          history. Both workspaces record the move.
        </p>
        {preview.sources.length ? (
          <ul>
            {preview.sources.map((source) => (
              <li key={source.id}>
                <strong>{source.name}</strong>
                <span>
                  {source.willDisable
                    ? "Will be disabled because no repositories remain."
                    : source.remainingRepositoryCount
                      ? `${source.remainingRepositoryCount} other repositories remain; its enabled state does not change.`
                      : "Stays disabled with no repositories."}
                </span>
                <span>
                  Destination source:{" "}
                  {destinationSourceNames.get(
                    source.destinationSourceId ?? "",
                  ) ?? "Not selected"}
                  . Destination enabled state and schedule do not change.
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {preview.clearConnectionContext.length ? (
          <details open>
            <summary>
              Connection context to clear (
              {preview.clearConnectionContext.length})
            </summary>
            <p>
              These connections stay here. Their descriptive project label is
              cleared; provider configuration and credentials are not
              transferred.
            </p>
            <ul>
              {preview.clearConnectionContext.map((connection) => (
                <li key={connection.id}>
                  {connection.name} / {connection.provider}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      {preview.resources.length ? (
        <section className="transfer-section">
          <h3>Provider resources needing resolution</h3>
          <ul>
            {preview.resources.map((resource) => (
              <li
                key={
                  resource.kind + resource.connectionId + resource.resourceKey
                }
              >
                <strong>
                  {resource.connectionName} / {resource.resourceKey}
                </strong>
                <span>
                  {resource.kind} /{" "}
                  {resource.direct
                    ? "Direct project association"
                    : "Repository-linked resource"}
                  {resource.sharedRepositoryCount
                    ? ` / Shared with ${resource.sharedRepositoryCount} other repositories`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function ProjectTransfer({
  snapshot,
  project,
  projectId,
  onClose,
  returnFocus,
}: {
  snapshot: Snapshot;
  project: Project | null;
  projectId: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [params, setParams] = useSearchParams();
  const reviewId = params.get(REVIEW_PARAM);
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const navigate = useNavigate();
  const dates = useDateTime();
  const [draft, setDraft] = useState<Choices>({
    destinationWorkspaceId: "",
    sourceBindings: [],
  });
  const [inspected, setInspected] = useState<{
    fields: TransferFields;
    preview: TransferPreview;
  } | null>(null);
  const [attempt, setAttempt] = useState<{
    fields: TransferFields;
    reviewId: string;
  } | null>(null);
  const [busy, setBusy] = useState<"preview" | "plan" | "apply" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [requiresPreview, setRequiresPreview] = useState(false);
  const [, ageReview] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const guard = useCloseGuard(
    Boolean(draft.destinationWorkspaceId || busy),
    onClose,
    onlyReviewNavigation,
  );
  const destinations = useQuery({
    queryKey: ["project-transfer-destinations", workspaceId],
    queryFn: ({ signal }) =>
      command<TransferDestinations>(
        "project_transfer_destinations",
        { workspaceId },
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      ),
    enabled: !reviewId && canAdmin,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const reviewKey = ["project-transfer-review", workspaceId, reviewId] as const;
  const review = useQuery({
    queryKey: reviewKey,
    queryFn: ({ signal }) =>
      command<TransferReview>(
        "project_transfer_review",
        { workspaceId, reviewId },
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      ),
    enabled: Boolean(reviewId) && canAdmin,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const data =
    !review.error && review.data?.fields.projectId === projectId
      ? review.data
      : undefined;
  const receiptId = data?.receipt?.reviewId;
  useEffect(() => {
    if (!receiptId) return;
    body.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [receiptId]);
  const expiresAt = data?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => ageReview((value) => value + 1), delay + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const sameChoices = Boolean(
    !requiresPreview &&
    inspected &&
    JSON.stringify(draft) === JSON.stringify(choices(inspected.fields)),
  );
  const expired = Boolean(data && Date.parse(data.expiresAt) <= Date.now());
  const valid =
    data?.state === "reviewed" && !expired && canAdmin && !review.isFetching;
  const preview = reviewId ? data?.preview : inspected?.preview;
  const retryPlan = Boolean(
    attempt &&
    ((error instanceof RequestError && error.status === 0) ||
      (error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name))),
  );
  function select(next: Choices) {
    setDraft(next);
    setAttempt(null);
    setError(null);
  }
  function reviewUrl(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set(REVIEW_PARAM, id);
    else next.delete(REVIEW_PARAM);
    setParams(next, { replace: true, preventScrollReset: true });
    setAcknowledged(false);
    body.current?.scrollTo({ top: 0 });
  }
  async function inspect() {
    if (busy || !canAdmin || !draft.destinationWorkspaceId) return;
    setBusy("preview");
    setRequiresPreview(true);
    setError(null);
    setAttempt(null);
    try {
      const signal = AbortSignal.timeout(REQUEST_MS);
      const saved = await command<Project>(
        "project_get",
        { workspaceId, projectId },
        signal,
      );
      const fields: TransferFields = {
        workspaceId,
        projectId,
        projectRevision: saved.revision,
        ...draft,
      };
      const preview = await command<TransferPreview>(
        "project_transfer_preview",
        fields,
        signal,
      );
      setInspected({ fields, preview });
      setRequiresPreview(false);
    } catch (failure) {
      if (unavailableAuthority(failure)) setInspected(null);
      setError(failure);
    } finally {
      setBusy(null);
    }
  }
  async function prepare() {
    if (busy || !canAdmin || !inspected?.preview.ready || !sameChoices) return;
    setBusy("plan");
    setError(null);
    const next = attempt ?? {
      fields: inspected.fields,
      reviewId: crypto.randomUUID(),
    };
    setAttempt(next);
    try {
      const saved = await command<TransferReview>(
        "project_transfer_plan",
        { ...next.fields, reviewId: next.reviewId },
        AbortSignal.timeout(REQUEST_MS),
      );
      client.setQueryData(
        ["project-transfer-review", workspaceId, saved.reviewId],
        saved,
      );
      reviewUrl(saved.reviewId);
    } catch (failure) {
      if (unavailableAuthority(failure)) setInspected(null);
      setError(failure);
    } finally {
      setBusy(null);
    }
  }
  function back() {
    setRequiresPreview(true);
    if (data) {
      setDraft(choices(data.fields));
      setInspected({ fields: data.fields, preview: data.preview });
    } else setInspected(null);
    setAttempt(null);
    setError(null);
    reviewUrl(null);
  }
  async function apply() {
    if (busy || !valid || !acknowledged || !data) return;
    setBusy("apply");
    setError(null);
    try {
      const receipt = await command<TransferReceipt>(
        "project_transfer_apply",
        { workspaceId, reviewId, fingerprint: data.fingerprint },
        AbortSignal.timeout(REQUEST_MS),
      );
      client.setQueryData<TransferReview>(reviewKey, {
        ...data,
        state: "applied",
        receipt,
      });
      for (const id of [
        receipt.sourceWorkspaceId,
        receipt.destinationWorkspaceId,
      ])
        void client.invalidateQueries({
          queryKey: ["workspace", id, "view"],
          refetchType: "none",
        });
      void client.invalidateQueries({
        queryKey: ["departed-resource", workspaceId],
      });
    } catch (failure) {
      setError(failure);
      const recovered = await review.refetch();
      if (recovered.data?.receipt) setError(null);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <AlertDialogContent
          className="transfer-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreHookFocus(returnFocus);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle ref={heading} tabIndex={-1}>
              {data?.receipt
                ? "Project moved"
                : reviewId
                  ? "Confirm workspace transfer"
                  : "Move project to another workspace"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {data?.receipt
                ? "The completed move is recorded below. No provider resources or credentials were moved."
                : reviewId
                  ? "Only this exact, expiring review can be confirmed. No provider resources or credentials will be moved."
                  : `Review access and dependencies for ${project?.name ?? "this project"}. Choosing a destination does not move anything.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="transfer-scroll" ref={body}>
            {!canAdmin ? (
              <p role="alert" className="permission-notice">
                Owner access is required in both workspaces. Your choices are
                preserved, but review details and confirmation are unavailable.
              </p>
            ) : (
              <>
                {error ||
                (reviewId && review.error) ||
                (!reviewId && destinations.error) ? (
                  <HookError
                    error={
                      error ?? (reviewId ? review.error : destinations.error)
                    }
                  />
                ) : null}
                {reviewId && review.isPending ? (
                  <p role="status">Loading the saved transfer review...</p>
                ) : null}
                {reviewId && review.data && !data && !review.error ? (
                  <p role="alert" className="form-error">
                    This review belongs to another project. Open it from that
                    project's original workspace.
                  </p>
                ) : null}
                {!reviewId ? (
                  <>
                    <div className="form-field">
                      <label htmlFor="transfer-destination">
                        Destination workspace
                      </label>
                      <Select
                        value={draft.destinationWorkspaceId || UNMAPPED}
                        disabled={Boolean(busy) || destinations.isPending}
                        onValueChange={(id) => {
                          select({
                            destinationWorkspaceId: id === UNMAPPED ? "" : id,
                            sourceBindings: [],
                          });
                          setInspected(null);
                        }}
                      >
                        <SelectTrigger id="transfer-destination">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNMAPPED}>
                            Choose a workspace
                          </SelectItem>
                          {destinations.data?.workspaces.map((workspace) => (
                            <SelectItem key={workspace.id} value={workspace.id}>
                              {workspace.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="field-help">
                        Only workspaces where you are an Owner are eligible.
                      </p>
                    </div>
                    {destinations.isPending ? (
                      <p role="status">Checking eligible workspaces...</p>
                    ) : destinations.data?.restriction ? (
                      <p className="permission-notice">
                        A workspace credential cannot cross workspace
                        boundaries. Use your signed-in Owner session.
                      </p>
                    ) : destinations.data &&
                      !destinations.data.workspaces.length ? (
                      <p className="permission-notice">
                        No other Owner workspaces are available. Join or set up
                        the intended workspace separately, then refresh this
                        list.
                      </p>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy) || destinations.isFetching}
                      onClick={() => void destinations.refetch()}
                    >
                      Refresh destinations
                    </Button>
                    {draft.destinationWorkspaceId ? (
                      <Button
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() => void inspect()}
                      >
                        <RefreshCw size={16} />
                        {busy === "preview"
                          ? "Inspecting dependencies..."
                          : inspected
                            ? "Refresh preview"
                            : "Inspect destination"}
                      </Button>
                    ) : null}
                    {inspected && !sameChoices ? (
                      <p role="status" className="permission-notice">
                        Refresh the preview to check these choices before
                        continuing.
                      </p>
                    ) : null}
                    {inspected?.preview.sources.length ? (
                      <section className="transfer-section">
                        <h3>Choose destination sources</h3>
                        <p>
                          Connections stay in their workspace. Explicitly
                          re-enroll each source's repositories under a matching
                          destination source.
                        </p>
                        {inspected.preview.sources.map((source) => (
                          <div className="form-field" key={source.id}>
                            <label htmlFor={"transfer-source-" + source.id}>
                              {source.name} ({source.provider})
                            </label>
                            <Select
                              value={
                                draft.sourceBindings.find(
                                  (binding) => binding.sourceId === source.id,
                                )?.destinationSourceId ?? UNMAPPED
                              }
                              disabled={Boolean(busy)}
                              onValueChange={(id) =>
                                select({
                                  ...draft,
                                  sourceBindings: [
                                    ...draft.sourceBindings.filter(
                                      (binding) =>
                                        binding.sourceId !== source.id,
                                    ),
                                    ...(id === UNMAPPED
                                      ? []
                                      : [
                                          {
                                            sourceId: source.id,
                                            destinationSourceId: id,
                                          },
                                        ]),
                                  ].sort((a, b) =>
                                    a.sourceId.localeCompare(b.sourceId),
                                  ),
                                })
                              }
                            >
                              <SelectTrigger
                                id={"transfer-source-" + source.id}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={UNMAPPED}>
                                  Choose a destination source
                                </SelectItem>
                                {inspected.preview.destinationSources
                                  .filter(
                                    (candidate) =>
                                      candidate.provider === source.provider,
                                  )
                                  .map((candidate) => (
                                    <SelectItem
                                      key={candidate.id}
                                      value={candidate.id}
                                    >
                                      {candidate.name}
                                      {candidate.enabled
                                        ? " (enabled)"
                                        : " (disabled)"}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            <p className="field-help">
                              {source.repositoryIds.length} repositories to
                              re-enroll. An emptied source will be disabled.
                            </p>
                          </div>
                        ))}
                        <a
                          href={
                            "/settings?" +
                            new URLSearchParams({
                              workspace: draft.destinationWorkspaceId,
                            })
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open destination settings in a new tab
                        </a>
                        <p className="field-help">
                          You can prepare a disabled source with no
                          repositories, then return here and refresh the
                          preview. The transfer does not enable it or grant
                          provider access.
                        </p>
                        {draft.sourceBindings.some(
                          (binding) =>
                            !inspected.preview.sources.some(
                              (source) => source.id === binding.sourceId,
                            ),
                        ) ? (
                          <Button
                            variant="outline"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              select({
                                ...draft,
                                sourceBindings: draft.sourceBindings.filter(
                                  (binding) =>
                                    inspected.preview.sources.some(
                                      (source) =>
                                        source.id === binding.sourceId,
                                    ),
                                ),
                              })
                            }
                          >
                            Remove mappings for unlinked sources
                          </Button>
                        ) : null}
                      </section>
                    ) : null}
                  </>
                ) : null}
                {data?.receipt ? (
                  <div className="transfer-result" role="status">
                    <CheckCheck size={22} />
                    <div>
                      <h3>Move recorded in both workspaces</h3>
                      <p>
                        {data.preview.project.name} moved to{" "}
                        {data.preview.destination.name} at{" "}
                        {dates.dateTime(data.receipt.completedAt)}. This receipt
                        records the original move, even if a later transfer
                        changes its location again.
                      </p>
                      <p>
                        Prior Activity and provider evidence remain in{" "}
                        {data.preview.source.name}.
                      </p>
                    </div>
                  </div>
                ) : null}
                {preview ? (
                  <>
                    <div className="transfer-route">
                      <span>{preview.source.name}</span>
                      <ArrowRight size={18} aria-label="to" />
                      <span>{preview.destination.name}</span>
                    </div>
                    {preview.blockers.length ? (
                      <section
                        className="transfer-blockers"
                        aria-labelledby="transfer-blocked"
                      >
                        <h3 id="transfer-blocked">Resolve before moving</h3>
                        <ul>
                          {preview.blockers.map((issue, index) => (
                            <li key={issue.code + index}>
                              <strong>{issue.title}</strong>
                              <p>{issue.message}</p>
                            </li>
                          ))}
                        </ul>
                        <p>
                          No metadata has moved. Refresh the preview after
                          resolving these dependencies.
                        </p>
                      </section>
                    ) : null}
                    <TransferFacts preview={preview} />
                  </>
                ) : null}
                {data && !data.receipt ? (
                  <>
                    <p className="transfer-muted">
                      Prepared by {data.actor}. Expires{" "}
                      {dates.dateTime(data.expiresAt)}. Access and dependencies
                      are checked again on confirmation.
                    </p>
                    {expired || data.state === "stale" ? (
                      <p role="alert" className="permission-notice">
                        This review {expired ? "expired" : "is stale"}. Return
                        to your choices and refresh the preview. Nothing will be
                        moved with this review.
                      </p>
                    ) : null}
                    <label className="project-checkbox">
                      <Checkbox
                        checked={acknowledged}
                        disabled={!valid || Boolean(busy)}
                        onCheckedChange={(value) =>
                          setAcknowledged(value === true)
                        }
                      />
                      <span>
                        I reviewed the access changes and understand that
                        credentials and earlier history stay in the original
                        workspace.
                      </span>
                    </label>
                  </>
                ) : null}
                {reviewId ? (
                  <div className="transfer-review-reference">
                    <span>Review reference</span>
                    <code>{reviewId}</code>
                    <Button
                      variant="outline"
                      disabled={Boolean(busy) || review.isFetching}
                      onClick={() => {
                        setError(null);
                        void review.refetch();
                      }}
                    >
                      Inspect saved result
                    </Button>
                    <p>
                      If a response was interrupted, inspect this same review
                      before attempting another move. Reloading this URL
                      preserves the review reference.
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <div className="transfer-actions">
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={data?.receipt ? guard.saved : guard.requestClose}
            >
              {data?.receipt ? "Close receipt" : "Cancel"}
            </Button>
            {data?.receipt ? (
              <Button
                onClick={() => {
                  const receipt = data.receipt!;
                  guard.saved();
                  navigate(
                    projectHref(
                      receipt.destinationWorkspaceId,
                      receipt.projectId,
                    ),
                  );
                }}
              >
                Open project in destination <ArrowRight size={16} />
              </Button>
            ) : reviewId ? (
              <>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={back}
                >
                  Back to choices
                </Button>
                <Button
                  disabled={
                    !valid || !acknowledged || Boolean(busy) || Boolean(error)
                  }
                  onClick={() => void apply()}
                >
                  {busy === "apply" ? "Moving project..." : "Confirm move"}
                </Button>
              </>
            ) : (
              <Button
                disabled={
                  !canAdmin ||
                  Boolean(busy) ||
                  !sameChoices ||
                  !inspected?.preview.ready ||
                  (Boolean(error) && !retryPlan)
                }
                onClick={() => void prepare()}
              >
                {busy === "plan"
                  ? "Preparing review..."
                  : retryPlan
                    ? "Retry preparing review"
                    : "Review transfer"}
              </Button>
            )}
          </div>
        </AlertDialogContent>
      </AlertDialog>
      <DiscardDialog guard={guard} busy={Boolean(busy)} />
    </>
  );
}
