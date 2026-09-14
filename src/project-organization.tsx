import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Location } from "react-router-dom";
import { restoreVisibleFocus } from "./lib/focus";
import {
  CAPABILITY,
  type Project,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import {
  PROJECT_ORGANIZATION_LIMITS,
  PROJECT_ORGANIZATION_PARAM,
  PROJECT_PRESENTATION_KEYS,
  newOrganizationProject,
  projectOrganizationPlanInput,
  suggestProject,
  type ProjectOrganizationFields,
  type ProjectOrganizationReceipt,
  type ProjectOrganizationReview,
  type ProjectPresentation,
} from "../shared/project-organization";
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
import { ProjectPriorities } from "./project-priorities";
import { IMPORTANCE_LABELS, PORTFOLIO_LABELS } from "./project-inventory";
import { command, RequestError } from "./lib/api";
import { pendingReview } from "./lib/pending-review";
import { useDateTime } from "./date-time";
import "./project-organization.css";

type DraftTarget = ProjectPresentation & {
  key: string;
  name: string;
  before: Project | null;
};
type Selection = Pick<Repository, "id" | "fullName" | "revision" | "projectId">;
const timeout = () =>
  AbortSignal.timeout(PROJECT_ORGANIZATION_LIMITS.REQUEST_TIMEOUT_MS);
const labelCount = (count: number, singular: string, plural = singular + "s") =>
  `${count} ${count === 1 ? singular : plural}`;
function reviewNavigation(current: Location, next: Location) {
  const a = new URLSearchParams(current.search),
    b = new URLSearchParams(next.search);
  a.delete(PROJECT_ORGANIZATION_PARAM);
  b.delete(PROJECT_ORGANIZATION_PARAM);
  return current.pathname === next.pathname && a.toString() === b.toString();
}
function fromProject(project: Project): DraftTarget {
  return {
    key: project.id,
    name: project.name,
    before: project,
    importance: project.importance,
    importanceNote: project.importanceNote,
    portfolio: project.portfolio,
  };
}
function pending(workspaceId: string, planId: string, value?: boolean) {
  return pendingReview("organization", workspaceId, planId, value);
}

function previewPage<T>(rows: T[], page: number) {
  const size = PROJECT_ORGANIZATION_LIMITS.PREVIEW_PAGE_SIZE;
  const visible = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  return rows.slice((visible - 1) * size, visible * size);
}
function OrganizationPages({
  name,
  count,
  page,
  onPage,
}: {
  name: string;
  count: number;
  page: number;
  onPage: (page: number) => void;
}) {
  const size = PROJECT_ORGANIZATION_LIMITS.PREVIEW_PAGE_SIZE;
  if (count <= size) return null;
  const pages = Math.ceil(count / size),
    visible = Math.min(page, pages);
  return (
    <nav className="organization-actions" aria-label={name + " pages"}>
      <p>
        {(visible - 1) * size + 1} to {Math.min(visible * size, count)} of{" "}
        {count}
      </p>
      <Button
        variant="outline"
        disabled={visible === 1}
        onClick={() => onPage(visible - 1)}
      >
        Previous
      </Button>
      <Button
        variant="outline"
        disabled={visible === pages}
        onClick={() => onPage(visible + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

export function ProjectOrganizationEditor({
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
  const [step, setStep] = useState<"select" | "configure" | "review">(
    initialReviewId ? "review" : "select",
  );
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, DraftTarget>>({});
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [priorityPage, setPriorityPage] = useState(1);
  const [review, setReview] = useState<ProjectOrganizationReview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const initialId = useRef(initialReviewId);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const cache = useQueryClient();
  const { dateTime, calendarDate } = useDateTime();
  const receipt = review?.receipt;
  const allowed = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const selected = Object.values(selection).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
  const usedTargets = [...new Set(selected.map((repo) => assignments[repo.id]))]
    .map((key) => targets[key!])
    .filter((target): target is DraftTarget => Boolean(target));
  const candidates = snapshot.repositories
    .filter(
      (repo) =>
        (includeArchived || repo.lifecycle === "active") &&
        repo.fullName.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const pageCount = Math.max(
    1,
    Math.ceil(candidates.length / PROJECT_ORGANIZATION_LIMITS.PAGE_SIZE),
  );
  const visiblePage = Math.min(page, pageCount);
  const visible = candidates.slice(
    (visiblePage - 1) * PROJECT_ORGANIZATION_LIMITS.PAGE_SIZE,
    visiblePage * PROJECT_ORGANIZATION_LIMITS.PAGE_SIZE,
  );
  const room = (rows: Repository[]) =>
    selected.length + rows.filter((row) => !selection[row.id]).length <=
    PROJECT_ORGANIZATION_LIMITS.REPOSITORIES;
  const guard = useCloseGuard(
    !receipt && (selected.length > 0 || Boolean(review) || busy || uncertain),
    onClose,
    reviewNavigation,
  );
  const changed =
    selected.some(
      (repo) =>
        snapshot.repositories.find((row) => row.id === repo.id)?.revision !==
        repo.revision,
    ) ||
    usedTargets.some(
      (target) =>
        target.before &&
        snapshot.projects.find((project) => project.id === target.before!.id)
          ?.revision !== target.before.revision,
    );
  const expired = Boolean(review && Date.parse(review.expiresAt) <= now);
  const fields: ProjectOrganizationFields = {
    workspaceId,
    repositories: selected.map((repo) => ({
      repositoryId: repo.id,
      revision: repo.revision,
      targetKey: assignments[repo.id] ?? "",
    })),
    targets: usedTargets.map((target) =>
      target.before
        ? {
            key: target.key,
            kind: "existing",
            projectId: target.before.id,
            revision: target.before.revision,
            patch: Object.fromEntries(
              PROJECT_PRESENTATION_KEYS.filter(
                (key) =>
                  JSON.stringify(target[key]) !==
                  JSON.stringify(target.before![key]),
              ).map((key) => [key, target[key]]),
            ),
          }
        : {
            key: target.key,
            kind: "new",
            project: {
              name: target.name,
              importance: target.importance,
              importanceNote: target.importanceNote,
              portfolio: target.portfolio,
            },
          },
    ),
  };
  const valid = projectOrganizationPlanInput.safeParse(fields);
  const reviewAssignments =
    review?.repositories.filter((row) => row.before?.id !== row.after.id)
      .length ?? 0;
  const reviewProjects =
    review?.projects.filter(
      (project) => !project.before || project.changed.length,
    ).length ?? 0;
  const reviewRepositories = [...(review?.repositories ?? [])].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
  const reviewTargets = [
    ...new Set(reviewRepositories.map((row) => row.after.id)),
  ].map((id) => review!.projects.find((project) => project.projectId === id)!);

  function hydrate(next: ProjectOrganizationReview) {
    setAssignmentPage(1);
    setPriorityPage(1);
    const keys = new Map(
      next.projects.map((project) => [project.key, project.projectId]),
    );
    setReview(next);
    setSelection(
      Object.fromEntries(
        next.repositories.map((row) => [
          row.repositoryId,
          {
            id: row.repositoryId,
            fullName: row.fullName,
            revision: row.revision,
            projectId: row.before?.id ?? row.after.id,
          },
        ]),
      ),
    );
    setAssignments(
      Object.fromEntries(
        next.fields.repositories.map((row) => [
          row.repositoryId,
          keys.get(row.targetKey)!,
        ]),
      ),
    );
    setTargets(
      Object.fromEntries(
        next.projects.map((project) => [
          project.projectId,
          {
            key: project.projectId,
            before: project.before,
            name: project.after.name,
            importance: project.after.importance,
            importanceNote: project.after.importanceNote,
            portfolio: project.after.portfolio,
          },
        ]),
      ),
    );
    setStep("review");
    setNow(Date.now());
    const unresolved = !next.receipt && pending(workspaceId, next.planId);
    setUncertain(unresolved);
    if (next.receipt) pending(workspaceId, next.planId, false);
  }
  useEffect(() => {
    if (!initialId.current) return;
    const abort = new AbortController();
    setBusy(true);
    command<ProjectOrganizationReview>(
      "projects_organize_review",
      { workspaceId, planId: initialId.current },
      AbortSignal.any([abort.signal, timeout()]),
    )
      .then((next) => {
        if (!abort.signal.aborted) hydrate(next);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
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

  function select(rows: Repository[]) {
    if (!room(rows)) return;
    const nextSelection = { ...selection },
      nextAssignments = { ...assignments },
      nextTargets = { ...targets };
    for (const repo of rows) {
      if (nextSelection[repo.id]) continue;
      nextSelection[repo.id] = repo;
      if (nextAssignments[repo.id] && nextTargets[nextAssignments[repo.id]!])
        continue;
      const suggestion = suggestProject(repo, snapshot.projects);
      const existing = snapshot.projects.find(
        (project) => project.id === suggestion.projectId,
      );
      const target = existing
        ? fromProject(existing)
        : {
            key: crypto.randomUUID(),
            ...newOrganizationProject(suggestion.name),
            before: null,
          };
      nextTargets[target.key] ??= target;
      nextAssignments[repo.id] = target.key;
    }
    setSelection(nextSelection);
    setAssignments(nextAssignments);
    setTargets(nextTargets);
  }
  function exclude(id: string) {
    setSelection((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }
  function assign(ids: string[], key: string) {
    if (key === "create-new") {
      const name =
        ids.length === 1
          ? selection[ids[0]!]!.fullName.split("/")[1]!
          : "New project";
      const target = {
        key: crypto.randomUUID(),
        ...newOrganizationProject(name),
        before: null,
      };
      setTargets((previous) => ({ ...previous, [target.key]: target }));
      key = target.key;
    } else if (!targets[key]) {
      const project = snapshot.projects.find((project) => project.id === key);
      if (!project) return;
      setTargets((previous) => ({
        ...previous,
        [key]: fromProject(project),
      }));
    }
    setAssignments((previous) => ({
      ...previous,
      ...Object.fromEntries(ids.map((id) => [id, key])),
    }));
  }
  function targetOptions() {
    return (
      <>
        <SelectItem value="create-new">Create a new project</SelectItem>
        {usedTargets
          .filter((target) => !target.before)
          .map((target) => (
            <SelectItem key={target.key} value={target.key}>
              New: {target.name || "Unnamed project"}
            </SelectItem>
          ))}
        {snapshot.projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
            {project.lifecycle === "archived" ? " (archived)" : ""}
          </SelectItem>
        ))}
        {usedTargets
          .filter(
            (target) =>
              target.before &&
              !snapshot.projects.some(
                (project) => project.id === target.before!.id,
              ),
          )
          .map((target) => (
            <SelectItem key={target.key} value={target.key} disabled>
              {target.name} (unavailable)
            </SelectItem>
          ))}
      </>
    );
  }
  function refresh() {
    void cache.invalidateQueries({ queryKey: ["workspace", workspaceId] });
  }
  async function prepare() {
    if (busy || !valid.success) return;
    setBusy(true);
    setError("");
    try {
      const next = await command<ProjectOrganizationReview>(
        "projects_organize_plan",
        valid.data,
        timeout(),
      );
      setReview(next);
      setAssignmentPage(1);
      setPriorityPage(1);
      setStep("review");
      setNow(Date.now());
      onReview(next.planId);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The review could not be prepared. Your choices are preserved.",
      );
      refresh();
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
      const next = await command<ProjectOrganizationReview>(
        "projects_organize_review",
        { workspaceId, planId: id },
        timeout(),
      );
      hydrate(next);
      if (next.state === "ready" && uncertain)
        setError(
          "No receipt has arrived yet. Check again or retry this same review; an earlier Apply may still finish.",
        );
      refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The receipt could not be checked. Keep this review and retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    pending(workspaceId, review.planId, true);
    try {
      const saved = await command<ProjectOrganizationReceipt>(
        "projects_organize_apply",
        {
          workspaceId,
          planId: review.planId,
          fingerprint: review.fingerprint,
        },
        timeout(),
      );
      setReview({ ...review, state: "applied", receipt: saved });
      setUncertain(false);
      pending(workspaceId, review.planId, false);
    } catch (failure) {
      const rejected =
        failure instanceof RequestError && failure.status === 409;
      setUncertain(!rejected);
      if (rejected) {
        setReview({ ...review, state: "stale" });
        pending(workspaceId, review.planId, false);
      }
      setError(
        (failure instanceof Error
          ? failure.message
          : "The Apply response was interrupted.") +
          (!rejected
            ? " Check the original receipt or retry this same review before starting another batch."
            : ""),
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }
  function useLatest() {
    setSelection((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, row]) => [
          id,
          snapshot.repositories.find((repo) => repo.id === id) ?? row,
        ]),
      ),
    );
    setTargets((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([key, target]) => {
          const latest = target.before
            ? snapshot.projects.find(
                (project) => project.id === target.before!.id,
              )
            : null;
          if (!latest || !target.before) return [key, target];
          const patch = Object.fromEntries(
            PROJECT_PRESENTATION_KEYS.filter(
              (field) =>
                JSON.stringify(target[field]) !==
                JSON.stringify(target.before![field]),
            ).map((field) => [field, target[field]]),
          );
          return [key, { ...fromProject(latest), ...patch }];
        }),
      ),
    );
    setError("");
  }
  function previewPages(
    name: string,
    count: number,
    page: number,
    onPage: (page: number) => void,
    anchor: string,
  ) {
    return (
      <OrganizationPages
        name={name}
        count={count}
        page={page}
        onPage={(next) => {
          onPage(next);
          const element = document.getElementById(anchor);
          element?.focus({ preventScroll: true });
          element?.scrollIntoView({ block: "start" });
        }}
      />
    );
  }
  function displayProject(project: ProjectPresentation, compact = false) {
    return (
      <dl className="organization-diff">
        <div>
          <dt>Importance</dt>
          <dd>{IMPORTANCE_LABELS[project.importance]}</dd>
        </div>
        {!compact || project.importanceNote ? (
          <div>
            <dt>Importance note</dt>
            <dd>{project.importanceNote || "None"}</dd>
          </div>
        ) : null}
        <div>
          <dt>Portfolio</dt>
          <dd>{PORTFOLIO_LABELS[project.portfolio.status]}</dd>
        </div>
        {!compact || project.portfolio.reason ? (
          <div>
            <dt>Portfolio reason</dt>
            <dd>{project.portfolio.reason || "None"}</dd>
          </div>
        ) : null}
        {!compact || project.portfolio.url ? (
          <div>
            <dt>Listing URL</dt>
            <dd>{project.portfolio.url || "None"}</dd>
          </div>
        ) : null}
        {!compact || project.portfolio.reviewDate ? (
          <div>
            <dt>Review date</dt>
            <dd>{calendarDate(project.portfolio.reviewDate)}</dd>
          </div>
        ) : null}
      </dl>
    );
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
          className="organization-dialog"
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreVisibleFocus(
              returnFocus?.isConnected
                ? returnFocus
                : document.querySelector<HTMLElement>("main h1,main h2"),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle ref={heading} tabIndex={-1}>
              {receipt
                ? "Projects organized"
                : step === "review"
                  ? "Review project organization"
                  : "Organize repositories"}
            </DialogTitle>
            <DialogDescription>
              {receipt ? "Changes saved." : "Nothing changes until Apply."}
            </DialogDescription>
            {!receipt ? (
              <p className="organization-muted">
                {step === "select"
                  ? "1. Select repositories"
                  : step === "configure"
                    ? "2. Choose projects and priorities"
                    : "3. Review and apply"}
              </p>
            ) : null}
          </DialogHeader>
          <div className="organization-scroll" ref={scroll} aria-busy={busy}>
            <fieldset
              className="organization-content"
              disabled={busy || !allowed}
            >
              {error ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
              {!allowed ? (
                <p role="alert">
                  Your access no longer permits organization changes. Your
                  choices are preserved.
                </p>
              ) : null}
              {receipt ? (
                <>
                  <p role="status">
                    Created{" "}
                    {labelCount(receipt.createdProjectIds.length, "project")},
                    updated priorities for{" "}
                    {labelCount(receipt.updatedProjectIds.length, "project")},
                    and assigned{" "}
                    {labelCount(
                      receipt.assignedRepositoryIds.length,
                      "repository",
                      "repositories",
                    )}
                    .
                  </p>
                  <p>
                    Applied {dateTime(receipt.appliedAt)}.{" "}
                    {receipt.unchangedRepositoryIds.length} assignments already
                    matched.
                  </p>
                  <p className="organization-muted">
                    This page URL reopens the original review and receipt for
                    the same identity.
                  </p>
                  {review?.repositories.map((row) => (
                    <article
                      key={row.repositoryId}
                      className="organization-row"
                    >
                      <h3>{row.fullName}</h3>
                      <p>
                        {row.before?.name ?? "Unavailable project"} to{" "}
                        <strong>{row.after.name}</strong>
                      </p>
                    </article>
                  ))}
                </>
              ) : step === "select" ? (
                <>
                  <Input
                    aria-label="Find repositories to organize"
                    placeholder="Find repositories..."
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                    }}
                  />
                  <div className="organization-actions">
                    <label className="organization-checkbox">
                      <Checkbox
                        checked={includeArchived}
                        onCheckedChange={(value) => {
                          setIncludeArchived(value === true);
                          setPage(1);
                        }}
                      />
                      Include archived repositories
                    </label>
                  </div>
                  <div className="organization-actions">
                    <p role="status">
                      {selected.length} of{" "}
                      {PROJECT_ORGANIZATION_LIMITS.REPOSITORIES} selected
                    </p>
                    <Button
                      variant="outline"
                      disabled={!visible.length || !room(visible)}
                      onClick={() => select(visible)}
                    >
                      Select this page
                    </Button>
                    {candidates.length > visible.length &&
                    candidates.length <=
                      PROJECT_ORGANIZATION_LIMITS.REPOSITORIES ? (
                      <Button
                        variant="outline"
                        disabled={!room(candidates)}
                        onClick={() => select(candidates)}
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
                    className="organization-selection"
                    aria-label="Repositories to organize"
                  >
                    {visible.map((repo) => {
                      const suggestion = suggestProject(
                        repo,
                        snapshot.projects,
                      );
                      return (
                        <li key={repo.id}>
                          <Checkbox
                            id={"organize-" + repo.id}
                            checked={Boolean(selection[repo.id])}
                            disabled={
                              !selection[repo.id] &&
                              selected.length ===
                                PROJECT_ORGANIZATION_LIMITS.REPOSITORIES
                            }
                            onCheckedChange={(value) =>
                              value ? select([repo]) : exclude(repo.id)
                            }
                          />
                          <label htmlFor={"organize-" + repo.id}>
                            <strong>{repo.fullName}</strong>
                            <span>
                              {suggestion.name} / {suggestion.reason}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {!visible.length ? (
                    <p>No repositories match these filters.</p>
                  ) : null}
                  <nav
                    className="organization-actions"
                    aria-label="Organization selection pages"
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
                  <div className="organization-actions">
                    <h3 id="organization-assignments-heading" tabIndex={-1}>
                      Repository assignments
                    </h3>
                    <Select
                      value=""
                      onValueChange={(key) =>
                        assign(
                          selected.map((repo) => repo.id),
                          key,
                        )
                      }
                    >
                      <SelectTrigger aria-label="Group all selected repositories">
                        <SelectValue placeholder="Group all into one project" />
                      </SelectTrigger>
                      <SelectContent>{targetOptions()}</SelectContent>
                    </Select>
                  </div>
                  <p className="organization-muted">
                    Keep separate projects or choose a shared project. Only
                    selected assignments will change.
                  </p>
                  {changed ? (
                    <div className="organization-notice">
                      <p>
                        Repositories or projects changed while you were editing.
                        Your choices have not been replaced.
                      </p>
                      <Button variant="outline" onClick={useLatest}>
                        Use latest repository and project versions
                      </Button>
                    </div>
                  ) : null}
                  <div className="organization-assignments">
                    {previewPages(
                      "Assignment",
                      selected.length,
                      assignmentPage,
                      setAssignmentPage,
                      "organization-assignments-heading",
                    )}
                    {previewPage(selected, assignmentPage).map((repo) => (
                      <article
                        className="organization-assignment"
                        key={repo.id}
                      >
                        <div>
                          <h4>{repo.fullName}</h4>
                          <p className="organization-muted">
                            From{" "}
                            {snapshot.projects.find(
                              (project) => project.id === repo.projectId,
                            )?.name ??
                              (repo.projectId
                                ? "Unavailable project"
                                : "Project unavailable")}
                          </p>
                        </div>
                        <Select
                          value={assignments[repo.id]}
                          onValueChange={(key) => assign([repo.id], key)}
                        >
                          <SelectTrigger
                            aria-label={"Project for " + repo.fullName}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>{targetOptions()}</SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          aria-label={"Exclude " + repo.fullName}
                          onClick={() => exclude(repo.id)}
                        >
                          Exclude
                        </Button>
                        {!snapshot.repositories.some(
                          (row) => row.id === repo.id,
                        ) ? (
                          <p className="field-error">
                            This repository left the workspace. Exclude it
                            before reviewing.
                          </p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                  <h3 id="organization-priorities-heading" tabIndex={-1}>
                    Project priorities
                  </h3>
                  <p className="organization-muted">
                    One decision per project, shared by its repositories.
                    Existing decisions stay unchanged unless edited.
                  </p>
                  {previewPages(
                    "Project priority",
                    usedTargets.length,
                    priorityPage,
                    setPriorityPage,
                    "organization-priorities-heading",
                  )}
                  {previewPage(usedTargets, priorityPage).map((target) => (
                    <section
                      key={target.key}
                      className="organization-row"
                      aria-label={
                        "Priorities for " + (target.name || "unnamed project")
                      }
                    >
                      {target.before ? (
                        <h4>{target.name}</h4>
                      ) : (
                        <div className="form-field">
                          <label htmlFor={target.key + "-name"}>
                            New project name
                          </label>
                          <Input
                            id={target.key + "-name"}
                            value={target.name}
                            maxLength={80}
                            onChange={(event) =>
                              setTargets((previous) => ({
                                ...previous,
                                [target.key]: {
                                  ...target,
                                  name: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                      )}
                      <p className="organization-muted">
                        {target.before ? "Existing project" : "New project"}.{" "}
                        {labelCount(
                          selected.filter(
                            (repo) => assignments[repo.id] === target.key,
                          ).length,
                          "selected repository",
                          "selected repositories",
                        )}
                        .
                      </p>
                      <details>
                        <summary>
                          {IMPORTANCE_LABELS[target.importance]} importance /
                          Portfolio: {PORTFOLIO_LABELS[target.portfolio.status]}{" "}
                          <span className="organization-edit-label">
                            Edit priorities
                          </span>
                        </summary>
                        <ProjectPriorities
                          id={target.key}
                          value={target}
                          onChange={(value) =>
                            setTargets((previous) => ({
                              ...previous,
                              [target.key]: { ...target, ...value },
                            }))
                          }
                        />
                      </details>
                    </section>
                  ))}
                  {!selected.length ? (
                    <p>No repositories selected. Go back to selection.</p>
                  ) : !valid.success ? (
                    <p role="status" className="field-error">
                      {valid.error.issues[0]?.message}
                    </p>
                  ) : null}
                </>
              ) : review ? (
                <>
                  <p>
                    <strong>{review.workspaceName}</strong>:{" "}
                    {labelCount(reviewAssignments, "repository assignment")} and{" "}
                    {labelCount(
                      reviewProjects,
                      "project creation or priority change",
                      "project creations or priority changes",
                    )}
                    .
                  </p>
                  <p className="organization-muted">
                    Reviewed as {review.actor}. Expires{" "}
                    {dateTime(review.expiresAt)}.
                  </p>
                  <p>
                    Expectations, descriptions, provider settings and direct
                    resource links are unchanged. Repository-derived project
                    context follows these assignments; earlier Activity keeps
                    its original context.
                  </p>
                  {expired || review.state === "stale" ? (
                    <p className="organization-notice" role="status">
                      {expired
                        ? "This review expired."
                        : "This review is no longer current."}{" "}
                      {uncertain
                        ? "An earlier Apply may still finish. Check the original receipt or retry the same review."
                        : "Go back to your choices and prepare a fresh review."}
                    </p>
                  ) : null}
                  <h3 id="organization-assignments-heading" tabIndex={-1}>
                    Repository assignments
                  </h3>
                  {previewPages(
                    "Assignment",
                    review.repositories.length,
                    assignmentPage,
                    setAssignmentPage,
                    "organization-assignments-heading",
                  )}
                  {previewPage(reviewRepositories, assignmentPage).map(
                    (row) => (
                      <article
                        key={row.repositoryId}
                        className="organization-row"
                      >
                        <h4>{row.fullName}</h4>
                        <p>
                          {row.before?.id === row.after.id ? (
                            <>
                              Keep <strong>{row.after.name}</strong>. No
                              assignment change.
                            </>
                          ) : (
                            <>
                              <span>
                                {row.before?.name ?? "Unavailable project"}
                              </span>{" "}
                              to{" "}
                              <strong>{row.after.name}</strong>
                            </>
                          )}
                        </p>
                      </article>
                    ),
                  )}
                  <h3 id="organization-priorities-heading" tabIndex={-1}>
                    Project decisions
                  </h3>
                  {previewPages(
                    "Project decision",
                    review.projects.length,
                    priorityPage,
                    setPriorityPage,
                    "organization-priorities-heading",
                  )}
                  {previewPage(reviewTargets, priorityPage).map((project) => (
                    <article key={project.key} className="organization-row">
                      <h4>{project.after.name}</h4>
                      {!project.before ? (
                        <>
                          <p>Create a new project with these decisions.</p>
                          {displayProject(project.after, true)}
                        </>
                      ) : project.changed.length ? (
                        <>
                          <p>
                            Project-level changes also apply to repositories
                            outside this selection.{" "}
                            {project.linkedRepositoryCount} linked at review.
                          </p>
                          <div className="organization-before-after">
                            <section>
                              <h5>Before</h5>
                              {displayProject(project.before)}
                            </section>
                            <section>
                              <h5>After</h5>
                              {displayProject(project.after)}
                            </section>
                          </div>
                        </>
                      ) : (
                        <p>
                          Keep existing project decisions. No metadata change.
                        </p>
                      )}
                    </article>
                  ))}
                  {!reviewAssignments && !reviewProjects ? (
                    <p role="status">
                      Everything already matches. There is nothing to apply.
                    </p>
                  ) : null}
                  <details>
                    <summary>Review reference</summary>
                    <p className="organization-reference">{review.planId}</p>
                    <p className="organization-reference">
                      {review.fingerprint}
                    </p>
                    <p>The page URL preserves this review and its receipt.</p>
                  </details>
                </>
              ) : (
                <p role="status">
                  {busy
                    ? "Loading saved review..."
                    : "The saved review is unavailable. Check it again or close this editor."}
                </p>
              )}
            </fieldset>
          </div>
          <div className="organization-footer">
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
                    disabled={!allowed || !selected.length}
                    onClick={() => setStep("configure")}
                  >
                    Choose projects
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
                      disabled={busy || !allowed || !valid.success || changed}
                      onClick={prepare}
                    >
                      {busy ? "Preparing review..." : "Review organization"}
                    </Button>
                  </>
                ) : (
                  <>
                    {review ? (
                      <Button
                        variant="outline"
                        disabled={busy || uncertain}
                        onClick={() => {
                          setReview(null);
                          setError("");
                          setStep("configure");
                          onReview(null);
                        }}
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
                              (!reviewAssignments && !reviewProjects)))
                        }
                        onClick={apply}
                      >
                        {busy
                          ? "Confirming..."
                          : uncertain
                            ? "Retry same review"
                            : "Apply organization"}
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
