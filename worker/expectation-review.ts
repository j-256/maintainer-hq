import { CAPABILITY, expectationSchema } from "../shared/domain";
import {
  EXPECTATION_REVIEW_KIND,
  expectationReviewCompleteInput,
  expectationReviewGetInput,
  type ExpectationReviewReceipt,
} from "../shared/expectation-review";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export class ExpectationReviews {
  constructor(readonly context: WorkspaceService) {}
  async get(input: unknown): Promise<ExpectationReviewReceipt> {
    const { workspaceId, repositoryId, reviewId } =
      expectationReviewGetInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.context.db
      .prepare(
        `SELECT o.result_json AS result FROM operations o JOIN action_plans p ON p.id=o.plan_id
      WHERE o.workspace_id=? AND o.plan_id=? AND o.kind=? AND o.status='succeeded'
      AND json_extract(p.input_json,'$.repositoryId')=? AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=?) AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        reviewId,
        EXPECTATION_REVIEW_KIND,
        repositoryId,
        workspaceId,
        repositoryId,
        ...guard.values,
      )
      .first<{ result: string }>();
    await authorizeHooks(this.context, workspaceId);
    if (!row)
      throw new DomainError(
        "not_found",
        "This completed review is not available in this repository workspace.",
        404,
      );
    return JSON.parse(row.result) as ExpectationReviewReceipt;
  }
  async complete(input: unknown): Promise<ExpectationReviewReceipt> {
    const fields = expectationReviewCompleteInput.parse(input);
    const { workspaceId, repositoryId, reviewId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const serialized = JSON.stringify({
      ...fields,
      actor: this.context.principal.subject,
      tokenId: this.context.principal.tokenId ?? null,
    });
    const fingerprint = await credentialHash(serialized);
    const db = this.context.db;
    const prior = await db
      .prepare(
        "SELECT fingerprint FROM action_plans WHERE id=? AND workspace_id=? AND kind=?",
      )
      .bind(reviewId, workspaceId, EXPECTATION_REVIEW_KIND)
      .first<{ fingerprint: string }>();
    if (prior) {
      if (prior.fingerprint !== fingerprint) this.conflict();
      return this.get({ workspaceId, repositoryId, reviewId });
    }
    const completedAt = new Date(this.context.now()).toISOString();
    if (
      fields.nextReviewDate &&
      fields.nextReviewDate <= completedAt.slice(0, 10)
    )
      throw new DomainError(
        "validation",
        "Choose a future review date, or leave it empty to finish without another scheduled review.",
        400,
      );
    const repository = await db
      .prepare(
        "SELECT full_name AS fullName,revision,expectations_json AS expectations,project_id AS projectId FROM repositories WHERE workspace_id=? AND id=?",
      )
      .bind(workspaceId, repositoryId)
      .first<{
        fullName: string;
        revision: number;
        expectations: string;
        projectId: string;
      }>();
    if (!repository || repository.revision !== fields.revision) this.conflict();
    const receipt: ExpectationReviewReceipt = {
      reviewId,
      repositoryId,
      repositoryName: repository.fullName,
      previousRevision: repository.revision,
      revision: repository.revision + 1,
      previousReviewDate: expectationSchema.parse(
        JSON.parse(repository.expectations),
      ).reviewDate,
      nextReviewDate: fields.nextReviewDate,
      outcome: fields.outcome,
      completedAt,
    };
    const writeId = crypto.randomUUID();
    const written =
      "EXISTS(SELECT 1 FROM operations WHERE id=? AND workspace_id=? AND plan_id=? AND kind=?)";
    const writtenValues = [
      writeId,
      workspaceId,
      reviewId,
      EXPECTATION_REVIEW_KIND,
    ];
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=? AND revision=?)`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          EXPECTATION_REVIEW_KIND,
          serialized,
          fingerprint,
          completedAt,
          completedAt,
          ...guard.values,
          workspaceId,
          repositoryId,
          fields.revision,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
        SELECT ?,?,?,?,?,'succeeded','Repository review completed',?,?,? WHERE ${guard.sql}
        AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND fingerprint=? AND applied_at IS NULL)
        AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=? AND revision=?)`,
        )
        .bind(
          writeId,
          workspaceId,
          reviewId,
          this.context.principal.subject,
          EXPECTATION_REVIEW_KIND,
          JSON.stringify(receipt),
          completedAt,
          completedAt,
          ...guard.values,
          reviewId,
          workspaceId,
          fingerprint,
          workspaceId,
          repositoryId,
          fields.revision,
        ),
      db
        .prepare(
          `UPDATE repositories SET expectations_json=json_set(expectations_json,'$.reviewDate',?),revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id=? AND ${written}`,
        )
        .bind(
          fields.nextReviewDate,
          completedAt,
          writeId,
          workspaceId,
          repositoryId,
          ...writtenValues,
        ),
      db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT ?,?,?,?,'repository.reviewed','Repository review completed',?,?,? WHERE ${written}`,
        )
        .bind(
          writeId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          fields.outcome,
          repositoryId,
          completedAt,
          ...writtenValues,
        ),
      db
        .prepare(
          `INSERT INTO activity_repository_links(workspace_id,event_id,repository_id) SELECT ?,?,? WHERE ${written}`,
        )
        .bind(workspaceId, writeId, repositoryId, ...writtenValues),
      db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE id=? AND workspace_id=? AND ${written}`,
        )
        .bind(completedAt, reviewId, workspaceId, ...writtenValues),
    ]);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const accepted = await db
      .prepare(
        "SELECT fingerprint FROM action_plans WHERE id=? AND workspace_id=? AND applied_at IS NOT NULL AND kind=?",
      )
      .bind(reviewId, workspaceId, EXPECTATION_REVIEW_KIND)
      .first<{ fingerprint: string }>();
    if (accepted?.fingerprint !== fingerprint) this.conflict();
    return this.get({ workspaceId, repositoryId, reviewId });
  }
  conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "The repository or review request changed. Your outcome has been kept; inspect saved state before completing a new review.",
      409,
    );
  }
}
