import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  type Connection,
  type Observation,
  type Repository,
} from "../shared/domain";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import {
  repositoryEvidenceSummary,
  repositoryGitHubContext,
} from "../src/repository-overview-model";

const now = Date.parse("2026-09-07T12:00:00Z");
const repository: Repository = {
  id: "repo",
  workspaceId: "alpha",
  fullName: "example/local-only",
  description: "",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  revision: 1,
  expectations: DEFAULT_EXPECTATIONS,
  updatedAt: new Date(now).toISOString(),
};
const source: Connection = {
  id: "github",
  name: "GitHub source",
  provider: "github",
  repositoryIds: [repository.id],
  revision: 1,
  enabled: true,
  freshnessMinutes: 30,
  credentialConfigured: true,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
};
const observation: Observation = {
  sourceId: source.id,
  resourceType: "repository",
  resourceId: repository.id,
  name: "Evidence",
  provider: "github",
  health: "healthy",
  summary: "Synthetic evidence",
  observedAt: new Date(now - 1000).toISOString(),
  receivedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 1000).toISOString(),
  details: {
    ci: "passing",
    openFindings: 0,
    github: {
      checks: GITHUB_CHECK_KEYS.map((key) => ({
        key,
        state: "observed",
        summary: "Observed",
        count: 0,
      })),
    },
  },
};

describe("Repository overview evidence distinctions", () => {
  it("never constructs an upstream for an unpublished or merely similarly named repository", () => {
    expect(
      repositoryGitHubContext(repository, { observations: [], connections: [] })
        .upstream,
    ).toBeNull();
    expect(
      repositoryGitHubContext(repository, {
        observations: [{ ...observation, resourceId: "other" }],
        connections: [{ ...source, repositoryIds: ["other"] }],
      }).upstream,
    ).toBeNull();
    expect(
      repositoryGitHubContext(repository, {
        observations: [],
        connections: [source],
      }).upstream,
    ).toBe("https://github.com/example/local-only");
    expect(
      repositoryGitHubContext(repository, {
        observations: [observation],
        connections: [],
      }).upstream,
    ).not.toBeNull();
  });
  it("keeps not configured, awaiting, disabled and stale evidence distinct from fresh results", () => {
    expect(
      repositoryEvidenceSummary("ci", undefined, undefined, now).label,
    ).toBe("Not configured");
    expect(repositoryEvidenceSummary("ci", undefined, source, now).label).toBe(
      "Awaiting evidence",
    );
    expect(
      repositoryEvidenceSummary("ci", observation, source, now),
    ).toMatchObject({ label: "Passing", tone: "success" });
    expect(
      repositoryEvidenceSummary(
        "ci",
        observation,
        { ...source, enabled: false },
        now,
      ),
    ).toMatchObject({
      label: "Collection disabled",
      tone: "neutral",
      detail: "Last result: Passing.",
    });
    expect(
      repositoryEvidenceSummary("ci", observation, source, now + 1000),
    ).toMatchObject({
      label: "Stale evidence",
      tone: "warning",
      detail: "Last result: Passing.",
    });
    expect(
      repositoryEvidenceSummary(
        "ci",
        { ...observation, details: { ci: "failing" } },
        source,
        now,
      ),
    ).toMatchObject({ label: "Failing", tone: "danger" });
  });
  it("requires complete security coverage before calling zero findings clear", () => {
    expect(
      repositoryEvidenceSummary("security", observation, source, now),
    ).toMatchObject({ label: "No open findings", tone: "success" });
    for (const details of [
      { openFindings: 0 },
      {
        ...observation.details,
        github: {
          checks: observation.details.github!.checks.map((check) =>
            check.key === "secretScanning"
              ? { ...check, state: "unavailable" as const }
              : check,
          ),
        },
      },
    ]) {
      expect(
        repositoryEvidenceSummary(
          "security",
          { ...observation, details },
          source,
          now,
        ),
      ).toMatchObject({ label: "Coverage incomplete", tone: "neutral" });
    }
    expect(
      repositoryEvidenceSummary(
        "security",
        { ...observation, details: { openFindings: 2 } },
        source,
        now,
      ),
    ).toMatchObject({ label: "2 open findings", tone: "danger" });
  });
});
