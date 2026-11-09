import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CAPABILITY } from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import { githubCredentialReferences } from "../worker/github-credentials";
import { requireGitHubAppOperator } from "../worker/github-app-setup-authority";
import { GitHubApps } from "../worker/github-app-registrations";
import { sealGitHubAppMaterial } from "../worker/github-app-crypto";
import { githubAppTestKey } from "./helpers/github-app-keys";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  githubAppTestPrincipal,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";

let fixture: GitHubAppFixture;
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
});
afterEach(() => vi.restoreAllMocks());

describe("deployment GitHub App registry", () => {
  it("atomically accepts trusted private material and preserves idempotent metadata-only operations", async () => {
    const review = await fixture.plan();
    const key = await githubAppTestKey();
    const selection = {
      workspaceId: "administration",
      planId: review.id,
      fingerprint: review.fingerprint,
    };
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
    const accepted = await new GitHubApps(fixture.operator).accept(selection, {
      identity: {
        id: 42,
        name: "Upstream App",
        slug: "repository-operator",
        account: { id: 50, login: "example", type: "Organization" },
        permissions: { metadata: "read", contents: "read" },
      },
      fingerprint: key.fingerprint,
      privateKey: { materialId: "signing-key", encrypted },
    });
    expect(accepted).toMatchObject({
      applied: true,
      registration: {
        revision: 1,
        state: "active",
        keyFingerprint: key.fingerprint,
        lifecycleIngress: "requires_webhook_secret",
      },
    });
    expect(
      await fixture.operator.githubAppRegistrationApply(selection),
    ).toEqual(accepted);
    const rows = await fixture.runtime.HQ_DB.prepare(
      "SELECT key_id,nonce,ciphertext FROM github_app_material WHERE registration_id='app-a'",
    ).all<{ key_id: string; nonce: string; ciphertext: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({
      key_id: encrypted.keyId,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    });
    const rename = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: {
        kind: "save",
        fields: {
          name: "Renamed local connection",
          appId: 42,
          visibility: "public",
          capabilities: ["collection"],
        },
        replaceKey: false,
      },
    });
    expect(
      (
        await fixture.operator.githubAppRegistrationApply({
          workspaceId: "administration",
          planId: rename.id,
          fingerprint: rename.fingerprint,
        })
      ).registration,
    ).toMatchObject({
      revision: 2,
      name: "Renamed local connection",
      keyFingerprint: key.fingerprint,
    });
    const disconnect = await fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 2,
      change: { kind: "disconnect" },
    });
    expect(
      (
        await fixture.operator.githubAppRegistrationApply({
          workspaceId: "administration",
          planId: disconnect.id,
          fingerprint: disconnect.fingerprint,
        })
      ).registration,
    ).toMatchObject({
      revision: 3,
      state: "disconnected",
      lifecycleIngress: "disabled",
    });
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "alpha",
          scope: "workspace",
        })
      ).registrations,
    ).toHaveLength(0);
  });
  it("does not turn workspace ownership into deployment administration", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(
      fixture.operator.githubAppList({
        workspaceId: "alpha",
        scope: "administration",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      fixture
        .as(githubAppTestPrincipal("other"))
        .githubAppList({ workspaceId: "beta", scope: "administration" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await fixture.operator.githubAppList({
        workspaceId: "alpha",
        scope: "workspace",
      }),
    ).toEqual({ registrations: [], limited: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a matching live verified operator and owner membership", async () => {
    for (const principal of [
      { ...githubAppTestPrincipal(), access: undefined },
      {
        ...githubAppTestPrincipal(),
        access: {
          issuer: "https://wrong.example",
          audience: fixture.permit.audience,
        },
      },
      {
        ...githubAppTestPrincipal(),
        access: { issuer: fixture.permit.issuer, audience: "wrong" },
      },
      {
        ...githubAppTestPrincipal(),
        tokenId: "automation",
        scopes: [CAPABILITY.READ, CAPABILITY.ADMIN],
      },
      { ...githubAppTestPrincipal(), sourceId: "source" },
      { ...githubAppTestPrincipal(), reporterId: "reporter" },
      githubAppTestPrincipal("operator"),
      githubAppTestPrincipal("viewer"),
    ])
      await expect(
        requireGitHubAppOperator(fixture.as(principal), "administration"),
      ).rejects.toMatchObject({ code: "forbidden" });
    const authority = await requireGitHubAppOperator(
      fixture.operator,
      "administration",
    );
    expect(authority).toMatchObject({
      workspaceId: "administration",
      subject: "owner",
      memberRevision: 1,
      permitId: "setup-permit",
      permitRevision: 1,
    });
  });

  it("fails closed on expired, missing, ambiguous or malformed deployment permits", async () => {
    for (const value of [
      undefined,
      "invalid",
      "x".repeat(32769),
      JSON.stringify([fixture.permit, fixture.permit]),
      JSON.stringify([{ ...fixture.permit, subject: "other" }]),
      JSON.stringify([
        {
          ...fixture.permit,
          expiresAt: new Date(fixture.clock.now - 1).toISOString(),
        },
      ]),
    ]) {
      fixture.runtime.GITHUB_APP_SETUP_PERMITS = value;
      await expect(
        requireGitHubAppOperator(fixture.operator, "administration"),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("binds safe reviews to the exact actor, input, membership and permit", async () => {
    const review = await fixture.plan();
    const selection = {
      workspaceId: "administration",
      planId: review.id,
      fingerprint: review.fingerprint,
    };
    expect(review).toMatchObject({
      registrationId: "app-a",
      revision: 0,
      privateInputRequired: true,
      applied: false,
    });
    expect(await fixture.operator.githubAppRegistrationGet(selection)).toEqual(
      review,
    );
    expect(JSON.stringify(review)).not.toContain("ciphertext");
    expect(JSON.stringify(review)).not.toContain("privateKey");
    await expect(
      fixture.operator.githubAppRegistrationApply(selection),
    ).rejects.toMatchObject({ code: "github_app_private_input_required" });
    fixture.runtime.GITHUB_APP_SETUP_PERMITS = JSON.stringify([
      { ...fixture.permit, revision: 2 },
    ]);
    await expect(
      fixture.operator.githubAppRegistrationApply(selection),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(
      await fixture.operator.githubAppList({
        workspaceId: "administration",
        scope: "administration",
      }),
    ).toEqual({ registrations: [], limited: false });
  });

  it("does not apply a review after owner membership changes", async () => {
    const review = await fixture.plan();
    await fixture.runtime.HQ_DB.prepare(
      "UPDATE members SET revision=2 WHERE workspace_id='administration' AND subject='owner'",
    ).run();
    await expect(
      fixture.operator.githubAppRegistrationApply({
        workspaceId: "administration",
        planId: review.id,
        fingerprint: review.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "administration",
          scope: "administration",
        })
      ).registrations,
    ).toHaveLength(0);
  });

  it("persists permit revocation so an older deployment binding cannot revive it", async () => {
    const review = await fixture.plan();
    expect(
      await fixture.operator.githubAppSetupPermitRevoke({
        workspaceId: "administration",
        permitId: fixture.permit.id,
        revision: 1,
      }),
    ).toMatchObject({ revoked: true });
    const event = await fixture.runtime.HQ_DB.prepare(
      "SELECT actor_subject,resource_id FROM activity WHERE type='github.app.setup.revoked'",
    ).first<{ actor_subject: string; resource_id: string }>();
    expect(event).toEqual({
      actor_subject: "owner",
      resource_id: "setup-permit",
    });
    await expect(
      requireGitHubAppOperator(fixture.operator, "administration"),
    ).rejects.toMatchObject({ code: "forbidden" });
    fixture.runtime.GITHUB_APP_SETUP_PERMITS = JSON.stringify([fixture.permit]);
    await expect(
      fixture.operator.githubAppRegistrationApply({
        workspaceId: "administration",
        planId: review.id,
        fingerprint: review.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
  });

  it("rejects expired and substituted reviews without accepting registration state", async () => {
    const review = await fixture.plan();
    await expect(
      fixture.operator.githubAppRegistrationGet({
        workspaceId: "administration",
        planId: review.id,
        fingerprint: "sha256:" + "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    fixture.clock.now += 10 * 60 * 1000 + 1;
    await expect(
      fixture.operator.githubAppRegistrationApply({
        workspaceId: "administration",
        planId: review.id,
        fingerprint: review.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(await githubCredentialReferences(fixture.runtime, "alpha")).toEqual([
      { id: "legacy", name: "Existing token" },
    ]);
  });

  it("does not accept a matching permit without live administrative ownership", async () => {
    fixture.runtime.GITHUB_APP_SETUP_PERMITS = JSON.stringify([
      { ...fixture.permit, subject: "operator" },
    ]);
    await expect(
      requireGitHubAppOperator(
        fixture.as(githubAppTestPrincipal("operator")),
        "administration",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    fixture.runtime.GITHUB_APP_SETUP_PERMITS = JSON.stringify([fixture.permit]);
    await fixture.runtime.HQ_DB.prepare(
      "DELETE FROM members WHERE workspace_id='administration' AND subject='owner'",
    ).run();
    await expect(
      requireGitHubAppOperator(fixture.operator, "administration"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("bounds outstanding reviews without enrolling any registration", async () => {
    for (let i = 0; i < 20; i++) await fixture.plan();
    await expect(fixture.plan()).rejects.toMatchObject({
      code: "github_app_conflict",
    });
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "administration",
          scope: "administration",
        })
      ).registrations,
    ).toHaveLength(0);
  });

  it("registers bounded metadata commands consistently for CLI and MCP", () => {
    for (const name of [
      "github_apps_list",
      "github_app_registration_plan",
      "github_app_registration_get",
      "github_app_registration_apply",
      "github_app_setup_permit_revoke",
    ] as const) {
      expect(
        commands[name].schema.safeParse({
          workspaceId: "administration",
          privateKey: "private-canary",
        }).success,
      ).toBe(false);
    }
    expect(
      commandAnnotations("github_app_registration_apply", false),
    ).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
