import { CAPABILITY } from "../shared/domain";
import type { DependencyChangeReview } from "../shared/dependency-changes";
import { hookActorGuard } from "./hook-authority";
import { githubCredentialIdentity } from "./github-credentials";
import { providerCredentialGuard } from "./provider-credential-store";
import { PROVIDER_CREDENTIAL_KIND } from "../shared/provider-credentials";
import type { WorkspaceService } from "./service";
export type RepositoryReview = Pick<
  DependencyChangeReview,
  "workspaceId" | "writer" | "planId" | "fingerprint" | "expiresAt" | "state"
> & {
  basis: Pick<
    DependencyChangeReview["basis"],
    "repository" | "source" | "headSha" | "treeSha" | "branch"
  >;
};
export type StoredRepositoryReview = {
  review: Omit<
    RepositoryReview,
    "planId" | "fingerprint" | "expiresAt" | "state"
  >;
  memberRevision: number;
  tokenId: string | null;
  credentialRef: string;
  credentialHash: string;
  writerIdentity: string | null;
};
export async function repositoryReviewGuard(
  context: WorkspaceService,
  stored: StoredRepositoryReview,
) {
  const { review } = stored;
  const { basis, workspaceId } = review;
  const credential = await githubCredentialIdentity(
    context.env,
    workspaceId,
    stored.credentialRef,
  );
  const actor = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.OPERATE,
    stored.memberRevision,
  );
  const writer =
    review.writer && stored.writerIdentity
      ? providerCredentialGuard(
          workspaceId,
          PROVIDER_CREDENTIAL_KIND.REPOSITORY,
          review.writer.id,
          stored.writerIdentity,
        )
      : { sql: "1", values: [] };
  return {
    sql: `${actor.sql} AND ${writer.sql} AND ?=1 AND EXISTS (
      SELECT 1 FROM repositories r JOIN source_repositories sr ON sr.workspace_id=r.workspace_id AND sr.repository_id=r.id
      JOIN connections s ON s.workspace_id=sr.workspace_id AND s.id=sr.source_id
      WHERE r.workspace_id=? AND r.id=? AND r.full_name=? AND r.revision=? AND s.id=? AND s.revision=? AND s.enabled=1 AND s.provider='github' AND s.credential_ref=?)`,
    values: [
      ...actor.values,
      ...writer.values,
      Number(
        credential?.hash === stored.credentialHash &&
          stored.tokenId === (context.principal.tokenId ?? null),
      ),
      workspaceId,
      basis.repository.id,
      basis.repository.fullName,
      basis.repository.revision,
      basis.source.id,
      basis.source.revision,
      stored.credentialRef,
    ],
  };
}
