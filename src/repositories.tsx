import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  type SetURLSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  Activity,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderGit2,
  GitPullRequest,
  KeyRound,
  Monitor,
  Pencil,
  PackageCheck,
  Plus,
  Search,
  ScanSearch,
  ShieldCheck,
  Tag,
  Webhook,
} from "lucide-react";
import {
  CAPABILITY,
  assessRepository,
  type Snapshot,
  type Repository,
  type Assessment,
  type Project,
} from "../shared/domain";
import { CLASSIFICATION_LABELS, HEALTH_LABELS } from "../shared/presentation";
import { EXPECTATION_REVIEW_PARAM } from "../shared/expectation-bulk";
import { FLEET_REVIEW_PARAM } from "../shared/fleet-discovery";
import { RepositoryEditor } from "./repository-editor";
import { StatusBadge } from "./components/ui/status";
import { HEALTH_TONES } from "./lib/status-tones";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  INVENTORY_FILTERS,
  INVENTORY_PAGE_SIZES,
  INVENTORY_SORTS,
  inventoryQuery,
  repositoryInventory,
  withInventoryContext,
} from "./repository-inventory";
import { RepositoryOverview } from "./repository-overview";
import { ActivityView } from "./activity";
import { DepartedResource } from "./departed-resource";
import { RepositoryResourcesView } from "./repository-resources";
import { repositoryHref } from "./resource-repositories";
import { projectHref } from "./project-inventory";
import "./github.css";
const SecretsView = lazy(() =>
  import("./secrets").then((module) => ({ default: module.SecretsView })),
);
const RepositoryAccessDialog = lazy(() =>
  import("./repository-access").then((module) => ({
    default: module.RepositoryAccessDialog,
  })),
);
const RepositoryReleases = lazy(() =>
  import("./releases").then((module) => ({
    default: module.RepositoryReleases,
  })),
);
const RepositoryWork = lazy(() =>
  import("./repository-work").then((module) => ({
    default: module.RepositoryWork,
  })),
);
const RepositoryDependencies = lazy(() =>
  import("./dependencies").then((module) => ({ default: module.RepositoryDependencies })),
);
const ExpectationBulkEditor = lazy(() =>
  import("./expectation-bulk").then((module) => ({
    default: module.ExpectationBulkEditor,
  })),
);
const INVENTORY_CLOCK_MS = 60 * 1000;
const FleetEnrollment = lazy(() =>
  import("./fleet-enrollment").then((module) => ({
    default: module.FleetEnrollment,
  })),
);

const REPOSITORY_SECTIONS = [
  {
    id: "overview",
    label: "Overview",
    Icon: FolderGit2,
    description: "Expectations and provider evidence",
  },
  {
    id: "work",
    label: "Work",
    Icon: GitPullRequest,
    description: "Open pull requests, reviews, checks and issues",
  },
  {
    id: "releases",
    label: "Releases",
    Icon: Tag,
    description: "Published releases and deployment evidence",
  },
  { id: "dependencies", label: "Dependencies", Icon: PackageCheck, description: "Temporary overrides and dependency maintenance" },
  {
    id: "hooks",
    label: "Hooks",
    Icon: Webhook,
    description: "Related subscriptions and delivery recovery",
  },
  {
    id: "monitoring",
    label: "Monitoring",
    Icon: Monitor,
    description: "Related monitor targets and incidents",
  },
  {
    id: "secrets",
    label: "Secrets",
    Icon: KeyRound,
    description: "Related configuration inventory, management, and operations",
  },
  {
    id: "activity",
    label: "Activity",
    Icon: Activity,
    description: "Goals, decisions, and recorded operations",
  },
] as const;

function repositoryPath(repository: Repository) {
  return (
    "/repositories/" +
    repository.id +
    "?workspace=" +
    encodeURIComponent(repository.workspaceId)
  );
}

export function HealthBadge({
  repository,
  snapshot,
  assessment: providedAssessment,
}: {
  repository: Repository;
  snapshot: Snapshot;
  assessment?: Assessment;
}) {
  const assessment =
    providedAssessment ?? assessRepository(repository, snapshot.observations);
  const label =
    repository.lifecycle === "archived"
      ? "Archived"
      : HEALTH_LABELS[assessment.health];
  return (
    <StatusBadge
      tone={
        repository.lifecycle === "archived"
          ? "neutral"
          : HEALTH_TONES[assessment.health]
      }
      className={"health-badge health-" + assessment.health}
    >
      {label}
    </StatusBadge>
  );
}

export function RepositoriesView({
  snapshot,
  // Keep the data-route setter so sequential controls commit before the next input
  setParams,
  scopedProject,
  additionalActions,
}: {
  snapshot: Snapshot;
  setParams: SetURLSearchParams;
  scopedProject?: Project;
  additionalActions?: ReactNode;
}) {
  const [params] = useSearchParams();
  const [enrolling, setEnrolling] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const fleetButton = useRef<HTMLButtonElement>(null);
  const bulkButton = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function updateVisibility() {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), INVENTORY_CLOCK_MS);
      }
    }
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  const enrollButton = useRef<HTMLButtonElement>(null);
  const resultsSummary = useRef<HTMLParagraphElement>(null);
  const navigate = useNavigate();
  const query = inventoryQuery(params);
  if (scopedProject) query.projectId = scopedProject.id;
  const inventory = repositoryInventory(snapshot, query, now);
  const inventoryParams = new URLSearchParams(params);
  if (scopedProject) {
    inventoryParams.set("fromProject", scopedProject.id);
    inventoryParams.delete("project");
  }
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const hasFilters = Boolean(
    query.search ||
      query.classification !== "all" ||
      query.filter !== "all" ||
      (!scopedProject && query.projectId !== "all"),
  );
  function changeQuery(key: string, value: string) {
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
      resultsSummary.current?.focus({ preventScroll: true });
      resultsSummary.current?.scrollIntoView({ block: "start" });
    }
  }
  function clearFilters() {
    const next = new URLSearchParams(params);
    for (const key of ["q", "classification", "filter", "page"])
      next.delete(key);
    if (!scopedProject) next.delete("project");
    setParams(next, { preventScrollReset: true, flushSync: true });
  }
  function saved(repository: Repository) {
    setEnrolling(false);
    navigate(withInventoryContext(repositoryPath(repository), inventoryParams));
  }
  return (
    <>
      <div className="page-heading repository-inventory-heading">
        <div>
          {!scopedProject ? <div className="eyebrow">YOUR FLEET</div> : null}
          {scopedProject ? <h2>Repositories</h2> : <h1>Repositories</h1>}
          <p>
            {scopedProject
              ? "Repositories explicitly grouped in this project. Their provider permissions are unchanged."
              : snapshot.repositories.length +
                " repositories in this workspace."}
          </p>
        </div>
        <div className="resource-actions">
          {additionalActions}
          {!scopedProject &&
          snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
            <Button
              ref={fleetButton}
              variant="outline"
              disabled={!canEdit}
              onClick={() => setFleetOpen(true)}
            >
              <ScanSearch size={16} aria-hidden="true" />
              Review enrollment
            </Button>
          ) : null}
          <Button
            variant="outline"
            ref={bulkButton}
            disabled={!canEdit || !snapshot.repositories.length}
            onClick={() => setBulkOpen(true)}
          >
            <CheckCheck size={16} /> Set expectations
          </Button>
          <Button
            ref={enrollButton}
            disabled={!canEdit || !snapshot.projects.length}
            onClick={() => setEnrolling(true)}
            title={
              !canEdit
                ? "An owner or operator can enroll repositories"
                : snapshot.projects.length
                  ? "Enroll a repository in this workspace"
                  : "Create a project before enrolling a repository"
            }
          >
            <Plus size={16} />
            Enroll repository
          </Button>
        </div>
      </div>
      {!canEdit ? (
        <p className="permission-notice">
          <ShieldCheck size={15} />
          Your workspace role can view repositories but cannot change their
          expectations.
        </p>
      ) : null}
      <div className="repository-toolbar">
        <div
          className="filter-tabs"
          role="group"
          aria-label="Repository status"
        >
          {INVENTORY_FILTERS.map((item) => (
            <Button
              key={item.value}
              variant="ghost"
              aria-label={item.label}
              aria-describedby={"repository-count-" + item.value}
              aria-pressed={query.filter === item.value}
              onClick={() => changeQuery("filter", item.value)}
            >
              {item.label}
              <span
                className="repository-filter-count"
                id={"repository-count-" + item.value}
              >
                {inventory.counts[item.value]}
              </span>
            </Button>
          ))}
        </div>
      </div>
      <div className="repository-inventory-controls">
        <div className="search-input">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search repositories"
            placeholder="Find a repository..."
            value={query.search}
            onChange={(event) => changeQuery("q", event.target.value)}
          />
        </div>
        <Select
          value={query.classification}
          onValueChange={(value) => changeQuery("classification", value)}
        >
          <SelectTrigger aria-label="Repository tracking">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tracking</SelectItem>
            {Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!scopedProject ? (
          <Select
            value={query.projectId}
            onValueChange={(value) => changeQuery("project", value)}
          >
            <SelectTrigger aria-label="Filter repositories by project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {snapshot.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={query.sort}
          onValueChange={(value) => changeQuery("sort", value)}
        >
          <SelectTrigger aria-label="Sort repositories">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVENTORY_SORTS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters ? (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="repository-inventory-summary">
        <p
          ref={resultsSummary}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {inventory.total
            ? `${inventory.first}-${inventory.last} of ${inventory.total}`
            : "0"}{" "}
          repositories
          {hasFilters ? " matching filters" : " active"}
        </p>
        <div className="repository-page-size">
          <label htmlFor="repository-page-size">Per page</label>
          <Select
            value={String(query.pageSize)}
            onValueChange={(value) => changeQuery("pageSize", value)}
          >
            <SelectTrigger id="repository-page-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVENTORY_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {inventory.total ? (
        <table className="repository-inventory" role="table">
          <caption className="sr-only">Repository inventory</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                Repository
              </th>
              <th scope="col" role="columnheader">
                Project
              </th>
              <th scope="col" role="columnheader">
                Tracking
              </th>
              <th scope="col" role="columnheader">
                Status
              </th>
              <th scope="col" role="columnheader">
                Evidence
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {inventory.rows.map(
              ({ repository, assessment, projectName, reviewDue }) => (
                <tr key={repository.id} role="row">
                  <th
                    scope="row"
                    role="rowheader"
                    className="repository-inventory-name"
                  >
                    <Link
                      to={withInventoryContext(
                        repositoryPath(repository),
                        inventoryParams,
                      )}
                    >
                      <FolderGit2 size={17} aria-hidden="true" />
                      <h2>{repository.fullName}</h2>
                    </Link>
                  </th>
                  <td role="cell" data-label="Project">
                    {projectName ? (
                      <Link
                        className="repository-project-link"
                        to={projectHref(
                          snapshot.workspace.id,
                          repository.projectId,
                        )}
                      >
                        {projectName}
                      </Link>
                    ) : (
                      <span className="repository-unassigned">
                        Project unavailable
                      </span>
                    )}
                  </td>
                  <td role="cell" data-label="Tracking">
                    {CLASSIFICATION_LABELS[repository.classification]}
                  </td>
                  <td role="cell" data-label="Status">
                    <div className="repository-inventory-status">
                      <HealthBadge
                        repository={repository}
                        snapshot={snapshot}
                        assessment={assessment}
                      />
                      {reviewDue ? (
                        <span className="review-due">
                          <Clock3 size={14} aria-hidden="true" />
                          Review overdue
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td role="cell" data-label="Evidence">
                    {assessment.freshness === "fresh"
                      ? "Fresh evidence"
                      : assessment.freshness === "stale"
                        ? "Refresh needed"
                        : "Awaiting evidence"}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">
          <FolderGit2 size={28} />
          <h2>
            {snapshot.repositories.length
              ? "No repositories match"
              : snapshot.projects.length
                ? "Enroll a repository you maintain"
                : "Start with a project"}
          </h2>
          <p>
            {snapshot.repositories.length
              ? "Try another status, tracking type, repository name, description, or project."
              : snapshot.projects.length
                ? "Choose its owning project and expectations, then connect evidence sources to see how things are doing."
                : "Repositories and enrolled operational resources belong to projects. Create the maintained effort first."}
          </p>
          {!snapshot.repositories.length &&
          !snapshot.projects.length &&
          canEdit ? (
            <Button asChild>
              <Link
                to={
                  "/projects?" +
                  new URLSearchParams({ workspace: snapshot.workspace.id })
                }
              >
                Create project
              </Link>
            </Button>
          ) : null}
        </div>
      )}
      {inventory.total ? (
        <nav className="repository-pagination" aria-label="Repository pages">
          <p>
            Page {inventory.page} of {inventory.pageCount}
          </p>
          <Button
            variant="outline"
            disabled={inventory.page === 1}
            onClick={() => changeQuery("page", String(inventory.page - 1))}
            aria-label="Previous repository page"
          >
            <ChevronLeft size={16} aria-hidden="true" />
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={inventory.page === inventory.pageCount}
            onClick={() => changeQuery("page", String(inventory.page + 1))}
            aria-label="Next repository page"
          >
            Next
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
      {bulkOpen || params.has(EXPECTATION_REVIEW_PARAM) ? (
        <Suspense fallback={<p role="status">Loading expectation editor...</p>}>
          <ExpectationBulkEditor
            snapshot={snapshot}
            initialReviewId={params.get(EXPECTATION_REVIEW_PARAM)}
            projectId={scopedProject?.id}
            returnFocus={bulkButton.current}
            onReview={(id) => {
              setBulkOpen(true);
              const next = new URLSearchParams(params);
              if (id) next.set(EXPECTATION_REVIEW_PARAM, id);
              else next.delete(EXPECTATION_REVIEW_PARAM);
              setParams(next, {
                replace: true,
                preventScrollReset: true,
                flushSync: true,
              });
            }}
            onClose={() => {
              setBulkOpen(false);
              if (params.has(EXPECTATION_REVIEW_PARAM)) {
                const next = new URLSearchParams(params);
                next.delete(EXPECTATION_REVIEW_PARAM);
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
      {fleetOpen || params.has(FLEET_REVIEW_PARAM) ? (
        <Suspense fallback={<p role="status">Loading enrollment review...</p>}>
          <FleetEnrollment
            snapshot={snapshot}
            initialReviewId={params.get(FLEET_REVIEW_PARAM)}
            returnFocus={fleetButton.current}
            onReview={(id) => {
              setFleetOpen(true);
              const next = new URLSearchParams(params);
              if (id) next.set(FLEET_REVIEW_PARAM, id);
              else next.delete(FLEET_REVIEW_PARAM);
              setParams(next, {
                replace: true,
                preventScrollReset: true,
                flushSync: true,
              });
            }}
            onClose={() => {
              setFleetOpen(false);
              if (params.has(FLEET_REVIEW_PARAM)) {
                const next = new URLSearchParams(params);
                next.delete(FLEET_REVIEW_PARAM);
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
      {enrolling ? (
        <RepositoryEditor
          snapshot={snapshot}
          onClose={() => setEnrolling(false)}
          onSaved={saved}
          returnFocus={enrollButton}
          defaultProjectId={scopedProject?.id}
        />
      ) : null}
    </>
  );
}

export function RepositoryDetail({ snapshot }: { snapshot: Snapshot }) {
  const { repositoryId } = useParams();
  const [params] = useSearchParams();
  const section =
    REPOSITORY_SECTIONS.find((item) => item.id === params.get("section"))?.id ??
    "overview";
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const accessButton = useRef<HTMLButtonElement>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const repository = snapshot.repositories.find(
    (item) => item.id === repositoryId,
  );
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  if (!repository)
    return (
      <DepartedResource
        snapshot={snapshot}
        kind="repository"
        resourceId={repositoryId!}
      />
    );
  return (
    <>
      <Link
        className="back-link repository-detail-back"
        to={
          params.get("fromProject")
            ? projectHref(
                snapshot.workspace.id,
                params.get("fromProject")!,
                "repositories",
                params,
              )
            : withInventoryContext(
                "/repositories?workspace=" +
                  encodeURIComponent(snapshot.workspace.id),
                params,
              )
        }
      >
        <ArrowLeft size={14} />
        {params.get("fromProject") ? "Project repositories" : "Repositories"}
      </Link>
      <div className="page-heading repository-heading">
        <div>
          <div className="eyebrow">
            {CLASSIFICATION_LABELS[repository.classification].toUpperCase()}{" "}
            REPOSITORY
          </div>
          <h1 tabIndex={-1}>{repository.fullName}</h1>
          <p>{repository.description || "No description added"}</p>
        </div>
        <div className="repository-heading-actions">
          <Button
            ref={accessButton}
            variant="outline"
            onClick={() => setAccessOpen(true)}
          >
            <ShieldCheck size={16} aria-hidden="true" />
            Access &amp; operations
          </Button>
          <Button
            ref={editButton}
            variant="outline"
            disabled={!canEdit}
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
            Edit expectations
          </Button>
        </div>
      </div>
      {saved ? (
        <div className="save-success" role="status">
          <CheckCheck size={16} />
          Expectations saved. The change is recorded in Activity.
        </div>
      ) : null}
      {!canEdit ? (
        <p className="permission-notice">
          <ShieldCheck size={15} />
          This session cannot edit expectations. See Access &amp; operations for
          the required role or client scope.
        </p>
      ) : null}
      <nav className="repository-sections" aria-label="Repository sections">
        {REPOSITORY_SECTIONS.map(({ id, label, Icon }) => (
          <Button
            asChild
            variant={id === section ? "secondary" : "ghost"}
            key={id}
          >
            <Link
              to={withInventoryContext(
                repositoryHref(snapshot.workspace.id, repository.id, id),
                params,
              )}
              aria-current={id === section ? "page" : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      {section === "overview" ? (
        <RepositoryOverview
          key={repository.id}
          repository={repository}
          snapshot={snapshot}
        />
      ) : section === "dependencies" ? (
        <Suspense fallback={<p role="status">Loading dependency maintenance...</p>}>
          <RepositoryDependencies key={repository.id} snapshot={snapshot} repository={repository} />
        </Suspense>
      ) : section === "work" ? (
        <Suspense
          fallback={<p role="status">Loading pull requests and issues...</p>}
        >
          <RepositoryWork
            key={repository.id}
            snapshot={snapshot}
            repository={repository}
          />
        </Suspense>
      ) : section === "releases" ? (
        <Suspense fallback={<p role="status">Loading release evidence...</p>}>
          <RepositoryReleases
            key={repository.id}
            snapshot={snapshot}
            repository={repository}
          />
        </Suspense>
      ) : section === "secrets" ? (
        <Suspense fallback={<p role="status">Loading repository Secrets...</p>}>
          <SecretsView snapshot={snapshot} repositoryId={repository.id} />
        </Suspense>
      ) : section === "activity" ? (
        <div className="repository-journal">
          <ActivityView
            snapshot={snapshot}
            scopedRepositoryId={repository.id}
          />
        </div>
      ) : (
        <RepositoryResourcesView
          key={section}
          snapshot={snapshot}
          repository={repository}
          kind={section === "hooks" ? "hook" : "monitor"}
        />
      )}
      {accessOpen ? (
        <Suspense fallback={<p role="status">Loading access guidance...</p>}>
          <RepositoryAccessDialog
            key={repository.id}
            snapshot={snapshot}
            repository={repository}
            onClose={() => setAccessOpen(false)}
            returnFocus={accessButton}
          />
        </Suspense>
      ) : null}
      {editing ? (
        <RepositoryEditor
          initial={repository}
          snapshot={snapshot}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setSaved(true);
          }}
          returnFocus={editButton}
        />
      ) : null}
    </>
  );
}
