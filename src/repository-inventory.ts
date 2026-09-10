import {
  assessRepository,
  reviewIsDue,
  type Assessment,
  type Observation,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import { IMPORTANCE_RANK } from "./project-inventory";

export const INVENTORY_FILTERS = [
  { value: "all", label: "Active repositories" },
  { value: "attention", label: "Needs attention" },
  { value: "unknown", label: "Unverified" },
  { value: "archived", label: "Archived" },
] as const;
export const INVENTORY_SORTS = [
  { value: "name", label: "Name A to Z" },
  { value: "name-desc", label: "Name Z to A" },
  { value: "attention", label: "Attention first" },
  { value: "importance", label: "Project importance first" },
  { value: "project", label: "Project A to Z" },
  { value: "updated", label: "Recently updated" },
] as const;
export const INVENTORY_PAGE_SIZES = [25, 50, 100] as const;
const INVENTORY_QUERY_KEYS = [
  "filter",
  "q",
  "classification",
  "sort",
  "page",
  "pageSize",
  "project",
  "fromProject",
  "projectList",
] as const;
const NAME_ORDER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const ATTENTION_RANK = { critical: 0, warning: 1, unknown: 3, healthy: 4 };
const REVIEW_DUE_RANK = 2;

type InventoryFilter = (typeof INVENTORY_FILTERS)[number]["value"];
type InventorySort = (typeof INVENTORY_SORTS)[number]["value"];
export type InventoryQuery = {
  filter: InventoryFilter;
  search: string;
  classification: Repository["classification"] | "all";
  projectId: string;
  sort: InventorySort;
  page: number;
  pageSize: (typeof INVENTORY_PAGE_SIZES)[number];
};
export type InventoryRow = {
  repository: Repository;
  assessment: Assessment;
  projectName: string | null;
  importance: keyof typeof IMPORTANCE_RANK;
  reviewDue: boolean;
};

export function inventoryQuery(params: URLSearchParams): InventoryQuery {
  const classification = params.get("classification");
  const page = Number(params.get("page"));
  return {
    filter:
      INVENTORY_FILTERS.find((item) => item.value === params.get("filter"))
        ?.value ?? "all",
    search: params.get("q") ?? "",
    projectId: params.get("project") ?? "all",
    classification:
      classification === "maintained" ||
      classification === "watchlist" ||
      classification === "reference"
        ? classification
        : "all",
    sort:
      INVENTORY_SORTS.find((item) => item.value === params.get("sort"))
        ?.value ?? "name",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize:
      INVENTORY_PAGE_SIZES.find(
        (size) => size === Number(params.get("pageSize")),
      ) ?? INVENTORY_PAGE_SIZES[0],
  };
}

export function withInventoryContext(href: string, params: URLSearchParams) {
  const context = new URLSearchParams();
  for (const key of INVENTORY_QUERY_KEYS) {
    const value = params.get(key);
    if (value) context.set(key, value);
  }
  return href + (context.size ? "&" + context.toString() : "");
}

function needsAttention(row: InventoryRow) {
  return (
    row.reviewDue ||
    row.assessment.health === "warning" ||
    row.assessment.health === "critical"
  );
}

function matchesStatus(row: InventoryRow, filter: InventoryFilter) {
  if (filter === "archived") return row.repository.lifecycle === "archived";
  return (
    row.repository.lifecycle === "active" &&
    (filter === "all" ||
      (filter === "attention"
        ? needsAttention(row)
        : row.assessment.health === "unknown"))
  );
}

function compareName(a: InventoryRow, b: InventoryRow) {
  return (
    NAME_ORDER.compare(a.repository.fullName, b.repository.fullName) ||
    (a.repository.id < b.repository.id
      ? -1
      : a.repository.id > b.repository.id
        ? 1
        : 0)
  );
}

function attentionRank(row: InventoryRow) {
  return Math.min(
    ATTENTION_RANK[row.assessment.health],
    row.reviewDue ? REVIEW_DUE_RANK : Infinity,
  );
}

export function repositoryInventory(
  snapshot: Pick<Snapshot, "repositories" | "observations" | "projects">,
  query: InventoryQuery,
  now = Date.now(),
) {
  const projects = new Map(
    snapshot.projects.map((project) => [project.id, project]),
  );
  const observations = new Map<string, Observation[]>();
  for (const observation of snapshot.observations) {
    if (observation.resourceType !== "repository") continue;
    const group = observations.get(observation.resourceId);
    if (group) group.push(observation);
    else observations.set(observation.resourceId, [observation]);
  }
  const all = snapshot.repositories
    .filter(
      (repository) =>
        query.projectId === "all" ||
        repository.projectId === query.projectId,
    )
    .map((repository): InventoryRow => ({
      repository,
      assessment: assessRepository(
        repository,
        observations.get(repository.id) ?? [],
        now,
      ),
      projectName: projects.get(repository.projectId)?.name ?? null,
      importance: projects.get(repository.projectId)?.importance ?? "standard",
      reviewDue: reviewIsDue(repository, now),
    }));
  const counts = Object.fromEntries(
    INVENTORY_FILTERS.map(({ value }) => [
      value,
      all.filter((row) => matchesStatus(row, value)).length,
    ]),
  ) as Record<InventoryFilter, number>;
  const search = query.search.trim().toLocaleLowerCase();
  const matching = all.filter(
    (row) =>
      matchesStatus(row, query.filter) &&
      (query.classification === "all" ||
        row.repository.classification === query.classification) &&
      [
        row.repository.fullName,
        row.repository.description,
        row.projectName ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search),
  );
  matching.sort((a, b) => {
    if (query.sort === "name-desc") return compareName(b, a);
    if (query.sort === "attention")
      return (
        attentionRank(a) - attentionRank(b) ||
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
        compareName(a, b)
      );
    if (query.sort === "importance")
      return (
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
        attentionRank(a) - attentionRank(b) ||
        compareName(a, b)
      );
    if (query.sort === "updated")
      return (
        Date.parse(b.repository.updatedAt) -
          Date.parse(a.repository.updatedAt) || compareName(a, b)
      );
    if (query.sort === "project")
      return (
        Number(a.projectName === null) - Number(b.projectName === null) ||
        NAME_ORDER.compare(a.projectName ?? "", b.projectName ?? "") ||
        compareName(a, b)
      );
    return compareName(a, b);
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
