import { z } from "zod";
import { CAPABILITY, LIMITS, workspaceInput } from "../shared/domain";
import {
  HOOK_LIMITS,
  HOOK_RETRY_KIND,
  HOOK_POLICY_KIND,
  hookReceiptSchema,
  hookRetryApplyInput,
  hookRetryInput,
  hookRetryPlanInput,
  type HookReceipt,
  type HookReview,
} from "../shared/hooks";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  callHookProvider,
  hookProvider,
  hookProviderActor,
  HookProviderError,
  type HookProvider,
} from "./hook-client";
import { HooksService } from "./hooks";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";
import { captureResourceActivity, copyActivityContext } from "./resource-links";

const reviewedSchema = hookRetryPlanInput
  .extend({
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    providerRef: z.string(),
    providerIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    providerActor: z.string(),
    connectionName: z.string(),
  })
  .strict();
type Reviewed = z.infer<typeof reviewedSchema>;
type PlanRow = {
  id: string;
  workspace_id: string;
  actor_subject: string;
  input_json: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  provider_review_json: string | null;
};
type OperationRow = NonNullable<HookReview["operation"]> & {
  result_json: string;
};

export class HookRetries {
  readonly hooks: HooksService;
  constructor(readonly context: WorkspaceService) {
    this.hooks = new HooksService(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "This review expired, changed, or lost its original authority. Refresh the delivery and create a new review. Reconcile any existing operation before retrying.",
      409,
    );
  }
  private async row(workspaceId: string, planId: string): Promise<PlanRow> {
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT p.id,p.workspace_id,p.actor_subject,p.input_json,p.fingerprint,p.created_at,p.expires_at,p.applied_at,h.provider_review_json
       FROM action_plans p JOIN hook_reviews h ON h.plan_id=p.id WHERE p.workspace_id=? AND p.id=? AND p.kind=? AND ${guard.sql}`,
      )
      .bind(workspaceId, planId, HOOK_RETRY_KIND, ...guard.values)
      .first<PlanRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Hooks retry review not found or access changed.",
        404,
      );
    return row;
  }
  private reviewed(row: PlanRow): Reviewed {
    return reviewedSchema.parse(JSON.parse(row.input_json));
  }
  private operation(workspaceId: string, planId: string) {
    return this.db
      .prepare(
        "SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?",
      )
      .bind(workspaceId, planId, HOOK_RETRY_KIND)
      .first<OperationRow>();
  }
  async get(input: unknown): Promise<HookReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const row = await this.row(workspaceId, planId);
    const reviewed = this.reviewed(row);
    const operation = await this.operation(workspaceId, planId);
    const result = operation
      ? z
          .object({ receipt: hookReceiptSchema.nullable().optional() })
          .parse(JSON.parse(operation.result_json))
      : null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      connectionId: reviewed.connectionId,
      connectionName: reviewed.connectionName,
      actorMatches:
        row.actor_subject === this.context.principal.subject &&
        reviewed.tokenId === (this.context.principal.tokenId ?? null),
      eventId: reviewed.eventId,
      sinkName: reviewed.sinkName,
      generation: reviewed.generation,
      updatedAt: reviewed.updatedAt,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      provider:
        result?.receipt ??
        (row.provider_review_json
          ? hookReceiptSchema.parse(JSON.parse(row.provider_review_json))
          : null),
      operation: operation
        ? {
            id: operation.id,
            status: operation.status,
            summary: operation.summary,
            updatedAt: operation.updatedAt,
          }
        : null,
    };
  }
  async history(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const guard = hookActorGuard(this.context, workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT o.id,o.kind,o.plan_id AS planId,o.status,o.summary,o.created_at AS createdAt,o.updated_at AS updatedAt
       FROM operations o WHERE o.workspace_id=? AND o.kind IN (?,?) AND ${guard.sql}
       ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
        )
        .bind(
          workspaceId,
          HOOK_RETRY_KIND,
          HOOK_POLICY_KIND,
          ...guard.values,
          HOOK_LIMITS.HISTORY,
        )
        .all<{
          id: string;
          kind: string;
          planId: string;
          status: string;
          summary: string;
          createdAt: string;
          updatedAt: string;
        }>()
    ).results;
  }
  private async provider(reviewed: Reviewed): Promise<HookProvider> {
    const provider = await hookProvider(
      this.context.env,
      reviewed.workspaceId,
      reviewed.providerRef,
    );
    if (provider.identity !== reviewed.providerIdentity) {
      throw new DomainError(
        "hooks_provider_changed",
        "The original Hookrelay provider identity changed. Restore its scoped recovery configuration before reconciling this operation.",
        409,
      );
    }
    return provider;
  }
  private checkReceipt(receipt: HookReceipt, reviewed: Reviewed) {
    if (
      receipt.planId !== reviewed.reviewId ||
      receipt.eventId !== reviewed.eventId ||
      receipt.sinkName !== reviewed.sinkName ||
      receipt.generation !== reviewed.generation ||
      receipt.updatedAt !== reviewed.updatedAt
    )
      throw new HookProviderError("metadata_invalid");
  }
  async plan(input: unknown): Promise<HookReview> {
    const fields = hookRetryPlanInput.parse(input);
    const { workspaceId, connectionId, reviewId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
    );
    const { row: connection, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    if (connection.revision !== fields.connectionRevision) this.conflict();
    const reviewed: Reviewed = {
      ...fields,
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      providerRef: connection.credential_ref,
      providerIdentity: provider.identity,
      providerActor: await hookProviderActor(this.context.principal.subject),
      connectionName: connection.name,
    };
    const serialized = JSON.stringify(reviewed);
    const fingerprint = await credentialHash(serialized);
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
      memberRevision,
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
         SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
           AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND provider='hookrelay')
           AND (SELECT COUNT(*) FROM (SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=?
             AND kind=? AND applied_at IS NULL AND expires_at>? LIMIT ?)) < ?`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          HOOK_RETRY_KIND,
          serialized,
          fingerprint,
          this.timestamp(),
          new Date(this.context.now() + LIMITS.PLAN_TTL_MS).toISOString(),
          ...guard.values,
          workspaceId,
          connectionId,
          connection.revision,
          workspaceId,
          this.context.principal.subject,
          HOOK_RETRY_KIND,
          this.timestamp(),
          HOOK_LIMITS.PENDING_REVIEWS,
          HOOK_LIMITS.PENDING_REVIEWS,
        ),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO hook_reviews (plan_id) SELECT id FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND fingerprint=? AND kind=?",
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          fingerprint,
          HOOK_RETRY_KIND,
        ),
    ]);
    const row = await this.row(workspaceId, reviewId).catch(
      (error: unknown) => {
        if (error instanceof DomainError && error.code === "not_found")
          this.conflict();
        throw error;
      },
    );
    if (
      row.actor_subject !== this.context.principal.subject ||
      row.fingerprint !== fingerprint
    )
      this.conflict();
    if (row.applied_at || row.provider_review_json)
      return this.get({ workspaceId, planId: reviewId });
    if (Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const response = await callHookProvider(
      provider,
      "retry_plan",
      workspaceId,
      reviewed.providerActor,
      {
        planId: reviewId,
        eventId: fields.eventId,
        sinkName: fields.sinkName,
        generation: fields.generation,
        updatedAt: fields.updatedAt,
      },
    );
    this.checkReceipt(response.result, reviewed);
    if (
      !response.capabilities.includes("retry") ||
      response.result.state !== "review"
    )
      this.conflict();
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const saved = await this.db
      .prepare(
        `UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL AND ${guard.sql}
       AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)
       AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND fingerprint=? AND applied_at IS NULL AND julianday(expires_at)>julianday('now'))`,
      )
      .bind(
        JSON.stringify(response.result),
        reviewId,
        ...guard.values,
        workspaceId,
        connectionId,
        connection.revision,
        reviewId,
        fingerprint,
      )
      .run();
    if (
      !saved.meta.changes &&
      !(await this.row(workspaceId, reviewId)).provider_review_json
    )
      this.conflict();
    return this.get({ workspaceId, planId: reviewId });
  }
  private async ready(row: PlanRow, reviewed: Reviewed) {
    if (
      row.actor_subject !== this.context.principal.subject ||
      reviewed.tokenId !== (this.context.principal.tokenId ?? null)
    )
      this.conflict();
    const revision = await authorizeHooks(
      this.context,
      row.workspace_id,
      CAPABILITY.OPERATE,
    );
    if (revision !== reviewed.memberRevision) this.conflict();
    const { row: connection, provider } = await this.hooks.active(
      row.workspace_id,
      reviewed.connectionId,
    );
    if (
      connection.revision !== reviewed.connectionRevision ||
      provider.identity !== reviewed.providerIdentity
    )
      this.conflict();
    return provider;
  }
  private async record(
    workspaceId: string,
    operationId: string,
    status: "succeeded" | "failed" | "indeterminate",
    summary: string,
    receipt: HookReceipt | null,
  ) {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE workspace_id=? AND id=? AND kind=? AND status IN ('pending','running','indeterminate')",
        )
        .bind(
          status,
          summary,
          JSON.stringify({ receipt }),
          this.timestamp(),
          workspaceId,
          operationId,
          HOOK_RETRY_KIND,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
         SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM operations WHERE workspace_id=? AND id=? AND status=?)`,
        )
        .bind(
          operationId + "_" + status,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "hook.retry." + status,
          status === "succeeded"
            ? "Hook retry accepted"
            : status === "failed"
              ? "Hook retry not accepted"
              : "Hook retry needs reconciliation",
          summary,
          this.timestamp(),
          workspaceId,
          operationId,
          status,
        ),
      ...copyActivityContext(
        this.db,
        workspaceId,
        operationId,
        operationId + "_" + status,
      ),
    ]);
  }
  async apply(input: unknown): Promise<HookReview> {
    const { workspaceId, planId, fingerprint } =
      hookRetryApplyInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const reviewed = this.reviewed(row);
    if (
      row.fingerprint !== fingerprint ||
      row.actor_subject !== this.context.principal.subject ||
      reviewed.tokenId !== (this.context.principal.tokenId ?? null)
    )
      this.conflict();
    const existing = await this.operation(workspaceId, planId);
    if (existing) return this.get({ workspaceId, planId });
    const reviewedProvider = await this.ready(row, reviewed);
    if (
      !row.provider_review_json ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      this.conflict();
    const providerReview = hookReceiptSchema.parse(
      JSON.parse(row.provider_review_json),
    );
    this.checkReceipt(providerReview, reviewed);
    if (
      providerReview.state !== "review" ||
      Date.parse(providerReview.expiresAt) <= this.context.now()
    )
      this.conflict();
    const delivery = await callHookProvider(
      reviewedProvider,
      "delivery",
      workspaceId,
      reviewed.providerActor,
      {
        eventId: reviewed.eventId,
        sinkName: reviewed.sinkName,
      },
    );
    if (
      delivery.result.eventId !== reviewed.eventId ||
      delivery.result.sinkName !== reviewed.sinkName ||
      delivery.result.generation !== reviewed.generation ||
      delivery.result.updatedAt !== reviewed.updatedAt ||
      delivery.result.status !== "exhausted"
    )
      this.conflict();
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
      reviewed.memberRevision,
    );
    const operationId = crypto.randomUUID();
    const summary =
      "Retry requested for " +
      reviewed.sinkName +
      ". Provider acceptance has not been confirmed.";
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at)
         SELECT ?,?,?,?,?,'pending',?,?,? WHERE ${guard.sql}
           AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND credential_ref=?)
           AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND fingerprint=?
             AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))`,
        )
        .bind(
          operationId,
          workspaceId,
          planId,
          this.context.principal.subject,
          HOOK_RETRY_KIND,
          summary,
          this.timestamp(),
          this.timestamp(),
          ...guard.values,
          workspaceId,
          reviewed.connectionId,
          reviewed.connectionRevision,
          reviewed.providerRef,
          planId,
          workspaceId,
          this.context.principal.subject,
          fingerprint,
          this.timestamp(),
        ),
      this.db
        .prepare(
          "UPDATE action_plans SET applied_at=? WHERE id=? AND workspace_id=? AND applied_at IS NULL AND EXISTS (SELECT 1 FROM operations WHERE id=? AND plan_id=?)",
        )
        .bind(this.timestamp(), planId, workspaceId, operationId, planId),
      this.db
        .prepare(
          "INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM operations WHERE id=?)",
        )
        .bind(
          operationId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "hook.retry.requested",
          "Hook retry requested",
          summary,
          this.timestamp(),
          operationId,
        ),
      ...captureResourceActivity(
        this.db,
        workspaceId,
        operationId,
        reviewed.connectionId,
        "hook",
        delivery.result.subscription,
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      if (await this.operation(workspaceId, planId))
        return this.get({ workspaceId, planId });
      this.conflict();
    }
    let submitted = false;
    try {
      const provider = await this.ready(row, reviewed);
      const started = await this.db
        .prepare(
          `UPDATE operations SET status='running',updated_at=? WHERE id=? AND workspace_id=? AND status='pending' AND ${guard.sql}
         AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)`,
        )
        .bind(
          this.timestamp(),
          operationId,
          workspaceId,
          ...guard.values,
          workspaceId,
          reviewed.connectionId,
          reviewed.connectionRevision,
        )
        .run();
      if (!started.meta.changes) this.conflict();
      submitted = true;
      const response = await callHookProvider(
        provider,
        "retry_apply",
        workspaceId,
        reviewed.providerActor,
        { planId },
      );
      this.checkReceipt(response.result, reviewed);
      if (response.result.state !== "accepted")
        throw new HookProviderError("metadata_invalid");
      await this.record(
        workspaceId,
        operationId,
        "succeeded",
        "Hookrelay accepted the retry for " +
          reviewed.sinkName +
          ". Queue delivery is a separate outcome.",
        response.result,
      );
    } catch {
      await this.record(
        workspaceId,
        operationId,
        submitted ? "indeterminate" : "failed",
        submitted
          ? "Hookrelay acceptance is uncertain. Reconcile this operation before any new retry."
          : "Access or connection state changed before submission. No provider retry was sent.",
        null,
      );
    }
    return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown): Promise<HookReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const operation = await this.operation(workspaceId, planId);
    if (!operation || ["succeeded", "failed"].includes(operation.status))
      return this.get({ workspaceId, planId });
    const reviewed = this.reviewed(row);
    const provider = await this.provider(reviewed);
    const response = await callHookProvider(
      provider,
      "retry_get",
      workspaceId,
      reviewed.providerActor,
      { planId },
    );
    this.checkReceipt(response.result, reviewed);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    if (response.result.state === "accepted") {
      await this.record(
        workspaceId,
        operation.id,
        "succeeded",
        "Hookrelay's durable receipt confirms acceptance for " +
          reviewed.sinkName +
          ". Queue delivery is a separate outcome.",
        response.result,
      );
    } else if (response.result.state === "expired") {
      await this.record(
        workspaceId,
        operation.id,
        "failed",
        "Hookrelay confirms this review expired without acceptance. Inspect the delivery before preparing another retry.",
        response.result,
      );
    } else {
      await this.record(
        workspaceId,
        operation.id,
        "indeterminate",
        "Hookrelay has not confirmed acceptance. The review is still open and a request may be in flight; reconcile again after it expires.",
        response.result,
      );
    }
    return this.get({ workspaceId, planId });
  }
}
