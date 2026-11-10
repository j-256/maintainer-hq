import { countD1Statements } from "./helpers/d1-count";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appInstallationFixture,
  appRepositoryFixture,
} from "./helpers/github-app-active-fixture";
import {
  assertGitHubDiscoveryAuthority,
  githubDiscoveryAuthoritySql,
  resolveGitHubCredential,
  resolveGitHubDiscoveryAuthority,
  resolveGitHubDiscoveryToken,
} from "../worker/github-credential-resolver";
import { invalidateGitHubAppAuthority } from "../worker/github-app-authority";
import type { GitHubCredentialRequest } from "../worker/github-app-types";
let fixture: GitHubAppFixture;
let request: GitHubCredentialRequest;
let repositories: (typeof appRepositoryFixture)[];
let requests: string[];
let denyTokens = false;
let mints: { repository_ids: number[]; permissions: object }[];
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  repositories = [appRepositoryFixture];
  requests = [];
  mints = [];
  denyTokens = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/app/installations/91")
      return Response.json(appInstallationFixture);
    if (path.endsWith("/access_tokens")) {
      if (denyTokens) return Response.json({}, { status: 403 });
      const body = JSON.parse(String(init?.body));
      mints.push(body);
      return Response.json({
        token: "synthetic-scoped-token",
        expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
        permissions: body.permissions,
        repositories: repositories.filter((repository) =>
          body.repository_ids.includes(repository.id),
        ),
      });
    }
    return Response.json({}, { status: 404 });
  });
  request = await activateGitHubAppFixture(fixture);
  requests = [];
  mints = [];
});
afterEach(() => vi.restoreAllMocks());
const discovery = () =>
  resolveGitHubDiscoveryAuthority(fixture.operator, request);
it("verifies and narrows the full accepted repository bound with shared provider checks and bounded SQL bindings", async () => {
  repositories = Array.from({ length: 100 }, (_, index) => ({
    ...appRepositoryFixture,
    id: 101 + index,
    full_name: "example/project" + (index || ""),
  }));
  const row = await fixture.runtime.HQ_DB.prepare(
    "SELECT metadata_json FROM github_app_grants WHERE id='grant-a'",
  ).first<{ metadata_json: string }>();
  const grant = JSON.parse(row!.metadata_json);
  grant.revision++;
  grant.repositories = repositories.map((repository) => ({
    id: repository.id,
    fullName: repository.full_name,
    private: repository.private,
    ownerId: repository.owner.id,
  }));
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_grants SET metadata_json=?,revision=? WHERE id='grant-a'",
  )
    .bind(JSON.stringify(grant), grant.revision)
    .run();
  const measured = countD1Statements(fixture.runtime.HQ_DB);
  const context = new Proxy(fixture.operator, {
    get(target, key) {
      return key === "db" ? measured.db : Reflect.get(target, key, target);
    },
  });
  const authority = await resolveGitHubDiscoveryAuthority(context, request);
  console.info("APP_RESOURCE_DISCOVERY_COLD", {
    calls: measured.calls(),
    statements: measured.count(),
    maxBindings: measured.maxBindings(),
  });
  expect(measured.calls()).toBeLessThanOrEqual(750);
  expect(measured.maxBindings()).toBeLessThanOrEqual(100);
  const beforeWarm = measured.calls();
  await resolveGitHubDiscoveryAuthority(context, request);
  console.info("APP_RESOURCE_DISCOVERY_WARM", measured.calls() - beforeWarm);
  expect(measured.calls() - beforeWarm).toBeLessThanOrEqual(350);
  expect(authority.fences).toHaveLength(100);
  expect(requests).toHaveLength(2);
  expect(mints).toHaveLength(1);
  expect(mints[0].repository_ids).toEqual(
    repositories.map((repository) => repository.id),
  );
  expect(
    githubDiscoveryAuthoritySql(authority).values.length,
  ).toBeLessThanOrEqual(100);
  expect(await resolveGitHubDiscoveryToken(fixture.operator, authority)).toBe(
    "synthetic-scoped-token",
  );
  expect(mints).toHaveLength(2);
  expect(mints[1]).toEqual(mints[0]);
  expect(JSON.stringify(authority)).not.toContain("synthetic-scoped-token");
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_authority SET generation=generation+1 WHERE repository_id=200",
  ).run();
  await expect(
    assertGitHubDiscoveryAuthority(fixture.operator, authority),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
  await invalidateGitHubAppAuthority(fixture.operator, "app-a");
  await expect(
    assertGitHubDiscoveryAuthority(fixture.operator, authority),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
});
it("requires administrative actor authority for pre-enrollment discovery", async () => {
  await expect(
    resolveGitHubCredential(fixture.operator, {
      ...request,
      repositoryId: null,
    }),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
  expect(requests).toEqual([]);
});
it("preserves a provider denial without falling back to the manual token catalog", async () => {
  denyTokens = true;
  const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(discovery()).rejects.toMatchObject({
    code: "github_app_denied",
  });
  expect(requests).toEqual([
    "/app/installations/91",
    "/app/installations/91/access_tokens",
  ]);
  expect(diagnostics.mock.calls.map((call) => call[0])).toContainEqual(
    expect.objectContaining({
      event: "hq.github.app.authority",
      state: "denied",
      requests: 2,
    }),
  );
  expect(
    (
      await fixture.runtime.HQ_DB.prepare(
        "SELECT state FROM github_app_authority",
      ).first<{ state: string }>()
    )?.state,
  ).toBe("denied");
});
