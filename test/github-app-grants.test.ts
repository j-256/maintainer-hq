import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GitHubAppGrants } from "../worker/github-app-grants";
import { GitHubApps } from "../worker/github-app-registrations";
import { sealGitHubAppMaterial } from "../worker/github-app-crypto";
import { commands } from "../shared/commands";
import { githubAppTestKey } from "./helpers/github-app-keys";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  githubAppTestPrincipal,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
let fixture: GitHubAppFixture;
const installation = {
  id: 91,
  app_id: 42,
  account: { id: 50, login: "example", type: "Organization" },
  permissions: { metadata: "read", contents: "read" },
  repository_selection: "selected",
  suspended_at: null,
};
const repository = {
  id: 101,
  full_name: "example/project",
  private: true,
  owner: { id: 50 },
};
let provider: ReturnType<typeof vi.spyOn>;
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  const review = await fixture.plan();
  const key = await githubAppTestKey();
  const encrypted = await sealGitHubAppMaterial(
    {
      env: fixture.runtime,
      deploymentId: "synthetic-deployment",
      administrativeWorkspaceId: "administration",
      registrationId: "app-a",
      kind: "private-key",
      materialId: "signing-key",
      revision: 1,
    },
    new TextEncoder().encode(key.pkcs8),
  );
  await new GitHubApps(fixture.operator).accept(
    {
      workspaceId: "administration",
      planId: review.id,
      fingerprint: review.fingerprint,
    },
    {
      identity: {
        id: 42,
        name: "Upstream App",
        slug: "repository-operator",
        account: installation.account as {
          id: number;
          login: string;
          type: "Organization";
        },
        permissions: installation.permissions as {
          metadata: "read";
          contents: "read";
        },
      },
      fingerprint: key.fingerprint,
      privateKey: { materialId: "signing-key", encrypted },
    },
  );
  provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return Response.json({
          token: "synthetic-ephemeral-token",
          expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
          permissions: JSON.parse(String(init?.body)).permissions,
          repositories: [repository],
        });
      if (url.includes("/app/installations?"))
        return Response.json([installation]);
      if (url.endsWith("/app/installations/91"))
        return Response.json(installation);
      if (url.endsWith("/app"))
        return Response.json({
          id: 42,
          name: "Upstream App",
          slug: "repository-operator",
          owner: installation.account,
          permissions: installation.permissions,
        });
      return Response.json({}, { status: 404 });
    });
});
afterEach(() => vi.restoreAllMocks());
const grants = () => new GitHubAppGrants(fixture.operator);
const offer = (
  targetWorkspaceId = "alpha",
  grantId = "grant-a",
  revision = 0,
) =>
  grants().plan({
    workspaceId: "administration",
    targetWorkspaceId,
    registrationId: "app-a",
    installationId: 91,
    grantId,
    revision,
    repositoryIds: [101],
    capabilities: ["collection"],
  });
const selection = (
  review: { id: string; fingerprint: string },
  workspaceId = "alpha",
) => ({ workspaceId, planId: review.id, fingerprint: review.fingerprint });
describe("GitHub App workspace grants", () => {
  it("requires both approvals but allows one actor to satisfy both", async () => {
    const review = await offer();
    expect(review).toMatchObject({
      state: "offered",
      targetWorkspaceId: "alpha",
      repositories: [{ id: 101, fullName: "example/project", ownerId: 50 }],
    });
    expect((await grants().list({ workspaceId: "alpha" })).grants).toEqual([]);
    await expect(
      new GitHubAppGrants(fixture.as(githubAppTestPrincipal("other"))).accept(
        selection(review),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const accepted = await grants().accept(selection(review));
    expect(accepted).toMatchObject({
      state: "active",
      grant: { id: "grant-a", revision: 1, credentialRef: "grant-a" },
    });
    expect(await grants().accept(selection(review))).toEqual(accepted);
    expect((await grants().list({ workspaceId: "alpha" })).grants).toHaveLength(
      1,
    );
    expect(JSON.stringify(accepted)).not.toContain("synthetic-ephemeral-token");
    expect(JSON.stringify(accepted)).not.toContain("permitFingerprint");
    expect(
      await fixture.runtime.HQ_DB.prepare(
        "SELECT 1 FROM source_repositories",
      ).first(),
    ).toBeNull();
  });
  it("separates setup authority lifetime from an active grant", async () => {
    await grants().accept(selection(await offer()));
    const pending = await offer("beta", "grant-b");
    fixture.clock.now += 3600001;
    expect(
      (await grants().list({ workspaceId: "alpha" })).grants[0].state,
    ).toBe("active");
    await expect(
      new GitHubAppGrants(fixture.as(githubAppTestPrincipal("other"))).accept(
        selection(pending, "beta"),
      ),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });
  it("rejects a revoked issuer permit without disabling activated grants", async () => {
    await grants().accept(selection(await offer()));
    const pending = await offer("beta", "grant-b");
    await fixture.operator.githubAppSetupPermitRevoke({
      workspaceId: "administration",
      permitId: fixture.permit.id,
      revision: fixture.permit.revision,
    });
    await expect(
      new GitHubAppGrants(fixture.as(githubAppTestPrincipal("other"))).accept(
        selection(pending, "beta"),
      ),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(
      (await grants().list({ workspaceId: "alpha" })).grants[0].state,
    ).toBe("active");
  });
  it("limits discovery to verified deployment operators and marks partial pages", async () => {
    await expect(
      grants().installations({ workspaceId: "alpha", registrationId: "app-a" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(provider).not.toHaveBeenCalled();
    expect(
      await grants().installations({
        workspaceId: "administration",
        registrationId: "app-a",
      }),
    ).toMatchObject({ items: [{ id: 91 }], nextCursor: null, limited: false });
    provider.mockResolvedValueOnce(
      Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          ...installation,
          id: index + 1,
        })),
      ),
    );
    expect(
      await grants().installations({
        workspaceId: "administration",
        registrationId: "app-a",
        cursor: "10000",
      }),
    ).toMatchObject({ nextCursor: null, limited: true });
  });
  it("records owner requests without granting authority or exposing global installations", async () => {
    const request = await grants().request({
      workspaceId: "alpha",
      requestId: "request-a",
      requestedCapabilities: ["collection"],
    });
    expect(request).toMatchObject({ id: "request-a", state: "requested" });
    expect(provider).not.toHaveBeenCalled();
    await expect(
      new GitHubAppGrants(fixture.as(githubAppTestPrincipal("viewer"))).request(
        {
          workspaceId: "administration",
          requestId: "request-b",
          requestedCapabilities: ["collection"],
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await grants().requests({
          workspaceId: "administration",
          scope: "administration",
        })
      ).requests,
    ).toHaveLength(1);
    expect(
      (
        await new GitHubAppGrants(
          fixture.as(githubAppTestPrincipal("other")),
        ).requests({ workspaceId: "beta", scope: "workspace" })
      ).requests,
    ).toEqual([]);
    expect((await grants().list({ workspaceId: "alpha" })).grants).toEqual([]);
  });
  it("refuses guessed installations, wrong Apps, suspended installations and capability widening", async () => {
    await expect(
      grants().plan({
        workspaceId: "administration",
        targetWorkspaceId: "alpha",
        registrationId: "app-a",
        installationId: 999,
        grantId: "grant-a",
        revision: 0,
        repositoryIds: [101],
        capabilities: ["collection"],
      }),
    ).rejects.toMatchObject({ code: "github_app_denied" });
    await expect(
      grants().plan({
        workspaceId: "administration",
        targetWorkspaceId: "alpha",
        registrationId: "app-a",
        installationId: 91,
        grantId: "grant-a",
        revision: 0,
        repositoryIds: [101],
        capabilities: ["configuration-write"],
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    provider.mockResolvedValueOnce(
      Response.json({ ...installation, app_id: 77 }),
    );
    await expect(offer()).rejects.toMatchObject({
      code: "github_app_response_invalid",
    });
    provider.mockResolvedValueOnce(
      Response.json({
        ...installation,
        suspended_at: new Date().toISOString(),
      }),
    );
    await expect(offer()).rejects.toMatchObject({
      code: "github_app_conflict",
    });
  });
  it("fences lost issuer membership, revocation and registration changes during acceptance", async () => {
    const pending = await offer();
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='administration' AND subject='owner'",
    ).run();
    await expect(grants().accept(selection(pending))).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    const next = await offer();
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input: unknown, init?: unknown) => {
      const response = await original(input, init);
      if (String(input).includes("/access_tokens"))
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE github_app_registrations SET revision=revision+1 WHERE id='app-a'",
        ).run();
      return response;
    });
    await expect(grants().accept(selection(next))).rejects.toMatchObject({
      code: "github_app_conflict",
    });
  });
  it("checks provider repository identity again and retains the old grant while an update is offered", async () => {
    await grants().accept(selection(await offer()));
    const update = await offer("alpha", "grant-a", 1);
    expect(
      (await grants().list({ workspaceId: "alpha" })).grants[0].revision,
    ).toBe(1);
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input: unknown, init?: unknown) =>
      String(input).includes("/access_tokens")
        ? Response.json({
            token: "synthetic-ephemeral-token",
            expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
            permissions: { metadata: "read" },
            repositories: [
              {
                ...repository,
                full_name: "transferred/project",
                owner: { id: 88 },
              },
            ],
          })
        : original(input, init),
    );
    await expect(grants().accept(selection(update))).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    expect(
      (await grants().list({ workspaceId: "alpha" })).grants[0].revision,
    ).toBe(1);
  });
  it("keeps grant revocation independent, reviewed and local", async () => {
    await grants().accept(selection(await offer()));
    const beta = new GitHubAppGrants(
      fixture.as(githubAppTestPrincipal("other")),
    );
    await beta.accept(selection(await offer("beta", "grant-b"), "beta"));
    const review = await grants().revokePlan({
      workspaceId: "alpha",
      grantId: "grant-a",
      revision: 1,
    });
    const calls = provider.mock.calls.length;
    await grants().accept(selection(review));
    expect(provider.mock.calls).toHaveLength(calls);
    expect(
      (await grants().list({ workspaceId: "alpha" })).grants[0].state,
    ).toBe("revoked");
    expect((await beta.list({ workspaceId: "beta" })).grants[0].state).toBe(
      "active",
    );
    expect(await grants().accept(selection(review))).toMatchObject({
      state: "revoked",
    });
  });
  it("fences recipient membership and grant expiry across provider verification", async () => {
    const pending = await grants().plan({
      workspaceId: "administration",
      targetWorkspaceId: "alpha",
      registrationId: "app-a",
      installationId: 91,
      grantId: "grant-a",
      revision: 0,
      repositoryIds: [101],
      capabilities: ["collection"],
      expiresAt: new Date(fixture.clock.now + 1000).toISOString(),
    });
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input: unknown, init?: unknown) => {
      const response = await original(input, init);
      if (String(input).includes("/access_tokens")) fixture.clock.now += 1001;
      return response;
    });
    await expect(grants().accept(selection(pending))).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    provider.mockImplementation(original);
    const next = await offer();
    provider.mockImplementation(async (input: unknown, init?: unknown) => {
      const response = await original(input, init);
      if (String(input).includes("/access_tokens"))
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        ).run();
      return response;
    });
    await expect(grants().accept(selection(next))).rejects.toMatchObject({
      code: "github_app_conflict",
    });
  });
  it("allows an operator to revoke a disconnected App's grant without affecting another workspace", async () => {
    const beta = new GitHubAppGrants(
      fixture.as(githubAppTestPrincipal("other")),
    );
    await beta.accept(selection(await offer("beta", "grant-b"), "beta"));
    const disconnect = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: { kind: "disconnect" },
    });
    await fixture.operator.githubAppRegistrationApply({
      workspaceId: "administration",
      planId: disconnect.id,
      fingerprint: disconnect.fingerprint,
    });
    const revoke = await grants().revokePlan({
      workspaceId: "administration",
      targetWorkspaceId: "beta",
      grantId: "grant-b",
      revision: 1,
    });
    const calls = provider.mock.calls.length;
    expect(
      await grants().accept(selection(revoke, "administration")),
    ).toMatchObject({ state: "revoked" });
    expect(provider.mock.calls).toHaveLength(calls);
    expect((await beta.list({ workspaceId: "beta" })).grants[0].state).toBe(
      "revoked",
    );
  });
  it("rejects credential-reference collisions and includes shared grant impact in registration reviews", async () => {
    await expect(offer("alpha", "legacy")).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    const staleDisconnect = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: { kind: "disconnect" },
    });
    await grants().accept(selection(await offer()));
    await expect(
      fixture.operator.githubAppRegistrationApply({
        workspaceId: "administration",
        planId: staleDisconnect.id,
        fingerprint: staleDisconnect.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    const disconnect = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: { kind: "disconnect" },
    });
    expect(disconnect.impact.affectedWorkspaceIds).toEqual([
      "administration",
      "alpha",
    ]);
    expect(commands.github_app_grant_accept.method).toBe(
      "githubAppGrantAccept",
    );
  });
});
