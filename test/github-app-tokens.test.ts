import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  readGitHubAuthReference,
  resolveGitHubCredential,
  assertGitHubAuthorityFence,
  evictGitHubAppToken,
} from "../worker/github-credential-resolver";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
} from "./helpers/github-app-active-fixture";
let fixture: GitHubAppFixture;
let request: Awaited<ReturnType<typeof activateGitHubAppFixture>>;
let provider: MockInstance<typeof fetch>;
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
const resolve = () => resolveGitHubCredential(fixture.operator, request);
describe("scoped App token resolution", () => {
  it("coalesces identical mints, narrows scope and persists no tokens", async () => {
    const results = await Promise.all([resolve(), resolve(), resolve()]);
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    const mints = provider.mock.calls.filter(([url]) =>
      String(url).includes("/access_tokens"),
    );
    expect(
      mints.filter(
        ([, init]) =>
          JSON.parse(String(init?.body)).permissions.contents === "read",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(String(mints.at(-1)?.[1]?.body))).toEqual({
      repository_ids: [101],
      permissions: { metadata: "read", contents: "read" },
    });
    const stored = await fixture.runtime.HQ_DB.prepare(
      "SELECT * FROM github_app_authority",
    ).all();
    expect(JSON.stringify(stored)).not.toContain(
      "synthetic-installation-token",
    );
    expect(
      await readGitHubAuthReference(fixture.operator, "alpha", "grant-a"),
    ).toEqual({ kind: "app", grantId: "grant-a" });
    expect(
      await readGitHubAuthReference(fixture.operator, "alpha", "legacy"),
    ).toEqual({ kind: "token", reference: "legacy" });
  });
  it("renews tokens without changing authority identity or provider quota", async () => {
    const first = await resolve();
    const betaRequest = await activateGitHubAppFixture(
      fixture,
      "beta",
      "grant-b",
    );
    const beta = await resolveGitHubCredential(
      {
        env: fixture.runtime,
        db: fixture.runtime.HQ_DB,
        now: () => fixture.clock.now,
      },
      betaRequest,
    );
    fixture.clock.now += 3550000;
    const second = await resolve();
    expect(second.token).not.toBe(first.token);
    expect(second.authorityIdentity).toBe(first.authorityIdentity);
    expect(second.quotaKey).toBe(beta.quotaKey);
    expect(second.fence).toEqual(first.fence);
  });
  it("shares provider identity across live readers while fencing each membership independently", async () => {
    const first = await resolve();
    await fixture.runtime.HQ_DB.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','reader','Reader','viewer')",
    ).run();
    const reader = fixture.as({ subject: "reader", displayName: "Reader" });
    const second = await resolveGitHubCredential(reader, {
      ...request,
      binding: {
        kind: "actor",
        subject: "reader",
        tokenId: null,
        membershipRevision: 1,
      },
    });
    expect(second.authorityIdentity).toBe(first.authorityIdentity);
    expect(second.token).toBe(first.token);
    expect(second.fence.binding).not.toEqual(first.fence.binding);
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(
      assertGitHubAuthorityFence(fixture.operator, first.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(
      assertGitHubAuthorityFence(reader, second.fence),
    ).resolves.toBeUndefined();
  });
  it("allows one explicit remint without changing authority or replaying a provider operation", async () => {
    const first = await resolve();
    evictGitHubAppToken(fixture.operator, first);
    const second = await resolve();
    expect(second.token).not.toBe(first.token);
    expect(second.authorityIdentity).toBe(first.authorityIdentity);
    expect(second.fence).toEqual(first.fence);
  });
  it("requires the durable scheduled job and its exact enrolled item", async () => {
    const scheduled = {
      ...request,
      binding: {
        kind: "source" as const,
        sourceId: "github",
        sourceRevision: 1,
        jobId: "scheduled-job",
      },
    };
    await expect(
      resolveGitHubCredential(fixture.operator, scheduled),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(provider).not.toHaveBeenCalled();
    const now = new Date(fixture.clock.now).toISOString();
    await fixture.runtime.HQ_DB.batch([
      fixture.runtime.HQ_DB.prepare(
        "INSERT INTO github_refreshes(workspace_id,id,source_id,source_revision,credential_ref,credential_hash,actor_subject,actor_name,credential_kind,trigger,input_hash,status,summary,created_at,write_id) VALUES ('alpha','scheduled-job','github',1,'grant-a','synthetic-authority','system:github-collector','Collector','app','scheduled','synthetic','queued','Queued',?,'synthetic')",
      ).bind(now),
      fixture.runtime.HQ_DB.prepare(
        "INSERT INTO github_refresh_items(workspace_id,refresh_id,repository_id,full_name,status,summary,updated_at) VALUES ('alpha','scheduled-job',?,'example/project','queued','Queued',?)",
      ).bind(request.repositoryId, now),
    ]);
    const lease = await resolveGitHubCredential(fixture.operator, scheduled);
    expect(lease.fence.binding).toEqual(scheduled.binding);
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE github_refreshes SET status='cancelled' WHERE workspace_id='alpha' AND id='scheduled-job'",
    ).run();
    await expect(
      assertGitHubAuthorityFence(fixture.operator, lease.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });
  it("accepts implicit metadata read authority when GitHub omits that permission label", async () => {
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/app/installations/91")) {
        const value = (await response.json()) as {
          permissions: Record<string, string>;
        };
        delete value.permissions.metadata;
        return Response.json(value);
      }
      return response;
    });
    expect((await resolve()).fence.kind).toBe("app");
  });
  it("clips a lease to the actor's verified sign-in expiry", async () => {
    const expiresAt = fixture.clock.now + 1000;
    const service = fixture.as({ ...fixture.operator.principal, expiresAt });
    const lease = await resolveGitHubCredential(service, request);
    expect(lease.validUntil).toBeLessThanOrEqual(expiresAt);
  });
  it("retains legacy token hashes and quotas without contacting App endpoints", async () => {
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE connections SET credential_ref='legacy',revision=2 WHERE workspace_id='alpha' AND id='github'",
    ).run();
    const lease = await resolveGitHubCredential(fixture.operator, {
      ...request,
      reference: { kind: "token", reference: "legacy" },
      connectionRevision: 2,
    });
    expect(lease.token).toBe("synthetic-legacy-token");
    expect(lease.quotaKey).toBe(lease.authorityIdentity);
    expect(lease.observedAuthorityGeneration).toBeNull();
    expect(provider).not.toHaveBeenCalled();
  });
  it("preserves existing collection token reference names that resemble another credential namespace", async () => {
    fixture.runtime.GITHUB_CREDENTIALS = JSON.stringify({
      "managed-personal": {
        workspaceId: "alpha",
        name: "Manual source",
        token: "synthetic-manual-source-token",
      },
    });
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE connections SET credential_ref='managed-personal',revision=2 WHERE workspace_id='alpha' AND id='github'",
    ).run();
    const result = await resolveGitHubCredential(fixture.operator, {
      ...request,
      reference: { kind: "token", reference: "managed-personal" },
      connectionRevision: 2,
    });
    expect(result.fence.kind).toBe("token");
    expect(result.token).toBe("synthetic-manual-source-token");
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(["before", "during"] as const)(
    "reports exhausted execution budget %s protected key loading without provider I/O",
    async (timing) => {
      let reads = 0;
      const remainingBudgetMs = () =>
        timing === "before" || ++reads > 1 ? 0 : 8000;
      await expect(
        resolveGitHubCredential(
          {
            env: fixture.runtime,
            db: fixture.runtime.HQ_DB,
            now: () => fixture.clock.now,
            principal: fixture.operator.principal,
            remainingBudgetMs,
          },
          request,
        ),
      ).rejects.toMatchObject({ code: "github_app_budget_exhausted" });
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it("invalidates old leases and refuses fallback when replacement key material is missing", async () => {
    const first = await resolve();
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE github_app_registrations SET revision=revision+1,key_revision=key_revision+1 WHERE id='app-a'",
    ).run();
    provider.mockClear();
    await expect(
      assertGitHubAuthorityFence(fixture.operator, first.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(resolve()).rejects.toMatchObject({
      code: "github_app_material_unavailable",
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it("fences grant revocation, connection revisions, and token-kind substitution", async () => {
    const lease = await resolve();
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE github_app_grants SET state='revoked',revision=revision+1 WHERE id='grant-a'",
    ).run();
    await expect(
      assertGitHubAuthorityFence(fixture.operator, lease.fence),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(
      resolveGitHubCredential(fixture.operator, {
        ...request,
        reference: { kind: "token", reference: "grant-a" },
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(resolve()).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    expect(
      await readGitHubAuthReference(fixture.operator, "alpha", "grant-a"),
    ).toEqual({ kind: "app", grantId: "grant-a" });
  });
  it("does not share scope entries across grants, capabilities or permissions", async () => {
    const first = await resolve();
    const narrower = await resolveGitHubCredential(fixture.operator, {
      ...request,
      permissions: { metadata: "read" },
    });
    expect(narrower.token).not.toBe(first.token);
    await expect(
      resolveGitHubCredential(fixture.operator, {
        ...request,
        capability: "repository-maintenance",
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(
      resolveGitHubCredential(fixture.operator, {
        ...request,
        permissions: { contents: "write" },
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    await expect(
      resolveGitHubCredential(fixture.operator, {
        ...request,
        workspaceId: "beta",
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });
  it("rejects early expiry and rechecks local authority after a delayed mint", async () => {
    const original = provider.getMockImplementation()!;
    provider.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (
        String(input).includes("/access_tokens") &&
        JSON.parse(String((init as RequestInit)?.body)).permissions.contents
      )
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha' AND id='github'",
        ).run();
      return response;
    });
    await expect(resolve()).rejects.toMatchObject({
      code: "github_app_conflict",
    });
  });
});
