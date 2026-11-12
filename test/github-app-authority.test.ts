import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  verifyGitHubAppAuthority,
  invalidateGitHubAppAuthority,
} from "../worker/github-app-authority";
import {
  resolveGitHubCredential,
  assertGitHubAuthorityFence,
} from "../worker/github-credential-resolver";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
  appInstallationFixture,
} from "./helpers/github-app-active-fixture";
let fixture: GitHubAppFixture;
let request: Awaited<ReturnType<typeof activateGitHubAppFixture>>;
let provider: ReturnType<typeof vi.spyOn>;
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(appProviderFixture(fixture));
  request = await activateGitHubAppFixture(fixture);
  provider.mockClear();
});
afterEach(() => vi.restoreAllMocks());
const scope = () => ({
  registrationId: "app-a",
  installationId: 91,
  repositoryId: 101,
  grantId: "grant-a",
  grantRevision: 1,
  workspaceId: "alpha",
});
describe("GitHub App authority observations", () => {
  it("requires refresh after sixty seconds and rejects removed generations", async () => {
    const first = await resolveGitHubCredential(fixture.operator, request);
    const calls = provider.mock.calls.length;
    await resolveGitHubCredential(fixture.operator, request);
    expect(provider.mock.calls.length).toBe(calls);
    fixture.clock.now += 60001;
    await resolveGitHubCredential(fixture.operator, request);
    expect(provider.mock.calls.length).toBeGreaterThan(calls);
    await invalidateGitHubAppAuthority(fixture.operator, "app-a", 91);
    await expect(
      assertGitHubAuthorityFence(fixture.operator, first.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });
  it("refreshes authority after a registration revision changes", async () => {
    await resolveGitHubCredential(fixture.operator, request);
    const review = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: {
        kind: "save",
        fields: {
          name: "Renamed App",
          appId: 42,
          visibility: "public",
          capabilities: ["collection"],
        },
        replaceKey: false,
      },
    });
    await fixture.operator.githubAppRegistrationApply({
      workspaceId: "administration",
      planId: review.id,
      fingerprint: review.fingerprint,
    });
    provider.mockClear();
    await resolveGitHubCredential(fixture.operator, request);
    expect(
      provider.mock.calls.some(([input]: [unknown]) =>
        String(input).endsWith("/app/installations/91"),
      ),
    ).toBe(true);
  });
  it("does not let a delayed successful check erase a newer invalidation", async () => {
    await verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect");
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input: unknown, init?: unknown) => {
      const response = await original(input, init);
      if (String(input).includes("/access_tokens"))
        await invalidateGitHubAppAuthority(fixture.operator, "app-a", 91);
      return response;
    });
    await expect(
      verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect"),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(
      await fixture.runtime.HQ_DB.prepare(
        "SELECT state FROM github_app_authority",
      ).first(),
    ).toEqual({ state: "unknown" });
  });
  it("retains denial across a failed refresh and shares cooldown across grants", async () => {
    await activateGitHubAppFixture(fixture, "beta", "grant-b");
    provider.mockResolvedValueOnce(
      Response.json({
        ...appInstallationFixture,
        suspended_at: new Date(fixture.clock.now).toISOString(),
      }),
    );
    await expect(
      verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect"),
    ).rejects.toMatchObject({ code: "github_app_denied" });
    provider.mockResolvedValueOnce(
      Response.json({}, { status: 429, headers: { "retry-after": "120" } }),
    );
    await expect(
      verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect"),
    ).rejects.toMatchObject({ code: "github_app_rate_limited" });
    expect(
      await fixture.runtime.HQ_DB.prepare(
        "SELECT state FROM github_app_authority",
      ).first(),
    ).toEqual({ state: "denied" });
    const calls = provider.mock.calls.length;
    await expect(
      verifyGitHubAppAuthority(
        fixture.operator,
        { ...scope(), workspaceId: "beta", grantId: "grant-b" },
        "fresh_effect",
      ),
    ).rejects.toMatchObject({ code: "github_app_rate_limited" });
    expect(provider.mock.calls.length).toBe(calls);
  });
  it("records bounded authority failure diagnostics without provider payloads or credentials", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.mockResolvedValueOnce(
      Response.json({ private_provider_payload: "omit" }, { status: 404 }),
    );
    await expect(
      verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect"),
    ).rejects.toMatchObject({ code: "github_app_denied" });
    expect(
      warning.mock.calls.some(
        ([entry]) =>
          entry?.event === "hq.github.app.authority" &&
          entry.state === "denied" &&
          entry.requests === 1 &&
          typeof entry.correlationId === "string",
      ),
    ).toBe(true);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "private_provider_payload",
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "synthetic-installation-token",
    );
  });
  it("logs rejected token scope as denied with fixed provider metadata and invalidates old authority", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveGitHubCredential(fixture.operator, request);
    const normal = appProviderFixture(fixture);
    provider.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith("/access_tokens")
        ? new Response("private-provider-body-canary", { status: 422 })
        : normal(input, init),
    );
    await expect(verifyGitHubAppAuthority(fixture.operator, scope(), "fresh_effect"))
      .rejects.toMatchObject({ code: "github_app_denied" });
    expect(warning.mock.calls.some(([entry]) => entry?.event === "hq.github.app.authority" &&
      entry.state === "denied" && entry.providerStage === "installation_token" && entry.providerStatus === 422)).toBe(true);
    expect(await fixture.operator.db.prepare("SELECT state FROM github_app_authority WHERE repository_id=101").first("state")).toBe("denied");
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-provider-body-canary|synthetic-installation-token/);
  });
  it("fresh effects bypass a read snapshot and invalidate changed repository access", async () => {
    const first = await resolveGitHubCredential(fixture.operator, request);
    const calls = provider.mock.calls.length;
    provider.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    await expect(
      resolveGitHubCredential(fixture.operator, {
        ...request,
        phase: "effect",
      }),
    ).rejects.toMatchObject({ code: "github_app_denied" });
    expect(provider.mock.calls.length).toBeGreaterThan(calls);
    await expect(
      assertGitHubAuthorityFence(fixture.operator, first.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });
});
