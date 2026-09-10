import { describe, expect, it, vi } from "vitest";
import { inspectDependencyFiles } from "../worker/dependency-client";
import {
  DEPENDENCIES_LIMITS,
  dependencyEvidenceSchema,
  dependencySummary,
} from "../shared/dependencies";
import { DEPENDENCY_POLICY_PATH } from "../shared/dependency-policy";
import {
  dependencyFixture,
  DEPENDENCY_TEST_NOW as NOW,
} from "./fixtures/dependencies";
import {
  DEPENDENCY_PROVIDER as F,
  dependencyProviderFixture,
} from "./fixtures/dependency-provider";

async function setup(fixture = dependencyFixture()) {
  const provider = await dependencyProviderFixture(fixture);
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target));
      expect(url.origin).toBe("https://api.github.com");
      expect(url.pathname.startsWith("/repos/" + F.repository)).toBe(true);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer " + F.token,
      );
      return provider.response(url);
    },
  );
  return {
    provider,
    fetcher,
    read: () =>
      inspectDependencyFiles(F.repository, F.token, {
        fetch: fetcher,
        now: () => NOW,
      }),
  };
}
describe("Immutable repository dependency inspection", () => {
  it("verifies blob identities and returns only typed policy evidence", async () => {
    const f = await setup();
    const { evidence, files } = await f.read();
    expect(evidence).toMatchObject({
      read: { state: "observed" },
      headSha: F.head,
      report: {
        analysis: { outcome: "passed", findings: [{ status: "mitigated" }] },
      },
    });
    expect(files.get("package.json")).toContain(F.privateValue);
    expect(JSON.stringify(evidence)).not.toContain(F.privateValue);
    expect(JSON.stringify(evidence)).not.toContain(F.token);
    expect(evidence.requests).toBe(6);
    expect(dependencyEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      f.fetcher.mock.calls
        .filter(([target]) =>
          new URL(String(target)).pathname.includes("/git/"),
        )
        .every(([target]) => !String(target).includes("main")),
    ).toBe(true);
  });
  it("distinguishes a proven absent policy from failed or forbidden reads", async () => {
    const f = await setup();
    f.provider.tree.tree = [];
    expect((await f.read()).evidence).toMatchObject({
      policy: "absent",
      read: { state: "observed" },
      report: null,
      requests: 3,
    });
    f.fetcher.mockImplementation(
      async () => new Response(F.privateValue, { status: 404 }),
    );
    const failed = await f.read();
    expect(failed.evidence).toMatchObject({
      policy: "unknown",
      read: { state: "unavailable", reason: "permission" },
      report: null,
    });
    expect(JSON.stringify(failed.evidence)).not.toContain(F.privateValue);
  });
  it.each([
    "truncated",
    "symlink",
    "too_large",
    "missing",
    "digest",
    "duplicate",
    "invalid_policy",
  ])("rejects %s evidence without a healthy report", async (kind) => {
    const f = await setup();
    if (kind === "truncated") f.provider.tree.truncated = true;
    if (kind === "symlink") f.provider.tree.tree[0].mode = "120000";
    if (kind === "too_large")
      f.provider.tree.tree[0].size = DEPENDENCIES_LIMITS.FILE_BYTES + 1;
    if (kind === "missing") f.provider.tree.tree.splice(2, 1);
    if (kind === "duplicate")
      f.provider.tree.tree.push(f.provider.tree.tree[0]);
    if (kind === "digest" || kind === "invalid_policy") {
      const entry = f.provider.tree.tree.find(
        (item) => item.path === DEPENDENCY_POLICY_PATH,
      )!;
      const blob = f.provider.blobs.get(entry.sha) as { content: string };
      blob.content = btoa("{}");
    }
    const result = await f.read();
    expect(result.evidence.read.state).not.toBe("observed");
    expect(result.evidence.report).toBeNull();
    expect(result.files.size).toBe(0);
    expect(result.documents).toEqual([]);
  });
  it("preserves policy violations as observed findings, not collection failures", async () => {
    const fixture = dependencyFixture();
    fixture.lock.packages["node_modules/decoder"].version = "1.0.0";
    const evidence = (await (await setup(fixture)).read()).evidence;
    expect(evidence).toMatchObject({
      read: { state: "observed" },
      report: {
        analysis: { outcome: "failed", findings: [{ status: "vulnerable" }] },
      },
    });
  });
  it("reports provider cooldowns without retrying or exposing response bodies", async () => {
    const f = await setup();
    f.fetcher.mockImplementation(
      async () =>
        new Response(F.privateValue, {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const { evidence } = await f.read();
    expect(evidence).toMatchObject({
      requests: 1,
      retryAt: new Date(NOW + 120000).toISOString(),
      read: { state: "rate_limited" },
    });
    expect(JSON.stringify(evidence)).not.toContain(F.privateValue);
  });
  it("updates review deadlines and stale labels without changing the inspection timestamp", async () => {
    const { evidence } = await (await setup()).read();
    const result = {
      repository: { id: "r", fullName: F.repository, revision: 1 },
      source: { id: "s", name: "Source", revision: 1 },
      state: "ready" as const,
      nextReadAt: null,
      evidence,
    };
    expect(dependencySummary(result, NOW)).toMatchObject({
      state: "tracked",
      stale: false,
      active: 1,
    });
    expect(
      dependencySummary(result, Date.parse("2026-10-10T00:00:00.000Z")),
    ).toMatchObject({
      state: "attention",
      stale: true,
      attention: 1,
      observedAt: evidence.observedAt,
    });
  });
});
