import type { GitHubAuthReference } from "../shared/github-apps";
import type { GitHubCredentialContext } from "./github-app-types";

export async function readGitHubAuthReference(
  context: GitHubCredentialContext,
  workspaceId: string,
  referenceId: string,
): Promise<GitHubAuthReference> {
  const row = await context.db
    .prepare(
      "SELECT grant_id FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?",
    )
    .bind(workspaceId, referenceId)
    .first<{ grant_id: string }>();
  return row
    ? { kind: "app", grantId: row.grant_id }
    : { kind: "token", reference: referenceId };
}
