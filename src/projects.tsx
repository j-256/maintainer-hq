import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  type SetURLSearchParams,
} from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  FolderGit2,
  KeyRound,
  Monitor,
  Pencil,
  PackageCheck,
  Plus,
  Search,
  Tag,
  Webhook,
} from "lucide-react";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import { PROJECT_ORGANIZATION_PARAM } from "../shared/project-organization";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { ProjectEditor } from "./project-editor";
import { ProjectTransfer } from "./project-transfer";
import { DepartedResource } from "./departed-resource";
import { RepositoryEditor } from "./repository-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { ActivityView } from "./activity";
import { RepositoriesView } from "./repositories";
import { ProjectResourcesView } from "./project-resources";
import { useDateTime } from "./date-time";
import {
  IMPORTANCE_LABELS,
  PORTFOLIO_LABELS,
  PROJECT_FILTERS,
  PROJECT_PAGE_SIZES,
  PROJECT_SORTS,
  projectHref,
  projectInventory,
  projectInventoryRows,
  projectQuery,
  projectsHref,
  type ProjectInventoryRow,
} from "./project-inventory";
import "./projects.css";
import "./repositories.css";
import "./repository-workspace.css";

const PROJECT_CLOCK_MS = 60 * 1000;
const ProjectReleases = lazy(() =>
  import("./releases").then((module) => ({ default: module.ProjectReleases })),
);
const ProjectDependencies = lazy(() =>
  import("./dependencies").then((module) => ({ default: module.DependenciesView })),
);
const ProjectOrganizationEditor = lazy(() =>
  import("./project-organization").then((module) => ({
    default: module.ProjectOrganizationEditor,
  })),
);
export const PROJECT_SECTIONS = [
  { id: "overview", label: "Overview", Icon: FolderKanban },
  { id: "repositories", label: "Repositories", Icon: FolderGit2 },
  { id: "releases", label: "Releases", Icon: Tag },
  { id: "dependencies", label: "Dependencies", Icon: PackageCheck },
  { id: "hooks", label: "Hooks", Icon: Webhook },
  { id: "monitoring", label: "Monitoring", Icon: Monitor },
  { id: "secrets", label: "Secrets", Icon: KeyRound },
  { id: "activity", label: "Activity", Icon: Activity },
] as const;
function useProjectClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function visible() {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), PROJECT_CLOCK_MS);
      }
    }
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}
function EvidenceSummary({ row }: { row: ProjectInventoryRow }) {
  return (
    <div className="project-evidence-summary">
      {!row.repositoryCount ? (
        <span>No repositories</span>
      ) : !row.activeRepositoryCount ? (
        <span>No active repositories</span>
      ) : (
        <>
          {row.warningCount ? (
            <span>
              {row.warningCount}{" "}
              {row.warningCount === 1
                ? "repository needs"
                : "repositories need"}{" "}
              attention
            </span>
          ) : null}
          {row.unknownCount ? (
            <span>
              {row.unknownCount} unverified{" "}
              {row.unknownCount === 1 ? "repository" : "repositories"}
            </span>
          ) : null}
          {!row.warningCount && !row.unknownCount ? (
            <span>Repository expectations met</span>
          ) : null}
        </>
      )}
      {row.reviewDue ? (
        <span className="review-due">Portfolio review overdue</span>
      ) : null}
    </div>
  );
}
export function ProjectsView({
  snapshot,
  setParams,
}: {
  snapshot: Snapshot;
  setParams: SetURLSearchParams;
}) {
  const [params] = useSearchParams();
  const now = useProjectClock();
  const [creating, setCreating] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const organizeButton = useRef<HTMLButtonElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const navigate = useNavigate();
  const query = projectQuery(params);
  const inventory = projectInventory(snapshot, query, now);
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const filtered = Boolean(
    query.search ||
    query.filter !== "active" ||
    query.importance !== "all" ||
    query.portfolio !== "all",
  );
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, {
      replace: key === "q",
      preventScrollReset: true,
      flushSync: true,
    });
    if (key === "page") {
      summary.current?.focus({ preventScroll: true });
      summary.current?.scrollIntoView({ block: "start" });
    }
  }
  function clear() {
    const next = new URLSearchParams(params);
    for (const key of ["q", "filter", "importance", "portfolio", "page"])
      next.delete(key);
    setParams(next, { preventScrollReset: true, flushSync: true });
  }
  return (
    <>
      <div className="page-heading repository-inventory-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h1>Projects</h1>
          <p>
            {snapshot.projects.length} projects, each with its own repositories
            and operational resources.
          </p>
        </div>
        <div className="resource-actions">
          <Button
            variant="outline"
            ref={organizeButton}
            disabled={!canEdit || !snapshot.repositories.length}
            onClick={() => setOrganizing(true)}
          >
            <FolderGit2 size={16} /> Organize repositories
          </Button>
          <Button
            ref={createButton}
            disabled={!canEdit}
            onClick={() => setCreating(true)}
            title={
              canEdit
                ? "Create a project"
                : "An owner or operator can create projects"
            }
          >
            <Plus size={16} /> Create project
          </Button>
        </div>
      </div>
      {!canEdit ? (
        <p className="permission-notice">
          Read-only access. An owner or operator can change project metadata.
        </p>
      ) : null}
      <div className="repository-toolbar">
        <div className="filter-tabs" role="group" aria-label="Project status">
          {PROJECT_FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              variant="ghost"
              aria-pressed={query.filter === value}
              onClick={() => change("filter", value)}
            >
              {label}
              <span className="repository-filter-count">
                {inventory.counts[value]}
              </span>
            </Button>
          ))}
        </div>
      </div>
      <div className="repository-inventory-controls">
        <div className="search-input">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search projects"
            value={query.search}
            maxLength={200}
            placeholder="Find a project..."
            onChange={(event) => change("q", event.target.value)}
          />
        </div>
        <Select
          value={query.importance}
          onValueChange={(value) => change("importance", value)}
        >
          <SelectTrigger aria-label="Filter project importance">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All importance</SelectItem>
            {Object.entries(IMPORTANCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.portfolio}
          onValueChange={(value) => change("portfolio", value)}
        >
          <SelectTrigger aria-label="Filter portfolio inclusion">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All portfolio decisions</SelectItem>
            {Object.entries(PORTFOLIO_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.sort}
          onValueChange={(value) => change("sort", value)}
        >
          <SelectTrigger aria-label="Sort projects">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_SORTS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="repository-inventory-summary">
        <p ref={summary} tabIndex={-1} role="status">
          Showing {inventory.first} to {inventory.last} of {inventory.total}{" "}
          projects
        </p>
        <div className="repository-page-size">
          <span>Per page</span>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) => change("pageSize", value)}
          >
            <SelectTrigger aria-label="Projects per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_PAGE_SIZES.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {inventory.total ? (
        <table className="repository-inventory project-inventory" role="table">
          <caption className="sr-only">Project inventory</caption>
          <thead role="rowgroup">
            <tr role="row">
              {[
                "Project",
                "Importance",
                "Portfolio",
                "Repositories",
                "Repository evidence",
              ].map((label) => (
                <th key={label} role="columnheader" scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {inventory.rows.map((row) => (
              <tr key={row.project.id} role="row">
                <th
                  scope="row"
                  role="rowheader"
                  className="repository-inventory-name"
                >
                  <Link
                    to={projectHref(
                      snapshot.workspace.id,
                      row.project.id,
                      "overview",
                      params,
                    )}
                  >
                    <FolderKanban size={17} aria-hidden="true" />
                    <h2>{row.project.name}</h2>
                  </Link>
                </th>
                <td role="cell" data-label="Importance">
                  {IMPORTANCE_LABELS[row.project.importance]}
                </td>
                <td role="cell" data-label="Portfolio">
                  {PORTFOLIO_LABELS[row.project.portfolio.status]}
                </td>
                <td role="cell" data-label="Repositories">
                  {row.repositoryCount}
                </td>
                <td role="cell" data-label="Repository evidence">
                  <EvidenceSummary row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">
          <FolderKanban size={28} />
          <h2>
            {snapshot.projects.length
              ? "No projects match"
              : "Bring your work together"}
          </h2>
          <p>
            {snapshot.projects.length
              ? "Try another name, importance, inclusion decision, or project status."
              : "Create a project on its own or enroll its first repository in the same step."}
          </p>
        </div>
      )}
      {inventory.total ? (
        <nav className="repository-pagination" aria-label="Project pages">
          <p>
            Page {inventory.page} of {inventory.pageCount}
          </p>
          <Button
            variant="outline"
            disabled={inventory.page === 1}
            onClick={() => change("page", String(inventory.page - 1))}
            aria-label="Previous project page"
          >
            <ChevronLeft size={16} /> Previous
          </Button>
          <Button
            variant="outline"
            disabled={inventory.page === inventory.pageCount}
            onClick={() => change("page", String(inventory.page + 1))}
            aria-label="Next project page"
          >
            Next <ChevronRight size={16} />
          </Button>
        </nav>
      ) : null}
      <p className="project-footnote">
        Importance orders your work; it does not change observed health.
      </p>
      {organizing || params.has(PROJECT_ORGANIZATION_PARAM) ? (
        <Suspense fallback={<p role="status">Loading project organizer...</p>}>
          <ProjectOrganizationEditor
            snapshot={snapshot}
            initialReviewId={params.get(PROJECT_ORGANIZATION_PARAM)}
            returnFocus={organizeButton.current}
            onReview={(id) => {
              setOrganizing(true);
              const next = new URLSearchParams(params);
              if (id) next.set(PROJECT_ORGANIZATION_PARAM, id);
              else next.delete(PROJECT_ORGANIZATION_PARAM);
              setParams(next, {
                replace: true,
                preventScrollReset: true,
                flushSync: true,
              });
            }}
            onClose={() => {
              setOrganizing(false);
              if (params.has(PROJECT_ORGANIZATION_PARAM)) {
                const next = new URLSearchParams(params);
                next.delete(PROJECT_ORGANIZATION_PARAM);
                setParams(next, {
                  replace: true,
                  preventScrollReset: true,
                  flushSync: true,
                });
              }
            }}
          />
        </Suspense>
      ) : null}
      {creating ? (
        <ProjectEditor
          snapshot={snapshot}
          onClose={() => setCreating(false)}
          onSaved={(project) =>
            navigate(
              projectHref(
                snapshot.workspace.id,
                project.id,
                "overview",
                params,
              ),
            )
          }
          returnFocus={createButton.current}
        />
      ) : null}
    </>
  );
}

export function ProjectDetail({
  snapshot,
  setParams,
}: {
  snapshot: Snapshot;
  setParams: SetURLSearchParams;
}) {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const dates = useDateTime();
  const now = useProjectClock();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const [linking, setLinking] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const transferButton = useRef<HTMLButtonElement>(null);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [linkingRepository, setLinkingRepository] = useState<Repository | null>(
    null,
  );
  const project = snapshot.projects.find((project) => project.id === projectId);
  const section =
    PROJECT_SECTIONS.find((item) => item.id === params.get("section"))?.id ??
    "overview";
  const transfer =
    projectId && (transferring || params.has("transfer")) ? (
      <ProjectTransfer
        key="project-transfer"
        snapshot={snapshot}
        project={project ?? null}
        projectId={projectId}
        onClose={() => {
          setTransferring(false);
          if (params.has("transfer")) {
            const next = new URLSearchParams(params);
            next.delete("transfer");
            setParams(next, { replace: true, preventScrollReset: true });
          }
        }}
        returnFocus={transferButton.current}
      />
    ) : null;
  if (!project)
    return (
      <>
        <DepartedResource
          snapshot={snapshot}
          kind="project"
          resourceId={projectId!}
        />
        {transfer}
      </>
    );
  const row = projectInventoryRows(snapshot, now).find(
    (row) => row.project.id === project.id,
  )!;
  const projectNames = new Map(
    snapshot.projects.map((value) => [value.id, value.name]),
  );
  const repositoryChoices = linking
    ? snapshot.repositories.filter(
        (repository) =>
          repository.projectId !== project.id &&
          repository.fullName
            .toLocaleLowerCase()
            .includes(repositorySearch.trim().toLocaleLowerCase()),
      )
    : [];
  return (
    <>
      <Link
        className="back-link"
        to={projectsHref(snapshot.workspace.id, params)}
      >
        <ArrowLeft size={16} /> Projects
      </Link>
      <div className="page-heading repository-heading">
        <div>
          <div className="eyebrow">
            {project.lifecycle === "archived" ? "ARCHIVED PROJECT" : "PROJECT"}
          </div>
          <h1 tabIndex={-1}>{project.name}</h1>
          {project.description ? <p>{project.description}</p> : null}
        </div>
        <div className="project-heading-actions">
          <Button
            ref={transferButton}
            variant="outline"
            disabled={!snapshot.capabilities.includes(CAPABILITY.ADMIN)}
            title="Owner access in both workspaces is required"
            onClick={() => setTransferring(true)}
          >
            <ArrowRightLeft size={16} /> Move to workspace
          </Button>
          <Button
            ref={editButton}
            variant="outline"
            disabled={!snapshot.capabilities.includes(CAPABILITY.EDIT)}
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            <Pencil size={16} /> Edit project
          </Button>
        </div>
      </div>
      {saved ? (
        <p role="status" className="save-success">
          Project saved. The change is recorded in Activity.
        </p>
      ) : null}
      {!snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
        <p className="permission-notice">
          Moving a project requires Owner access in both workspaces.
        </p>
      ) : null}
      {project.lifecycle === "archived" ? (
        <p className="permission-notice">
          This project is archived in HQ. Its provider resources and
          repositories have not been stopped or archived.
        </p>
      ) : null}
      <nav className="repository-sections" aria-label="Project sections">
        {PROJECT_SECTIONS.map(({ id, label, Icon }) => (
          <Button
            key={id}
            asChild
            variant={section === id ? "secondary" : "ghost"}
          >
            <Link
              to={projectHref(snapshot.workspace.id, project.id, id, params)}
              aria-current={section === id ? "page" : undefined}
            >
              <Icon size={16} />
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      {section === "overview" ? (
        <>
          <div className="project-summary-strip">
            <Badge variant="outline">
              {IMPORTANCE_LABELS[project.importance]} importance
            </Badge>
            <Badge variant="outline">
              Portfolio: {PORTFOLIO_LABELS[project.portfolio.status]}
            </Badge>
            <span>
              {row.repositoryCount}{" "}
              {row.repositoryCount === 1 ? "repository" : "repositories"}
            </span>
          </div>
          <div className="detail-grid">
            <section className="detail-card">
              <div className="detail-card-heading">
                <h2>Priorities and visibility</h2>
              </div>
              <dl className="project-metadata">
                <div>
                  <dt>Importance</dt>
                  <dd>{IMPORTANCE_LABELS[project.importance]}</dd>
                </div>
                {project.importanceNote ? (
                  <div>
                    <dt>Why it matters</dt>
                    <dd>{project.importanceNote}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Portfolio inclusion</dt>
                  <dd>{PORTFOLIO_LABELS[project.portfolio.status]}</dd>
                </div>
                {project.portfolio.reason ? (
                  <div>
                    <dt>Inclusion reason</dt>
                    <dd>{project.portfolio.reason}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Review date</dt>
                  <dd>
                    {dates.calendarDate(project.portfolio.reviewDate)}
                    {row.reviewDue ? " (overdue)" : ""}
                  </dd>
                </div>
                {project.portfolio.url ? (
                  <div>
                    <dt>Listing</dt>
                    <dd>
                      <a
                        href={project.portfolio.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open portfolio listing <ArrowUpRight size={14} />
                      </a>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p>
                Importance sets attention priority, not health or permissions.
                Listed is your inclusion decision, not a verified publication.
              </p>
            </section>
            <section className="detail-card">
              <div className="detail-card-heading">
                <h2>Repository evidence</h2>
              </div>
              <EvidenceSummary row={row} />
              <p>
                This summarizes repository expectations only. Hooks and
                monitoring have their own provider evidence and checks.
              </p>
              <div className="project-section-links">
                {PROJECT_SECTIONS.slice(1).map(({ id, label, Icon }) => (
                  <Button key={id} asChild variant="outline">
                    <Link
                      to={projectHref(
                        snapshot.workspace.id,
                        project.id,
                        id,
                        params,
                      )}
                    >
                      <Icon size={16} />
                      {label}
                    </Link>
                  </Button>
                ))}
              </div>
            </section>
          </div>
          <p className="project-footnote">
            Project ID <code>{project.id}</code> / Revision {project.revision} /
            Updated{" "}
            <time
              dateTime={project.updatedAt}
              title={dates.tooltip(project.updatedAt)}
            >
              {dates.dateTime(project.updatedAt)}
            </time>
          </p>
        </>
      ) : section === "repositories" ? (
        <RepositoriesView
          snapshot={snapshot}
          setParams={setParams}
          scopedProject={project}
          additionalActions={
            <Button
              ref={linkButton}
              variant="outline"
              disabled={!snapshot.capabilities.includes(CAPABILITY.EDIT)}
              onClick={() => {
                setRepositorySearch("");
                setLinking(true);
              }}
            >
              Link existing repository
            </Button>
          }
        />
      ) : section === "dependencies" ? (
        <Suspense fallback={<p role="status">Loading dependency maintenance...</p>}>
          <ProjectDependencies snapshot={snapshot} projectId={project.id} />
        </Suspense>
      ) : section === "releases" ? (
        <Suspense fallback={<p role="status">Loading project releases...</p>}>
          <ProjectReleases
            key={project.id}
            snapshot={snapshot}
            projectId={project.id}
          />
        </Suspense>
      ) : section === "activity" ? (
        <ActivityView
          key={project.id}
          snapshot={snapshot}
          scopedProjectId={project.id}
        />
      ) : (
        <ProjectResourcesView
          key={project.id + section}
          snapshot={snapshot}
          project={project}
          kind={
            section === "hooks"
              ? "hook"
              : section === "monitoring"
                ? "monitor"
                : "secret"
          }
        />
      )}
      {transfer}
      {editing ? (
        <ProjectEditor
          initial={project}
          snapshot={snapshot}
          onClose={() => setEditing(false)}
          onSaved={() => setSaved(true)}
          returnFocus={editButton.current}
        />
      ) : null}
      {linking ? (
        <Dialog open onOpenChange={setLinking}>
          <DialogContent className="project-repository-picker">
            <DialogHeader>
              <DialogTitle>Link an existing repository</DialogTitle>
              <DialogDescription>
                Choose one repository to review its project assignment. Nothing
                changes until you save the repository.
              </DialogDescription>
            </DialogHeader>
            <Input
              aria-label="Find an existing repository"
              placeholder="owner/repository"
              value={repositorySearch}
              onChange={(event) => setRepositorySearch(event.target.value)}
            />
            <div className="project-repository-choices">
              {repositoryChoices.map((repository) => (
                <Button
                  variant="outline"
                  key={repository.id}
                  onClick={() => {
                    setLinking(false);
                    setLinkingRepository(repository);
                  }}
                >
                  <span>{repository.fullName}</span>
                  <span>
                    {(repository.projectId &&
                      projectNames.get(repository.projectId)) ||
                      "Project unavailable"}
                    {repository.lifecycle === "archived"
                      ? " / Archived repository"
                      : ""}
                  </span>
                </Button>
              ))}
              {!repositoryChoices.length ? (
                <p role="status" className="field-help">
                  {repositorySearch.trim()
                    ? "No repositories match this search."
                    : "No other repositories are enrolled in this workspace. Use Enroll repository to add one."}
                </p>
              ) : null}
            </div>
            <p className="field-help">
              Assigning a repository from another project moves its current
              grouping. Historical activity keeps its original context.
            </p>
            <Button variant="outline" onClick={() => setLinking(false)}>
              Cancel
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
      {linkingRepository ? (
        <RepositoryEditor
          snapshot={snapshot}
          initial={linkingRepository}
          suggestedProjectId={project.id}
          returnFocus={linkButton}
          onClose={() => setLinkingRepository(null)}
          onSaved={() => setLinkingRepository(null)}
        />
      ) : null}
    </>
  );
}
