import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
} from "./helpers/github-app-active-fixture";
import {
  assertGitHubAuthorityFence,
  resolveGitHubCredential,
} from "../worker/github-credential-resolver";
import { DependencyGitHub } from "../worker/dependency-github";
import { collectGitHub } from "../worker/github-client";
import { countD1Statements } from "./helpers/d1-count";
beforeAll(migrateGitHubAppFixture);
afterEach(() => vi.restoreAllMocks());
it("migrates explicitly, fences old work and preserves advanced token recovery and other workspace grants", async () => {
  const fixture = await createGitHubAppFixture();
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(appProviderFixture(fixture));
  const request = await activateGitHubAppFixture(fixture);
  await activateGitHubAppFixture(fixture, "beta", "grant-b");
  const scope = { workspaceId: "alpha", sourceId: "github" };
  const fields = (credentialRef: string) => ({
    name: "GitHub",
    enabled: true,
    freshnessMinutes: 30,
    repositoryIds: [request.repositoryId],
    credentialRef,
    refreshIntervalMinutes: 15,
  });
  let source = await fixture.operator.githubSourceUpdate({
    ...scope,
    revision: 1,
    source: fields("legacy"),
  });
  const oldToken = await resolveGitHubCredential(fixture.operator, {
    ...request,
    reference: { kind: "token", reference: "legacy" },
    connectionRevision: source.revision,
  });
  await fixture.operator.githubRefresh({
    ...scope,
    revision: source.revision,
    refreshId: "before-migration",
  });
  source = await fixture.operator.githubSourceUpdate({
    ...scope,
    revision: source.revision,
    source: fields("grant-a"),
  });
  const current = { ...request, connectionRevision: source.revision };
  await expect(
    assertGitHubAuthorityFence(fixture.operator, oldToken.fence),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
  expect(
    (
      await fixture.operator.githubRefreshGet({
        ...scope,
        refreshId: "before-migration",
      })
    ).status,
  ).toBe("cancelled");
  const first = await resolveGitHubCredential(fixture.operator, current);
  fixture.clock.now += 3550000;
  const renewed = await resolveGitHubCredential(fixture.operator, current);
  expect(renewed.token).not.toBe(first.token);
  expect(renewed.authorityIdentity).toBe(first.authorityIdentity);
  const revoke = await fixture.operator.githubAppGrantRevokePlan({
    workspaceId: "alpha",
    grantId: "grant-a",
    revision: 1,
  });
  await fixture.operator.githubAppGrantAccept({
    workspaceId: "alpha",
    planId: revoke.id,
    fingerprint: revoke.fingerprint,
  });
  await expect(
    resolveGitHubCredential(fixture.operator, current),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
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
  source = await fixture.operator.githubSourceUpdate({
    ...scope,
    revision: source.revision,
    source: fields("legacy"),
  });
  expect(source.enabled).toBe(true);
  expect(source.credentialConfigured).toBe(true);
  expect(
    (
      await resolveGitHubCredential(fixture.operator, {
        ...current,
        connectionRevision: source.revision,
        reference: { kind: "token", reference: "legacy" },
      })
    ).token,
  ).toBe("synthetic-legacy-token");
  expect(
    (
      await fixture
        .as({ subject: "other", displayName: "Other" })
        .githubAppGrantList({ workspaceId: "beta" })
    ).grants[0].state,
  ).toBe("active");
  expect(
    (
      await fixture.operator.githubRefreshGet({
        ...scope,
        refreshId: "before-migration",
      })
    ).status,
  ).toBe("cancelled");
  expect(
    provider.mock.calls.filter(([, init]) => init?.method === "DELETE"),
  ).toEqual([]);
});
it("treats long installation tokens as opaque across collection and repository maintenance while retaining manual bounds", async () => {
  const token = "ghs_42_" + "a".repeat(4096) + ".b.c";
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + token,
    );
    return Response.json({}, { status: 404 });
  });
  await collectGitHub("example/project", token, {
    credentialKind: "app",
    fetch: fetcher,
  });
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockClear();
  await collectGitHub("example/project", token, { fetch: fetcher });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    () => new DependencyGitHub("example/project", token, fetcher),
  ).not.toThrow();
});
it("accounts cold, warm and fresh-effect single-repository authorization separately from provider payload work", async () => {
  const fixture = await createGitHubAppFixture();
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(appProviderFixture(fixture));
  const request = await activateGitHubAppFixture(fixture);
  const measured = countD1Statements(fixture.runtime.HQ_DB);
  const context = new Proxy(fixture.operator, {
    get(target, key) {
      return key === "db" ? measured.db : Reflect.get(target, key, target);
    },
  });
  for (const phase of ["cold", "warm", "effect"] as const) {
    measured.reset();
    provider.mockClear();
    const sign = vi.spyOn(crypto.subtle, "sign");
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const digest = vi.spyOn(crypto.subtle, "digest");
    const lease = await resolveGitHubCredential(context, {
      ...request,
      phase: phase === "effect" ? "effect" : "read",
    });
    console.info("APP_RESOURCE_SINGLE", phase, {
      calls: measured.calls(),
      statements: measured.count(),
      provider: provider.mock.calls.length,
      sign: sign.mock.calls.length,
      decrypt: decrypt.mock.calls.length,
      digest: digest.mock.calls.length,
    });
    expect(measured.calls()).toBeLessThanOrEqual(35);
    expect(provider.mock.calls.length).toBeLessThanOrEqual(
      phase === "warm" ? 0 : 3,
    );
    expect(lease.validUntil).toBeLessThanOrEqual(fixture.clock.now + 60000);
    sign.mockRestore();
    decrypt.mockRestore();
    digest.mockRestore();
  }
});
