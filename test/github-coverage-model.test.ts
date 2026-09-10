import { describe, expect, it } from "vitest";
import type { Observation, Repository } from "../shared/domain";
import type { GitHubSource } from "../shared/github";
import { GITHUB_CHECK_KEYS, type GitHubCheck } from "../shared/github-evidence";
import {
  GITHUB_COVERAGE_LIMITS,
  githubCoverageInput,
  githubCoverageRepositories,
  githubCoverageHref,
} from "../shared/github-coverage";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const OBSERVED = "2026-01-01T11:59:00Z";
const EXPIRES = "2026-01-01T12:14:00Z";
const PRIVATE = "synthetic-private-provider-content";
const repository = {
  id: "repository",
  fullName: "example/repository",
  revision: 1,
  lifecycle: "active",
  classification: "maintained",
} satisfies Pick<
  Repository,
  "id" | "fullName" | "revision" | "lifecycle" | "classification"
>;
const source = {
  id: "github",
  name: "Example GitHub",
  provider: "github",
  revision: 2,
  enabled: true,
  freshnessMinutes: 15,
  repositoryIds: [repository.id],
  lastAttemptAt: OBSERVED,
  lastSuccessAt: "2025-12-01T00:00:00Z",
  lastError: PRIVATE,
  credentialConfigured: true,
  github: {
    credentialRef: PRIVATE,
    configurationValid: true,
    refreshIntervalMinutes: 5,
    nextRefreshAt: "2026-01-01T12:04:00Z",
    retryAt: null,
    activeRefreshId: null,
    lastRefreshId: "latest-refresh",
    lastRefreshStatus: "partial",
  },
} satisfies GitHubSource;
function observation(state: GitHubCheck["state"] = "observed"): Observation {
  return {
    sourceId: source.id,
    resourceId: repository.id,
    resourceType: "repository",
    name: repository.fullName,
    provider: "github",
    observedAt: OBSERVED,
    receivedAt: "2026-01-01T11:59:03Z",
    expiresAt: EXPIRES,
    health: "critical",
    summary: PRIVATE,
    details: {
      ci: "failing",
      openFindings: 4,
      github: {
        checks: GITHUB_CHECK_KEYS.map((key) => ({
          key,
          state,
          summary: PRIVATE,
        })),
      },
    },
  };
}
function coverage(
  sources: GitHubSource[] = [source],
  observations = [observation()],
) {
  return githubCoverageRepositories(
    [repository],
    sources,
    observations,
    NOW,
  )[0];
}

describe("GitHub evidence coverage", () => {
  it("keeps complete coverage independent from CI failures and security findings", () => {
    const result = coverage();
    expect(result.state).toBe("current");
    expect(result.sources[0].lastCompleteAt).toBe(source.lastSuccessAt);
    expect(result.sources[0].evidence).toMatchObject({
      observedAt: OBSERVED,
      expiresAt: EXPIRES,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(result.sources[0]).not.toHaveProperty("credentialRef");
  });

  it.each([
    ["unavailable", "unavailable"],
    ["error", "error"],
    ["limited", "limited"],
    ["rate_limited", "rate_limited"],
    ["unobserved", "incomplete"],
  ] as const)(
    "keeps %s evidence distinct from observed coverage",
    (state, expected) => {
      const evidence = observation();
      evidence.details.github!.checks[0].state = state;
      expect(coverage([source], [evidence]).state).toBe(expected);
    },
  );

  it("expires evidence by its observed deadline, not by receipt or last complete collection", () => {
    const old = observation();
    old.expiresAt = new Date(NOW).toISOString();
    old.receivedAt = new Date(NOW).toISOString();
    expect(coverage([source], [old]).state).toBe("stale");
    expect(coverage().state).toBe("current");
  });

  it("does not mistake configuration, disablement or missing enrollment for evidence", () => {
    expect(coverage([], []).state).toBe("not_collected");
    expect(coverage([{ ...source, repositoryIds: [] }]).state).toBe(
      "not_collected",
    );
    expect(coverage([{ ...source, enabled: false }]).state).toBe("disabled");
    expect(coverage([{ ...source, credentialConfigured: false }]).state).toBe(
      "not_configured",
    );
    expect(
      coverage([
        { ...source, github: { ...source.github, configurationValid: false } },
      ]).state,
    ).toBe("not_configured");
    expect(coverage([source], []).state).toBe("awaiting");
  });

  it("does not let one readable source hide another source's gap", () => {
    const other = { ...source, id: "other" };
    const result = coverage(
      [source, other],
      [observation(), { ...observation("unavailable"), sourceId: other.id }],
    );
    expect(result.state).toBe("unavailable");
    expect(result.sources.map((item) => item.state)).toEqual([
      "current",
      "unavailable",
    ]);
  });

  it("keeps cooldown and active refresh separate from still-current accepted coverage", () => {
    const busy = {
      ...source,
      github: {
        ...source.github,
        retryAt: EXPIRES,
        activeRefreshId: "in-flight",
      },
    };
    const result = coverage([busy]);
    expect(result.state).toBe("current");
    expect(result.sources[0]).toMatchObject({
      retryAt: EXPIRES,
      activeRefreshId: "in-flight",
      latestRefresh: null,
    });
  });

  it("rejects old names and unrelated source evidence while retaining historical timestamps", () => {
    const old = { ...observation(), name: "example/previous-name" };
    const renamed = coverage([source], [old]);
    expect(renamed.state).toBe("awaiting");
    expect(renamed.sources[0].evidence).toMatchObject({
      observedAt: OBSERVED,
      identityMatches: false,
    });
    expect(
      coverage([source], [{ ...observation(), sourceId: "other" }]).state,
    ).toBe("awaiting");
    expect(
      coverage([source], [{ ...observation(), resourceId: "other" }]).state,
    ).toBe("awaiting");
  });

  it("uses the newest accepted observation and does not copy extra repository fields", () => {
    const old = {
      ...observation("unavailable"),
      observedAt: "2026-01-01T11:58:00Z",
    };
    expect(coverage([source], [observation(), old]).state).toBe("current");
    const extended = { ...repository, description: PRIVATE };
    expect(
      JSON.stringify(
        githubCoverageRepositories([extended], [source], [observation()], NOW),
      ),
    ).not.toContain(PRIVATE);
  });

  it("bounds repository reads and keeps coverage links separate from receipt references", () => {
    const input = { workspaceId: "workspace", repositoryIds: [repository.id] };
    expect(githubCoverageInput.parse(input).sourceId).toBeNull();
    expect(
      githubCoverageInput.safeParse({ ...input, repositoryIds: [] }).success,
    ).toBe(false);
    expect(
      githubCoverageInput.safeParse({
        ...input,
        repositoryIds: [repository.id, repository.id],
      }).success,
    ).toBe(false);
    expect(
      githubCoverageInput.safeParse({
        ...input,
        repositoryIds: Array.from(
          { length: GITHUB_COVERAGE_LIMITS.REPOSITORIES + 1 },
          (_, index) => "repo-" + index,
        ),
      }).success,
    ).toBe(false);
    expect(
      githubCoverageInput.safeParse({
        ...input,
        providerUrl: "https://example.com",
      }).success,
    ).toBe(false);
    expect(githubCoverageHref("workspace", repository.id, source.id)).toBe(
      "/settings/github?workspace=workspace&repository=repository&lifecycle=all&connection=github",
    );
  });
});
