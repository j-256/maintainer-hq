import { z } from "zod";
import { idSchema, reviewIsDue, workspaceInput, type Snapshot } from "./domain";
import {
  COVERAGE_GUIDANCE,
  COVERAGE_LABELS,
  githubCoverageHref,
  githubCoverageRepositories,
} from "./github-coverage";
import { GITHUB_CHECK_LABELS, GITHUB_LIMITS } from "./github-evidence";
import { coverageAssessment } from "./coverage-evidence";

export const ATTENTION_LIMITS = Object.freeze({
  PAGE_SIZE: 25,
  CONNECTIONS_VISIBLE: 2,
  CONTEXT_ROWS: 1000,
  RESPONSE_BYTES: 256 * 1024,
  READ_FRESH_MS: 60_000,
  CLOCK_MS: 30_000,
  DAY_MS: 24 * 60 * 60_000,
});
export const ATTENTION_CATEGORIES = ["problem", "review", "coverage"] as const;
export const ATTENTION_LABELS = Object.freeze({
  problem: "Problems",
  review: "Reviews",
  coverage: "Coverage gaps",
});
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];
export const attentionFilterInput = z.object({
  category: z.enum(["all", ...ATTENTION_CATEGORIES]).default("all"),
  search: z.string().trim().max(160).default(""),
  page: z.number().int().min(1).max(1000).default(1),
});
export const workspaceAttentionInput = workspaceInput
  .extend(attentionFilterInput.shape)
  .strict();
export const attentionConnectionInput = workspaceInput
  .extend({
    connectionId: idSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export type AttentionItem = {
  id: string;
  category: AttentionCategory;
  severity: "critical" | "warning" | "info";
  title: string;
  reason: string;
  action: string;
  href: string;
  repositoryIds: string[];
  projectIds: string[];
  connectionId: string | null;
  resourceKey: string | null;
  source: string | null;
  observedAt: string | null;
  expiresAt: string | null;
};
export type AttentionContext = Pick<
  Snapshot,
  "workspace" | "projects" | "repositories" | "observations" | "connections"
>;
export type AttentionConnection = {
  connectionId: string;
  revision: number;
  readAt: string;
  items: AttentionItem[];
  limited: boolean;
};

export function attentionHref(
  path: string,
  workspaceId: string,
  fields: Record<string, string> = {},
) {
  return (
    path + "?" + new URLSearchParams({ workspace: workspaceId, ...fields })
  );
}

export function workspaceAttention(
  context: AttentionContext,
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const active = context.repositories.filter(
    (repository) => repository.lifecycle === "active",
  );
  const coverage = githubCoverageRepositories(
    active,
    context.connections,
    context.observations,
    now,
  );
  const coverageByRepository = new Map(
    coverage.map((row) => [row.repository.id, row]),
  );
  const latest = new Map<string, AttentionContext["observations"][number]>();
  const operational = new Map<string, AttentionContext["observations"]>();
  for (const observation of context.observations) {
    if (
      observation.resourceType === "repository" &&
      observation.details.coverage
    ) {
      const key = JSON.stringify([
        observation.provider,
        observation.resourceId,
      ]);
      const group = operational.get(key) ?? [];
      group.push(observation);
      operational.set(key, group);
    }
    if (
      observation.provider !== "github" ||
      observation.resourceType !== "repository"
    )
      continue;
    const key = JSON.stringify([observation.sourceId, observation.resourceId]);
    const previous = latest.get(key);
    if (
      !previous ||
      Date.parse(observation.observedAt) > Date.parse(previous.observedAt)
    )
      latest.set(key, observation);
  }
  const workspaceId = context.workspace.id;
  for (const repository of active) {
    const href = attentionHref(
      "/repositories/" + encodeURIComponent(repository.id),
      workspaceId,
    );
    const base = {
      repositoryIds: [repository.id],
      projectIds: repository.projectId ? [repository.projectId] : [],
      connectionId: null,
      resourceKey: null,
      source: null,
      observedAt: null,
      expiresAt: null,
    };
    for (const [key, provider, title] of [
      ["hooks", "hookrelay", "Hookrelay"],
      ["monitoring", "endpoint-monitor", "Monitoring"],
    ] as const) {
      if (repository.expectations[key] !== "required") continue;
      const observations =
        operational.get(JSON.stringify([provider, repository.id])) ?? [];
      const satisfied =
        observations.length > 0 &&
        observations.every(
          (item) =>
            Date.parse(item.expiresAt) > now &&
            coverageAssessment(item.details.coverage!, now).satisfied,
        );
      if (!satisfied)
        items.push({
          ...base,
          id: "coverage:" + key + ":" + repository.id,
          category: "coverage",
          severity: "info",
          title: title + " requirement needs evidence",
          reason: observations.length
            ? "Linked-resource evidence is incomplete, expired, or does not meet the assessment rule."
            : "Check this repository's linked resources, or configure and link the required coverage.",
          action: "Inspect operational checks",
          href: href + "#repository-operational-title",
        });
    }
    if (reviewIsDue(repository, now))
      items.push({
        ...base,
        id: "review:repository:" + repository.id,
        category: "review",
        severity: "info",
        title: "Expectation review overdue",
        reason:
          "Review date: " +
          repository.expectations.reviewDate +
          ". Confirm the requirements still fit this repository.",
        action: "Review expectations",
        href,
      });
    const row = coverageByRepository.get(repository.id)!;
    const required =
      repository.expectations.ci === "required" ||
      repository.expectations.security === "required" ||
      repository.expectations.visibility !== "any";
    if (row.state !== "current" && (row.sources.length || required)) {
      const gaps = row.sources.filter((source) => source.state !== "current");
      const unread = [
        ...new Set(
          gaps.flatMap(
            (source) =>
              source.evidence?.checks
                .filter((check) => check.state !== "observed")
                .map((check) => GITHUB_CHECK_LABELS[check.key]) ?? [],
          ),
        ),
      ];
      items.push({
        ...base,
        id: "coverage:github:" + repository.id,
        category: "coverage",
        severity: "info",
        title: COVERAGE_LABELS[row.state],
        reason:
          (unread.length ? unread.join(", ") + ". " : "") +
          COVERAGE_GUIDANCE[row.state],
        action: "Inspect coverage",
        href: githubCoverageHref(workspaceId, repository.id),
        source: gaps.map((source) => source.name).join(", ") || null,
        observedAt: gaps[0]?.evidence?.observedAt ?? null,
      });
    }
    for (const source of row.sources) {
      if (
        !source.enabled ||
        !source.credentialConfigured ||
        !source.configurationValid ||
        !source.evidence?.identityMatches
      )
        continue;
      const observation = latest.get(
        JSON.stringify([source.id, repository.id]),
      );
      if (!observation) continue;
      if (Date.parse(observation.observedAt) > now) {
        items.push({
          ...base,
          id: "future-evidence:" + source.id + ":" + repository.id,
          category: "coverage",
          severity: "info",
          title: "Evidence timestamp is ahead of this clock",
          reason:
            "Check the observation time and clock before using this result. It does not establish a current CI or security outcome.",
          action: "Inspect coverage",
          href: githubCoverageHref(workspaceId, repository.id),
          source: source.name,
          observedAt: observation.observedAt,
        });
        continue;
      }
      if (Date.parse(observation.expiresAt) <= now) continue;
      const evidence = observation.details;
      const observed = {
        ...base,
        connectionId: source.id,
        source: source.name,
        observedAt: observation.observedAt,
        expiresAt: observation.expiresAt,
      };
      const upstream =
        GITHUB_LIMITS.WEB_ORIGIN +
        "/" +
        repository.fullName.split("/").map(encodeURIComponent).join("/");
      if (
        repository.expectations.ci === "required" &&
        evidence.ci !== "passing" &&
        evidence.ci !== "failing"
      )
        items.push({
          ...observed,
          id: "ci-unverified:" + source.id + ":" + repository.id,
          category: "coverage",
          severity: "info",
          title: "Required CI is not verified",
          reason:
            "Readable check endpoints do not establish a passing CI result. Inspect the default-branch checks and configured expectation.",
          action: "Inspect CI evidence",
          href,
        });
      if (evidence.ci === "failing")
        items.push({
          ...observed,
          id: "ci:" + source.id + ":" + repository.id,
          category: "problem",
          severity: "warning",
          title: "Default-branch CI is failing",
          reason:
            "A failing check or commit status was observed" +
            (evidence.github?.headSha
              ? " at " + evidence.github.headSha.slice(0, 12)
              : "") +
            ".",
          action: "Open commit checks",
          href: evidence.github?.headSha
            ? upstream + "/commit/" + evidence.github.headSha + "/checks"
            : href,
        });
      if (evidence.openFindings && evidence.openFindings > 0)
        items.push({
          ...observed,
          id: "security:" + source.id + ":" + repository.id,
          category: "problem",
          severity: "warning",
          title: evidence.openFindings + " open security findings",
          reason:
            "Findings were observed in the collected security categories. Unread categories may contain additional findings.",
          action: "Open security findings",
          href: upstream + "/security",
        });
      if (
        repository.expectations.security === "required" &&
        evidence.openFindings === undefined &&
        source.state === "current"
      )
        items.push({
          ...observed,
          id: "security-unverified:" + source.id + ":" + repository.id,
          category: "coverage",
          severity: "info",
          title: "Required security result is not verified",
          reason:
            "Readable endpoints without a finding count do not establish a security result. Inspect the collected evidence and configured expectation.",
          action: "Inspect security evidence",
          href,
        });
      if (
        repository.expectations.visibility !== "any" &&
        evidence.visibility === undefined &&
        source.state === "current"
      )
        items.push({
          ...observed,
          id: "visibility-unverified:" + source.id + ":" + repository.id,
          category: "coverage",
          severity: "info",
          title: "Required visibility is not verified",
          reason:
            "The observation does not report repository visibility. Inspect its evidence before comparing it with the configured expectation.",
          action: "Inspect repository evidence",
          href,
        });
      if (
        repository.expectations.visibility !== "any" &&
        evidence.visibility &&
        evidence.visibility !== repository.expectations.visibility
      )
        items.push({
          ...observed,
          id: "visibility:" + source.id + ":" + repository.id,
          category: "problem",
          severity: "warning",
          title: "Repository visibility differs from expectations",
          reason:
            "Expected " +
            repository.expectations.visibility +
            "; GitHub reported " +
            evidence.visibility +
            ".",
          action: "Review repository",
          href,
        });
    }
  }
  for (const project of context.projects) {
    if (
      project.lifecycle !== "active" ||
      !project.portfolio.reviewDate ||
      now <
        Date.parse(project.portfolio.reviewDate + "T00:00:00Z") +
          ATTENTION_LIMITS.DAY_MS
    )
      continue;
    items.push({
      id: "review:project:" + project.id,
      category: "review",
      severity: "info",
      title: "Portfolio review overdue",
      reason:
        "Review date: " +
        project.portfolio.reviewDate +
        ". Revisit this project's inclusion decision.",
      action: "Review Portfolio",
      href: attentionHref(
        "/projects/" + encodeURIComponent(project.id),
        workspaceId,
      ),
      repositoryIds: [],
      projectIds: [project.id],
      connectionId: null,
      resourceKey: null,
      source: null,
      observedAt: null,
      expiresAt: null,
    });
  }
  return items;
}

export function ageAttention(item: AttentionItem, now: number): AttentionItem {
  if (
    !item.expiresAt ||
    now < Date.parse(item.expiresAt) ||
    item.category === "review"
  )
    return item;
  return {
    ...item,
    category: "coverage",
    severity: "info",
    title: "Last known: " + item.title,
    reason: "This evidence needs a refresh. " + item.reason,
  };
}

export function attentionPage(
  items: AttentionItem[],
  context: Pick<AttentionContext, "projects" | "repositories">,
  input: z.input<typeof attentionFilterInput>,
  now: number,
) {
  const filter = attentionFilterInput.parse(input);
  const repositories = new Map(
    context.repositories.map((repository) => [repository.id, repository]),
  );
  const projects = new Map(
    context.projects.map((project) => [project.id, project]),
  );
  const categoryRank = { problem: 0, review: 1, coverage: 2 };
  const severityRank = { critical: 0, warning: 1, info: 2 };
  const importanceRank = { critical: 0, high: 1, standard: 2 };
  const contextName = (item: AttentionItem) =>
    [
      ...item.repositoryIds.map((id) => repositories.get(id)?.fullName ?? ""),
      ...item.projectIds.map((id) => projects.get(id)?.name ?? ""),
      item.resourceKey ?? "",
      item.source ?? "",
    ].join(" ");
  const importance = (item: AttentionItem) =>
    Math.min(
      2,
      ...item.projectIds.map(
        (id) => importanceRank[projects.get(id)?.importance ?? "standard"],
      ),
    );
  const aged = items.map((item) => ageAttention(item, now));
  const counts = { problem: 0, review: 0, coverage: 0 };
  for (const item of aged) counts[item.category]++;
  const needle = filter.search.toLowerCase();
  const filtered = aged
    .filter(
      (item) =>
        (filter.category === "all" || item.category === filter.category) &&
        (!needle ||
          (item.title + " " + item.reason + " " + contextName(item))
            .toLowerCase()
            .includes(needle)),
    )
    .sort(
      (a, b) =>
        categoryRank[a.category] - categoryRank[b.category] ||
        severityRank[a.severity] - severityRank[b.severity] ||
        importance(a) - importance(b) ||
        contextName(a).localeCompare(contextName(b)) ||
        a.id.localeCompare(b.id),
    );
  const pages = Math.max(
    1,
    Math.ceil(filtered.length / ATTENTION_LIMITS.PAGE_SIZE),
  );
  const page = Math.min(filter.page, pages);
  const offset = (page - 1) * ATTENTION_LIMITS.PAGE_SIZE;
  return {
    items: filtered.slice(offset, offset + ATTENTION_LIMITS.PAGE_SIZE),
    counts,
    total: filtered.length,
    page,
    pages,
    offset,
  };
}
