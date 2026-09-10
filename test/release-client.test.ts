import { describe, expect, it, vi } from "vitest";
import { RELEASE_QUERY, collectReleases } from "../worker/release-client";
import { GitHubReader } from "../worker/github-client";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import { RELEASE_LIMITS, releaseProviderLinks } from "../shared/releases";
import {
  RELEASE_FIXTURE as F,
  comparisonFixture,
  releaseFixture,
} from "./fixtures/releases";

const NOW = Date.parse("2026-09-08T12:00:00Z");
function fixture(
  graph: unknown = releaseFixture(),
  compare: unknown = comparisonFixture(),
) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(GITHUB_LIMITS.API_ORIGIN);
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer " + F.token,
      );
      if (url.pathname === "/graphql") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          query: RELEASE_QUERY,
          variables: { owner: "example", name: "release-fixture" },
        });
        return graph instanceof Response ? graph : Response.json(graph);
      }
      expect(init?.method).toBe("GET");
      expect(url.pathname).toBe(
        `/repos/${F.repository}/compare/${F.base}...${F.head}`,
      );
      expect(url.search).toBe("?per_page=1");
      return compare instanceof Response ? compare : Response.json(compare);
    },
  );
  return {
    fetcher,
    read: () =>
      collectReleases(F.repository, F.token, {
        fetch: fetcher,
        now: () => NOW,
      }),
  };
}

describe("Bounded release evidence", () => {
  it("uses a fixed read query and immutable comparison, retaining only minimized evidence", async () => {
    const f = fixture();
    const result = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(RELEASE_LIMITS.REQUESTS);
    expect(result.release.record).toEqual({
      id: 17,
      tag: "v1.0.0",
      publishedAt: F.timestamp,
      sha: F.base,
    });
    expect(result.comparison.record).toEqual({
      baseSha: F.base,
      headSha: F.head,
      status: "ahead",
      aheadBy: 3,
      behindBy: 0,
    });
    expect(result.deployments.records[0]).toMatchObject({
      id: 6089727714,
      status: "FAILURE",
    });
    expect(JSON.stringify(result)).not.toContain(F.privateValue);
    expect(JSON.stringify(result)).not.toContain(F.token);
    expect(releaseProviderLinks(F.repository, result).comparison).toBe(
      `https://github.com/${F.repository}/compare/${F.base}...${F.head}`,
    );
  });
  it("does not request release bodies, commit messages, provider payloads or target URLs", () => {
    expect(RELEASE_QUERY).not.toMatch(
      /\b(mutation|description|payload|environmentUrl|logUrl|message)\b/,
    );
  });
  it("preserves release evidence when deployments are forbidden", async () => {
    const graph = {
      ...releaseFixture(),
      errors: [
        {
          type: "FORBIDDEN",
          path: ["deploymentRepository", "deployments"],
          message: F.privateValue,
        },
      ],
    };
    const result = await fixture(graph).read();
    expect(result.release.state).toBe("observed");
    expect(result.comparison.state).toBe("observed");
    expect(result.deployments).toEqual({
      state: "unavailable",
      reason: "permission",
      total: null,
      hasMore: false,
      records: [],
    });
    expect(JSON.stringify(result)).not.toContain(F.privateValue);
  });
  it("does not treat an unavailable repository as an empty successful read", async () => {
    const result = await fixture({
      data: { releaseRepository: null, deploymentRepository: null },
      errors: [
        { type: "NOT_FOUND", path: ["releaseRepository"] },
        { type: "NOT_FOUND", path: ["deploymentRepository"] },
      ],
    }).read();
    expect(result.release.state).toBe("unavailable");
    expect(result.deployments.total).toBeNull();
    expect(result.comparison.state).toBe("unobserved");
  });
  it("rejects GraphQL errors whose scope cannot be attributed to the fixed query", async () => {
    const result = await fixture({
      ...releaseFixture(),
      errors: [
        { type: "FORBIDDEN", path: ["unexpected"], message: F.privateValue },
      ],
    }).read();
    expect(result.release).toMatchObject({
      state: "error",
      reason: "response_invalid",
      record: null,
    });
    expect(result.deployments.records).toEqual([]);
  });
  it("labels an empty successful inventory without inferring runtime health", async () => {
    const graph = releaseFixture();
    const data = {
      ...graph.data,
      releaseRepository: {
        ...graph.data.releaseRepository,
        latestRelease: null,
      },
      deploymentRepository: {
        ...graph.data.deploymentRepository,
        deployments: {
          totalCount: 0,
          pageInfo: { hasNextPage: false },
          nodes: [],
        },
      },
    };
    const f = fixture({ data });
    const result = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(result.release).toEqual({
      state: "observed",
      reason: "complete",
      record: null,
    });
    expect(result.deployments).toMatchObject({
      state: "observed",
      total: 0,
      records: [],
    });
    expect(result.comparison.state).toBe("unobserved");
    expect(result).not.toHaveProperty("health");
  });
  it("avoids a comparison request when the observed SHAs match", async () => {
    const graph = releaseFixture();
    graph.data.releaseRepository.defaultBranchRef.target.oid = F.base;
    const f = fixture(graph);
    const result = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(result.comparison.record?.status).toBe("identical");
  });
  it("keeps a bounded deployment sample explicit and rejects duplicate, misordered and inconsistent samples", async () => {
    const graph = releaseFixture();
    const rows = graph.data.deploymentRepository.deployments;
    rows.nodes = Array.from({ length: RELEASE_LIMITS.DEPLOYMENTS }, (_, i) => ({
      ...rows.nodes[0],
      databaseId: i + 1,
    }));
    rows.totalCount = 12;
    rows.pageInfo.hasNextPage = true;
    expect((await fixture(graph).read()).deployments).toMatchObject({
      state: "observed",
      total: 12,
      hasMore: true,
    });
    rows.nodes[1].databaseId = 1;
    expect((await fixture(graph).read()).deployments.state).toBe("error");
    rows.nodes[1].databaseId = 2;
    rows.nodes[1].createdAt = "2026-09-02T12:00:00Z";
    expect((await fixture(graph).read()).deployments.state).toBe("error");
    rows.nodes[1].createdAt = F.timestamp;
    rows.pageInfo.hasNextPage = false;
    expect((await fixture(graph).read()).deployments.state).toBe("error");
  });
  it.each(["releaseRepository", "deploymentRepository"] as const)(
    "rejects identity drift in %s",
    async (alias) => {
      const graph = releaseFixture();
      graph.data[alias].nameWithOwner = "example/different";
      const result = await fixture(graph).read();
      expect(
        alias === "releaseRepository"
          ? result.release.state
          : result.deployments.state,
      ).toBe("error");
    },
  );
  it.each(["base", "counts", "status"])(
    "rejects inconsistent comparison %s",
    async (variant) => {
      const value = comparisonFixture();
      if (variant === "base") value.base_commit.sha = F.head;
      if (variant === "counts") value.total_commits = 9;
      if (variant === "status") value.status = "identical";
      const result = await fixture(releaseFixture(), value).read();
      expect(result.comparison).toMatchObject({
        state: "error",
        reason: "response_invalid",
        record: null,
      });
      expect(result.release.state).toBe("observed");
    },
  );
  it.each(["isDraft", "isPrerelease"] as const)(
    "does not accept a %s release as published stable evidence",
    async (field) => {
      const graph = releaseFixture();
      graph.data.releaseRepository.latestRelease[field] = true;
      expect((await fixture(graph).read()).release.state).toBe("error");
    },
  );
  it("honors GraphQL rate limits even when HTTP returns success and suppresses the comparison", async () => {
    const graph = {
      ...releaseFixture(),
      errors: [{ type: "RATE_LIMITED", path: ["deploymentRepository"] }],
    };
    const f = fixture(
      Response.json(graph, {
        headers: { "X-RateLimit-Reset": String(NOW / 1000 + 600) },
      }),
    );
    const result = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(result.deployments.state).toBe("rate_limited");
    expect(result.comparison.state).toBe("rate_limited");
    expect(result.retryAt).toBe(new Date(NOW + 600000).toISOString());
  });
  it.each([301, 401, 403, 404, 429, 500])(
    "does not follow or disclose provider error %s",
    async (status) => {
      const f = fixture(
        new Response(F.privateValue, {
          status,
          headers: { Location: "https://elsewhere.example/private" },
        }),
      );
      const result = await f.read();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(result.release.state).not.toBe("observed");
      expect(JSON.stringify(result)).not.toContain(F.privateValue);
    },
  );
  it("bounds response bytes before accepting any metadata", async () => {
    const result = await fixture(
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(GITHUB_LIMITS.RESPONSE_BYTES + 1),
        },
      }),
    ).read();
    expect(result.release).toMatchObject({
      state: "limited",
      reason: "response_size",
    });
  });
  it("bounds streamed bodies and stalled reads", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(GITHUB_LIMITS.RESPONSE_BYTES + 1));
      },
    });
    expect(
      (
        await fixture(
          new Response(stream, {
            headers: { "Content-Type": "application/json" },
          }),
        ).read()
      ).release.reason,
    ).toBe("response_size");
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const result = await collectReleases(F.repository, F.token, {
      fetch: fetcher,
      requestTimeoutMs: 5,
    });
    expect(result.release.reason).toBe("timeout");
  });
  it("does not allow GraphQL requests to another endpoint and preserves the lower request budget", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const reader = new GitHubReader(F.token, {
      fetch: fetcher,
      maxRequests: 1,
    });
    await expect(
      reader.request(
        "repository",
        new URL("https://api.github.com/repos/example/repo"),
        { query: RELEASE_QUERY, variables: {} },
      ),
    ).rejects.toMatchObject({ reason: "configuration" });
    await reader.request(
      "repository",
      new URL("https://api.github.com/graphql"),
      { query: RELEASE_QUERY, variables: {} },
    );
    await expect(
      reader.request("repository", new URL("https://api.github.com/graphql"), {
        query: RELEASE_QUERY,
        variables: {},
      }),
    ).rejects.toMatchObject({ reason: "request_limit" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
