import { describe, expect, it, vi } from "vitest";
import {
  WORK_QUERY,
  WORK_SIGNALS_QUERY,
  collectRepositoryWork,
} from "../worker/work-client";
import {
  WORK_LIMITS,
  filterWork,
  workEvidenceSchema,
  workItemUrl,
} from "../shared/repository-work";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import {
  WORK_FIXTURE as F,
  providerPull,
  workFixture,
  workSignalsFixture,
} from "./fixtures/repository-work";

const NOW = Date.parse(F.timestamp);
function fixture(
  metadata: unknown = workFixture(),
  signals: unknown = workSignalsFixture(),
) {
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(target)).href).toBe(
        GITHUB_LIMITS.API_ORIGIN + "/graphql",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer " + F.token,
      );
      const body = JSON.parse(String(init?.body));
      expect([WORK_QUERY, WORK_SIGNALS_QUERY]).toContain(body.query);
      if (body.query === WORK_QUERY)
        expect(body.variables).toEqual({
          owner: "example",
          name: "work-fixture",
        });
      const result = body.query === WORK_QUERY ? metadata : signals;
      return result instanceof Response ? result : Response.json(result);
    },
  );
  return {
    fetcher,
    read: () =>
      collectRepositoryWork(F.repository, F.token, {
        fetch: fetcher,
        now: () => NOW,
      }),
  };
}
describe("Bounded repository work", () => {
  it("joins exact PR identities and head commits while minimizing public evidence", async () => {
    const f = fixture();
    const result = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body))).toEqual({
      query: WORK_SIGNALS_QUERY,
      variables: { ids: ["PR_synthetic_2", "PR_synthetic_1"] },
    });
    expect(result.pulls).toMatchObject({
      state: "observed",
      total: 2,
      hasMore: false,
    });
    expect(result.pulls.records[1]).toMatchObject({
      review: { state: "observed", decision: "REVIEW_REQUIRED", requested: 0 },
      checks: { state: "observed", status: "FAILURE" },
    });
    expect(result.pulls.records[0].dependencyBot).toBe("dependabot");
    expect(result.issues).toMatchObject({
      state: "observed",
      total: 1,
      enabled: true,
    });
    expect(workEvidenceSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(F.privateValue);
    expect(JSON.stringify(result)).not.toContain(F.token);
    expect(JSON.stringify(result)).not.toContain("PR_synthetic");
    expect(workItemUrl(F.repository, "pull", 1)).toBe(
      "https://github.com/example/work-fixture/pull/1",
    );
  });
  it("never requests private bodies, comments, review text, arbitrary searches or mutations", () => {
    expect(WORK_QUERY + WORK_SIGNALS_QUERY).not.toMatch(
      /\b(body|bodyHTML|comments|search|mutation|email|message|url)\b/,
    );
  });
  it("skips signal reads on an observed empty PR inventory and distinguishes disabled issues", async () => {
    const metadata = workFixture(F.repository, []);
    metadata.data.issueRepository.hasIssuesEnabled = false;
    metadata.data.issueRepository.issues = {
      totalCount: 0,
      pageInfo: { hasNextPage: false },
      nodes: [],
    };
    const f = fixture(metadata);
    expect(await f.read()).toMatchObject({
      pulls: { state: "observed", total: 0 },
      issues: { state: "observed", total: 0, enabled: false },
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["pullRepository", "issueRepository"])(
    "preserves independent metadata when %s is forbidden",
    async (alias) => {
      const result = await fixture({
        ...workFixture(),
        errors: [{ type: "FORBIDDEN", path: [alias], message: F.privateValue }],
      }).read();
      expect(
        alias === "pullRepository" ? result.pulls : result.issues,
      ).toMatchObject({ state: "unavailable", total: null, records: [] });
      expect(
        alias === "pullRepository" ? result.issues.state : result.pulls.state,
      ).toBe("observed");
    },
  );
  it("keeps PR metadata and review evidence when only checks are forbidden", async () => {
    const result = await fixture(workFixture(), {
      ...workSignalsFixture(),
      errors: [
        {
          type: "FORBIDDEN",
          path: [
            "nodes",
            0,
            "commits",
            "nodes",
            0,
            "commit",
            "statusCheckRollup",
          ],
          message: F.privateValue,
        },
      ],
    }).read();
    expect(result.pulls.records[0]).toMatchObject({
      title: "Review dependency update 2",
      review: { state: "observed" },
      checks: { state: "unavailable", status: null },
    });
    expect(result.pulls.records[1].checks.status).toBe("FAILURE");
  });
  it("keeps head checks when review evidence is forbidden", async () => {
    const result = await fixture(workFixture(), {
      ...workSignalsFixture(),
      errors: [{ type: "FORBIDDEN", path: ["nodes", 0, "reviewDecision"] }],
    }).read();
    expect(result.pulls.records[0]).toMatchObject({
      review: { state: "unavailable", decision: null },
      checks: { state: "observed", status: "SUCCESS" },
    });
  });
  it("keeps null decisions, absent reviewer counts and absent check rollups explicitly unknown", async () => {
    const signals = workSignalsFixture();
    const value = {
      ...signals.data.nodes[0],
      reviewDecision: null,
      reviewRequests: null,
      commits: {
        nodes: [{ commit: { oid: F.head, statusCheckRollup: null } }],
      },
    };
    const result = await fixture(workFixture(), {
      data: { nodes: [value, signals.data.nodes[1]] },
    }).read();
    expect(result.pulls.records[0]).toMatchObject({
      review: { state: "observed", decision: null, requested: null },
      checks: { state: "observed", status: null },
    });
    expect(
      filterWork(result.pulls.records, "review", NOW).map((p) => p.number),
    ).toEqual([1]);
  });
  it.each(["identity", "number", "repository", "head", "commit", "closed"])(
    "rejects %s drift without losing PR metadata",
    async (variant) => {
      const signals = workSignalsFixture();
      const item = signals.data.nodes[0];
      if (variant === "identity") item.id = "PR_different";
      if (variant === "number") item.number = 42;
      if (variant === "repository")
        item.repository.nameWithOwner = "example/other";
      if (variant === "head") item.headRefOid = "b".repeat(40);
      if (variant === "commit")
        item.commits.nodes[0].commit.oid = "b".repeat(40);
      if (variant === "closed") item.state = "CLOSED";
      const result = await fixture(workFixture(), signals).read();
      expect(result.pulls.state).toBe("observed");
      expect(result.pulls.records[0].checks).toMatchObject({
        state: "error",
        status: null,
      });
      expect(result.pulls.records[0].review.state).toBe(
        variant === "commit" ? "observed" : "error",
      );
    },
  );
  it("rejects null nodes, unknown enum values and missing commits without fabricating clean states", async () => {
    for (const value of [
      null,
      { ...workSignalsFixture().data.nodes[0], commits: { nodes: [] } },
      { ...workSignalsFixture().data.nodes[0], reviewDecision: "MERGEABLE" },
    ]) {
      const result = await fixture(workFixture(), {
        data: { nodes: [value, workSignalsFixture().data.nodes[1]] },
      }).read();
      expect(result.pulls.state).toBe("observed");
      expect(
        result.pulls.records[0].checks.state === "error" ||
          result.pulls.records[0].review.state === "error",
      ).toBe(true);
    }
  });
  it("merges bounded recent and oldest samples without claiming full review/check coverage", async () => {
    const recent = Array.from({ length: WORK_LIMITS.RECENT_PULLS }, (_, i) =>
      providerPull(i + 1),
    );
    const oldest = Array.from({ length: WORK_LIMITS.OLDEST_PULLS }, (_, i) => ({
      ...providerPull(i + 11),
      createdAt: "2026-01-01T12:00:00Z",
      updatedAt: "2026-02-01T12:00:00Z",
    }));
    const metadata = workFixture(F.repository, recent);
    metadata.data.pullRepository.recent = {
      totalCount: 51,
      pageInfo: { hasNextPage: true },
      nodes: recent,
    };
    metadata.data.pullRepository.oldest = {
      totalCount: 51,
      pageInfo: { hasNextPage: true },
      nodes: oldest,
    };
    const selected = [...recent, ...oldest].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number,
    );
    const result = await fixture(
      metadata,
      workSignalsFixture(
        F.repository,
        selected.map((p) => p.id),
      ),
    ).read();
    expect(result.pulls).toMatchObject({
      total: 51,
      hasMore: true,
      state: "observed",
    });
    expect(result.pulls.records).toHaveLength(WORK_LIMITS.PULLS);
    expect(filterWork(result.pulls.records, "aging", NOW)).toHaveLength(
      WORK_LIMITS.PULLS,
    );
  });
  it.each(["count", "duplicate", "order", "overlap", "page", "identity"])(
    "rejects inconsistent metadata %s",
    async (variant) => {
      const metadata = workFixture();
      const pulls = metadata.data.pullRepository;
      if (variant === "count") pulls.oldest.totalCount = 4;
      if (variant === "duplicate")
        pulls.recent.nodes[1] = pulls.recent.nodes[0];
      if (variant === "order")
        pulls.oldest.nodes[0].createdAt = "2026-07-01T12:00:00Z";
      if (variant === "overlap")
        pulls.oldest.nodes[0].headRefOid = "b".repeat(40);
      if (variant === "page") pulls.recent.pageInfo.hasNextPage = true;
      if (variant === "identity") pulls.nameWithOwner = "example/other";
      const f = fixture(metadata);
      expect((await f.read()).pulls).toMatchObject({
        state: "error",
        records: [],
        total: null,
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("requires exact provider Bot attribution instead of matching titles or human names", async () => {
    const pulls = [
      providerPull(1, { __typename: "User", login: "dependabot" }),
      providerPull(2, { __typename: "Bot", login: "renovate" }),
      providerPull(3, { __typename: "Bot", login: "another-bot" }),
    ];
    const result = await fixture(
      workFixture(F.repository, pulls),
      workSignalsFixture(
        F.repository,
        [...pulls].reverse().map((p) => p.id),
      ),
    ).read();
    expect(result.pulls.records.map((p) => p.dependencyBot)).toEqual([
      null,
      "renovate",
      null,
    ]);
    expect(
      filterWork(result.pulls.records, "dependencies", NOW).map(
        (p) => p.number,
      ),
    ).toEqual([2]);
  });
  it.each(["metadata", "signals"])(
    "persists HTTP-success GraphQL cooldown from %s without extra reads",
    async (phase) => {
      const rate = {
        type: "RATE_LIMITED",
        path: phase === "metadata" ? ["issueRepository"] : ["nodes"],
      };
      const response = Response.json(
        {
          ...(phase === "metadata" ? workFixture() : workSignalsFixture()),
          errors: [rate],
        },
        { headers: { "X-RateLimit-Reset": String(NOW / 1000 + 600) } },
      );
      const f =
        phase === "metadata"
          ? fixture(response)
          : fixture(workFixture(), response);
      const result = await f.read();
      expect(result.retryAt).toBe(new Date(NOW + 600000).toISOString());
      expect(
        result.pulls.records.every((p) => p.checks.state === "rate_limited"),
      ).toBe(true);
      expect(f.fetcher).toHaveBeenCalledTimes(phase === "metadata" ? 1 : 2);
    },
  );
  it.each([301, 401, 403, 404, 429, 500])(
    "keeps metadata when signals fail with HTTP %i",
    async (status) => {
      const result = await fixture(
        workFixture(),
        new Response(F.privateValue, { status }),
      ).read();
      expect(result.pulls.state).toBe("observed");
      expect(result.pulls.records[0].checks.status).toBeNull();
      expect(result.pulls.records[0].checks.state).not.toBe("observed");
      expect(JSON.stringify(result)).not.toContain(F.privateValue);
    },
  );
  it("rejects unscoped error paths and oversized signal collections", async () => {
    const f = fixture({
      ...workFixture(),
      errors: [{ type: "FORBIDDEN", path: ["unexpected"] }],
    });
    expect((await f.read()).pulls.state).toBe("error");
    const result = await fixture(workFixture(), { data: { nodes: [] } }).read();
    expect(result.pulls.records[0].review.state).toBe("error");
  });
});
