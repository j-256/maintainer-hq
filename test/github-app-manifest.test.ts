import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApplication } from "../worker/app";
import {
  renderGitHubAppManifest,
  completeGitHubAppManifest,
} from "../worker/github-app-manifest";
import { githubAppTestKey } from "./helpers/github-app-keys";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  githubAppTestPrincipal,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";

let fixture: GitHubAppFixture;
let key: Awaited<ReturnType<typeof githubAppTestKey>>;
beforeAll(async () => {
  await migrateGitHubAppFixture();
  key = await githubAppTestKey();
});
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  fixture.runtime.GITHUB_APP_ORIGIN = "https://hq.example";
});
afterEach(() => vi.restoreAllMocks());
const startInput = {
  workspaceId: "administration",
  registrationId: "app-a",
  name: "Repository operator",
  visibility: "public",
  capabilities: ["repository-maintenance"],
  account: { login: "example", type: "Organization" },
};
const upstream = {
  id: 42,
  slug: "repository-operator",
  name: "Repository operator",
  owner: { id: 50, login: "example", type: "Organization" },
  permissions: { metadata: "read", contents: "write", pull_requests: "write" },
};
async function prepare() {
  const attempt = await fixture.operator.githubAppManifestStart(startInput);
  const response = await renderGitHubAppManifest(
    new Request(attempt.browserUrl),
    fixture.operator,
  );
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const html = await response.text();
  const action = /action="([^"]+)"/.exec(html)?.[1];
  expect(action).toBeTruthy();
  const state = new URL(action!).searchParams.get("state")!;
  return {
    attempt,
    html,
    state,
    callback: new Request(
      "https://hq.example/api/github-apps/manifest/callback?" +
        new URLSearchParams({ code: "synthetic-code-canary", state }),
      { headers: { "Sec-Fetch-Site": "cross-site" } },
    ),
  };
}
function provider() {
  let exchanges = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (
      url ===
      "https://api.github.com/app-manifests/synthetic-code-canary/conversions"
    ) {
      expect(new Headers(init?.headers).get("User-Agent")).toBe("maintainer-hq");
      exchanges++;
      return Response.json({
        ...upstream,
        pem: key.pkcs8,
        webhook_secret: "synthetic-lifecycle-secret",
        client_secret: "discard-oauth-secret-canary",
      });
    }
    if (url === "https://api.github.com/app") return Response.json(upstream);
    throw new Error("Unexpected synthetic provider request");
  });
  return () => exchanges;
}

describe("guided GitHub App manifest registration", () => {
  it("renders a configuration manifest with GitHub's accepted Variables permission", async () => {
    const attempt = await fixture.operator.githubAppManifestStart({
      ...startInput,
      capabilities: ["configuration-read", "configuration-write"],
    });
    const response = await renderGitHubAppManifest(
      new Request(attempt.browserUrl),
      fixture.operator,
    );
    const html = await response.text();
    expect(html).toContain("&quot;actions_variables&quot;:&quot;write&quot;");
    expect(html).not.toContain("&quot;variables&quot;");
  });

  it("allows GitHub form submission only on the authenticated manifest page", async () => {
    const attempt = await fixture.operator.githubAppManifestStart(startInput);
    const app = createApplication(async () => githubAppTestPrincipal());
    const form = await app.fetch(
      new Request(attempt.browserUrl),
      fixture.runtime,
    );
    expect(form.status).toBe(200);
    expect(form.headers.get("Content-Security-Policy")).toContain(
      "form-action https://github.com",
    );
    const session = await app.fetch(
      new Request("https://hq.example/api/session"),
      fixture.runtime,
    );
    expect(session.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
  });
  it("keeps manifest state in the authenticated browser ceremony and saves complete private custody", async () => {
    const { attempt, html, callback, state } = await prepare();
    expect(JSON.stringify(attempt)).not.toContain(state);
    expect(html).toContain(
      "https://github.com/organizations/example/settings/apps/new",
    );
    expect(html).not.toContain("PRIVATE KEY");
    const exchanges = provider();
    const diagnostics = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await createApplication(async () =>
      githubAppTestPrincipal(),
    ).fetch(callback, fixture.runtime);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).not.toContain("code=");
    expect(response.headers.get("Location")).not.toContain("state=");
    expect(
      new URL(response.headers.get("Location")!).searchParams.get(
        "githubAppWorkspace",
      ),
    ).toBe("administration");
    expect(
      new URL(response.headers.get("Location")!).searchParams.get(
        "supportReference",
      ),
    ).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(exchanges()).toBe(1);
    expect(
      diagnostics.mock.calls.some(
        (call) =>
          call[0]?.event === "hq.github.app.manifest" &&
          call[0]?.state === "complete",
      ),
    ).toBe(true);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      "synthetic-code-canary",
    );
    const status = await fixture.operator.githubAppManifestGet({
      workspaceId: "administration",
      attemptId: attempt.id,
    });
    expect(status.state).toBe("complete");
    expect(JSON.stringify(status)).not.toContain("synthetic-lifecycle-secret");
    expect(JSON.stringify(status)).not.toContain("discard-oauth-secret-canary");
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "administration",
          scope: "administration",
        })
      ).registrations[0],
    ).toMatchObject({ appId: 42, lifecycleIngress: "ready" });
    await completeGitHubAppManifest(
      new Request(callback.url),
      fixture.operator,
    );
    expect(exchanges()).toBe(1);
  });

  it("claims conversion once and preserves an uncertain exchange without replay", async () => {
    const { attempt, callback } = await prepare();
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
    let exchanges = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      exchanges++;
      throw new Error("Synthetic lost provider response");
    });
    expect(
      (await completeGitHubAppManifest(callback, fixture.operator)).status,
    ).toBe(303);
    expect(
      (
        await fixture.operator.githubAppManifestGet({
          workspaceId: "administration",
          attemptId: attempt.id,
        })
      ).state,
    ).toBe("indeterminate");
    expect(
      diagnostics.mock.calls.some(
        (call) =>
          call[0]?.event === "hq.github.app.manifest" &&
          call[0]?.stage === "exchange" &&
          call[0]?.state === "indeterminate",
      ),
    ).toBe(true);
    await completeGitHubAppManifest(
      new Request(callback.url),
      fixture.operator,
    );
    expect(exchanges).toBe(1);
  });

  it("does not exchange wrong state, expired attempts or a return after operator revocation", async () => {
    const { callback } = await prepare();
    const exchanges = provider();
    const wrong = new URL(callback.url);
    wrong.searchParams.set(
      "state",
      wrong.searchParams.get("state") + "changed",
    );
    await completeGitHubAppManifest(new Request(wrong), fixture.operator);
    expect(exchanges()).toBe(0);
    await fixture.operator.githubAppSetupPermitRevoke({
      workspaceId: "administration",
      permitId: fixture.permit.id,
      revision: fixture.permit.revision,
    });
    await completeGitHubAppManifest(callback, fixture.operator);
    expect(exchanges()).toBe(0);
  });

  it("requires reauthentication and scrubs a callback even when the human session is lost", async () => {
    const { callback } = await prepare();
    const exchanges = provider();
    const response = await createApplication(async () => {
      throw new Error("Synthetic expired identity");
    }).fetch(callback, fixture.runtime);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).not.toContain(
      "synthetic-code-canary",
    );
    expect(exchanges()).toBe(0);
  });

  it("does not convert an expired attempt", async () => {
    const { callback, attempt } = await prepare();
    const exchanges = provider();
    fixture.clock.now += 10 * 60 * 1000 + 1;
    await completeGitHubAppManifest(callback, fixture.operator);
    expect(exchanges()).toBe(0);
    expect(
      (
        await fixture.operator.githubAppManifestGet({
          workspaceId: "administration",
          attemptId: attempt.id,
        })
      ).state,
    ).toBe("expired");
  });

  it("rechecks original authority after exchanging the code", async () => {
    const { callback, attempt } = await prepare();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/conversions")) {
        await fixture.operator.githubAppSetupPermitRevoke({
          workspaceId: "administration",
          permitId: fixture.permit.id,
          revision: 1,
        });
        return Response.json({
          ...upstream,
          pem: key.pkcs8,
          webhook_secret: "synthetic-lifecycle-secret",
        });
      }
      return Response.json(upstream);
    });
    await completeGitHubAppManifest(callback, fixture.operator);
    expect(
      await fixture.runtime.HQ_DB.prepare(
        "SELECT count(*) FROM github_app_registrations",
      ).first<number>("count(*)"),
    ).toBe(0);
    expect(
      await fixture.runtime.HQ_DB.prepare(
        "SELECT state FROM github_app_manifest_attempts WHERE id=?",
      )
        .bind(attempt.id)
        .first<string>("state"),
    ).toBe("indeterminate");
  });

  it("refuses arbitrary setup origins and account substitution", async () => {
    fixture.runtime.GITHUB_APP_ORIGIN = "https://hq.example/arbitrary/path";
    await expect(
      fixture.operator.githubAppManifestStart(startInput),
    ).rejects.toThrow();
    fixture.runtime.GITHUB_APP_ORIGIN = "https://hq.example";
    const { callback, attempt } = await prepare();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/conversions")
        ? Response.json({
            ...upstream,
            pem: key.pkcs8,
            webhook_secret: "synthetic-lifecycle-secret",
          })
        : Response.json({
            ...upstream,
            owner: { ...upstream.owner, login: "other" },
          }),
    );
    await completeGitHubAppManifest(callback, fixture.operator);
    expect(
      (
        await fixture.operator.githubAppManifestGet({
          workspaceId: "administration",
          attemptId: attempt.id,
        })
      ).state,
    ).toBe("indeterminate");
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "administration",
          scope: "administration",
        })
      ).registrations,
    ).toHaveLength(0);
  });
});
