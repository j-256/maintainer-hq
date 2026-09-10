import { describe, expect, it } from "vitest";
import { changedDependencyRule } from "../shared/dependency-changes";
import { analyzeDependencyPolicy } from "../shared/dependency-policy";
import {
  dependencyFixture,
  DEPENDENCY_TEST_NOW as NOW,
} from "./fixtures/dependencies";

describe("Safe override changes", () => {
  it("renews only bounded dates and accountable metadata", () => {
    const f = dependencyFixture();
    const analysis = analyzeDependencyPolicy(f.policy, f.documents, NOW);
    const changed = changedDependencyRule(
      analysis,
      f.rule.id,
      {
        kind: "renew",
        owner: "Maintainer",
        reason: "Both installed runners still require the older decoder",
        reviewDays: 7,
      },
      NOW,
    );
    expect(changed.before).toEqual(f.rule);
    expect(changed.after).toEqual({
      ...f.rule,
      owner: "Maintainer",
      reason: "Both installed runners still require the older decoder",
      reviewedAt: new Date(NOW).toISOString(),
      reviewBy: new Date(NOW + 7 * 86400000).toISOString(),
    });
    expect(f.rule.owner).toBe("Project maintainers");
  });
  it("keeps the advisory guard when removing a verified-unused override", () => {
    const f = dependencyFixture();
    f.lock.packages["node_modules/runner"].dependencies = { decoder: "1.0.1" };
    f.lock.packages["node_modules/harness/node_modules/runner"].dependencies = {
      decoder: "1.0.1",
    };
    const analysis = analyzeDependencyPolicy(f.policy, f.documents, NOW);
    const changed = changedDependencyRule(
      analysis,
      f.rule.id,
      {
        kind: "remove",
        reason:
          "Both installed runner releases now request the patched decoder",
      },
      NOW,
    );
    expect(changed.after).toMatchObject({
      lifecycle: "removed",
      advisory: f.rule.advisory,
      vulnerable: f.rule.vulnerable,
      removeWhen: f.rule.removeWhen,
    });
  });
  it("blocks edits when locks are vulnerable or incomplete", () => {
    const f = dependencyFixture();
    f.lock.packages["node_modules/decoder"].version = "1.0.0";
    expect(() =>
      changedDependencyRule(
        analyzeDependencyPolicy(f.policy, f.documents, NOW),
        f.rule.id,
        {
          kind: "renew",
          reason:
            "Cannot renew an override that no longer mitigates the advisory",
          owner: "Maintainer",
          reviewDays: 14,
        },
        NOW,
      ),
    ).toThrow(/problems/);
  });
});
