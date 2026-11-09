import { applyD1Migrations, env } from "cloudflare:test";
import { WorkspaceService } from "../../worker/service";
import type { Env } from "../../worker/types";
import type { Principal } from "../../shared/domain";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
export const GITHUB_APP_TEST_ISSUER = "https://identity.example";
export const GITHUB_APP_TEST_AUDIENCE = "synthetic-hq-application";
export const githubAppTestPrincipal = (subject = "owner"): Principal => ({
  subject,
  displayName: subject,
  access: {
    issuer: GITHUB_APP_TEST_ISSUER,
    audience: GITHUB_APP_TEST_AUDIENCE,
  },
});
export async function migrateGitHubAppFixture() {
  await applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS);
}
export async function createGitHubAppFixture() {
  const clock = { now: Date.now() };
  const permit = {
    id: "setup-permit",
    revision: 1,
    administrativeWorkspaceId: "administration",
    subject: "owner",
    issuer: GITHUB_APP_TEST_ISSUER,
    audience: GITHUB_APP_TEST_AUDIENCE,
    expiresAt: new Date(clock.now + 60 * 60 * 1000).toISOString(),
  };
  const runtime: Env = {
    ...bindings,
    ACCESS_ISSUER: GITHUB_APP_TEST_ISSUER,
    ACCESS_AUDIENCE: GITHUB_APP_TEST_AUDIENCE,
    GITHUB_APP_DEPLOYMENT_ID: "synthetic-deployment",
    GITHUB_APP_SETUP_PERMITS: JSON.stringify([permit]),
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "key-a",
      keys: [{ id: "key-a", key: btoa("a".repeat(32)) }],
    }),
    GITHUB_CREDENTIALS: JSON.stringify({
      legacy: {
        workspaceId: "alpha",
        name: "Existing token",
        token: "synthetic-legacy-token",
      },
    }),
  };
  await runtime.HQ_DB.batch([
    runtime.HQ_DB.prepare("DELETE FROM workspaces"),
    runtime.HQ_DB.prepare("DELETE FROM github_app_setup_revocations"),
    runtime.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    runtime.HQ_DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('administration','Administration',?),('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(
      new Date(clock.now).toISOString(),
      new Date(clock.now).toISOString(),
      new Date(clock.now).toISOString(),
    ),
    runtime.HQ_DB.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('administration','owner','Owner','owner'),('administration','operator','Operator','operator'),('administration','viewer','Viewer','viewer'),('alpha','owner','Owner','owner'),('beta','other','Other','owner')",
    ),
  ]);
  const as = (principal = githubAppTestPrincipal(), development = false) =>
    new WorkspaceService(runtime, principal, development, () => clock.now);
  const operator = as();
  const plan = () =>
    operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 0,
      change: {
        kind: "save",
        fields: {
          name: "Repository operator",
          appId: 42,
          visibility: "public",
          capabilities: ["collection"],
        },
        replaceKey: true,
      },
    });
  return { clock, runtime, permit, as, operator, plan };
}
export type GitHubAppFixture = Awaited<
  ReturnType<typeof createGitHubAppFixture>
>;
