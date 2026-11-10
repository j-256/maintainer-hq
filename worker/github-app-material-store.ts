import { githubAppMetadataSchema } from "../shared/github-apps";
import { GitHubAppClient, githubAppRemainingBudget } from "./github-app-client";
import {
  normalizeGitHubAppKey,
  openGitHubAppMaterial,
} from "./github-app-crypto";
import { DomainError } from "./errors";
import type { GitHubAppRegistrationRow } from "./github-app-registrations";
import type { GitHubCredentialContext } from "./github-app-types";

// Internal caller must authorize the registration or an active workspace grant first
export async function openGitHubAppClient(
  context: GitHubCredentialContext,
  registration: GitHubAppRegistrationRow,
) {
  githubAppRemainingBudget(context.remainingBudgetMs);
  const metadata = githubAppMetadataSchema.parse(
    JSON.parse(registration.metadata_json),
  );
  const row = await context.db
    .prepare(
      "SELECT material_id,key_id,nonce,ciphertext FROM github_app_material WHERE registration_id=? AND kind='private-key' AND revision=?",
    )
    .bind(registration.id, registration.key_revision)
    .first<{
      material_id: string;
      key_id: string;
      nonce: string;
      ciphertext: string;
    }>();
  if (!row || metadata.state !== "active")
    throw new DomainError(
      "github_app_material_unavailable",
      "This App's active signing material is unavailable.",
      503,
    );
  const bytes = await openGitHubAppMaterial(
    {
      env: context.env,
      deploymentId: context.env.GITHUB_APP_DEPLOYMENT_ID ?? "",
      administrativeWorkspaceId: registration.administrative_workspace_id,
      registrationId: registration.id,
      kind: "private-key",
      materialId: row.material_id,
      revision: registration.key_revision,
    },
    { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext },
  );
  try {
    const key = await normalizeGitHubAppKey(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (key.fingerprint !== metadata.keyFingerprint)
      throw new DomainError(
        "github_app_material_unavailable",
        "This App's signing identity does not match its protected material.",
        503,
      );
    return new GitHubAppClient({
      appId: metadata.appId,
      privateKey: key.pkcs8,
      now: context.now,
      fetch: context.fetch,
      budgetMs: githubAppRemainingBudget(context.remainingBudgetMs),
    });
  } finally {
    bytes.fill(0);
  }
}
