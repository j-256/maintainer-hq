import { describe, expect, it } from "vitest";
import type { Observation, Repository } from "../shared/domain";
import type { GitHubSource } from "../shared/github";
import { GITHUB_CHECK_KEYS, type GitHubCheck } from "../shared/github-evidence";
import { githubManagementLinks } from "../shared/github-settings";
import { DEFAULT_GITHUB_SECURITY } from "../shared/github-requirements";
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
    expect(result.managementLinks).toEqual([]);
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
      const result = coverage([source], [evidence]);
      expect(result.state).toBe(expected);
      if (state !== "unavailable") expect(result.managementLinks).toEqual([]);
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
    expect(result.managementLinks.map((link) => link.id)).toEqual([
      "repository-access",
      "security",
      "fine-grained-tokens",
      "classic-tokens",
      "app-installations",
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
    const old = {
      ...observation("unavailable"),
      name: "example/previous-name",
    };
    const renamed = coverage([source], [old]);
    expect(renamed.state).toBe("awaiting");
    expect(renamed.managementLinks).toEqual([]);
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

  it("links scanner gaps to settings without assuming a repository access failure", () => {
    const evidence = observation();
    evidence.details.github!.checks.find(
      (check) => check.key === "secretScanning",
    )!.state = "unavailable";
    const result = coverage([source], [evidence]);
    expect(
      result.managementLinks.filter((link) => link.scope === "repository"),
    ).toEqual([
      {
        id: "security",
        label: "Security settings on GitHub",
        href: "https://github.com/example/repository/settings/security_analysis",
        scope: "repository",
      },
    ]);
    expect(
      result.managementLinks.every(
        (link) => new URL(link.href).origin === "https://github.com",
      ),
    ).toBe(true);
    expect(JSON.stringify(result.managementLinks)).not.toContain(PRIVATE);
    expect(result.remediation).toEqual([
      expect.objectContaining({
        key: "secretScanning",
        label: "Secret scanning",
        guidance: expect.stringContaining(
          "Secret scanning alerts read permission",
        ),
      }),
    ]);
  });

  it("requires every scanner by default and preserves unread evidence when one is explicitly not required", () => {
    const evidence = observation();
    evidence.details.github!.checks.find(
      (check) => check.key === "codeScanning",
    )!.state = "unavailable";
    const before = structuredClone(evidence);
    expect(coverage([source], [evidence])).toMatchObject({
      state: "unavailable",
      securityRequirements: DEFAULT_GITHUB_SECURITY,
    });
    const configured = {
      ...repository,
      expectations: {
        githubSecurity: {
          ...DEFAULT_GITHUB_SECURITY,
          codeScanning: "not_required" as const,
        },
      },
    };
    const [result] = githubCoverageRepositories(
      [configured],
      [source],
      [evidence],
      NOW,
    );
    expect(result).toMatchObject({
      state: "requirements_met",
      remediation: [],
      managementLinks: [],
    });
    expect(result.sources[0].evidence).toMatchObject({
      observedAt: OBSERVED,
      expiresAt: EXPIRES,
      checks: expect.arrayContaining([
        { key: "codeScanning", state: "unavailable", required: false },
      ]),
    });
    expect(evidence).toEqual(before);
    expect(coverage([source], [evidence]).state).toBe("unavailable");
    evidence.details.github!.checks[0].state = "unavailable";
    expect(
      githubCoverageRepositories([configured], [source], [evidence], NOW)[0],
    ).toMatchObject({
      state: "unavailable",
      remediation: [expect.objectContaining({ key: "repository" })],
    });
  });

  it("keeps freshness, repository identity and every selected source authoritative after a requirement changes", () => {
    const configured = {
      ...repository,
      expectations: {
        githubSecurity: {
          dependabot: "not_required",
          codeScanning: "not_required",
          secretScanning: "not_required",
        } as const,
      },
    };
    const evidence = observation();
    const other = { ...source, id: "other" };
    const read = (
      sources: GitHubSource[] = [source],
      observations = [evidence],
    ) =>
      githubCoverageRepositories([configured], sources, observations, NOW)[0];
    expect(read([source, other]).state).toBe("awaiting");
    expect(read([{ ...source, enabled: false }]).state).toBe("disabled");
    expect(read([{ ...source, credentialConfigured: false }]).state).toBe(
      "not_configured",
    );
    evidence.expiresAt = new Date(NOW).toISOString();
    expect(read().state).toBe("stale");
    evidence.expiresAt = EXPIRES;
    evidence.name = "example/previous-name";
    expect(read()).toMatchObject({ state: "awaiting", remediation: [] });
  });

  it("keeps invalid repository names out of GitHub settings destinations", () => {
    const checks = [{ key: "repository", state: "unavailable" }] as const;
    for (const fullName of [
      "https://other.example/repo",
      "example/repo?x=1",
      "example/repo#fragment",
      "example/%2e%2e",
      "Default branch evidence",
    ])
      expect(githubManagementLinks(fullName, checks)).toEqual([]);
    expect(githubManagementLinks("example/..", checks)).toEqual([]);
    expect(githubManagementLinks("example/.", checks)).toEqual([]);
  });
});
