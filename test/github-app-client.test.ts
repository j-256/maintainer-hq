import { beforeAll, describe, expect, it } from "vitest";
import { GitHubAppClient } from "../worker/github-app-client";
import { githubAppTestKey } from "./helpers/github-app-keys";

let key: Awaited<ReturnType<typeof githubAppTestKey>>;
beforeAll(async () => {
  key = await githubAppTestKey();
});
const now = Date.parse("2026-11-09T12:00:00Z");
const repository = {
  id: 101,
  full_name: "example/repository",
  private: true,
  owner: { id: 50 },
};
const installation = {
  id: 7,
  app_id: 42,
  account: { id: 50, login: "example", type: "Organization" },
  permissions: { contents: "read", metadata: "read" },
  repository_selection: "selected",
  suspended_at: null,
};
const scope = {
  installationId: 7,
  repositoryIds: [101],
  permissions: { contents: "read" as const, metadata: "read" as const },
};
function tokenResponse(extra: Record<string, unknown> = {}) {
  return {
    token: "synthetic-installation-token",
    expires_at: "2026-11-09T13:00:00Z",
    permissions: { contents: "read", metadata: "read" },
    repository_selection: "selected",
    repositories: [repository],
    ...extra,
  };
}
function client(fetcher: typeof fetch) {
  return new GitHubAppClient({
    appId: 42,
    privateKey: key.pkcs8,
    fetch: fetcher,
    now: () => now,
  });
}

describe("GitHub App fixed-origin client", () => {
  it("keeps signing material out of serialized client state", () => {
    const api = client(async () => Response.json({}));
    expect(JSON.stringify(api).includes("PRIVATE KEY")).toBe(false);
  });
  it("normalizes the authenticated App and refuses another App's identity", async () => {
    const app = {
      id: 42,
      name: "Repository operator",
      slug: "repository-operator",
      owner: installation.account,
      permissions: { contents: "read" },
      private_provider_extra: "omit",
    };
    expect(await client(async () => Response.json(app)).getApp()).toEqual({
      id: 42,
      name: "Repository operator",
      slug: "repository-operator",
      account: installation.account,
      permissions: { contents: "read" },
    });
    await expect(
      client(async () => Response.json({ ...app, id: 43 })).getApp(),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
  });
  it("requests only selected repositories and permissions and returns normalized private token data", async () => {
    let request: Request | undefined;
    const api = client(async (input, init) => {
      request = new Request(input, init);
      return Response.json(tokenResponse());
    });
    const token = await api.mintToken(scope);
    expect(request?.url).toBe(
      "https://api.github.com/app/installations/7/access_tokens",
    );
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("User-Agent")).toBe("maintainer-hq");
    expect(await request?.json()).toEqual({
      repository_ids: [101],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(token).toMatchObject({
      token: "synthetic-installation-token",
      expiresAt: "2026-11-09T13:00:00.000Z",
      repositoryIds: [101],
      permissions: { contents: "read", metadata: "read" },
    });
  });

  it("rejects excess, missing or expired token authority and malformed responses", async () => {
    for (const response of [
      tokenResponse({ repositories: [repository, { ...repository, id: 102 }] }),
      tokenResponse({ repositories: [] }),
      tokenResponse({ permissions: { contents: "write", metadata: "read" } }),
      tokenResponse({ permissions: { contents: "read", workflows: "write" } }),
      tokenResponse({ permissions: { metadata: "read" } }),
      tokenResponse({ expires_at: "2026-11-09T12:00:30Z" }),
      tokenResponse({ expires_at: "2026-11-11T13:00:00Z" }),
      tokenResponse({ token: "contains newline\n" }),
    ]) {
      await expect(
        client(async () => Response.json(response)).mintToken(scope),
      ).rejects.toMatchObject({ code: "github_app_response_invalid" });
    }
    await expect(
      client(async () => new Response("x".repeat(262145))).mintToken(scope),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
  });

  it("accepts documented selection labels only with the exact narrowed repository proof", async () => {
    for (const selection of ["all", undefined]) {
      const token = await client(async () =>
        Response.json(tokenResponse({ repository_selection: selection })),
      ).mintToken(scope);
      expect(token.repositoryIds).toEqual([101]);
    }
    await expect(
      client(async () =>
        Response.json(
          tokenResponse({
            repository_selection: "all",
            repositories: [repository, { ...repository, id: 102 }],
          }),
        ),
      ).mintToken(scope),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
  });

  it("fails before provider calls for unbounded or ambiguous token requests", async () => {
    let calls = 0;
    const api = client(async () => {
      calls++;
      return Response.json(tokenResponse());
    });
    for (const request of [
      { ...scope, repositoryIds: [] },
      { ...scope, repositoryIds: [101, 101] },
      { ...scope, installationId: -1 },
      { ...scope, permissions: {} },
    ])
      await expect(api.mintToken(request)).rejects.toMatchObject({
        code: "github_app_input_invalid",
      });
    expect(calls).toBe(0);
  });

  it("normalizes installations and refuses a substituted App identity", async () => {
    const api = client(async () =>
      Response.json({ ...installation, raw_provider_canary: "omit" }),
    );
    expect(await api.getInstallation(7)).toEqual({
      id: 7,
      appId: 42,
      account: { id: 50, login: "example", type: "Organization" },
      permissions: { contents: "read", metadata: "read" },
      repositorySelection: "selected",
      suspendedAt: null,
    });
    await expect(
      client(async () =>
        Response.json({ ...installation, app_id: 43 }),
      ).getInstallation(7),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
    await expect(
      client(async () =>
        Response.json({ ...installation, id: 8 }),
      ).getInstallation(7),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
  });

  it("uses bounded numeric pagination and does not mistake a full page for a complete inventory", async () => {
    let url = "";
    const page = await client(async (input) => {
      url = String(input);
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({ ...installation, id: i + 1 })),
      );
    }).listInstallations();
    expect(url).toBe(
      "https://api.github.com/app/installations?per_page=100&page=1",
    );
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBe("2");
    await expect(
      client(async () => Response.json([])).listInstallations(
        "https://other.invalid/",
      ),
    ).rejects.toMatchObject({ code: "github_app_input_invalid" });
  });

  it("verifies repository identity using a token narrowed to that numeric repository", async () => {
    let body: unknown;
    const result = await client(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(
        tokenResponse({ permissions: { metadata: "read" } }),
      );
    }).verifyRepository(7, 101);
    expect(body).toEqual({
      repository_ids: [101],
      permissions: { metadata: "read" },
    });
    expect(result).toEqual({
      id: 101,
      fullName: "example/repository",
      private: true,
      ownerId: 50,
    });
  });

  it("reports an inventory limit instead of claiming the last full page is complete", async () => {
    const page = await client(async () =>
      Response.json(
        Array.from({ length: 100 }, (_, i) => ({ ...installation, id: i + 1 })),
      ),
    ).listInstallations("10000");
    expect(page.nextCursor).toBeNull();
    expect(page.limited).toBe(true);
  });

  it("does not follow redirects or leak provider bodies in permission and quota failures", async () => {
    const denied = client(
      async () => new Response("private-provider-body-canary", { status: 403 }),
    );
    await expect(denied.getInstallation(7)).rejects.toMatchObject({
      code: "github_app_denied",
    });
    const limited = client(
      async () =>
        new Response("private-provider-body-canary", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    await expect(limited.getInstallation(7)).rejects.toMatchObject({
      code: "github_app_rate_limited",
      retryAt: "2026-11-09T12:00:30.000Z",
    });
    try {
      await denied.getInstallation(7);
    } catch (error) {
      expect(String(error)).not.toContain("private-provider-body-canary");
    }
    await expect(
      client(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://other.invalid" },
          }),
      ).getInstallation(7),
    ).rejects.toMatchObject({ code: "github_app_unavailable" });
  });
});
