import { z } from "zod";
import { CAPABILITY } from "../shared/domain";
import { DEPENDENCIES_LIMITS } from "../shared/dependencies";
import {
  DEPENDENCY_CHANGE_KIND as KIND,
  DEPENDENCY_CHANGE_LIMITS as LIMITS,
  changedDependencyRule,
  dependencyChangePlanInput,
  dependencyChangeReviewInput,
  dependencyChangeReviewSchema,
  type DependencyChangeReview,
} from "../shared/dependency-changes";
import { readRepositoryDependencies } from "./dependencies";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { githubCredentialIdentity } from "./github-credentials";
import { dependencyHash } from "./dependency-client";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";
import { dependencyCredential } from "./dependency-credentials";
import { providerCredentialGuard } from "./provider-credential-store";
import { PROVIDER_CREDENTIAL_KIND } from "../shared/provider-credentials";

export const storedDependencyReviewSchema = z
  .object({
    review: dependencyChangeReviewSchema.omit({
      planId: true,
      fingerprint: true,
      expiresAt: true,
      state: true,
    }),
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    credentialRef: z.string(),
    credentialHash: z.string(),
    writerIdentity: z.string().nullable().default(null),
  })
  .strict();
export type StoredDependencyReview = z.infer<
  typeof storedDependencyReviewSchema
>;
export function dependencyReviewConflict(): never {
  throw new DomainError(
    "revision_conflict",
    "This dependency review expired, its evidence changed, or access changed. Inspect the repository again and prepare a fresh review. No repository changes were applied.",
    409,
  );
}
export async function dependencyReviewGuard(
  context: WorkspaceService,
  stored: StoredDependencyReview,
) {
  const { review } = stored;
  const { basis, workspaceId } = review;
  const actor = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.OPERATE,
    stored.memberRevision,
  );
  const credential = await githubCredentialIdentity(
    context.env,
    workspaceId,
    stored.credentialRef,
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
export class DependencyChanges {
  constructor(readonly context: WorkspaceService) {}
  async plan(input: unknown): Promise<DependencyChangeReview> {
    const fields = dependencyChangePlanInput.parse(input);
    const { workspaceId, sourceId, repositoryId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
    );
    const result = await readRepositoryDependencies(this.context, {
      workspaceId,
      sourceId,
      repositoryId,
      ...(fields.pullNumber ? { pullNumber: fields.pullNumber } : {}),
    });
    const evidence = result.evidence;
    const now = this.context.now();
    if (
      result.state !== "ready" ||
      !evidence?.report ||
      evidence.read.state !== "observed" ||
      !evidence.headSha ||
      !evidence.treeSha ||
      !evidence.branch ||
      now - Date.parse(evidence.observedAt) >= DEPENDENCIES_LIMITS.CACHE_MS ||
      Date.parse(evidence.observedAt) > now ||
      evidence.headSha !== fields.headSha ||
      evidence.report.policyDigest !== fields.policyDigest
    )
      dependencyReviewConflict();
    let changed: ReturnType<typeof changedDependencyRule>;
    try {
      changed = changedDependencyRule(
        evidence.report.analysis,
        fields.overrideId,
        fields.change,
        now,
      );
    } catch (error) {
      throw new DomainError(
        "validation",
        error instanceof Error
          ? error.message
          : "This dependency change is not supported by the inspected evidence.",
        400,
      );
    }
    const source = await this.context.db
      .prepare(
        "SELECT credential_ref FROM connections WHERE workspace_id=? AND id=? AND revision=?",
      )
      .bind(workspaceId, sourceId, result.source.revision)
      .first<{ credential_ref: string }>();
    const credential = source
      ? await githubCredentialIdentity(
          this.context.env,
          workspaceId,
          source.credential_ref,
        )
      : null;
    if (!credential || !source) dependencyReviewConflict();
    const writer = fields.credentialId
      ? await dependencyCredential(
          this.context,
          workspaceId,
          fields.credentialId,
          result.repository.fullName,
        )
      : null;
    const stored: StoredDependencyReview = {
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      credentialRef: source.credential_ref,
      credentialHash: credential.hash,
      writerIdentity: writer?.identity ?? null,
      review: {
        workspaceId,
        actor: this.context.principal.displayName,
        writer: writer
          ? {
              id: fields.credentialId!,
              name: writer.settings.name,
              revision: writer.revision,
              expiresAt: writer.settings.expiresAt,
            }
          : null,
        change: fields.change,
        ...changed,
        basis: {
          repository: result.repository,
          source: result.source,
          observedAt: evidence.observedAt,
          headSha: evidence.headSha,
          treeSha: evidence.treeSha,
          branch: evidence.branch,
          pullNumber: evidence.pullNumber,
          policyDigest: evidence.report.policyDigest,
          files: evidence.report.files,
        },
      },
    };
    const serialized = JSON.stringify(
      storedDependencyReviewSchema.parse(stored),
    );
    const fingerprint = await dependencyHash(serialized);
    const planId = crypto.randomUUID();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + LIMITS.REVIEW_MS).toISOString();
    const guard = await dependencyReviewGuard(this.context, stored);
    const resultRows = await this.context.db.batch([
      this.context.db
        .prepare(
          `DELETE FROM action_plans WHERE id IN (SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND expires_at<=? AND NOT EXISTS (SELECT 1 FROM operations WHERE plan_id=action_plans.id) LIMIT ?) AND ${guard.sql}`,
        )
        .bind(
          workspaceId,
          this.context.principal.subject,
          KIND,
          timestamp,
          LIMITS.CLEANUP,
          ...guard.values,
        ),
      this.context.db
        .prepare(
          `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND EXISTS (SELECT 1 FROM ${fields.pullNumber ? "github_dependency_candidate_cache" : "github_dependency_cache"} WHERE workspace_id=? AND source_id=? AND repository_id=? AND identity=? AND json_extract(result_json,'$.headSha')=? AND json_extract(result_json,'$.report.policyDigest')=?)
        AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
        )
        .bind(
          planId,
          workspaceId,
          this.context.principal.subject,
          KIND,
          serialized,
          fingerprint,
          timestamp,
          expiresAt,
          ...guard.values,
          workspaceId,
          sourceId,
          repositoryId,
          JSON.stringify([
            result.repository.fullName,
            result.repository.revision,
            result.source.revision,
            credential.hash,
            ...(fields.pullNumber ? [fields.pullNumber] : []),
          ]),
          fields.headSha,
          fields.policyDigest,
          workspaceId,
          this.context.principal.subject,
          KIND,
          timestamp,
          LIMITS.PENDING,
        ),
    ]);
    if (!resultRows[1].meta.changes)
      throw new DomainError(
        "conflict",
        "Dependency evidence or access changed, or the pending-review limit was reached. Reload existing reviews before preparing another.",
        409,
      );
    return this.review({ workspaceId, planId });
  }
  async load(workspaceId: string, planId: string) {
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const actor = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.context.db
      .prepare(
        `SELECT input_json,fingerprint,expires_at FROM action_plans WHERE workspace_id=? AND id=? AND kind=? AND actor_subject=? AND ${actor.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        KIND,
        this.context.principal.subject,
        ...actor.values,
      )
      .first<{ input_json: string; fingerprint: string; expires_at: string }>();
    if (!row)
      throw new DomainError(
        "not_found",
        "This dependency review is not available to this workspace and identity.",
        404,
      );
    const stored = storedDependencyReviewSchema.parse(
      JSON.parse(row.input_json),
    );
    if (
      stored.review.workspaceId !== workspaceId ||
      stored.tokenId !== (this.context.principal.tokenId ?? null) ||
      (await dependencyHash(row.input_json)) !== row.fingerprint
    )
      dependencyReviewConflict();
    return { row, stored };
  }
  async review(input: unknown): Promise<DependencyChangeReview> {
    const { workspaceId, planId } = dependencyChangeReviewInput.parse(input);
    const { row, stored } = await this.load(workspaceId, planId);
    const guard = await dependencyReviewGuard(this.context, stored);
    const matches = await this.context.db
      .prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.values)
      .first();
    const state =
      Date.parse(row.expires_at) <= this.context.now()
        ? "expired"
        : matches
          ? "ready"
          : "stale";
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    return dependencyChangeReviewSchema.parse({
      ...stored.review,
      planId,
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
      state,
    });
  }
}
