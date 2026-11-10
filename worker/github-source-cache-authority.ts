import { GITHUB_CAPABILITY } from "../shared/github-apps";
import { CAPABILITY } from "../shared/domain";
import { DomainError } from "./errors";
import { resolveGitHubReadAuthority } from "./github-credential-resolver";
import type { GitHubCredentialDescriptor } from "./github-credential-descriptors";
import type { WorkspaceService } from "./service";

// Inventory pages inspect local authority only; an explicit refresh verifies upstream access
export async function githubSourceCacheAuthority(
  context: WorkspaceService,
  workspaceId: string,
  memberRevision: number,
  source: {
    id: string;
    full_name: string;
    source_id: string | null;
    source_revision: number;
  },
  credential: GitHubCredentialDescriptor,
) {
  if (credential.kind === "token")
    return { authorityIdentity: credential.hash, fence: null };
  try {
    return await resolveGitHubReadAuthority(
      context,
      {
        workspaceId,
        repositoryId: source.id,
        repositoryFullName: source.full_name,
        connectionId: source.source_id!,
        connectionRevision: source.source_revision,
        reference: credential.reference,
        capability: GITHUB_CAPABILITY.COLLECTION,
        actorCapability: CAPABILITY.READ,
        binding: {
          kind: "actor",
          subject: context.principal.subject,
          tokenId: context.principal.tokenId ?? null,
          membershipRevision: memberRevision,
        },
        phase: "read",
      },
      true,
    );
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "github_app_authority_unverified"
    )
      return null;
    throw error;
  }
}
