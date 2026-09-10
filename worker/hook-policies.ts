import { z } from "zod";
import { CAPABILITY, LIMITS } from "../shared/domain";
import {
  HOOK_LIMITS,
  HOOK_POLICY_KIND,
  hookConnectionInput,
  hookPolicyDetailInput,
  hookPolicyPageInput,
  hookPolicyPlanInput,
  hookPolicyReceiptSchema,
  hookRetryApplyInput,
  hookRetryInput,
  type HookConfigurationAvailability,
  type HookPolicyReceipt,
  type HookPolicyReview,
} from "../shared/hooks";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  callHookProvider,
  hookProvider,
  hookProviderActor,
  HookProviderError,
} from "./hook-client";
import { HooksService } from "./hooks";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";
import {
  captureResourceActivity,
  copyActivityContext,
  ResourceLinksService,
} from "./resource-links";

const reviewedSchema = hookPolicyPlanInput
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
type OperationRow = NonNullable<HookPolicyReview["operation"]> & {
  result_json: string;
};
const REJECTED_POLICY_CODES = new Set([
  "unauthorized",
  "forbidden",
  "validation",
  "inactive",
  "conflict",
  "expired",
  "review_unavailable",
]);
const samePolicy = (first: unknown, second: unknown): boolean => {
  const canonical = (value: unknown): string =>
    value === null || typeof value !== "object"
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : `{${Object.keys(value)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
  return canonical(first) === canonical(second);
};

export class HookPolicies {
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
      "This routing review expired, changed, or lost its original authority. Keep your draft, refresh the policy and review again. Reconcile an existing operation before another change.",
      409,
    );
  }
  async configuration(input: unknown): Promise<HookConfigurationAvailability> {
    const { workspaceId, connectionId } = hookConnectionInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    let result: HookConfigurationAvailability;
    try {
      const response = await callHookProvider(
        provider,
        "configuration",
        workspaceId,
        await hookProviderActor(this.context.principal.subject),
      );
      result = { status: "supported", configuration: response.result };
    } catch (error) {
      if (
        !(error instanceof HookProviderError) ||
        error.providerCode !== "validation"
      )
        throw error;
      result = { status: "unsupported", configuration: null };
    }
    await authorizeHooks(this.context, workspaceId);
    await this.hooks.unchanged(workspaceId, row);
    return result;
  }
  async detail(input: unknown) {
    const { workspaceId, connectionId, resourceId } =
      hookPolicyDetailInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    const response = await callHookProvider(
      provider,
      "configuration_subscription",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      { resourceId },
    );
    if (
      response.result.resourceId !== resourceId ||
      response.result.mode !== "active"
    )
      throw new HookProviderError("metadata_invalid");
    await authorizeHooks(this.context, workspaceId);
    await this.hooks.unchanged(workspaceId, row);
    return response;
  }
  async page(input: unknown, kind: "subscriptions" | "sinks") {
    const { workspaceId, connectionId, authorityId, revision, cursor } =
      hookPolicyPageInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    const response = await callHookProvider(
      provider,
      kind === "subscriptions"
        ? "configuration_subscriptions"
        : "configuration_sinks",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      { revision, cursor },
    );
    if (
      response.result.authorityId !== authorityId ||
      response.result.revision !== revision ||
      response.result.mode !== "active"
    )
      this.conflict();
    await authorizeHooks(this.context, workspaceId);
    await this.hooks.unchanged(workspaceId, row);
    const names = response.result.items.map((item) => item.name);
    const associations =
      kind === "subscriptions"
        ? (
            await this.db
              .prepare(
                "SELECT subscription,project_id AS projectId,revision FROM hook_associations WHERE workspace_id=? AND connection_id=? AND subscription IN (SELECT value FROM json_each(?))",
              )
              .bind(workspaceId, connectionId, JSON.stringify(names))
              .all<{
                subscription: string;
                projectId: string | null;
                revision: number;
              }>()
          ).results
        : [];
    const repositoryLinks =
      kind === "subscriptions"
        ? await new ResourceLinksService(this.context).forResources(
            workspaceId,
            "hook",
            connectionId,
            names,
          )
        : [];
    await authorizeHooks(this.context, workspaceId);
    await this.hooks.unchanged(workspaceId, row);
    return { ...response, associations, repositoryLinks };
  }
  private async row(workspaceId: string, planId: string): Promise<PlanRow> {
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT p.id,p.workspace_id,p.actor_subject,p.input_json,p.fingerprint,p.created_at,p.expires_at,p.applied_at,h.provider_review_json
      FROM action_plans p JOIN hook_reviews h ON h.plan_id=p.id WHERE p.workspace_id=? AND p.id=? AND p.kind=? AND ${guard.sql}`,
      )
      .bind(workspaceId, planId, HOOK_POLICY_KIND, ...guard.values)
      .first<PlanRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Routing review not found or access changed.",
        404,
      );
    return row;
  }
  private operation(workspaceId: string, planId: string) {
    return this.db
      .prepare(
        "SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?",
      )
      .bind(workspaceId, planId, HOOK_POLICY_KIND)
      .first<OperationRow>();
  }
  async get(input: unknown): Promise<HookPolicyReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const row = await this.row(workspaceId, planId);
    const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const operation = await this.operation(workspaceId, planId);
    const result = operation
      ? z
          .object({ receipt: hookPolicyReceiptSchema.nullable().optional() })
          .parse(JSON.parse(operation.result_json))
      : null;
    await authorizeHooks(this.context, workspaceId);
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      connectionId: reviewed.connectionId,
      connectionName: reviewed.connectionName,
      resourceId: reviewed.resourceId,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actorMatches:
        row.actor_subject === this.context.principal.subject &&
        reviewed.tokenId === (this.context.principal.tokenId ?? null),
      provider:
        result?.receipt ??
        (row.provider_review_json
          ? hookPolicyReceiptSchema.parse(JSON.parse(row.provider_review_json))
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
  private checkReceipt(
    receipt: HookPolicyReceipt,
    reviewed: Reviewed,
    baseline?: HookPolicyReceipt,
  ) {
    if (
      receipt.planId !== reviewed.reviewId ||
      receipt.resourceId !== reviewed.resourceId ||
      receipt.authorityId !== reviewed.authorityId ||
      receipt.revision !== reviewed.revision ||
      !samePolicy(receipt.after, reviewed.policy) ||
      (baseline &&
        (!samePolicy(receipt.before, baseline.before) ||
          receipt.resourceName !== baseline.resourceName ||
          receipt.createdAt !== baseline.createdAt ||
          receipt.expiresAt !== baseline.expiresAt))
    ) {
      throw new HookProviderError("metadata_invalid");
    }
  }
  private async provider(reviewed: Reviewed) {
    const provider = await hookProvider(
      this.context.env,
      reviewed.workspaceId,
      reviewed.providerRef,
    );
    if (provider.identity !== reviewed.providerIdentity)
      throw new DomainError(
        "hooks_provider_changed",
        "The original Hookrelay provider identity changed. Restore its scoped recovery configuration before reconciling this operation.",
        409,
      );
    return provider;
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
    const { row: connection, provider } = await this.hooks.active(
      row.workspace_id,
      reviewed.connectionId,
    );
    if (
      revision !== reviewed.memberRevision ||
      connection.revision !== reviewed.connectionRevision ||
      provider.identity !== reviewed.providerIdentity
    )
      this.conflict();
    return provider;
  }
  async plan(input: unknown): Promise<HookPolicyReview> {
    const fields = hookPolicyPlanInput.parse(input);
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
        AND (SELECT COUNT(*) FROM (SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=?
          AND applied_at IS NULL AND expires_at>? LIMIT ?)) < ?`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          HOOK_POLICY_KIND,
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
          HOOK_POLICY_KIND,
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
          HOOK_POLICY_KIND,
        ),
    ]);
    const row = await this.row(workspaceId, reviewId);
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
      "configuration_policy_plan",
      workspaceId,
      reviewed.providerActor,
      {
        planId: reviewId,
        authorityId: fields.authorityId,
        revision: fields.revision,
        resourceId: fields.resourceId,
        policy: fields.policy,
      },
    );
    this.checkReceipt(response.result, reviewed);
    if (response.result.status !== "ready") this.conflict();
    await this.ready(row, reviewed);
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
  private async record(
    workspaceId: string,
    operationId: string,
    status: "succeeded" | "failed" | "indeterminate",
    summary: string,
    receipt: HookPolicyReceipt | null,
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
          HOOK_POLICY_KIND,
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
          "hook.policy." + status,
          status === "succeeded"
            ? "Hook routing changed"
            : status === "failed"
              ? "Hook routing not changed"
              : "Hook routing needs reconciliation",
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
  async apply(input: unknown): Promise<HookPolicyReview> {
    const { workspaceId, planId, fingerprint } =
      hookRetryApplyInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    if (
      row.fingerprint !== fingerprint ||
      row.actor_subject !== this.context.principal.subject ||
      reviewed.tokenId !== (this.context.principal.tokenId ?? null)
    )
      this.conflict();
    if (await this.operation(workspaceId, planId))
      return this.get({ workspaceId, planId });
    const provider = await this.ready(row, reviewed);
    if (
      !row.provider_review_json ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      this.conflict();
    const baseline = hookPolicyReceiptSchema.parse(
      JSON.parse(row.provider_review_json),
    );
    this.checkReceipt(baseline, reviewed);
    if (
      baseline.status !== "ready" ||
      Date.parse(baseline.expiresAt) <= this.context.now()
    )
      this.conflict();
    const detail = await callHookProvider(
      provider,
      "configuration_subscription",
      workspaceId,
      reviewed.providerActor,
      { resourceId: reviewed.resourceId },
    );
    if (
      detail.result.resourceId !== reviewed.resourceId ||
      detail.result.authorityId !== reviewed.authorityId ||
      detail.result.revision !== reviewed.revision ||
      detail.result.mode !== "active" ||
      detail.result.name !== baseline.resourceName ||
      !samePolicy(detail.result.policy, baseline.before)
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
      "Routing change requested for " +
      baseline.resourceName +
      ". Provider acceptance is not yet confirmed.";
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
          HOOK_POLICY_KIND,
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
          "hook.policy.requested",
          "Hook routing change requested",
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
        baseline.resourceName,
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      if (await this.operation(workspaceId, planId))
        return this.get({ workspaceId, planId });
      this.conflict();
    }
    let submitted = false;
    try {
      const live = await this.ready(row, reviewed);
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
        live,
        "configuration_policy_apply",
        workspaceId,
        reviewed.providerActor,
        { planId },
      );
      this.checkReceipt(response.result, reviewed, baseline);
      if (response.result.status !== "accepted")
        throw new HookProviderError("metadata_invalid");
      await this.record(
        workspaceId,
        operationId,
        "succeeded",
        "Hookrelay accepted routing revision " +
          response.result.receipt!.revision +
          " for " +
          baseline.resourceName +
          ". This changes future ingress, not queued deliveries or the upstream webhook.",
        response.result,
      );
    } catch (error) {
      const rejected =
        submitted &&
        error instanceof HookProviderError &&
        REJECTED_POLICY_CODES.has(error.providerCode);
      await this.record(
        workspaceId,
        operationId,
        submitted && !rejected ? "indeterminate" : "failed",
        rejected
          ? "Hookrelay rejected this routing change. Refresh its policy and permissions before reviewing again."
          : submitted
            ? "Hookrelay acceptance is uncertain. Reconcile this operation before another routing change."
            : "Authority changed before submission. No provider routing change was sent.",
        null,
      );
    }
    return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown): Promise<HookPolicyReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const operation = await this.operation(workspaceId, planId);
    if (!operation || ["succeeded", "failed"].includes(operation.status))
      return this.get({ workspaceId, planId });
    const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const baseline = hookPolicyReceiptSchema.parse(
      JSON.parse(row.provider_review_json!),
    );
    const response = await callHookProvider(
      await this.provider(reviewed),
      "configuration_policy_get",
      workspaceId,
      reviewed.providerActor,
      { planId },
    );
    this.checkReceipt(response.result, reviewed, baseline);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    if (response.result.status === "accepted") {
      await this.record(
        workspaceId,
        operation.id,
        "succeeded",
        "Hookrelay's receipt confirms routing revision " +
          response.result.receipt!.revision +
          " for " +
          baseline.resourceName +
          ". Notification delivery is a separate outcome.",
        response.result,
      );
    } else if (["expired", "conflict"].includes(response.result.status)) {
      await this.record(
        workspaceId,
        operation.id,
        "failed",
        "Hookrelay confirms this review can no longer be accepted. Refresh the policy before another change.",
        response.result,
      );
    } else {
      await this.record(
        workspaceId,
        operation.id,
        "indeterminate",
        "This review is still open and a request may be in flight. Reconcile again after it expires.",
        response.result,
      );
    }
    return this.get({ workspaceId, planId });
  }
}
