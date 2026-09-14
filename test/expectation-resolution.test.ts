import { expect, it } from "vitest";
import {
  expectationHref,
  hookExpectationResolution,
  sameExpectationFlow,
} from "../shared/expectation-resolution";
import type { RepositoryCoverage } from "../shared/repository-coverage";

const observedAt = "2026-09-14T00:00:00.000Z";
const expiresAt = "2026-09-14T00:01:00.000Z";
function coverage(): RepositoryCoverage {
  return {
    repositoryId: "repo",
    phase: "ready",
    nextReadAt: null,
    generatedAt: observedAt,
    links: { hooks: 1, monitoring: 0 },
    evidence: [
      {
        connectionId: "hooks",
        connectionName: "Hooks",
        kind: "hook",
        observation: {
          sourceId: "hooks",
          resourceType: "repository",
          resourceId: "repo",
          name: "Coverage",
          health: "healthy",
          summary: "Routing configured",
          provider: "hookrelay",
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
                  resourceKey: "subscription",
                  state: "configured",
                  observedAt,
                  freshUntil: expiresAt,
                },
              ],
            },
          },
        },
      },
    ],
  };
}
it("requires complete, fresh evidence for every linked hook before presenting configured routing", () => {
  const value = coverage();
  const now = Date.parse(observedAt);
  expect(hookExpectationResolution(value, now).tone).toBe("success");
  expect(hookExpectationResolution(value, Date.parse(expiresAt)).tone).toBe(
    "warning",
  );
  value.links.hooks = 2;
  expect(hookExpectationResolution(value, now).tone).toBe("warning");
  value.links.hooks = 1;
  value.evidence[0]!.observation.details.coverage.complete = false;
  expect(hookExpectationResolution(value, now).tone).toBe("warning");
  value.evidence[0]!.observation.details.coverage.complete = true;
  value.evidence[0]!.observation.details.coverage.resources[0]!.observedAt =
    expiresAt;
  expect(hookExpectationResolution(value, now).tone).toBe("warning");
});
it("offers setup, routing repair and missing-subscription resolution from distinct evidence", () => {
  const value = coverage();
  expect(hookExpectationResolution(undefined, 0).action).toBe(
    "Set up coverage",
  );
  value.evidence[0]!.observation.details.coverage.resources[0]!.state =
    "disabled";
  expect(hookExpectationResolution(value, Date.parse(observedAt)).action).toBe(
    "Configure routing",
  );
  value.evidence[0]!.observation.details.coverage.resources[0]!.state =
    "missing";
  expect(hookExpectationResolution(value, Date.parse(observedAt)).action).toBe(
    "Resolve coverage",
  );
});
it("keeps internal setup navigation in the draft while guarding workspace and repository changes", () => {
  const url = new URL(
    expectationHref("workspace", "repo", "hooks"),
    "https://example.test",
  );
  const editing = {
    pathname: url.pathname,
    search: "?workspace=workspace&dialog=expectations",
  };
  expect(sameExpectationFlow(editing, url)).toBe(true);
  expect(
    sameExpectationFlow(editing, {
      ...editing,
      pathname: "/repositories/other",
    }),
  ).toBe(false);
  expect(
    sameExpectationFlow(editing, {
      ...editing,
      search: "?workspace=other&dialog=expectations",
    }),
  ).toBe(false);
  expect(
    sameExpectationFlow(editing, {
      ...editing,
      search: "?workspace=workspace",
    }),
  ).toBe(false);
});
