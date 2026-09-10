import {
  assessRepository,
  type Observation,
  type Project,
  type Snapshot,
} from "../shared/domain";

export const IMPORTANCE_LABELS = {
  standard: "Standard",
  high: "High",
  critical: "Critical",
} as const;
export const IMPORTANCE_RANK = { standard: 2, high: 1, critical: 0 } as const;
export const PORTFOLIO_LABELS = {
  undecided: "Undecided",
  planned: "Planned",
  listed: "Listed",
  excluded: "Excluded",
} as const;
export const PROJECT_FILTERS = [
  { value: "active", label: "Active projects" },
  { value: "attention", label: "Needs attention" },
  { value: "archived", label: "Archived" },
] as const;
export const PROJECT_SORTS = [
  { value: "importance", label: "Importance first" },
  { value: "attention", label: "Attention first" },
  { value: "name", label: "Name A to Z" },
  { value: "updated", label: "Recently updated" },
] as const;
export const PROJECT_PAGE_SIZES = [25, 50, 100] as const;
const QUERY_KEYS = [
  "q",
  "filter",
  "importance",
  "portfolio",
  "sort",
  "page",
  "pageSize",
] as const;
const PROJECT_LIST_CONTEXT = "projectList";
const REPOSITORY_QUERY_KEYS = [
  "q",
  "filter",
  "classification",
  "sort",
  "page",
  "pageSize",
] as const;
const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;
const ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export type ProjectQuery = ReturnType<typeof projectQuery>;
export type ProjectInventoryRow = {
  project: Project;
  repositoryCount: number;
  activeRepositoryCount: number;
  warningCount: number;
  unknownCount: number;
  reviewDue: boolean;
};
export function projectReviewDue(project: Project, now = Date.now()) {
  const review = project.portfolio.reviewDate;
  return Boolean(
    review && now >= Date.parse(review + "T00:00:00.000Z") + CALENDAR_DAY_MS,
  );
}
function copyQuery(
  target: URLSearchParams,
  source: URLSearchParams,
  keys: readonly string[],
) {
  for (const key of keys) {
    const value = source.get(key);
    if (value) target.set(key, value);
  }
}
export function projectHref(
  workspaceId: string,
  projectId: string,
  section = "overview",
  context?: URLSearchParams,
) {
  const params = new URLSearchParams({ workspace: workspaceId, section });
  if (context) {
    params.set(PROJECT_LIST_CONTEXT, projectListContext(context));
    if (
      section === "repositories" &&
      (context.get("section") === "repositories" || context.has("fromProject"))
    )
      copyQuery(params, context, REPOSITORY_QUERY_KEYS);
  }
  return "/projects/" + encodeURIComponent(projectId) + "?" + params;
}
export function projectListContext(context: URLSearchParams) {
  const list = new URLSearchParams();
  copyQuery(
    list,
    context.has(PROJECT_LIST_CONTEXT)
      ? new URLSearchParams(context.get(PROJECT_LIST_CONTEXT)!)
      : context.has("section") ||
          context.has("fromProject") ||
          context.has("project")
        ? new URLSearchParams()
        : context,
    QUERY_KEYS,
  );
  return list.toString();
}
export function projectsHref(workspaceId: string, context?: URLSearchParams) {
  const params = new URLSearchParams({ workspace: workspaceId });
  if (context)
    copyQuery(
      params,
      context.has(PROJECT_LIST_CONTEXT)
        ? new URLSearchParams(context.get(PROJECT_LIST_CONTEXT)!)
        : context,
      QUERY_KEYS,
    );
  return "/projects?" + params;
}
export function projectQuery(params: URLSearchParams) {
  const page = Number(params.get("page"));
  const importance = params.get("importance");
  const portfolio = params.get("portfolio");
  return {
    search: params.get("q") ?? "",
    filter:
      PROJECT_FILTERS.find((value) => value.value === params.get("filter"))
        ?.value ?? "active",
    importance:
      importance && Object.hasOwn(IMPORTANCE_LABELS, importance)
        ? (importance as Project["importance"])
        : ("all" as const),
    portfolio:
      portfolio && Object.hasOwn(PORTFOLIO_LABELS, portfolio)
        ? (portfolio as Project["portfolio"]["status"])
        : ("all" as const),
    sort:
      PROJECT_SORTS.find((value) => value.value === params.get("sort"))
        ?.value ?? "importance",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize:
      PROJECT_PAGE_SIZES.find(
        (value) => value === Number(params.get("pageSize")),
      ) ?? PROJECT_PAGE_SIZES[0],
  };
}
export function projectInventoryRows(
  snapshot: Pick<Snapshot, "projects" | "repositories" | "observations">,
  now = Date.now(),
) {
  const rows = new Map<string, ProjectInventoryRow>(
    snapshot.projects.map((project) => [
      project.id,
      {
        project,
        repositoryCount: 0,
        activeRepositoryCount: 0,
        warningCount: 0,
        unknownCount: 0,
        reviewDue: projectReviewDue(project, now),
      },
    ]),
  );
  const observations = new Map<string, Observation[]>();
  for (const observation of snapshot.observations) {
    if (observation.resourceType !== "repository") continue;
    const existing = observations.get(observation.resourceId);
    if (existing) existing.push(observation);
    else observations.set(observation.resourceId, [observation]);
  }
  for (const repository of snapshot.repositories) {
    const row = rows.get(repository.projectId);
    if (!row) continue;
    row.repositoryCount += 1;
    if (repository.lifecycle === "archived") continue;
    row.activeRepositoryCount += 1;
    const assessment = assessRepository(
      repository,
      observations.get(repository.id) ?? [],
      now,
    );
    if (assessment.health === "warning" || assessment.health === "critical")
      row.warningCount += 1;
    if (assessment.health === "unknown") row.unknownCount += 1;
  }
  return [...rows.values()];
}
function matchesFilter(
  row: ProjectInventoryRow,
  filter: ProjectQuery["filter"],
) {
  return filter === "archived"
    ? row.project.lifecycle === "archived"
    : row.project.lifecycle === "active" &&
        (filter !== "attention" || row.warningCount > 0 || row.reviewDue);
}
export function projectInventory(
  snapshot: Pick<Snapshot, "projects" | "repositories" | "observations">,
  query: ProjectQuery,
  now = Date.now(),
) {
  const all = projectInventoryRows(snapshot, now);
  const counts = Object.fromEntries(
    PROJECT_FILTERS.map(({ value }) => [
      value,
      all.filter((row) => matchesFilter(row, value)).length,
    ]),
  ) as Record<ProjectQuery["filter"], number>;
  const search = query.search.trim().toLocaleLowerCase();
  const matching = all.filter(
    (row) =>
      matchesFilter(row, query.filter) &&
      (query.importance === "all" ||
        row.project.importance === query.importance) &&
      (query.portfolio === "all" ||
        row.project.portfolio.status === query.portfolio) &&
      (row.project.name + " " + row.project.description)
        .toLocaleLowerCase()
        .includes(search),
  );
  matching.sort((a, b) => {
    const name =
      ORDER.compare(a.project.name, b.project.name) ||
      a.project.id.localeCompare(b.project.id);
    if (query.sort === "name") return name;
    if (query.sort === "updated")
      return (
        Date.parse(b.project.updatedAt) - Date.parse(a.project.updatedAt) ||
        name
      );
    const importance =
      IMPORTANCE_RANK[a.project.importance] -
      IMPORTANCE_RANK[b.project.importance];
    if (query.sort === "attention")
      return (
        Number(b.warningCount > 0 || b.reviewDue) -
          Number(a.warningCount > 0 || a.reviewDue) ||
        importance ||
        name
      );
    return importance || name;
  });
  const total = matching.length;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * query.pageSize;
  return {
    counts,
    total,
    page,
    pageCount,
    first: total ? start + 1 : 0,
    last: Math.min(start + query.pageSize, total),
    rows: matching.slice(start, start + query.pageSize),
  };
}
