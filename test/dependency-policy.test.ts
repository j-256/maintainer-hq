import { describe, expect, it } from "vitest";
import {
  analyzeDependencyPolicy,
  dependencyPolicySchema,
  dependencyUpstreamEvidence,
  DEPENDENCY_LIMITS,
} from "../shared/dependency-policy";
import {
  dependencyFixture,
  DEPENDENCY_TEST_NOW as NOW,
} from "./fixtures/dependencies";

describe("temporary npm override lifecycle", () => {
  it("verifies both development and test parents against a hoisted patched dependency", () => {
    const fixture = dependencyFixture();
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("passed");
    expect(result.findings[0]).toMatchObject({
      status: "mitigated",
      resolvedVersions: ["1.0.1"],
      upstream: { state: "not_checked" },
    });
    expect(result.findings[0]!.matches).toEqual([
      {
        parentVersion: "2.1.0",
        requested: "1.0.0",
        resolved: "1.0.1",
        scope: "development",
        overridden: true,
      },
      {
        parentVersion: "2.0.0",
        requested: "1.0.0",
        resolved: "1.0.1",
        scope: "development",
        overridden: true,
      },
    ]);
  });
  it("accepts exact version build metadata without accepting prefixed or loose versions", () => {
    const fixture = dependencyFixture();
    fixture.rule.replacement = "1.0.1+build.7";
    fixture.manifest.overrides.runner["decoder@1.0.0"] =
      fixture.rule.replacement;
    fixture.lock.packages["node_modules/decoder"]!.version =
      fixture.rule.replacement;
    expect(
      analyzeDependencyPolicy(fixture.policy, fixture.documents, NOW).outcome,
    ).toBe("passed");
    for (const replacement of ["v1.0.1", "1.0", " 1.0.1", "1.0.1 "]) {
      fixture.rule.replacement = replacement;
      expect(dependencyPolicySchema.safeParse(fixture.policy).success).toBe(
        false,
      );
    }
  });
  it("does not call an override unused until the test parent has also been upgraded", () => {
    const fixture = dependencyFixture();
    fixture.lock.packages["node_modules/runner"]!.dependencies = {
      decoder: "1.0.1",
    };
    expect(
      analyzeDependencyPolicy(fixture.policy, fixture.documents, NOW)
        .findings[0]!.status,
    ).toBe("mitigated");
    fixture.lock.packages[
      "node_modules/harness/node_modules/runner"
    ]!.dependencies = { decoder: "1.0.1" };
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("failed");
    expect(result.findings[0]!.status).toBe("unused");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "unused_override",
    );
  });
  it("keeps removed lifecycle records as regression checks without imposing an active review deadline", () => {
    const fixture = dependencyFixture();
    fixture.rule.lifecycle = "removed";
    fixture.manifest.overrides = {} as typeof fixture.manifest.overrides;
    fixture.lock.packages["node_modules/runner"]!.dependencies = {
      decoder: "1.0.1",
    };
    fixture.lock.packages[
      "node_modules/harness/node_modules/runner"
    ]!.dependencies = { decoder: "1.0.1" };
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW + DEPENDENCY_LIMITS.REVIEW_MS,
    );
    expect(result.outcome).toBe("passed");
    expect(result.findings[0]!.status).toBe("resolved");
    fixture.lock.packages["node_modules/decoder"]!.version = "1.0.0";
    expect(
      analyzeDependencyPolicy(fixture.policy, fixture.documents, NOW)
        .findings[0]!.status,
    ).toBe("vulnerable");
  });
  it("rejects a claimed removal while the override is still present", () => {
    const fixture = dependencyFixture();
    fixture.rule.lifecycle = "removed";
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "override_still_present",
    );
  });
  it("finds vulnerable nested copies even when the direct parent resolves the patched copy", () => {
    const fixture = dependencyFixture();
    fixture.lock.packages["node_modules/harness/node_modules/decoder"] = {
      version: "1.0.0",
      dev: false,
    };
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.findings[0]!.status).toBe("vulnerable");
    expect(result.findings[0]!.resolvedVersions).toEqual(["1.0.0", "1.0.1"]);
    expect(result.findings[0]!.matches[1]!.resolved).toBe("1.0.0");
  });
  it.each([
    [
      "missing override",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.manifest.overrides = {} as typeof f.manifest.overrides;
      },
      "override_missing",
    ],
    [
      "changed override",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.manifest.overrides.runner["decoder@1.0.0"] = "1.0.2";
      },
      "override_changed",
    ],
    [
      "missing resolution",
      (f: ReturnType<typeof dependencyFixture>) => {
        delete f.lock.packages["node_modules/decoder"];
      },
      "missing_resolution",
    ],
    [
      "manifest drift",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.manifest.devDependencies.runner = "2.2.0";
      },
      "manifest_drift",
    ],
    [
      "unsupported lock",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.lock.lockfileVersion = 2;
      },
      "unsupported_lockfile",
    ],
    [
      "workspace link",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.lock.packages["node_modules/harness"]!.link = true;
      },
      "invalid_lockfile",
    ],
    [
      "aliased package",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.lock.packages["node_modules/decoder"]!.name = "not-the-decoder";
      },
      "invalid_resolution",
    ],
    [
      "unsafe path",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.lock.packages["node_modules/../decoder"] = { version: "1.0.1" };
      },
      "invalid_lockfile",
    ],
    [
      "non-registry request",
      (f: ReturnType<typeof dependencyFixture>) => {
        f.lock.packages["node_modules/runner"]!.dependencies = {
          decoder: "git+https://example.invalid/decoder",
        };
      },
      "invalid_resolution",
    ],
  ])("rejects %s without claiming mitigation", (_name, change, code) => {
    const fixture = dependencyFixture();
    change(fixture);
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("failed");
    expect(result.findings[0]!.status).toBe("invalid");
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });
  it("requires lifecycle records for every override in a monitored manifest", () => {
    const fixture = dependencyFixture();
    Object.assign(fixture.manifest.overrides.runner, {
      "another@1.0.0": "1.0.1",
    });
    expect(
      analyzeDependencyPolicy(
        fixture.policy,
        fixture.documents,
        NOW,
      ).issues.map((issue) => issue.code),
    ).toContain("untracked_override");
  });
  it("fails overdue reviews without deleting or disabling the mitigation", () => {
    const fixture = dependencyFixture();
    const before = JSON.stringify(fixture);
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      Date.parse(fixture.rule.reviewBy),
    );
    expect(result.outcome).toBe("failed");
    expect(result.findings[0]!.status).toBe("review_due");
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it("rejects future reviews, excessive review windows, duplicate identities and unsafe paths", () => {
    const fixture = dependencyFixture();
    expect(
      analyzeDependencyPolicy(
        fixture.policy,
        fixture.documents,
        NOW - DEPENDENCY_LIMITS.REVIEW_MS,
      ).issues.map((issue) => issue.code),
    ).toContain("future_review");
    for (const change of [
      (f: ReturnType<typeof dependencyFixture>) => {
        f.rule.reviewBy = "2027-01-01T00:00:00.000Z";
      },
      (f: ReturnType<typeof dependencyFixture>) => {
        f.rule.reviewBy = f.rule.reviewedAt;
      },
      (f: ReturnType<typeof dependencyFixture>) => {
        f.policy.manifests[0]!.overrides.push({ ...f.rule });
      },
      (f: ReturnType<typeof dependencyFixture>) => {
        f.policy.manifests[0]!.path = "../package.json";
      },
      (f: ReturnType<typeof dependencyFixture>) => {
        f.rule.replacement = "1.0.0";
      },
      (f: ReturnType<typeof dependencyFixture>) => {
        f.rule.requested = "^1.0.0";
      },
    ]) {
      const selected = dependencyFixture();
      change(selected);
      expect(dependencyPolicySchema.safeParse(selected.policy).success).toBe(
        false,
      );
    }
  });
  it("handles scoped packages and distinguishes runtime parent use", () => {
    const fixture = dependencyFixture();
    fixture.rule.parent = "@example/runner";
    fixture.rule.package = "@example/decoder";
    fixture.manifest.overrides = {
      "@example/runner": { "@example/decoder@1.0.0": "1.0.1" },
    } as unknown as typeof fixture.manifest.overrides;
    fixture.lock.packages["node_modules/@example/runner"] = {
      version: "2.0.0",
      dependencies: { "@example/decoder": "1.0.0" },
    };
    fixture.lock.packages["node_modules/@example/decoder"] = {
      version: "1.0.1",
    };
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("passed");
    expect(result.findings[0]!.matches[0]!.scope).toBe("runtime");
  });
  it("keeps bounded evidence failures visible even after many matching parents", () => {
    const fixture = dependencyFixture();
    for (let index = 0; index <= DEPENDENCY_LIMITS.MATCHES; index++)
      fixture.lock.packages[
        `node_modules/parent-${index}/node_modules/runner`
      ] = { version: "2.0.0", dev: true, dependencies: { decoder: "1.0.0" } };
    const result = analyzeDependencyPolicy(
      fixture.policy,
      fixture.documents,
      NOW,
    );
    expect(result.outcome).toBe("failed");
    expect(result.findings[0]!.status).toBe("invalid");
    expect(result.findings[0]!.matches.length).toBe(DEPENDENCY_LIMITS.MATCHES);
  });
});

describe("upstream release evidence", () => {
  it("distinguishes an upstream fix from adoption by installed parents", () => {
    const { rule } = dependencyFixture();
    expect(
      dependencyUpstreamEvidence(
        rule,
        {
          name: "runner",
          version: "3.0.0",
          dependencies: { decoder: "1.0.1" },
        },
        NOW,
      ),
    ).toMatchObject({
      state: "fix_available",
      parentVersion: "3.0.0",
      requested: "1.0.1",
    });
    expect(
      dependencyUpstreamEvidence(
        rule,
        {
          name: "runner",
          version: "3.0.0",
          dependencies: { decoder: "^1.0.0" },
        },
        NOW,
      ).state,
    ).toBe("not_fixed");
    expect(
      dependencyUpstreamEvidence(
        rule,
        {
          name: "runner",
          version: "3.0.0",
          dependencies: { decoder: "git+https://example.invalid/decoder" },
        },
        NOW,
      ).state,
    ).toBe("unsupported");
    expect(
      dependencyUpstreamEvidence(
        rule,
        { name: "wrong", version: "3.0.0", dependencies: { decoder: "1.0.1" } },
        NOW,
      ).state,
    ).toBe("unsupported");
  });
});
