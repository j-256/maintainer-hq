import { z } from "zod";
import { CAPABILITY, LIMITS } from "../shared/domain";
import {
  HOOK_LIMITS,
  hookRetryInput,
  hookRetryApplyInput,
} from "../shared/hooks";
import {
  HOOK_SETUP_KIND,
  hookSetupConnectionInput,
  hookSetupPlanInput,
  hookSetupReceiptSchema,
  hookSetupStatusInput,
  type HookSetupReceipt,
  type HookSetupReview,
} from "../shared/hook-setup";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  callHookProvider,
  hookProvider,
  hookProviderActor,
  HookProviderError,
} from "./hook-client";
import { HooksService } from "./hooks";
import { ResourceLinksService } from "./resource-links";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

const reviewedSchema = hookSetupPlanInput
  .extend({
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    repositoryName: z.string(),
    projectId: z.string(),
    providerRef: z.string(),
    providerIdentity: z.string(),
    providerActor: z.string(),
    connectionName: z.string(),
  })
  .strict();
type Reviewed = z.infer<typeof reviewedSchema>;
type Row = {
  id: string;
  actor_subject: string;
  fingerprint: string;
  input_json: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  provider_review_json: string | null;
};
type Operation = NonNullable<HookSetupReview["operation"]> & {
  result_json: string;
};

export class HookSetup {
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
      "Setup changed or the review expired. Keep your draft and review again; reconcile an existing operation before another attempt.",
      409,
    );
  }
  async configuration(input: unknown) {
    const { workspaceId, connectionId } = hookSetupConnectionInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    let result;
    try {
      const response = await callHookProvider(
        provider,
        "github_setup_configuration",
        workspaceId,
        await hookProviderActor(this.context.principal.subject),
      );
      result = { status: "supported" as const, configuration: response.result };
    } catch (error) {
      if (
        !(error instanceof HookProviderError) ||
        error.providerCode !== "validation"
      )
        throw error;
      result = { status: "unsupported" as const, configuration: null };
    }
    await this.hooks.unchanged(workspaceId, row);
    await authorizeHooks(this.context, workspaceId);
    return result;
  }
  async status(input: unknown) {
    const { workspaceId, connectionId, resourceId } =
      hookSetupStatusInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    const response = await callHookProvider(
      provider,
      "github_setup_status",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      { resourceId },
    );
    if (response.result.resourceId !== resourceId)
      throw new HookProviderError("metadata_invalid");
    await this.hooks.unchanged(workspaceId, row);
    await authorizeHooks(this.context, workspaceId);
    return response.result;
  }
  async row(workspaceId: string, planId: string) {
    const row = await this.db
      .prepare(
        `SELECT p.*,h.provider_review_json FROM action_plans p JOIN hook_reviews h ON h.plan_id=p.id
      WHERE p.id=? AND p.workspace_id=? AND p.kind=?`,
      )
      .bind(planId, workspaceId, HOOK_SETUP_KIND)
      .first<Row>();
    if (!row)
      throw new DomainError("not_found", "Hook setup review not found.", 404);
    return row;
  }
  operation(workspaceId: string, planId: string) {
    return this.db
      .prepare(
        "SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?",
      )
      .bind(workspaceId, planId, HOOK_SETUP_KIND)
      .first<Operation>();
  }
  async get(input: unknown): Promise<HookSetupReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const row = await this.row(workspaceId, planId);
    const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const operation = await this.operation(workspaceId, planId);
    const receipt = operation
      ? z
          .object({ receipt: hookSetupReceiptSchema.nullable().optional() })
          .parse(JSON.parse(operation.result_json)).receipt
      : null;
    const provider =
      receipt ??
      (row.provider_review_json
        ? hookSetupReceiptSchema.parse(JSON.parse(row.provider_review_json))
        : null);
    const linked = provider?.routingConfigured
      ? Boolean(
          await this.db
            .prepare(
              `SELECT repository_id FROM repository_resource_links
      WHERE workspace_id=? AND repository_id=? AND connection_id=? AND kind='hook' AND resource_key=?`,
            )
            .bind(
              workspaceId,
              reviewed.repositoryId,
              reviewed.connectionId,
              provider.name,
            )
            .first(),
        )
      : false;
    await authorizeHooks(this.context, workspaceId);
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      connectionId: reviewed.connectionId,
      connectionName: reviewed.connectionName,
      repositoryId: reviewed.repositoryId,
      repositoryName: reviewed.repositoryName,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actorMatches:
        row.actor_subject === this.context.principal.subject &&
        reviewed.tokenId === (this.context.principal.tokenId ?? null),
      linked,
      provider,
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
  async provider(reviewed: Reviewed) {
    const provider = await hookProvider(
      this.context.env,
      reviewed.workspaceId,
      reviewed.providerRef,
    );
    if (provider.identity !== reviewed.providerIdentity) this.conflict();
    return provider;
  }
  async ready(reviewed: Reviewed) {
    const memberRevision = await authorizeHooks(
      this.context,
      reviewed.workspaceId,
      CAPABILITY.OPERATE,
    );
    await authorizeHooks(this.context, reviewed.workspaceId, CAPABILITY.EDIT);
    if (memberRevision !== reviewed.memberRevision) this.conflict();
    const repository = await this.db
      .prepare(
        "SELECT full_name AS fullName,revision,project_id AS projectId FROM repositories WHERE workspace_id=? AND id=?",
      )
      .bind(reviewed.workspaceId, reviewed.repositoryId)
      .first<{ fullName: string; revision: number; projectId: string }>();
    if (
      !repository ||
      repository.revision !== reviewed.repositoryRevision ||
      repository.fullName !== reviewed.repositoryName ||
      repository.projectId !== reviewed.projectId
    )
      this.conflict();
    const { row, provider } = await this.hooks.active(
      reviewed.workspaceId,
      reviewed.connectionId,
    );
    if (
      row.revision !== reviewed.connectionRevision ||
      provider.identity !== reviewed.providerIdentity
    )
      this.conflict();
    return provider;
  }
  checkReceipt(
    receipt: HookSetupReceipt,
    reviewed: Reviewed,
    baseline?: HookSetupReceipt,
  ) {
    if (
      receipt.planId !== reviewed.reviewId ||
      receipt.name !== reviewed.name ||
      receipt.repository !== reviewed.repositoryName ||
      receipt.action !== (reviewed.resourceId ? "install" : "create") ||
      (reviewed.resourceId && receipt.resourceId !== reviewed.resourceId) ||
      JSON.stringify(receipt.events) !== JSON.stringify(reviewed.events) ||
      JSON.stringify(receipt.sinks) !== JSON.stringify(reviewed.sinks) ||
      (baseline &&
        (baseline.resourceId !== receipt.resourceId ||
          baseline.expiresAt !== receipt.expiresAt ||
          baseline.createdAt !== receipt.createdAt))
    ) {
      throw new HookProviderError("metadata_invalid");
    }
  }
  async plan(input: unknown) {
    const fields = hookSetupPlanInput.parse(input);
    const { workspaceId, connectionId, reviewId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
    );
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const repository = await this.db
      .prepare(
        "SELECT full_name AS fullName,revision,project_id AS projectId FROM repositories WHERE workspace_id=? AND id=?",
      )
      .bind(workspaceId, fields.repositoryId)
      .first<{ fullName: string; revision: number; projectId: string }>();
    if (!repository || repository.revision !== fields.repositoryRevision)
      this.conflict();
    const { row: connection, provider } = await this.hooks.active(
      workspaceId,
      connectionId,
    );
    if (connection.revision !== fields.connectionRevision) this.conflict();
    const reviewed: Reviewed = {
      ...fields,
      memberRevision,
      repositoryName: repository.fullName,
      projectId: repository.projectId,
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
          `INSERT OR IGNORE INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
          AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          HOOK_SETUP_KIND,
          serialized,
          fingerprint,
          this.timestamp(),
          new Date(this.context.now() + LIMITS.PLAN_TTL_MS).toISOString(),
          ...guard.values,
          workspaceId,
          this.context.principal.subject,
          HOOK_SETUP_KIND,
          this.timestamp(),
          HOOK_LIMITS.PENDING_REVIEWS,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO hook_reviews(plan_id) SELECT id FROM action_plans WHERE id=? AND workspace_id=? AND fingerprint=? AND kind=?`,
        )
        .bind(reviewId, workspaceId, fingerprint, HOOK_SETUP_KIND),
    ]);
    const row = await this.row(workspaceId, reviewId);
    if (
      row.fingerprint !== fingerprint ||
      row.actor_subject !== this.context.principal.subject
    )
      this.conflict();
    if (row.provider_review_json || row.applied_at)
      return this.get({ workspaceId, planId: reviewId });
    if (Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const response = await callHookProvider(
      await this.ready(reviewed),
      "github_setup_plan",
      workspaceId,
      reviewed.providerActor,
      {
        planId: reviewId,
        authorityId: fields.authorityId,
        revision: fields.revision,
        resourceId: fields.resourceId,
        name: fields.name,
        repository: repository.fullName,
        events: fields.events,
        sinks: fields.sinks,
      },
    );
    this.checkReceipt(response.result, reviewed);
    if (response.result.status !== "ready") this.conflict();
    await this.ready(reviewed);
    await this.db
      .prepare(
        `UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL AND ${guard.sql}`,
      )
      .bind(JSON.stringify(response.result), reviewId, ...guard.values)
      .run();
    return this.get({ workspaceId, planId: reviewId });
  }
  async link(reviewed: Reviewed, receipt: HookSetupReceipt) {
    if (!receipt.routingConfigured) return;
    const provider = await this.ready(reviewed);
    const detail = await callHookProvider(
      provider,
      "configuration_subscription",
      reviewed.workspaceId,
      reviewed.providerActor,
      { resourceId: receipt.resourceId },
    );
    if (
      detail.result.resourceId !== receipt.resourceId ||
      detail.result.name !== receipt.name
    )
      throw new HookProviderError("metadata_invalid");
    if (receipt.action === "create") {
      const association = await this.hooks.association({
        workspaceId: reviewed.workspaceId,
        connectionId: reviewed.connectionId,
        subscription: receipt.name,
      });
      if (!association.projectId)
        await this.hooks.associate({
          workspaceId: reviewed.workspaceId,
          connectionId: reviewed.connectionId,
          subscription: receipt.name,
          revision: association.revision,
          projectId: reviewed.projectId,
        });
    }
    const links = new ResourceLinksService(this.context);
    const current = await links.get({
      workspaceId: reviewed.workspaceId,
      connectionId: reviewed.connectionId,
      kind: "hook",
      resourceKey: receipt.name,
    });
    if (current.repositoryIds.includes(reviewed.repositoryId)) return;
    await links.save({
      workspaceId: reviewed.workspaceId,
      connectionId: reviewed.connectionId,
      kind: "hook",
      resourceKey: receipt.name,
      revision: current.revision,
      connectionRevision: reviewed.connectionRevision,
      repositoryIds: [...current.repositoryIds, reviewed.repositoryId],
    });
  }
  async record(
    reviewed: Reviewed,
    operationId: string,
    receipt: HookSetupReceipt | null,
    submitted = true,
  ) {
    const complete = receipt?.webhookInstalled === true;
    const linked = Boolean(
      receipt?.routingConfigured &&
        (await this.db
          .prepare(
            `SELECT repository_id FROM repository_resource_links
      WHERE workspace_id=? AND repository_id=? AND connection_id=? AND kind='hook' AND resource_key=?`,
          )
          .bind(
            reviewed.workspaceId,
            reviewed.repositoryId,
            reviewed.connectionId,
            receipt.name,
          )
          .first()),
    );
    const rejected =
      receipt && ["rejected", "expired", "conflict"].includes(receipt.status);
    const status = complete
      ? linked
        ? "succeeded"
        : "partial"
      : receipt?.status === "configured" ||
          (rejected && receipt.routingConfigured)
        ? "partial"
        : rejected || !submitted
          ? "failed"
          : "indeterminate";
    const summary = complete
      ? linked
        ? "Hook routing and GitHub installation confirmed. Notification delivery requires separate evidence."
        : "Hook routing and GitHub installation confirmed; the repository link is pending. Link the subscription from the expectation editor."
      : receipt?.routingConfigured
        ? "Routing configured; GitHub installation is incomplete. Inspect the saved setup before another attempt."
        : submitted
          ? "Hook setup has no confirmed completion. Reconcile the saved operation before another attempt."
          : "Authority changed before provider submission.";
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE id=? AND workspace_id=? AND kind=?",
        )
        .bind(
          status,
          summary,
          JSON.stringify({ receipt }),
          this.timestamp(),
          operationId,
          reviewed.workspaceId,
          HOOK_SETUP_KIND,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM operations WHERE id=? AND workspace_id=? AND kind=?)`,
        )
        .bind(
          operationId + "_" + status,
          reviewed.workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "hook.setup." + status,
          "Hook setup " + status,
          summary,
          this.timestamp(),
          operationId,
          reviewed.workspaceId,
          HOOK_SETUP_KIND,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT ?,?,id FROM repositories WHERE workspace_id=? AND id=? AND project_id=?`,
        )
        .bind(
          reviewed.workspaceId,
          operationId + "_" + status,
          reviewed.workspaceId,
          reviewed.repositoryId,
          reviewed.projectId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
        SELECT ?,?,id FROM projects WHERE workspace_id=? AND id=?`,
        )
        .bind(
          reviewed.workspaceId,
          operationId + "_" + status,
          reviewed.workspaceId,
          reviewed.projectId,
        ),
    ]);
  }
  async apply(input: unknown) {
    const started = Date.now();
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
    await this.ready(reviewed);
    if (
      !row.provider_review_json ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      this.conflict();
    const baseline = hookSetupReceiptSchema.parse(
      JSON.parse(row.provider_review_json),
    );
    this.checkReceipt(baseline, reviewed);
    if (
      baseline.status !== "ready" ||
      Date.parse(baseline.expiresAt) <= this.context.now()
    )
      this.conflict();
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
      reviewed.memberRevision,
    );
    const operationId = crypto.randomUUID();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at)
        SELECT ?,?,?,?,?,'pending','Hook setup requested',?,? WHERE ${guard.sql}
          AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)
          AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=? AND revision=? AND project_id=?)
          AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND fingerprint=? AND applied_at IS NULL AND julianday(expires_at)>julianday('now'))`,
        )
        .bind(
          operationId,
          workspaceId,
          planId,
          this.context.principal.subject,
          HOOK_SETUP_KIND,
          this.timestamp(),
          this.timestamp(),
          ...guard.values,
          workspaceId,
          reviewed.connectionId,
          reviewed.connectionRevision,
          workspaceId,
          reviewed.repositoryId,
          reviewed.repositoryRevision,
          reviewed.projectId,
          planId,
          fingerprint,
        ),
      this.db
        .prepare(
          "UPDATE action_plans SET applied_at=? WHERE id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND plan_id=?)",
        )
        .bind(this.timestamp(), planId, operationId, planId),
    ]);
    if (!saved[0]!.meta.changes) {
      if (await this.operation(workspaceId, planId))
        return this.get({ workspaceId, planId });
      this.conflict();
    }
    let submitted = false;
    let receipt: HookSetupReceipt | null = null;
    try {
      const provider = await this.ready(reviewed);
      submitted = true;
      const response = await callHookProvider(
        provider,
        "github_setup_apply",
        workspaceId,
        reviewed.providerActor,
        { planId },
      );
      this.checkReceipt(response.result, reviewed, baseline);
      receipt = response.result;
    } catch {
      /* The operation remains recoverable under its original provider identity */
    }
    if (receipt?.routingConfigured) {
      try {
        await this.link(reviewed, receipt);
      } catch {
        /* Linking remains a visible separate incomplete step */
      }
    }
    await this.record(reviewed, operationId, receipt, submitted);
    const result = await this.get({ workspaceId, planId });
    this.diagnostic("apply", workspaceId, result, started);
    return result;
  }
  async reconcile(input: unknown) {
    const started = Date.now();
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const operation = await this.operation(workspaceId, planId);
    const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const response = await callHookProvider(
      await this.provider(reviewed),
      "github_setup_get",
      workspaceId,
      reviewed.providerActor,
      { planId },
    );
    this.checkReceipt(
      response.result,
      reviewed,
      row.provider_review_json
        ? hookSetupReceiptSchema.parse(JSON.parse(row.provider_review_json))
        : undefined,
    );
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    if (!operation) {
      await this.db
        .prepare(
          "UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL",
        )
        .bind(JSON.stringify(response.result), planId)
        .run();
      return this.get({ workspaceId, planId });
    }
    if (response.result.routingConfigured) {
      try {
        await this.link(reviewed, response.result);
      } catch {
        /* The receipt stays available if association authority changed */
      }
    }
    await this.record(reviewed, operation.id, response.result);
    const result = await this.get({ workspaceId, planId });
    this.diagnostic("reconcile", workspaceId, result, started);
    return result;
  }
  diagnostic(
    action: "apply" | "reconcile",
    workspaceId: string,
    result: HookSetupReview,
    started: number,
  ) {
    if (!result.operation) return;
    emitDiagnostic({
      event: "hq.hooks.setup",
      action,
      reference: result.operation.id,
      workspaceId,
      repositoryId: result.repositoryId,
      state: result.provider?.status ?? "unavailable",
      linked: result.linked,
      reason: result.provider?.errorCode ?? null,
      elapsedMs: Date.now() - started,
    });
  }
}
