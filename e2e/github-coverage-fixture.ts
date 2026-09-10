import {
  DEFAULT_EXPECTATIONS,
  type Observation,
  type Repository,
} from "../shared/domain";
import { GITHUB_CHECK_KEYS, type GitHubCheck } from "../shared/github-evidence";
import type { GitHubRefresh, GitHubSource } from "../shared/github";
import {
  githubCoverageInput,
  githubCoverageRepositories,
  type GitHubCoverage,
} from "../shared/github-coverage";

export function coverageFixture() {
  const workspaceId = "development";
  const now = Date.now();
  const stamp = (offset = 0) => new Date(now + offset).toISOString();
  const repositories: Repository[] = Array.from({ length: 31 }, (_, index) => ({
    id: "coverage-" + (index + 1),
    workspaceId,
    fullName: "example/service-" + String(index + 1).padStart(2, "0"),
    description: "Synthetic evidence coverage example",
    projectId: "development-default",
    classification: index % 2 === 0 ? "maintained" : "watchlist",
    lifecycle: index === 16 ? "archived" : "active",
    expectations: DEFAULT_EXPECTATIONS,
    revision: 2,
    updatedAt: stamp(),
  }));
  function source(
    id: string,
    name: string,
    repositoryIds: string[],
  ): GitHubSource {
    return {
      id,
      name,
      repositoryIds,
      provider: "github",
      enabled: true,
      revision: 3,
      credentialConfigured: true,
      freshnessMinutes: 30,
      lastAttemptAt: stamp(-120000),
      lastSuccessAt: stamp(-86400000),
      lastError: null,
      github: {
        configurationValid: true,
        credentialRef: "synthetic-read-only",
        refreshIntervalMinutes: 5,
        nextRefreshAt: stamp(180000),
        retryAt: null,
        activeRefreshId: null,
        lastRefreshId: "receipt-" + id,
        lastRefreshStatus: "partial",
      },
    };
  }
  const sources = [
    source(
      "coverage-primary",
      "GitHub - selected service repositories",
      repositories
        .filter((_, index) => ![3, 4, 5].includes(index))
        .map((repository) => repository.id),
    ),
    {
      ...source("coverage-unconfigured", "Credential not configured", [
        repositories[3].id,
      ]),
      credentialConfigured: false,
    },
    {
      ...source("coverage-disabled", "Deliberately disabled", [
        repositories[4].id,
      ]),
      enabled: false,
    },
    source("coverage-secondary", "Additional read-only connection", [
      repositories[11].id,
    ]),
  ];
  const states: Record<number, GitHubCheck["state"]> = {
    1: "unavailable",
    7: "error",
    8: "limited",
    9: "rate_limited",
    10: "unobserved",
  };
  const observations: Observation[] = sources.flatMap((connection) =>
    connection.repositoryIds
      .filter((id) => id !== repositories[6].id)
      .map((id) => {
        const index = repositories.findIndex(
          (repository) => repository.id === id,
        );
        return {
          sourceId: connection.id,
          resourceId: id,
          resourceType: "repository",
          provider: "github",
          name:
            index === 12
              ? "example/before-rename"
              : repositories[index].fullName,
          health: "critical",
          summary: "CI failing with observed findings; coverage is separate",
          observedAt: stamp(index === 2 ? -3600000 : -60000),
          receivedAt: stamp(-55000),
          expiresAt: stamp(index === 2 ? -60000 : 900000),
          details: {
            ci: "failing",
            openFindings: 2,
            github: {
              checks: GITHUB_CHECK_KEYS.map((key) => ({
                key,
                state:
                  key === "secretScanning"
                    ? connection.id === "coverage-secondary"
                      ? "unavailable"
                      : (states[index] ?? "observed")
                    : "observed",
                summary: "Synthetic bounded check evidence",
                count: 2,
              })),
            },
          },
        };
      }),
  );
  function response(value: unknown): GitHubCoverage {
    const input = githubCoverageInput.parse(value);
    const selection = input.sourceId
      ? sources.filter((source) => source.id === input.sourceId)
      : sources;
    const rows = githubCoverageRepositories(
      input.repositoryIds.map(
        (id) => repositories.find((repository) => repository.id === id)!,
      ),
      selection,
      observations,
      now,
    );
    for (const row of rows)
      for (const source of row.sources) {
        const index = repositories.findIndex(
          (repository) => repository.id === row.repository.id,
        );
        source.latestRefresh = {
          refreshId: "receipt-" + source.id,
          sourceRevision: index === 13 ? 2 : source.revision,
          currentRevision: index !== 13,
          identityMatches: index !== 15,
          createdAt: stamp(-120000),
          status:
            index === 6
              ? "queued"
              : index === 14
                ? "cancelled"
                : source.state === "current"
                  ? "succeeded"
                  : "partial",
          attempts: [6, 14].includes(index) ? 0 : 1,
          updatedAt: stamp(-60000),
          observedAt: source.evidence?.observedAt ?? null,
        };
      }
    return {
      generatedAt: stamp(),
      sourceId: input.sourceId,
      repositories: rows,
    };
  }
  function receipt(sourceId: string): GitHubRefresh {
    const source = sources.find((source) => source.id === sourceId)!;
    return {
      id: "receipt-" + sourceId,
      sourceId,
      sourceRevision: source.revision,
      actor: "Scheduled collector",
      trigger: "scheduled",
      status: "partial",
      summary: "Synthetic completed refresh with explicit access gaps",
      createdAt: stamp(-120000),
      completedAt: stamp(-30000),
      total: source.repositoryIds.length,
      finished: source.repositoryIds.length,
      items: source.repositoryIds.map((repositoryId) => ({
        repositoryId,
        fullName: repositories.find(
          (repository) => repository.id === repositoryId,
        )!.fullName,
        status: "partial",
        attempts: 1,
        updatedAt: stamp(-60000),
        observedAt: stamp(-60000),
        summary: "Synthetic refresh result",
        evidence: null,
        diagnostics: null,
      })),
    };
  }
  return {
    workspaceId,
    repositories,
    sources,
    observations,
    response,
    receipt,
  };
}
