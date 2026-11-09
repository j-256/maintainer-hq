import { DEFAULT_EXPECTATIONS } from "../../shared/domain";
import { GitHubApps } from "../../worker/github-app-registrations";
import { sealGitHubAppMaterial } from "../../worker/github-app-crypto";
import { githubAppTestKey } from "./github-app-keys";
import type { GitHubAppFixture } from "./github-app-fixture";
export const appInstallationFixture = {
  id: 91,
  app_id: 42,
  account: { id: 50, login: "example", type: "Organization" as const },
  permissions: {
    metadata: "read" as const,
    contents: "read" as const,
    pull_requests: "read" as const,
  },
  repository_selection: "selected" as const,
  suspended_at: null,
};
export const appRepositoryFixture = {
  id: 101,
  full_name: "example/project",
  private: true,
  owner: { id: 50 },
};
export function appProviderFixture(fixture: GitHubAppFixture) {
  let minted = 0;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/app/installations/91"))
      return Response.json(appInstallationFixture);
    if (url.includes("/access_tokens"))
      return Response.json({
        token: "synthetic-installation-token-" + ++minted,
        expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
        repositories: [appRepositoryFixture],
      });
    return Response.json({}, { status: 404 });
  };
}
export async function activateGitHubAppFixture(
  fixture: GitHubAppFixture,
  workspaceId = "alpha",
  grantId = "grant-a",
) {
  if (!(await new GitHubApps(fixture.operator).registration("app-a"))) {
    const review = await fixture.plan();
    const key = await githubAppTestKey();
    const encrypted = await sealGitHubAppMaterial(
      {
        env: fixture.runtime,
        deploymentId: fixture.runtime.GITHUB_APP_DEPLOYMENT_ID!,
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
          account: appInstallationFixture.account,
          permissions: appInstallationFixture.permissions,
        },
        fingerprint: key.fingerprint,
        privateKey: { materialId: "signing-key", encrypted },
      },
    );
  }
  const review = await fixture.operator.githubAppGrantPlan({
    workspaceId: "administration",
    targetWorkspaceId: workspaceId,
    registrationId: "app-a",
    installationId: 91,
    grantId,
    revision: 0,
    repositoryIds: [101],
    capabilities: ["collection"],
  });
  const owner = fixture.as({
    subject: workspaceId === "alpha" ? "owner" : "other",
    displayName: "Owner",
  });
  await owner.githubAppGrantAccept({
    workspaceId,
    planId: review.id,
    fingerprint: review.fingerprint,
  });
  await fixture.runtime.HQ_DB.batch([
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO projects(id,workspace_id,name,description) VALUES (?,?,'Project','')",
    ).bind("project-" + workspaceId, workspaceId),
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES (?,?,?,'',?,'maintained','active',?,?,'synthetic')",
    ).bind(
      "repository-" + workspaceId,
      workspaceId,
      appRepositoryFixture.full_name,
      "project-" + workspaceId,
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(fixture.clock.now).toISOString(),
    ),
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,revision,enabled) VALUES ('github',?,'GitHub','github',?,?,1,1)",
    ).bind(
      workspaceId,
      JSON.stringify({ refreshIntervalMinutes: 15 }),
      grantId,
    ),
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO source_repositories(workspace_id,source_id,repository_id) VALUES (?,'github',?)",
    ).bind(workspaceId, "repository-" + workspaceId),
  ]);
  return {
    workspaceId,
    reference: { kind: "app" as const, grantId },
    repositoryId: "repository-" + workspaceId,
    repositoryFullName: appRepositoryFixture.full_name,
    capability: "collection" as const,
    connectionId: "github",
    connectionRevision: 1,
    binding: {
      kind: "actor" as const,
      subject: workspaceId === "alpha" ? "owner" : "other",
      tokenId: null,
      membershipRevision: 1,
    },
    phase: "read" as const,
  };
}
