import { z } from "zod";
import { CAPABILITY, LIMITS, workspaceInput } from "../shared/domain";
import {
  MONITOR_DEFAULTS,
  MONITOR_LIMITS,
  MONITOR_OPERATION_KIND,
  monitorApplyInput,
  monitorConfigurationPlanInput,
  monitorConfigurationSchema,
  monitorDefaultsSchema,
  monitorReceiptSchema,
  monitorReviewInput,
  monitorTargetSchema,
  monitorTriagePlanInput,
  type JsonValue,
  type MonitorConfiguration,
  type MonitorReceipt,
  type MonitorReview,
} from "../shared/monitoring";
import {
  authorizeHooks as authorizeOperator,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  callMonitorProvider,
  monitorActor,
  monitorProvider,
  MonitorProviderError,
} from "./monitoring-client";
import { MonitoringService } from "./monitoring";
import { credentialHash } from "./credential-hash";
import { captureResourceActivity, copyActivityContext } from "./resource-links";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

const requestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("configuration"),
      input: monitorConfigurationPlanInput,
    })
    .strict(),
  z
    .object({ kind: z.literal("triage"), input: monitorTriagePlanInput })
    .strict(),
]);
const reviewedSchema = z
  .object({
    request: requestSchema,
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    providerRef: z.string(),
    providerIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    providerActor: z.string(),
    connectionName: z.string(),
    targetId: z.string().nullable(),
    candidateFingerprint: z.string().nullable(),
    before: z.union([monitorTargetSchema, monitorDefaultsSchema]).nullable(),
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
type OperationRow = NonNullable<MonitorReview["operation"]> & {
  result_json: string;
};

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key]!)]),
    );
  return value;
}
export function canonicalMonitorConfiguration(
  value: MonitorConfiguration,
): MonitorConfiguration {
  const result = monitorConfigurationSchema.parse(value);
  for (const target of result.targets) {
    target.url = new URL(target.url).toString();
    if (target.expectedStatuses) target.expectedStatuses.sort((a, b) => a - b);
    if (target.expect?.location)
      target.expect.location.url = new URL(
        target.expect.location.url,
      ).toString();
    if (target.expect?.jsonSubset)
      target.expect.jsonSubset = sortJson(target.expect.jsonSubset) as Record<
        string,
        JsonValue
      >;
  }
  return result;
}

export class MonitoringOperations {
  readonly monitoring: MonitoringService;
  constructor(readonly context: WorkspaceService) {
    this.monitoring = new MonitoringService(context);
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
      "This review changed, expired, or lost its original authority. Keep your draft and reload provider state. Reconcile any uncertain operation before another change.",
      409,
    );
  }
  private async row(workspaceId: string, planId: string): Promise<PlanRow> {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT p.id,p.workspace_id,p.actor_subject,p.input_json,p.fingerprint,p.created_at,p.expires_at,p.applied_at,m.provider_review_json
      FROM action_plans p JOIN monitoring_reviews m ON m.plan_id=p.id WHERE p.workspace_id=? AND p.id=? AND p.kind=? AND ${guard.sql}`,
      )
      .bind(workspaceId, planId, MONITOR_OPERATION_KIND, ...guard.values)
      .first<PlanRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Monitoring review not found or access changed.",
        404,
      );
    return row;
  }
  private reviewed(row: PlanRow) {
    return reviewedSchema.parse(JSON.parse(row.input_json));
  }
  private operation(workspaceId: string, planId: string) {
    return this.db
      .prepare(
        "SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?",
      )
      .bind(workspaceId, planId, MONITOR_OPERATION_KIND)
      .first<OperationRow>();
  }
  async get(input: unknown): Promise<MonitorReview> {
    const { workspaceId, planId } = monitorReviewInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const row = await this.row(workspaceId, planId);
    const reviewed = this.reviewed(row);
    const operation = await this.operation(workspaceId, planId);
    const result = operation
      ? z
          .object({ receipt: monitorReceiptSchema.nullable().optional() })
          .parse(JSON.parse(operation.result_json))
      : null;
    const receipt =
      result?.receipt ??
      (row.provider_review_json
        ? monitorReceiptSchema.parse(JSON.parse(row.provider_review_json))
        : null);
    await authorizeOperator(this.context, workspaceId);
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      connectionId: reviewed.request.input.connectionId,
      connectionName: reviewed.connectionName,
      actorMatches:
        row.actor_subject === this.context.principal.subject &&
        reviewed.tokenId === (this.context.principal.tokenId ?? null),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      change:
        reviewed.request.kind === "configuration"
          ? reviewed.request.input.change
          : null,
      before: reviewed.before,
      provider: receipt
        ? {
            id: receipt.id,
            kind: receipt.kind,
            status: receipt.status,
            preview: receipt.preview,
            result: receipt.result,
            expiresAt: receipt.expiresAt,
            appliedAt: receipt.appliedAt,
          }
        : null,
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
    await authorizeOperator(this.context, workspaceId);
    const guard = actorGuard(this.context, workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT id,plan_id AS planId,status,summary,created_at AS createdAt,updated_at AS updatedAt
      FROM operations WHERE workspace_id=? AND kind=? AND ${guard.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .bind(
          workspaceId,
          MONITOR_OPERATION_KIND,
          ...guard.values,
          MONITOR_LIMITS.HISTORY,
        )
        .all<{
          id: string;
          planId: string;
          status: string;
          summary: string;
          createdAt: string;
          updatedAt: string;
        }>()
    ).results;
  }
  private async provider(reviewed: Reviewed) {
    const provider = await monitorProvider(
      this.context.env,
      reviewed.request.input.workspaceId,
      reviewed.providerRef,
    );
    if (provider.identity !== reviewed.providerIdentity)
      throw new DomainError(
        "monitoring_provider_changed",
        "The original provider identity changed. Restore its scoped recovery credential and binding before reconciling this operation.",
        409,
      );
    return provider;
  }
  private checkReceipt(
    receipt: MonitorReceipt,
    reviewed: Reviewed,
    original: MonitorReceipt | null = null,
  ) {
    const request = reviewed.request;
    if (
      receipt.workspaceId !== request.input.workspaceId ||
      receipt.actorId !== reviewed.providerActor ||
      receipt.kind !== request.kind ||
      (original &&
        (receipt.id !== original.id ||
          receipt.createdAt !== original.createdAt ||
          receipt.expiresAt !== original.expiresAt ||
          receipt.credentialId !== original.credentialId ||
          receipt.credentialRevision !== original.credentialRevision ||
          JSON.stringify(receipt.preview) !== JSON.stringify(original.preview)))
    )
      throw new MonitorProviderError("metadata_invalid");
    if (request.kind === "configuration" && receipt.kind === "configuration") {
      if (
        receipt.preview.expectedFingerprint !== reviewed.candidateFingerprint ||
        receipt.preview.expectedRevision !==
          request.input.configurationRevision ||
        (receipt.result &&
          (receipt.result.configFingerprint !==
            receipt.preview.expectedFingerprint ||
            receipt.result.revision !== receipt.preview.resultingRevision ||
            receipt.result.targetCount !== receipt.preview.targetCount))
      )
        throw new MonitorProviderError("metadata_invalid");
    } else if (request.kind === "triage" && receipt.kind === "triage") {
      const fields = request.input;
      if (
        receipt.preview.incidentId !== fields.incidentId ||
        receipt.preview.incidentRevision !== fields.incidentRevision ||
        receipt.preview.targetId !== reviewed.targetId ||
        receipt.preview.action !== fields.action ||
        receipt.preview.note !== (fields.note?.trim() ?? null) ||
        receipt.preview.until !==
          (fields.until ? new Date(fields.until).toISOString() : null) ||
        (receipt.result &&
          (receipt.result.incidentId !== fields.incidentId ||
            receipt.result.action !== fields.action))
      )
        throw new MonitorProviderError("metadata_invalid");
    }
  }
  async configurationPlan(input: unknown) {
    return this.plan({
      kind: "configuration",
      input: monitorConfigurationPlanInput.parse(input),
    });
  }
  async triagePlan(input: unknown) {
    return this.plan({
      kind: "triage",
      input: monitorTriagePlanInput.parse(input),
    });
  }
  private async plan(
    request: z.infer<typeof requestSchema>,
  ): Promise<MonitorReview> {
    const { workspaceId, connectionId, connectionRevision, reviewId } =
      request.input;
    const memberRevision = await authorizeOperator(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
    );
    const { row: connection, provider } = await this.monitoring.active(
      workspaceId,
      connectionId,
    );
    if (connection.revision !== connectionRevision) this.conflict();
    const existing = await this.db
      .prepare("SELECT 1 FROM action_plans WHERE id=?")
      .bind(reviewId)
      .first();
    if (existing) {
      const row = await this.row(workspaceId, reviewId);
      const saved = this.reviewed(row);
      if (
        row.actor_subject !== this.context.principal.subject ||
        saved.tokenId !== (this.context.principal.tokenId ?? null) ||
        saved.memberRevision !== memberRevision ||
        saved.providerIdentity !== provider.identity ||
        JSON.stringify(saved.request) !== JSON.stringify(request)
      )
        this.conflict();
      if (row.provider_review_json || row.applied_at)
        return this.get({ workspaceId, planId: reviewId });
      if (Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    }
    let targetId: string | null = null;
    let before: Reviewed["before"] = null;
    let candidateFingerprint: string | null = null;
    let providerInput: Record<string, unknown>;
    if (request.kind === "configuration") {
      const response = await callMonitorProvider(
        provider,
        "configuration",
        workspaceId,
      );
      if (!response.capabilities.includes("configure"))
        throw new MonitorProviderError("forbidden");
      const remote = response.result.configuration;
      if ((remote?.revision ?? 0) !== request.input.configurationRevision)
        this.conflict();
      const configuration: MonitorConfiguration = remote?.configuration ?? {
        schemaVersion: 2,
        defaults: { ...MONITOR_DEFAULTS },
        targets: [],
      };
      const change = request.input.change;
      if (change.kind === "defaults") {
        before = configuration.defaults;
        configuration.defaults = change.defaults;
      } else {
        targetId = change.targetId;
        before =
          configuration.targets.find((target) => target.id === targetId) ??
          null;
        if (
          (change.action === "create" && before) ||
          (change.action !== "create" && !before)
        )
          this.conflict();
        if (change.action === "create")
          configuration.targets.push(change.target!);
        else if (change.action === "remove")
          configuration.targets = configuration.targets.filter(
            (target) => target.id !== targetId,
          );
        else
          configuration.targets = configuration.targets.map((target) =>
            target.id === targetId ? change.target! : target,
          );
        if (change.target?.expect) configuration.schemaVersion = 2;
      }
      const candidate = canonicalMonitorConfiguration(configuration);
      candidateFingerprint =
        "sha256:" + (await credentialHash(JSON.stringify(candidate)));
      providerInput = {
        expectedRevision: request.input.configurationRevision,
        configuration: candidate,
      };
    } else {
      const response = await callMonitorProvider(
        provider,
        "incident",
        workspaceId,
        { incidentId: request.input.incidentId },
      );
      if (!response.capabilities.includes("triage"))
        throw new MonitorProviderError("forbidden");
      const incident = response.result.incident;
      if (
        incident.id !== request.input.incidentId ||
        incident.revision !== request.input.incidentRevision ||
        incident.status !== "open"
      )
        this.conflict();
      targetId = incident.targetId;
      const { incidentId, incidentRevision, action, note, until } =
        request.input;
      providerInput = {
        incidentId,
        expectedRevision: incidentRevision,
        action,
        note,
        until,
      };
    }
    const reviewed: Reviewed = {
      request,
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      providerRef: connection.credential_ref,
      providerIdentity: provider.identity,
      providerActor: await monitorActor(this.context.principal.subject),
      connectionName: connection.name,
      targetId,
      candidateFingerprint,
      before,
    };
    const serialized = JSON.stringify(reviewed);
    const fingerprint = await credentialHash(serialized);
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
      memberRevision,
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND provider='endpoint-monitor')
          AND (SELECT COUNT(*) FROM (SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>? LIMIT ?)) < ?`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          MONITOR_OPERATION_KIND,
          serialized,
          fingerprint,
          this.timestamp(),
          new Date(this.context.now() + LIMITS.PLAN_TTL_MS).toISOString(),
          ...guard.values,
          workspaceId,
          connectionId,
          connectionRevision,
          workspaceId,
          this.context.principal.subject,
          MONITOR_OPERATION_KIND,
          this.timestamp(),
          MONITOR_LIMITS.PENDING_REVIEWS,
          MONITOR_LIMITS.PENDING_REVIEWS,
        ),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO monitoring_reviews (plan_id) SELECT id FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND fingerprint=? AND kind=?",
        )
        .bind(
          reviewId,
          workspaceId,
          this.context.principal.subject,
          fingerprint,
          MONITOR_OPERATION_KIND,
        ),
    ]);
    const row = await this.row(workspaceId, reviewId);
    if (
      row.actor_subject !== this.context.principal.subject ||
      row.fingerprint !== fingerprint
    )
      this.conflict();
    if (row.provider_review_json || row.applied_at)
      return this.get({ workspaceId, planId: reviewId });
    await this.ready(row, reviewed);
    const response = await callMonitorProvider(
      provider,
      request.kind === "configuration" ? "configuration_plan" : "triage_plan",
      workspaceId,
      { ...providerInput, actorId: reviewed.providerActor },
    );
    this.checkReceipt(response.result, reviewed);
    if (
      response.result.status !== "reviewed" ||
      response.result.credentialId !== provider.providerId ||
      response.result.credentialRevision !== provider.revision
    )
      throw new MonitorProviderError("metadata_invalid");
    await this.ready(row, reviewed);
    const saved = await this.db
      .prepare(
        `UPDATE monitoring_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL AND ${guard.sql}
      AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)
      AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND fingerprint=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))`,
      )
      .bind(
        JSON.stringify(response.result),
        reviewId,
        ...guard.values,
        workspaceId,
        connectionId,
        connectionRevision,
        reviewId,
        fingerprint,
        this.timestamp(),
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
      reviewed.tokenId !== (this.context.principal.tokenId ?? null) ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      this.conflict();
    const revision = await authorizeOperator(
      this.context,
      row.workspace_id,
      CAPABILITY.OPERATE,
    );
    if (revision !== reviewed.memberRevision) this.conflict();
    const { row: connection, provider } = await this.monitoring.active(
      row.workspace_id,
      reviewed.request.input.connectionId,
    );
    if (
      connection.revision !== reviewed.request.input.connectionRevision ||
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
    receipt: MonitorReceipt | null,
  ) {
    const eventId = operationId + "_" + status;
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
          MONITOR_OPERATION_KIND,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM operations WHERE workspace_id=? AND id=? AND status=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "monitoring.operation." + status,
          status === "succeeded"
            ? "Monitoring operation accepted"
            : status === "failed"
              ? "Monitoring operation not accepted"
              : "Monitoring operation needs reconciliation",
          summary,
          this.timestamp(),
          workspaceId,
          operationId,
          status,
        ),
      ...copyActivityContext(this.db, workspaceId, operationId, eventId),
    ]);
  }
  async apply(input: unknown): Promise<MonitorReview> {
    const { workspaceId, planId, fingerprint } = monitorApplyInput.parse(input);
    await authorizeOperator(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const reviewed = this.reviewed(row);
    if (
      row.fingerprint !== fingerprint ||
      row.actor_subject !== this.context.principal.subject ||
      reviewed.tokenId !== (this.context.principal.tokenId ?? null)
    )
      this.conflict();
    if (await this.operation(workspaceId, planId))
      return this.get({ workspaceId, planId });
    await this.ready(row, reviewed);
    if (!row.provider_review_json) this.conflict();
    const original = monitorReceiptSchema.parse(
      JSON.parse(row.provider_review_json),
    );
    this.checkReceipt(original, reviewed);
    if (
      original.status !== "reviewed" ||
      Date.parse(original.expiresAt) <= this.context.now()
    )
      this.conflict();
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
      reviewed.memberRevision,
    );
    const operationId = crypto.randomUUID();
    const summary =
      "Requested a reviewed " +
      (reviewed.request.kind === "configuration"
        ? "configuration change"
        : "incident action") +
      (reviewed.targetId ? " for " + reviewed.targetId : "") +
      ". Provider acceptance is not yet confirmed.";
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at)
        SELECT ?,?,?,?,?,'pending',?,?,? WHERE ${guard.sql}
          AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND credential_ref=?)
          AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND fingerprint=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))`,
        )
        .bind(
          operationId,
          workspaceId,
          planId,
          this.context.principal.subject,
          MONITOR_OPERATION_KIND,
          summary,
          this.timestamp(),
          this.timestamp(),
          ...guard.values,
          workspaceId,
          reviewed.request.input.connectionId,
          reviewed.request.input.connectionRevision,
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
          "INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) SELECT ?,?,?,?,'monitoring.operation.requested','Monitoring operation requested',?,? WHERE EXISTS (SELECT 1 FROM operations WHERE id=?)",
        )
        .bind(
          operationId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          summary,
          this.timestamp(),
          operationId,
        ),
      ...captureResourceActivity(
        this.db,
        workspaceId,
        operationId,
        reviewed.request.input.connectionId,
        "monitor",
        reviewed.targetId,
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
          `UPDATE operations SET status='running',updated_at=? WHERE workspace_id=? AND id=? AND status='pending' AND ${guard.sql}
        AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)`,
        )
        .bind(
          this.timestamp(),
          workspaceId,
          operationId,
          ...guard.values,
          workspaceId,
          reviewed.request.input.connectionId,
          reviewed.request.input.connectionRevision,
        )
        .run();
      if (!started.meta.changes) this.conflict();
      submitted = true;
      const response = await callMonitorProvider(
        provider,
        "operation_apply",
        workspaceId,
        { actorId: reviewed.providerActor, planId: original.id },
      );
      this.checkReceipt(response.result, reviewed, original);
      if (response.result.status !== "applied")
        throw new MonitorProviderError("metadata_invalid");
      await this.record(
        workspaceId,
        operationId,
        "succeeded",
        "Endpoint Monitor accepted the reviewed operation" +
          (reviewed.targetId ? " for " + reviewed.targetId : "") +
          ". This receipt is not proof of endpoint recovery.",
        response.result,
      );
    } catch {
      await this.record(
        workspaceId,
        operationId,
        submitted ? "indeterminate" : "failed",
        submitted
          ? "Provider acceptance is uncertain. Reconcile this operation before reviewing another change."
          : "Access or connection state changed before submission. No provider action was sent.",
        null,
      );
    }
    return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown): Promise<MonitorReview> {
    const { workspaceId, planId } = monitorReviewInput.parse(input);
    await authorizeOperator(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId);
    const operation = await this.operation(workspaceId, planId);
    if (!operation || ["succeeded", "failed"].includes(operation.status))
      return this.get({ workspaceId, planId });
    const reviewed = this.reviewed(row);
    const original = monitorReceiptSchema.parse(
      JSON.parse(row.provider_review_json!),
    );
    const provider = await this.provider(reviewed);
    const response = await callMonitorProvider(
      provider,
      "operation_get",
      workspaceId,
      { actorId: reviewed.providerActor, planId: original.id },
    );
    this.checkReceipt(response.result, reviewed, original);
    await authorizeOperator(this.context, workspaceId, CAPABILITY.OPERATE);
    if (response.result.status === "applied")
      await this.record(
        workspaceId,
        operation.id,
        "succeeded",
        "The provider's durable receipt confirms acceptance. Refresh targets or incidents for live state; this is not proof of endpoint health.",
        response.result,
      );
    else if (response.result.status === "expired")
      await this.record(
        workspaceId,
        operation.id,
        "failed",
        "The provider confirms this review expired without acceptance. Refresh provider state before preparing another review.",
        response.result,
      );
    else
      await this.record(
        workspaceId,
        operation.id,
        "indeterminate",
        "The provider has not confirmed acceptance. This review is still open and a request may be in flight; reconcile again after expiry.",
        response.result,
      );
    return this.get({ workspaceId, planId });
  }
}
