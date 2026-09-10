import { expect, it } from "vitest";
import type { Observation } from "../shared/domain";
import type { RepositoryCoverage } from "../shared/repository-coverage";
import {
  coverageObservationVersion,
  invalidateSupersededCoverage,
  latestCoverage,
} from "../src/lib/coverage-convergence";
import { workspaceQueryMatches } from "../src/lib/workspace-push";

const observedAt = "2026-08-20T12:00:00.000Z";
const expiresAt = "2026-08-20T12:01:00.000Z";
const observation: Observation = {
  sourceId: "monitor",
  resourceType: "repository",
  resourceId: "first",
  name: "Synthetic",
  provider: "endpoint-monitor",
  health: "healthy",
  summary: "Retained coverage",
  observedAt,
  receivedAt: observedAt,
  expiresAt,
  details: {
    coverage: {
      version: 1,
      connectionRevision: 1,
      readAt: observedAt,
      freshUntil: expiresAt,
      total: 1,
      complete: true,
      resources: [
        {
          resourceKey: "health",
          state: "passing",
          observedAt,
          freshUntil: expiresAt,
        },
      ],
    },
  },
};
const coverage = (
  generatedAt: string,
  phase: RepositoryCoverage["phase"],
): RepositoryCoverage => ({
  repositoryId: "first",
  phase,
  nextReadAt: expiresAt,
  generatedAt,
  links: { hooks: 0, monitoring: 1 },
  evidence: [
    {
      connectionId: "monitor",
      connectionName: "Monitoring",
      kind: "monitor",
      observation: {
        ...observation,
        details: { coverage: observation.details.coverage! },
      },
    },
  ],
});

it("keys convergence only to this repository's changed operational evidence", () => {
  const version = coverageObservationVersion("first", [observation]);
  const unrelated = [
    { ...observation, resourceId: "second", receivedAt: expiresAt },
    {
      ...observation,
      sourceId: "github",
      provider: "github" as const,
      details: { ci: "passing" as const },
      receivedAt: expiresAt,
    },
  ];
  expect(
    coverageObservationVersion("first", [...unrelated, observation]),
  ).toEqual(version);
  expect(
    coverageObservationVersion("first", [
      { ...observation, expiresAt: observedAt },
    ]),
  ).not.toEqual(version);
  expect(
    coverageObservationVersion("first", [
      { ...observation, receivedAt: expiresAt },
    ]),
  ).not.toEqual(version);
  expect(coverageObservationVersion("first", [])).not.toEqual(version);
});

it("uses accepted cached progress and ignores an older response without renewing evidence", () => {
  const pending = coverage(observedAt, "pending");
  const ready = coverage("2026-08-20T12:00:05.000Z", "ready");
  expect(latestCoverage(pending, ready)).toBe(ready);
  expect(latestCoverage(ready, pending)).toBe(ready);
  expect(
    latestCoverage(ready, {
      ...ready,
      repositoryId: "second",
      generatedAt: expiresAt,
    }),
  ).toBe(ready);
  expect(latestCoverage(undefined, ready)).toBe(ready);
  expect(latestCoverage(ready, undefined)).toBe(ready);
  expect(ready.evidence[0]!.observation.expiresAt).toBe(expiresAt);
});

it("does not couple source or Activity notifications to provider or retained-coverage queries", () => {
  for (const prefix of ["repository-coverage", "repository-coverage-cache"]) {
    expect(
      workspaceQueryMatches([prefix, "alpha", "first"], "alpha", [
        "sources",
        "activity",
      ]),
    ).toBe(false);
    expect(
      workspaceQueryMatches([prefix, "alpha", "first"], "alpha", [
        "associations",
      ]),
    ).toBe(true);
    expect(
      workspaceQueryMatches([prefix, "alpha", "first"], "alpha", ["access"]),
    ).toBe(true);
    expect(
      workspaceQueryMatches([prefix, "beta", "first"], "alpha", ["access"]),
    ).toBe(false);
  }
});

it("cannot keep an old verified deadline after a newer accepted push or invalidation", () => {
  const saved = coverage(observedAt, "ready");
  const acceptedAt = "2026-08-20T12:00:05.000Z";
  const pushed = { ...observation, receivedAt: acceptedAt };
  expect(
    invalidateSupersededCoverage(saved, [pushed])?.evidence[0]!.observation
      .expiresAt,
  ).toBe(acceptedAt);
  expect(
    invalidateSupersededCoverage(saved, [
      { ...observation, expiresAt: observedAt },
    ])?.evidence[0]!.observation.expiresAt,
  ).toBe(observedAt);
  expect(saved.evidence[0]!.observation.expiresAt).toBe(expiresAt);
  expect(
    invalidateSupersededCoverage(saved, [{ ...pushed, resourceId: "second" }])
      ?.evidence[0],
  ).toBe(saved.evidence[0]);
  const newer = {
    ...saved,
    evidence: [
      {
        ...saved.evidence[0]!,
        observation: {
          ...saved.evidence[0]!.observation,
          receivedAt: acceptedAt,
        },
      },
    ],
  };
  expect(invalidateSupersededCoverage(newer, [observation])?.evidence[0]).toBe(
    newer.evidence[0],
  );
  expect(invalidateSupersededCoverage(undefined, [pushed])).toBeUndefined();
});
