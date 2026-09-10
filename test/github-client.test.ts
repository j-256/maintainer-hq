import { describe, expect, it, vi } from "vitest";
import { collectGitHub, githubNextPage } from "../worker/github-client";
import {
  GITHUB_LIMITS,
  githubEvidenceSchema,
  githubSecurityComplete,
} from "../shared/github-evidence";
import {
  assessRepository,
  DEFAULT_EXPECTATIONS,
  type Observation,
  type Repository,
} from "../shared/domain";

const REPOSITORY = "example/fixture";
const TOKEN = "synthetic-credential-for-tests";
const SHA = "a".repeat(40);
const NOW = Date.parse("2026-09-05T12:00:00Z");
const PREFIX = "/repos/" + REPOSITORY;
const PATH = Object.freeze({
  repository: PREFIX,
  head: PREFIX + "/branches/main",
  checks: PREFIX + "/commits/" + SHA + "/check-runs",
  statuses: PREFIX + "/commits/" + SHA + "/status",
  dependabot: PREFIX + "/dependabot/alerts",
  codeScanning: PREFIX + "/code-scanning/alerts",
  secretScanning: PREFIX + "/secret-scanning/alerts",
});
const RAW_VALUE = "synthetic-sensitive-provider-field";
const check = (id = 1, conclusion = "success") => ({
  id,
  head_sha: SHA,
  status: "completed",
  conclusion,
});
const status = (id = 1, state = "success", context = "legacy-ci") => ({
  id,
  state,
  context,
});
const alert = (number = 1) => ({ number, state: "open", secret: RAW_VALUE });
const json = (body: unknown, headers?: HeadersInit) =>
  Response.json(body, { headers });
type Override = (url: URL) => Response | Promise<Response>;

function fixture(overrides: Partial<Record<keyof typeof PATH, Override>> = {}) {
  const defaults: Record<keyof typeof PATH, Override> = {
    repository: () =>
      json({
        full_name: REPOSITORY,
        private: true,
        default_branch: "main",
        description: RAW_VALUE,
      }),
    head: () =>
      json({ name: "main", commit: { sha: SHA, message: RAW_VALUE } }),
    checks: () => json({ total_count: 1, check_runs: [check()] }),
    statuses: () =>
      json({ sha: SHA, state: "pending", total_count: 0, statuses: [] }),
    dependabot: () => json([]),
    codeScanning: () => json([]),
    secretScanning: () => json([]),
  };
  const urls: URL[] = [];
  const request = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url);
      expect(url.origin).toBe(GITHUB_LIMITS.API_ORIGIN);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer " + TOKEN);
      expect(headers.get("X-GitHub-Api-Version")).toBe(
        GITHUB_LIMITS.API_VERSION,
      );
      const key = (Object.keys(PATH) as (keyof typeof PATH)[]).find(
        (candidate) => PATH[candidate] === url.pathname,
      );
      if (!key) throw new Error("Unexpected fixture path");
      return (overrides[key] ?? defaults[key])(url);
    },
  ) as unknown as typeof fetch;
  return {
    urls,
    request,
    collect: (
      options: { requestTimeoutMs?: number; signal?: AbortSignal } = {},
    ) =>
      collectGitHub(REPOSITORY, TOKEN, {
        fetch: request,
        now: () => NOW,
        ...options,
      }),
  };
}

describe("Read-only GitHub collection", () => {
  it("counts started requests and parsed list pages without polluting evidence equality", async () => {
    const result = await fixture().collect();
    expect(result.diagnostics).toMatchObject({
      requests: 7,
      pages: 5,
      elapsedMs: expect.any(Number),
    });
    expect(
      result.diagnostics.endpoints.every((item) => item.reason === "complete"),
    ).toBe(true);
    expect(result.details).not.toHaveProperty("diagnostics");
    expect(result.details.github).not.toHaveProperty("diagnostics");
  });

  it("distinguishes runtime errors from limits, permissions and provider failures", async () => {
    for (const [response, reason] of [
      [
        () => {
          throw new TypeError(RAW_VALUE);
        },
        "unexpected",
      ],
      [() => new Response(RAW_VALUE, { status: 401 }), "credential"],
      [() => new Response(RAW_VALUE, { status: 403 }), "permission"],
      [() => new Response(RAW_VALUE, { status: 502 }), "provider_error"],
      [() => new Response(RAW_VALUE, { status: 302 }), "redirect"],
      [() => new Response(RAW_VALUE, { status: 429 }), "rate_limit"],
      [() => json({ unexpected: RAW_VALUE }), "response_invalid"],
      [
        () =>
          new Response(null, {
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(GITHUB_LIMITS.RESPONSE_BYTES + 1),
            },
          }),
        "response_size",
      ],
    ] as const) {
      const result = await fixture({ repository: response }).collect();
      expect(result.diagnostics).toMatchObject({
        requests: 1,
        pages: 0,
        endpoints: [
          expect.objectContaining({ key: "repository", reason }),
          ...Array.from({ length: 6 }, () =>
            expect.objectContaining({ requests: 0, reason: "not_attempted" }),
          ),
        ],
      });
      expect(JSON.stringify(result)).not.toContain(RAW_VALUE);
      if (reason === "unexpected")
        expect(result.summary).not.toContain("request limits");
    }
  });

  it("makes timeouts and preflight cancellation distinct with accurate started counts", async () => {
    const timedOut = await fixture({
      repository: () => new Promise<Response>(() => {}),
    }).collect({ requestTimeoutMs: 5 });
    expect(timedOut.diagnostics.endpoints[0]).toMatchObject({
      reason: "timeout",
      requests: 1,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await fixture().collect({ signal: controller.signal });
    expect(cancelled.diagnostics.endpoints[0]).toMatchObject({
      reason: "interrupted",
      requests: 0,
    });
  });

  it("records a page cutoff separately from invalid pagination", async () => {
    const result = await fixture({
      dependabot: (url) => {
        const page = Number(url.searchParams.get("after") ?? "0");
        const next = new URL(url);
        next.searchParams.set("after", String(page + 1));
        return json([alert(page + 1)], {
          Link: "<" + next.href + '>; rel="next"',
        });
      },
    }).collect();
    expect(
      result.diagnostics.endpoints.find((item) => item.key === "dependabot"),
    ).toMatchObject({
      requests: GITHUB_LIMITS.MAX_PAGES,
      pages: GITHUB_LIMITS.MAX_PAGES,
      reason: "page_limit",
    });
    expect(result.diagnostics.requests).toBe(6 + GITHUB_LIMITS.MAX_PAGES);
  });
  it("preserves the global receiver required by native Workers fetch", async () => {
    const source = fixture();
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(function (
      this: unknown,
      input,
      init,
    ) {
      expect(this).toBe(globalThis);
      return source.request(input, init);
    });
    try {
      const result = await collectGitHub(REPOSITORY, TOKEN, { now: () => NOW });
      expect(result.status).toBe("succeeded");
      expect(source.urls).toHaveLength(7);
    } finally {
      request.mockRestore();
    }
  });

  it("pins CI to the default-branch commit and emits only minimized evidence", async () => {
    const source = fixture();
    const result = await source.collect();
    expect(result).toMatchObject({
      status: "succeeded",
      health: "healthy",
      observedAt: new Date(NOW).toISOString(),
      details: {
        ci: "passing",
        visibility: "private",
        openFindings: 0,
        github: { headSha: SHA },
      },
    });
    expect(githubEvidenceSchema.safeParse(result.details.github).success).toBe(
      true,
    );
    expect(result.details.github?.defaultBranch).toBe("main");
    expect(source.urls).toHaveLength(7);
    expect(
      source.urls
        .find((url) => url.pathname === PATH.codeScanning)
        ?.searchParams.get("ref"),
    ).toBe("refs/heads/main");
    expect(
      source.urls
        .find((url) => url.pathname === PATH.secretScanning)
        ?.searchParams.get("hide_secret"),
    ).toBe("true");
    expect(JSON.stringify(result)).not.toContain(RAW_VALUE);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("does not equate absent, skipped, or pending CI results with passing CI", async () => {
    for (const runs of [
      [],
      [check(1, "skipped")],
      [{ ...check(), status: "in_progress", conclusion: null }],
    ]) {
      const result = await fixture({
        checks: () => json({ total_count: runs.length, check_runs: runs }),
      }).collect();
      expect(result.status).toBe("succeeded");
      expect(result.details.ci).toBe("unknown");
      expect(result.health).toBe("unknown");
    }
    const result = await fixture({
      checks: () => json({ total_count: 0, check_runs: [] }),
      statuses: () =>
        json({
          sha: SHA,
          state: "success",
          total_count: 1,
          statuses: [status()],
        }),
    }).collect();
    expect(result.details.ci).toBe("passing");
  });

  it("keeps an aggregate pending status unverified even if the returned context passed", async () => {
    const result = await fixture({
      statuses: () =>
        json({
          sha: SHA,
          state: "pending",
          total_count: 1,
          statuses: [status()],
        }),
    }).collect();
    expect(result.details.ci).toBe("unknown");
  });

  it("surfaces known problems without converting missing security permissions to zero", async () => {
    const result = await fixture({
      checks: () => json({ total_count: 1, check_runs: [check(1, "failure")] }),
      dependabot: () => json([alert()]),
      secretScanning: () => new Response(RAW_VALUE, { status: 403 }),
    }).collect();
    expect(result).toMatchObject({
      status: "partial",
      health: "warning",
      details: { ci: "failing", openFindings: 1 },
    });
    expect(githubSecurityComplete(result.details.github!)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(RAW_VALUE);
    const unknown = await fixture({
      dependabot: () => new Response("not enabled", { status: 404 }),
    }).collect();
    expect(unknown.details.openFindings).toBeUndefined();
    expect(unknown.health).toBe("unknown");
  });

  it("rejects wrong repository identities, wrong commit evidence, and malformed success responses", async () => {
    const moved = fixture({
      repository: () =>
        json({
          full_name: "other/project",
          private: false,
          default_branch: "main",
        }),
    });
    expect((await moved.collect()).status).toBe("failed");
    expect(moved.urls).toHaveLength(1);
    for (const branch of [".", ".."]) {
      const invalid = fixture({
        repository: () =>
          json({
            full_name: REPOSITORY,
            private: true,
            default_branch: branch,
          }),
      });
      expect((await invalid.collect()).status).toBe("failed");
      expect(invalid.urls).toHaveLength(1);
    }
    for (const overrides of [
      {
        checks: () =>
          json({
            total_count: 1,
            check_runs: [{ ...check(), head_sha: "b".repeat(40) }],
          }),
      },
      {
        statuses: () =>
          json({
            sha: "b".repeat(40),
            state: "success",
            total_count: 1,
            statuses: [status()],
          }),
      },
      { dependabot: () => json({ message: RAW_VALUE }) },
      { secretScanning: () => json([{ ...alert(), state: "resolved" }]) },
    ]) {
      const result = await fixture(overrides).collect();
      expect(result.status).toBe("partial");
      expect(result.health).not.toBe("healthy");
      expect(JSON.stringify(result)).not.toContain(RAW_VALUE);
    }
  });

  it("follows validated Dependabot cursors without using unsupported page parameters", async () => {
    const source = fixture({
      dependabot: (url) =>
        url.searchParams.has("after")
          ? json([alert(2)])
          : json([alert()], {
              Link:
                "<" +
                GITHUB_LIMITS.API_ORIGIN +
                PATH.dependabot +
                '?state=open&per_page=100&after=next-cursor>; rel="next"',
            }),
    });
    const result = await source.collect();
    expect(result.details.openFindings).toBe(2);
    expect(result.status).toBe("succeeded");
    const pages = source.urls.filter((url) => url.pathname === PATH.dependabot);
    expect(pages).toHaveLength(2);
    expect(pages.every((url) => !url.searchParams.has("page"))).toBe(true);
    expect(pages[1].searchParams.get("after")).toBe("next-cursor");
  });

  it("marks capped pages, duplicate results, and incorrect totals as incomplete", async () => {
    const pages = fixture({
      dependabot: (url) => {
        const page = Number(url.searchParams.get("after") ?? "1");
        return json([alert(page)], {
          Link:
            "<" +
            GITHUB_LIMITS.API_ORIGIN +
            PATH.dependabot +
            "?state=open&per_page=100&after=" +
            (page + 1) +
            '>; rel="next"',
        });
      },
    });
    const capped = await pages.collect();
    expect(capped.status).toBe("partial");
    expect(capped.details.openFindings).toBe(GITHUB_LIMITS.MAX_PAGES);
    expect(
      capped.diagnostics.endpoints.find((item) => item.key === "dependabot"),
    ).toMatchObject({ pages: GITHUB_LIMITS.MAX_PAGES, reason: "page_limit" });
    expect(
      capped.details.github?.checks.find((item) => item.key === "dependabot")
        ?.state,
    ).toBe("limited");
    expect(
      pages.urls.filter((url) => url.pathname === PATH.dependabot),
    ).toHaveLength(GITHUB_LIMITS.MAX_PAGES);
    const duplicate = await fixture({
      checks: () => json({ total_count: 2, check_runs: [check(), check()] }),
    }).collect();
    expect(duplicate.details.ci).toBe("unknown");
    const wrongTotal = await fixture({
      checks: () => json({ total_count: 3, check_runs: [check()] }),
    }).collect();
    expect(wrongTotal.details.ci).toBe("unknown");
    const duplicateContext = await fixture({
      statuses: () =>
        json({
          sha: SHA,
          state: "success",
          total_count: 2,
          statuses: [status(1), status(2)],
        }),
    }).collect();
    expect(duplicateContext.details.ci).toBe("unknown");
  });

  it("does not follow pagination across hosts, paths, filters, or secret visibility", async () => {
    for (const next of [
      "https://untrusted.example/collect?after=next",
      GITHUB_LIMITS.API_ORIGIN +
        "/repos/other/project/secret-scanning/alerts?after=next",
      GITHUB_LIMITS.API_ORIGIN +
        PATH.secretScanning +
        "?state=resolved&hide_secret=true&after=next",
      GITHUB_LIMITS.API_ORIGIN +
        PATH.secretScanning +
        "?state=open&hide_secret=false&after=next",
    ]) {
      const source = fixture({
        secretScanning: () => json([], { Link: "<" + next + '>; rel="next"' }),
      });
      const result = await source.collect();
      expect(result.status).toBe("partial");
      expect(result.details.openFindings).toBeUndefined();
      expect(
        source.urls.filter((url) => url.pathname === PATH.secretScanning),
      ).toHaveLength(1);
    }
    const base = new URL(
      GITHUB_LIMITS.API_ORIGIN +
        "/repos/example/next/dependabot/alerts?per_page=100&state=open",
    );
    expect(githubNextPage(base, "<" + base.href + '>; rel="prev"')).toBeNull();
    expect(() =>
      githubNextPage(base, "<" + base.href + '&after=a&after=b>; rel="next"'),
    ).toThrow();
    expect(() =>
      githubNextPage(base, "<" + base.href + '&page=2>; rel="next"', true),
    ).toThrow();
  });

  it("never follows credential-bearing redirects or persists provider errors", async () => {
    for (const code of [301, 302, 307, 401, 403, 404, 500, 503]) {
      const source = fixture({
        repository: () =>
          new Response(RAW_VALUE, {
            status: code,
            headers: { Location: "https://untrusted.example/" },
          }),
      });
      const result = await source.collect();
      expect(result.status).toBe("failed");
      expect(result.health).toBe("unknown");
      expect(source.urls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(RAW_VALUE);
    }
  });

  it("honors rate-limit hints and stops starting additional requests during cooldown", async () => {
    for (const response of [
      () =>
        new Response(RAW_VALUE, {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      () =>
        new Response(RAW_VALUE, {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String((NOW + 120000) / 1000),
          },
        }),
      () =>
        new Response(RAW_VALUE, {
          status: 403,
          headers: { "Retry-After": new Date(NOW + 120000).toUTCString() },
        }),
    ]) {
      const source = fixture({ head: response });
      const result = await source.collect();
      expect(result.retryAt).toBe(new Date(NOW + 120000).toISOString());
      expect(result.status).toBe("partial");
      expect(source.urls).toHaveLength(2);
      expect(
        result.details.github?.checks.find((item) => item.key === "dependabot")
          ?.state,
      ).toBe("rate_limited");
    }
  });

  it("bounds actual response bytes and cancels stalled response reads", async () => {
    const oversized = fixture({
      repository: () =>
        new Response("x".repeat(GITHUB_LIMITS.RESPONSE_BYTES + 1), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect((await oversized.collect()).details.github?.checks[0].state).toBe(
      "limited",
    );
    let cancelled = false;
    const stalled = fixture({
      repository: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    const result = await stalled.collect({ requestTimeoutMs: 10 });
    expect(result.status).toBe("failed");
    expect(cancelled).toBe(true);
    const noResponse = fixture({
      repository: () => new Promise<Response>(() => {}),
    });
    expect((await noResponse.collect({ requestTimeoutMs: 10 })).status).toBe(
      "failed",
    );
    expect(noResponse.urls).toHaveLength(1);
    const malformedType = await fixture({
      repository: () =>
        new Response("<html>" + RAW_VALUE, {
          headers: { "Content-Type": "text/html" },
        }),
    }).collect();
    expect(malformedType.status).toBe("failed");
    expect(JSON.stringify(malformedType)).not.toContain(RAW_VALUE);
  });

  it("rejects unsafe names and credentials before any network access", async () => {
    const source = fixture();
    for (const name of [
      "example/..",
      "example/.",
      "https://example.test/path",
      "example/repo?next=1",
    ])
      expect(
        (await collectGitHub(name, TOKEN, { fetch: source.request })).status,
      ).toBe("failed");
    expect(
      (
        await collectGitHub(REPOSITORY, "bad\nheader", {
          fetch: source.request,
        })
      ).status,
    ).toBe("failed");
    expect(source.urls).toHaveLength(0);
  });

  it("does not start network work for an already-cancelled collection", async () => {
    const source = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await source.collect({ signal: controller.signal });
    expect(result.status).toBe("failed");
    expect(source.urls).toHaveLength(0);
  });

  it("keeps partial security coverage visible in repository assessment", async () => {
    const result = await fixture({
      dependabot: () => json([alert()]),
      secretScanning: () => new Response(null, { status: 404 }),
    }).collect();
    const repository: Repository = {
      id: "repository",
      workspaceId: "workspace",
      fullName: REPOSITORY,
      description: "",
      projectId: "project",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
      revision: 1,
      updatedAt: new Date(NOW).toISOString(),
    };
    const observation: Observation = {
      sourceId: "github",
      resourceId: repository.id,
      resourceType: "repository",
      name: REPOSITORY,
      provider: "github",
      health: result.health,
      summary: result.summary,
      details: result.details,
      observedAt: result.observedAt,
      receivedAt: result.observedAt,
      expiresAt: new Date(NOW + 60000).toISOString(),
    };
    expect(assessRepository(repository, [observation], NOW).reasons).toContain(
      "Security coverage is incomplete",
    );
    expect(assessRepository(repository, [observation], NOW).health).toBe(
      "warning",
    );
  });
});
