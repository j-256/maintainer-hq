import { z } from "zod";
import {
  idSchema,
  workspaceInput,
  type Connection,
  type Observation,
  type Repository,
} from "./domain";
import { GITHUB_CHECK_KEYS, type GitHubCheck } from "./github-evidence";
import type { GitHubRefreshState, GitHubSource } from "./github";

export const GITHUB_COVERAGE_LIMITS = Object.freeze({
  REPOSITORIES: 25,
  SOURCE_ROWS: 1000,
  RESPONSE_BYTES: 512 * 1024,
});

export const githubCoverageInput = workspaceInput
  .extend({
    repositoryIds: z
      .array(idSchema)
      .min(1)
      .max(GITHUB_COVERAGE_LIMITS.REPOSITORIES)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each repository once",
      ),
    sourceId: idSchema.nullable().default(null),
  })
  .strict();

export const COVERAGE_LABELS = Object.freeze({
  current: "Coverage current",
  unavailable: "Access or feature gaps",
  incomplete: "Evidence incomplete",
  error: "Collection error",
  limited: "Read limit reached",
  rate_limited: "Provider rate limited",
  stale: "Evidence stale",
  awaiting: "Awaiting evidence",
  not_configured: "Connection not configured",
  disabled: "Collection disabled",
  not_collected: "Not collected",
});
export type GitHubCoverageState = keyof typeof COVERAGE_LABELS;
export const COVERAGE_PRIORITY: readonly GitHubCoverageState[] = [
  "error",
  "rate_limited",
  "stale",
  "limited",
  "unavailable",
  "incomplete",
  "not_configured",
  "awaiting",
  "disabled",
  "not_collected",
  "current",
];
export const COVERAGE_GUIDANCE: Record<GitHubCoverageState, string> =
  Object.freeze({
    current: "Open the repository to review CI results and security findings.",
    unavailable:
      "Check repository access, the credential's read permissions and feature availability. A denied read does not identify which is missing.",
    incomplete:
      "Inspect the unread checks and latest receipt before drawing a conclusion.",
    error:
      "Inspect the latest receipt for the failed read before retrying collection.",
    limited:
      "Inspect receipt diagnostics and upstream results; the bounded read did not establish complete coverage.",
    rate_limited:
      "Wait for the provider cooldown, then inspect the next refresh for unread checks.",
    stale:
      "Inspect the source schedule, cooldown and latest receipt. Refreshing this page does not freshen evidence.",
    awaiting:
      "Inspect the latest refresh or queue a collection if none is active.",
    not_configured:
      "Ask a workspace owner to review the connection settings and available read-only credential.",
    disabled:
      "Enable the connection to resume collection. Old results do not become fresh when it is enabled.",
    not_collected:
      "Choose a GitHub connection only if this repository should be collected from GitHub.",
  });

export type GitHubCoverageCheck = Pick<GitHubCheck, "key" | "state" | "count">;
export type GitHubCoverageAttempt = {
  refreshId: string;
  sourceRevision: number;
  currentRevision: boolean;
  identityMatches: boolean;
  createdAt: string;
  status: GitHubRefreshState;
  attempts: number;
  updatedAt: string;
  observedAt: string | null;
};
export type GitHubCoverageSource = {
  id: string;
  name: string;
  revision: number;
  state: GitHubCoverageState;
  enabled: boolean;
  credentialConfigured: boolean;
  configurationValid: boolean;
  lastRefreshQueuedAt: string | null;
  lastCompleteAt: string | null;
  nextRefreshAt: string | null;
  retryAt: string | null;
  activeRefreshId: string | null;
  evidence: {
    observedAt: string;
    receivedAt: string;
    expiresAt: string;
    identityMatches: boolean;
    checks: GitHubCoverageCheck[];
  } | null;
  latestRefresh: GitHubCoverageAttempt | null;
};
export type GitHubCoverageRepository = {
  repository: Pick<
    Repository,
    "id" | "fullName" | "revision" | "lifecycle" | "classification"
  >;
  state: GitHubCoverageState;
  sources: GitHubCoverageSource[];
};
export type GitHubCoverage = {
  generatedAt: string;
  sourceId: string | null;
  repositories: GitHubCoverageRepository[];
};

export function isGitHubSource(source: Connection): source is GitHubSource {
  return source.provider === "github" && Boolean(source.github);
}

function checkCoverage(checks: GitHubCoverageCheck[]): GitHubCoverageState {
  if (checks.some((check) => check.state === "error")) return "error";
  if (checks.some((check) => check.state === "rate_limited"))
    return "rate_limited";
  if (checks.some((check) => check.state === "limited")) return "limited";
  if (checks.some((check) => check.state === "unavailable"))
    return "unavailable";
  return checks.every((check) => check.state === "observed")
    ? "current"
    : "incomplete";
}

export function githubCoverageRepositories(
  repositories: GitHubCoverageRepository["repository"][],
  connections: Connection[],
  observations: Observation[],
  now: number,
): GitHubCoverageRepository[] {
  const evidence = new Map<string, Observation>();
  for (const observation of observations) {
    if (
      observation.provider !== "github" ||
      observation.resourceType !== "repository"
    )
      continue;
    const key = JSON.stringify([observation.resourceId, observation.sourceId]);
    const existing = evidence.get(key);
    if (
      !existing ||
      Date.parse(existing.observedAt) < Date.parse(observation.observedAt)
    )
      evidence.set(key, observation);
  }
  const scope = new Map<string, GitHubSource[]>();
  for (const source of connections.filter(isGitHubSource)) {
    for (const repositoryId of source.repositoryIds) {
      const selected = scope.get(repositoryId) ?? [];
      selected.push(source);
      scope.set(repositoryId, selected);
    }
  }
  return repositories.map((repository) => {
    const sources = (scope.get(repository.id) ?? []).map(
      (source): GitHubCoverageSource => {
        const observation = evidence.get(
          JSON.stringify([repository.id, source.id]),
        );
        const identityMatches =
          observation?.name.toLowerCase() === repository.fullName.toLowerCase();
        const checks = GITHUB_CHECK_KEYS.map((key): GitHubCoverageCheck => {
          const check = observation?.details.github?.checks.find(
            (item) => item.key === key,
          );
          return {
            key,
            state: check?.state ?? "unobserved",
            ...(check?.count !== undefined ? { count: check.count } : {}),
          };
        });
        const expiresAt = observation ? Date.parse(observation.expiresAt) : NaN;
        const state: GitHubCoverageState = !source.enabled
          ? "disabled"
          : !source.credentialConfigured || !source.github.configurationValid
            ? "not_configured"
            : !observation || !identityMatches
              ? "awaiting"
              : !Number.isFinite(now) ||
                  !Number.isFinite(expiresAt) ||
                  expiresAt <= now
                ? "stale"
                : checkCoverage(checks);
        return {
          id: source.id,
          name: source.name,
          revision: source.revision,
          state,
          enabled: source.enabled,
          credentialConfigured: source.credentialConfigured,
          configurationValid: source.github.configurationValid,
          lastRefreshQueuedAt: source.lastAttemptAt,
          lastCompleteAt: source.lastSuccessAt,
          nextRefreshAt: source.github.nextRefreshAt,
          retryAt: source.github.retryAt,
          activeRefreshId: source.github.activeRefreshId,
          evidence: observation
            ? {
                observedAt: observation.observedAt,
                receivedAt: observation.receivedAt,
                expiresAt: observation.expiresAt,
                identityMatches,
                checks,
              }
            : null,
          latestRefresh: null,
        };
      },
    );
    const state =
      COVERAGE_PRIORITY.find((candidate) =>
        sources.some((source) => source.state === candidate),
      ) ?? "not_collected";
    return {
      repository: {
        id: repository.id,
        fullName: repository.fullName,
        revision: repository.revision,
        lifecycle: repository.lifecycle,
        classification: repository.classification,
      },
      sources,
      state,
    };
  });
}

export function githubCoverageHref(
  workspaceId: string,
  repositoryId?: string,
  sourceId?: string,
) {
  const params = new URLSearchParams({ workspace: workspaceId });
  if (repositoryId) {
    params.set("repository", repositoryId);
    params.set("lifecycle", "all");
  }
  if (sourceId) params.set("connection", sourceId);
  return "/settings/github?" + params.toString();
}
