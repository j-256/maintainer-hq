import { expect, it } from "vitest";
import { workspaceQueryMatches } from "../src/lib/workspace-push";
import { coverageFixture } from "../e2e/github-coverage-fixture";
import type { Snapshot } from "../shared/domain";
import {
  clearExpectationResolution,
  expectationHref,
  githubExpectationResolution,
  monitoringExpectationResolution,
} from "../shared/expectation-resolution";
import type { RepositoryCoverage } from "../shared/repository-coverage";
function github() {
  const fixture = coverageFixture();
  const repository = fixture.repositories[0]!;
  const snapshot = {
    connections: fixture.sources,
    observations: fixture.observations,
  } as Snapshot;
  const observation = snapshot.observations.find(
    (item) => item.resourceId === repository.id,
  )!;
  return { repository, snapshot, observation };
}
it("only establishes GitHub outcomes from fresh matching enabled collection and complete relevant checks", () => {
  const { repository, snapshot, observation } = github();
  const now = Date.now();
  observation.details.ci = "passing";
  observation.details.openFindings = 0;
  expect(
    githubExpectationResolution(repository, snapshot, "ci", now).tone,
  ).toBe("success");
  expect(
    githubExpectationResolution(repository, snapshot, "security", now).tone,
  ).toBe("success");
  observation.details.github!.checks.find(
    (check) => check.key === "secretScanning",
  )!.state = "unavailable";
  expect(
    githubExpectationResolution(repository, snapshot, "security", now).tone,
  ).toBe("warning");
  expect(
    githubExpectationResolution(repository, snapshot, "ci", now).tone,
  ).toBe("success");
  observation.observedAt = new Date(now + 60000).toISOString();
  expect(
    githubExpectationResolution(repository, snapshot, "ci", now).tone,
  ).toBe("warning");
  observation.observedAt = new Date(now - 1000).toISOString();
  observation.name = "renamed/repository";
  expect(
    githubExpectationResolution(repository, snapshot, "ci", now).tone,
  ).toBe("warning");
  observation.name = repository.fullName;
  snapshot.connections[0]!.enabled = false;
  expect(
    githubExpectationResolution(repository, snapshot, "ci", now).tone,
  ).toBe("warning");
});
it("distinguishes missing collection, actual failures, and the expected visibility", () => {
  const { repository, snapshot, observation } = github();
  observation.details.ci = "failing";
  observation.details.openFindings = 2;
  observation.details.visibility = "public";
  expect(
    githubExpectationResolution(repository, snapshot, "ci", Date.now()).action,
  ).toBe("Inspect failing checks");
  expect(
    githubExpectationResolution(repository, snapshot, "security", Date.now())
      .action,
  ).toBe("Resolve findings");
  repository.expectations = {
    ...repository.expectations,
    visibility: "private",
  };
  expect(
    githubExpectationResolution(repository, snapshot, "visibility", Date.now())
      .label,
  ).toBe("Visibility mismatch");
  snapshot.connections = [];
  expect(
    githubExpectationResolution(repository, snapshot, "ci", Date.now()).action,
  ).toBe("Connect GitHub");
});
it("requires every linked monitor to have complete fresh coverage", () => {
  const now = Date.now();
  const stamp = (offset: number) => new Date(now + offset).toISOString();
  const value = {
    repositoryId: "repo",
    phase: "ready",
    nextReadAt: null,
    generatedAt: stamp(0),
    links: { hooks: 0, monitoring: 1 },
    evidence: [
      {
        connectionId: "monitor",
        connectionName: "Monitor",
        kind: "monitor",
        observation: {
          observedAt: stamp(-1000),
          expiresAt: stamp(60000),
          details: {
            coverage: {
              version: 1,
              connectionRevision: 1,
              readAt: stamp(-1000),
              freshUntil: stamp(60000),
              total: 1,
              complete: true,
              resources: [
                {
                  resourceKey: "target",
                  state: "passing",
                  observedAt: stamp(-1000),
                  freshUntil: stamp(60000),
                },
              ],
            },
          },
        },
      },
    ],
  } as RepositoryCoverage;
  expect(monitoringExpectationResolution(value, now).tone).toBe("success");
  value.links.monitoring = 2;
  expect(monitoringExpectationResolution(value, now).tone).toBe("warning");
  value.links.monitoring = 1;
  value.evidence[0]!.observation.details.coverage.resources[0]!.state =
    "incident";
  expect(monitoringExpectationResolution(value, now).tone).toBe("warning");
  value.evidence[0]!.observation.details.coverage.resources[0]!.state =
    "passing";
  expect(monitoringExpectationResolution(value, now + 60000).tone).toBe(
    "warning",
  );
});
it("clears all provider dialog state while preserving repository and project navigation", () => {
  const url = new URL(
    expectationHref("alpha", "repo", "monitoring"),
    "https://example.test",
  );
  url.searchParams.set("monitorTarget", ":create");
  url.searchParams.set("monitorReview", "review");
  url.searchParams.set("githubEdit", "true");
  url.searchParams.set("completedReview", "done");
  url.searchParams.set("section", "repositories");
  clearExpectationResolution(url.searchParams);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    workspace: "alpha",
    dialog: "expectations",
    section: "repositories",
  });
});

it("refreshes a repository review on completion or authority changes within its own workspace", () => {
  const key = ["repository-review", "alpha", "repository", "review"];
  for (const topic of ["workspace", "operations", "access"] as const)
    expect(workspaceQueryMatches(key, "alpha", [topic])).toBe(true);
  expect(workspaceQueryMatches(key, "beta", ["operations"])).toBe(false);
  for (const topic of ["sources", "activity", "hooks", "monitoring"] as const)
    expect(workspaceQueryMatches(key, "alpha", [topic])).toBe(false);
});
