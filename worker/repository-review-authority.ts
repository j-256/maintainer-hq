import { combineSqlGuards } from "./authority-sql";
import { CAPABILITY } from "../shared/domain";
import type { DependencyChangeReview } from "../shared/dependency-changes";
import { hookActorGuard } from "./hook-authority";
import {
  githubCredentialDescriptor,
  manualGitHubCredentialDescriptor,
} from "./github-credential-descriptors";
import {
  githubAuthorityFenceSql,
  assertGitHubAuthorityFence,
  resolveGitHubReadAuthority,
} from "./github-credential-resolver";
import type { GitHubAuthorityFence } from "./github-app-types";
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
  readFence?: GitHubAuthorityFence;
  writerFence?: GitHubAuthorityFence;
};
export async function repositoryReviewGuard(
  context: WorkspaceService,
  stored: StoredRepositoryReview,
  options: { refresh?: boolean } = {},
) {
  let providerCurrent = true;
  if (options.refresh) {
    for (const fence of [stored.readFence, stored.writerFence]) {
      if (fence?.kind !== "app") continue;
      try {
        await resolveGitHubReadAuthority(context, {
          ...fence,
          reference: { kind: "app", grantId: fence.grantId },
          phase: "read",
        });
        await assertGitHubAuthorityFence(context, fence);
      } catch {
        providerCurrent = false;
      }
    }
  }
  const { review } = stored;
  const { basis, workspaceId } = review;
  const credential =
    stored.readFence?.kind === "app"
      ? await githubCredentialDescriptor(
          context,
          workspaceId,
          stored.credentialRef,
        )
      : await manualGitHubCredentialDescriptor(
          context,
          workspaceId,
          stored.credentialRef,
        );
  const actor = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.OPERATE,
    stored.memberRevision,
  );
  const writer = stored.writerFence
    ? githubAuthorityFenceSql(stored.writerFence)
    : review.writer && stored.writerIdentity
      ? (() => {
          const guard = providerCredentialGuard(
            workspaceId,
            PROVIDER_CREDENTIAL_KIND.REPOSITORY,
            review.writer.id,
            stored.writerIdentity,
          );
          return {
            sql: `${guard.sql} AND NOT EXISTS(SELECT 1 FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?)`,
            values: [...guard.values, workspaceId, review.writer.id],
          };
        })()
      : { sql: "1", values: [] };
  const observed = stored.readFence
    ? githubAuthorityFenceSql(stored.readFence)
    : {
        sql: "NOT EXISTS(SELECT 1 FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?)",
        values: [workspaceId, stored.credentialRef],
      };
  const provider = combineSqlGuards([writer, observed]);
  return {
    sql: `${actor.sql} AND ${provider.sql} AND ?=1 AND EXISTS (
      SELECT 1 FROM repositories r JOIN source_repositories sr ON sr.workspace_id=r.workspace_id AND sr.repository_id=r.id
      JOIN connections s ON s.workspace_id=sr.workspace_id AND s.id=sr.source_id
      WHERE r.workspace_id=? AND r.id=? AND r.full_name=? AND r.revision=? AND s.id=? AND s.revision=? AND s.enabled=1 AND s.provider='github' AND s.credential_ref=?)`,
    values: [
      ...actor.values,
      ...provider.values,
      Number(
        providerCurrent &&
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
