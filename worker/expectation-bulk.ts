import { CAPABILITY, LIMITS, expectationSchema } from "../shared/domain";
import {
  EXPECTATION_BULK_LIMITS,
  changedExpectationFields,
  expectationBulkApplyInput,
  expectationBulkPlanInput,
  expectationBulkReviewInput,
  patchExpectations,
  type ExpectationBulkFields,
  type ExpectationBulkReceipt,
  type ExpectationBulkReview,
  type ExpectationBulkRow,
} from "../shared/expectation-bulk";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";

const PLAN_KIND = "expectations.bulk";
type Reviewed = {
  fields: ExpectationBulkFields;
  rows: ExpectationBulkRow[];
  workspaceName: string;
  actor: string;
  memberRevision: number;
  tokenId: string | null;
};
type PlanRow = { input: string; fingerprint: string; expiresAt: string };
const MATCHING_REPOSITORIES = `NOT EXISTS (
  SELECT 1 FROM json_each(?) selected LEFT JOIN repositories r
  ON r.workspace_id=? AND r.id=json_extract(selected.value,'$.repositoryId')
  WHERE r.id IS NULL OR r.revision<>json_extract(selected.value,'$.revision'))`;

export class ExpectationBulkService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  get principal() {
    return this.context.principal;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "The review expired, a selected repository changed, or workspace access changed. No expectation changes were applied. Keep your choices and prepare a fresh review.",
      409,
    );
  }
  private async matching(workspaceId: string, reviewed: Reviewed) {
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      reviewed.memberRevision,
    );
    return Boolean(
      await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql} AND ${MATCHING_REPOSITORIES}`)
        .bind(...guard.values, JSON.stringify(reviewed.rows), workspaceId)
        .first(),
    );
  }
  private async load(workspaceId: string, planId: string) {
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.EDIT);
    const plan = await this.db
      .prepare(
        `SELECT input_json AS input,fingerprint,expires_at AS expiresAt FROM action_plans
      WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND ${guard.sql}`,
      )
      .bind(
        planId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<PlanRow>();
    if (!plan)
      throw new DomainError(
        "not_found",
        "This expectation review is not available to this workspace and identity.",
        404,
      );
    const reviewed = JSON.parse(plan.input) as Reviewed;
    expectationBulkPlanInput.parse(reviewed.fields);
    if (
      reviewed.fields.workspaceId !== workspaceId ||
      reviewed.tokenId !== (this.principal.tokenId ?? null) ||
      (await credentialHash(plan.input)) !== plan.fingerprint
    )
      this.conflict();
    return { plan, reviewed };
  }
  private async receipt(workspaceId: string, planId: string) {
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.EDIT);
    const row = await this.db
      .prepare(
        `SELECT result_json AS result FROM operations
      WHERE workspace_id=? AND plan_id=? AND actor_subject=? AND kind=? AND status='succeeded' AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<{ result: string }>();
    return row ? (JSON.parse(row.result) as ExpectationBulkReceipt) : null;
  }
  private async response(
    workspaceId: string,
    planId: string,
    plan: PlanRow,
    reviewed: Reviewed,
  ): Promise<ExpectationBulkReview> {
    let receipt = await this.receipt(workspaceId, planId);
    let state: ExpectationBulkReview["state"] = receipt
      ? "applied"
      : Date.parse(plan.expiresAt) <= this.context.now()
        ? "expired"
        : (await this.matching(workspaceId, reviewed))
          ? "ready"
          : "stale";
    if (!receipt && state !== "ready") {
      receipt = await this.receipt(workspaceId, planId);
      if (receipt) state = "applied";
    }
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    return {
      fields: reviewed.fields,
      workspaceId,
      workspaceName: reviewed.workspaceName,
      planId,
      fingerprint: plan.fingerprint,
      actor: reviewed.actor,
      expiresAt: plan.expiresAt,
      rows: reviewed.rows,
      state,
      receipt,
    };
  }
  async review(input: unknown) {
    const { workspaceId, planId } = expectationBulkReviewInput.parse(input);
    const { plan, reviewed } = await this.load(workspaceId, planId);
    return this.response(workspaceId, planId, plan, reviewed);
  }
  async plan(input: unknown) {
    const fields = expectationBulkPlanInput.parse(input);
    const { workspaceId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const workspace = await this.context.authorize(
      workspaceId,
      CAPABILITY.EDIT,
    );
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    fields.repositories.sort((a, b) =>
      a.repositoryId.localeCompare(b.repositoryId, "en"),
    );
    const selection = JSON.stringify(fields.repositories);
    const result = await this.db
      .prepare(
        `SELECT id,full_name AS fullName,expectations_json AS expectations,revision FROM repositories
      WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${guard.sql}`,
      )
      .bind(workspaceId, selection, ...guard.values)
      .all<{
        id: string;
        fullName: string;
        expectations: string;
        revision: number;
      }>();
    if (result.results.length !== fields.repositories.length) this.conflict();
    const rows = fields.repositories.map((selected): ExpectationBulkRow => {
      const row = result.results.find(
        (row) => row.id === selected.repositoryId,
      );
      if (!row || row.revision !== selected.revision) this.conflict();
      const before = expectationSchema.parse(JSON.parse(row.expectations));
      const after = patchExpectations(before, selected.patch);
      return {
        repositoryId: row.id,
        fullName: row.fullName,
        revision: row.revision,
        before,
        after,
        changed: changedExpectationFields(before, after),
      };
    });
    const reviewed: Reviewed = {
      fields,
      rows,
      memberRevision,
      tokenId: this.principal.tokenId ?? null,
      workspaceName: workspace.name,
      actor: this.principal.displayName,
    };
    const serialized = JSON.stringify(reviewed);
    if (
      new TextEncoder().encode(serialized).byteLength >
      EXPECTATION_BULK_LIMITS.REVIEW_BYTES
    )
      throw new DomainError(
        "too_large",
        "Select fewer repositories for this review",
        413,
      );
    const planId = crypto.randomUUID();
    const fingerprint = await credentialHash(serialized);
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + LIMITS.PLAN_TTL_MS,
    ).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM action_plans WHERE id IN (SELECT id FROM action_plans
        WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM operations WHERE plan_id=action_plans.id) LIMIT ?) AND ${guard.sql}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          createdAt,
          EXPECTATION_BULK_LIMITS.CLEANUP_ROWS,
          ...guard.values,
        ),
      this.db
        .prepare(
          `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND ${MATCHING_REPOSITORIES}
        AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
        )
        .bind(
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          serialized,
          fingerprint,
          createdAt,
          expiresAt,
          ...guard.values,
          selection,
          workspaceId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          createdAt,
          EXPECTATION_BULK_LIMITS.PENDING_PLANS,
        ),
    ]);
    if (!results[1]?.meta.changes) {
      if (!(await this.matching(workspaceId, reviewed))) this.conflict();
      throw new DomainError(
        "capacity",
        "Too many open expectation reviews. Finish an existing review or wait for it to expire before preparing another.",
        409,
      );
    }
    return this.response(
      workspaceId,
      planId,
      { input: serialized, fingerprint, expiresAt },
      reviewed,
    );
  }
  async apply(input: unknown): Promise<ExpectationBulkReceipt> {
    const { workspaceId, planId, fingerprint } =
      expectationBulkApplyInput.parse(input);
    const { plan, reviewed } = await this.load(workspaceId, planId);
    if (plan.fingerprint !== fingerprint) this.conflict();
    const prior = await this.receipt(workspaceId, planId);
    if (prior) {
      await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
      return prior;
    }
    if (Date.parse(plan.expiresAt) <= this.context.now()) this.conflict();
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      reviewed.memberRevision,
    );
    const writeId = crypto.randomUUID();
    const appliedAt = this.timestamp();
    const changed = reviewed.rows.filter((row) => row.changed.length);
    const receipt: ExpectationBulkReceipt = {
      workspaceId,
      planId,
      fingerprint,
      appliedAt,
      changedRepositoryIds: changed.map((row) => row.repositoryId),
      unchangedRepositoryIds: reviewed.rows
        .filter((row) => !row.changed.length)
        .map((row) => row.repositoryId),
    };
    const written =
      "EXISTS (SELECT 1 FROM operations WHERE id=? AND workspace_id=? AND plan_id=? AND status='succeeded')";
    const writtenValues = [writeId, workspaceId, planId];
    const changedJson = JSON.stringify(
      changed.map((row) => ({
        ...row,
        eventId: crypto.randomUUID(),
        summary:
          row.fullName +
          ": " +
          row.changed.join(", ") +
          ". Reviewed bulk expectation change; provider observations are unchanged.",
      })),
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
        SELECT ?,?,?,?,?,'succeeded',?,?,?,? WHERE ${guard.sql} AND ${MATCHING_REPOSITORIES}
        AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND input_json=? AND fingerprint=? AND applied_at IS NULL
          AND expires_at>? AND julianday(expires_at)>julianday('now')) ON CONFLICT (plan_id) DO NOTHING`,
        )
        .bind(
          writeId,
          workspaceId,
          planId,
          this.principal.subject,
          PLAN_KIND,
          `${changed.length} repository expectation changes`,
          JSON.stringify(receipt),
          appliedAt,
          appliedAt,
          ...guard.values,
          JSON.stringify(reviewed.rows),
          workspaceId,
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          plan.input,
          fingerprint,
          appliedAt,
        ),
      this.db
        .prepare(
          `UPDATE repositories SET expectations_json=(SELECT json_extract(value,'$.after') FROM json_each(?) WHERE json_extract(value,'$.repositoryId')=repositories.id),
        revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          changedJson,
          appliedAt,
          writeId,
          workspaceId,
          changedJson,
          ...writtenValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT json_extract(value,'$.eventId'),?,?,?,'expectations.updated','Repository expectations updated',json_extract(value,'$.summary'),json_extract(value,'$.repositoryId'),?
        FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          appliedAt,
          changedJson,
          ...writtenValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.repositoryId') FROM json_each(?) WHERE ${written}`,
        )
        .bind(workspaceId, changedJson, ...writtenValues),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE id=? AND workspace_id=? AND ${written}`,
        )
        .bind(appliedAt, planId, workspaceId, ...writtenValues),
    ]);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const committed = await this.receipt(workspaceId, planId);
    if (!committed) this.conflict();
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    return committed;
  }
}
