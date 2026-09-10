import { z } from "zod";
import { CAPABILITY, LIMITS, idSchema } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_ACTION,
  MANAGED_CONFIGURATION_LIMITS,
  MANAGED_CONFIGURATION_OPERATION_KIND,
  MANAGED_CONFIGURATION_STATUS,
  managedConfigurationAction,
  managedConfigurationApplyInput,
  managedConfigurationHistoryInput,
  managedConfigurationPlanInput,
  managedConfigurationReceiptSchema,
  managedConfigurationReviewInput,
  managedConfigurationSchema,
  managedConfigurationStatus,
  managedDestinationKey,
  managedProviderSnapshotSchema,
  type ManagedConfiguration,
  type ManagedConfigurationOperation,
  type ManagedConfigurationReceipt,
  type ManagedConfigurationReview,
  type ManagedProviderSnapshot,
} from "../shared/managed-configurations";
import {
  SECRET_ENTRY_KIND,
  secretProviderKindSchema,
} from "../shared/secrets";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  ManagedConfigurations,
  type SelectedManagedDestination,
} from "./managed-configurations";
import { describeSecretResource } from "./secret-adapters";
import type { WorkspaceService } from "./service";

const managedResourceSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(255),
    repositoryIds: z.array(idSchema).min(1),
  })
  .strict();
const reviewedSchema = z
  .object({
    configuration: managedConfigurationSchema,
    destinationIndex:
      managedConfigurationPlanInput.shape.destinationIndex,
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    providerRef: z.string().min(1).max(255),
    providerIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    providerKind: secretProviderKindSchema,
    connectionName: z.string().min(1).max(80),
    resource: managedResourceSchema,
    before: managedProviderSnapshotSchema,
    action: z.enum([
      MANAGED_CONFIGURATION_ACTION.CREATE,
      MANAGED_CONFIGURATION_ACTION.UPDATE,
      MANAGED_CONFIGURATION_ACTION.DELETE,
      MANAGED_CONFIGURATION_ACTION.NONE,
    ]),
    writable: z.boolean(),
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
  configuration_id: string;
  destination_key: string;
  repository_id: string;
};
type OperationRow = {
  id: string;
  status: ManagedConfigurationOperation["status"];
  summary: string;
  result_json: string;
  createdAt: string;
  updatedAt: string;
};

function stableSnapshot(snapshot: ManagedProviderSnapshot) {
  const { observedAt: _observedAt, ...stable } = snapshot;
  return stable;
}

function sameProviderTarget(
  current: ManagedProviderSnapshot,
  expected: ManagedProviderSnapshot,
) {
  return (
    current.name === expected.name &&
    current.entryKind === expected.entryKind &&
    JSON.stringify(current.scope) === JSON.stringify(expected.scope) &&
    current.resourceIdentity === expected.resourceIdentity &&
    current.scopeIdentity === expected.scopeIdentity
  );
}

function stableConfiguration(configuration: ManagedConfiguration) {
  return {
    id: configuration.id,
    label: configuration.label,
    entryKind: configuration.entryKind,
    custody: configuration.custody,
    desiredValue: configuration.desiredValue,
    revision: configuration.revision,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
    destinations: configuration.destinations.map((item) => ({
      desiredState: item.desiredState,
      destination: {
        connectionId: item.destination.connectionId,
        target: item.destination.target,
        name: item.destination.name,
      },
    })),
  };
}

export class ManagedConfigurationOperations {
  readonly configurations: ManagedConfigurations;
  constructor(readonly context: WorkspaceService) {
    this.configurations = new ManagedConfigurations(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  conflict(): never {
    throw new DomainError(
      "managed_configuration_conflict",
      "This review changed, expired, or lost its original authority. Refresh live status and prepare a new review.",
      409,
    );
  }

  private async row(workspaceId: string, planId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT p.id,p.workspace_id,p.actor_subject,p.input_json,p.fingerprint,p.created_at,p.expires_at,p.applied_at,
          r.configuration_id,r.destination_key,r.repository_id
        FROM action_plans p JOIN managed_configuration_reviews r ON r.plan_id=p.id
        WHERE p.workspace_id=? AND p.id=? AND p.kind=? AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        MANAGED_CONFIGURATION_OPERATION_KIND,
        ...guard.values,
      )
      .first<PlanRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Managed configuration review not found or access changed.",
        404,
      );
    return row;
  }

  private reviewed(row: PlanRow) {
    try {
      return reviewedSchema.parse(JSON.parse(row.input_json));
    } catch {
      throw new DomainError(
        "managed_configuration_invalid",
        "This managed configuration review is invalid. Prepare a new review.",
        503,
      );
    }
  }

  private operation(workspaceId: string, planId: string) {
    return this.db
      .prepare(
        `SELECT id,status,summary,result_json,created_at AS createdAt,updated_at AS updatedAt
        FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?`,
      )
      .bind(workspaceId, planId, MANAGED_CONFIGURATION_OPERATION_KIND)
      .first<OperationRow>();
  }

  private fallbackReceipt(
    status: ManagedConfigurationOperation["status"],
  ): ManagedConfigurationReceipt {
    return {
      writeStatus: status === "running" ? "indeterminate" : "not-sent",
      reason:
        status === "running" ? "provider_result_uncertain" : null,
      observationStatus: MANAGED_CONFIGURATION_STATUS.UNAVAILABLE,
      item: null,
      observedAt: null,
      submittedAt: null,
    };
  }

  async get(input: unknown): Promise<ManagedConfigurationReview> {
    const { workspaceId, planId } = managedConfigurationReviewInput.parse(input);
    await authorize(this.context, workspaceId);
    const row = await this.row(workspaceId, planId);
    const reviewed = this.reviewed(row);
    const operation = await this.operation(workspaceId, planId);
    const receipt = operation
      ? z
          .object({ receipt: managedConfigurationReceiptSchema.optional() })
          .parse(JSON.parse(operation.result_json)).receipt ??
        this.fallbackReceipt(operation.status)
      : null;
    await authorize(this.context, workspaceId);
    const desired =
      reviewed.configuration.destinations[reviewed.destinationIndex];
    if (!desired) this.conflict();
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      actorMatches:
        row.actor_subject === this.context.principal.subject &&
        reviewed.tokenId === (this.context.principal.tokenId ?? null),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      configurationId: reviewed.configuration.id,
      configurationLabel: reviewed.configuration.label,
      configurationRevision: reviewed.configuration.revision,
      entryKind: reviewed.configuration.entryKind,
      custody: reviewed.configuration.custody,
      desiredValue: reviewed.configuration.desiredValue,
      desired,
      providerKind: reviewed.providerKind,
      connectionName: reviewed.connectionName,
      resource: reviewed.resource,
      before: reviewed.before,
      action: reviewed.action,
      writable: reviewed.writable,
      operation: operation
        ? {
            id: operation.id,
            status: operation.status,
            summary: operation.summary,
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
            receipt: receipt!,
          }
        : null,
    };
  }

  async history(input: unknown) {
    const { workspaceId, repositoryId } =
      managedConfigurationHistoryInput.parse(input);
    await authorize(this.context, workspaceId);
    if (repositoryId)
      await this.context.repository({ workspaceId, repositoryId });
    const guard = actorGuard(this.context, workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT o.id,o.plan_id AS planId,r.configuration_id AS configurationId,o.status,o.summary,
            o.created_at AS createdAt,o.updated_at AS updatedAt
          FROM operations o JOIN managed_configuration_reviews r ON r.plan_id=o.plan_id
          WHERE o.workspace_id=? AND o.kind=? AND (? IS NULL OR r.repository_id=?) AND ${guard.sql}
          ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
        )
        .bind(
          workspaceId,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          repositoryId ?? null,
          repositoryId ?? null,
          ...guard.values,
          MANAGED_CONFIGURATION_LIMITS.HISTORY,
        )
        .all()
    ).results;
  }

  private supported(
    configuration: ManagedConfiguration,
    selected: SelectedManagedDestination,
  ) {
    const scope = selected.destination.destination.target.scope.kind;
    if (
      configuration.entryKind !== SECRET_ENTRY_KIND.VARIABLE ||
      !selected.connection.adapter.capabilities.variableMutationScopeKinds.includes(
        scope,
      ) ||
      !selected.connection.provider.writeManagedVariable
    )
      throw new DomainError(
        "managed_configuration_unsupported",
        "This managed target can be inventoried, but HQ cannot apply its desired value without a supported non-secret provider write.",
        409,
      );
  }

  private async ready(
    workspaceId: string,
    reviewed: Reviewed,
    requireActor: boolean,
  ) {
    if (
      requireActor &&
      reviewed.tokenId !== (this.context.principal.tokenId ?? null)
    )
      this.conflict();
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    if (memberRevision !== reviewed.memberRevision && requireActor)
      this.conflict();
    const configuration = await this.configurations.configuration(
      workspaceId,
      reviewed.configuration.id,
    );
    const configurationMatches = requireActor
      ? JSON.stringify(managedConfigurationSchema.parse(configuration)) ===
        JSON.stringify(managedConfigurationSchema.parse(reviewed.configuration))
      : JSON.stringify(stableConfiguration(configuration)) ===
        JSON.stringify(stableConfiguration(reviewed.configuration));
    if (!configurationMatches)
      this.conflict();
    const selected = await this.configurations.selected(
      workspaceId,
      configuration,
      reviewed.destinationIndex,
    );
    this.supported(configuration, selected);
    const resource = describeSecretResource(selected.connection.resource);
    if (
      selected.connection.row.provider_kind !== reviewed.providerKind ||
      (requireActor &&
        (selected.connection.row.credential_ref !== reviewed.providerRef ||
          selected.connection.provider.identity !== reviewed.providerIdentity ||
          JSON.stringify(resource) !== JSON.stringify(reviewed.resource))) ||
      (!requireActor &&
        (resource.id !== reviewed.resource.id ||
          JSON.stringify(resource.repositoryIds) !==
            JSON.stringify(reviewed.resource.repositoryIds)))
    )
      this.conflict();
    return { configuration, selected };
  }

  async plan(input: unknown): Promise<ManagedConfigurationReview> {
    const request = managedConfigurationPlanInput.parse(input);
    const {
      workspaceId,
      configurationId,
      configurationRevision,
      destinationIndex,
      planId,
    } = request;
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    const collision = await this.db
      .prepare(
        "SELECT workspace_id,actor_subject,kind FROM action_plans WHERE id=?",
      )
      .bind(planId)
      .first<{ workspace_id: string; actor_subject: string; kind: string }>();
    if (collision) {
      if (
        collision.workspace_id !== workspaceId ||
        collision.actor_subject !== this.context.principal.subject ||
        collision.kind !== MANAGED_CONFIGURATION_OPERATION_KIND
      )
        this.conflict();
      const row = await this.row(workspaceId, planId);
      const reviewed = this.reviewed(row);
      if (
        reviewed.configuration.id !== configurationId ||
        reviewed.configuration.revision !== configurationRevision ||
        reviewed.destinationIndex !== destinationIndex ||
        reviewed.memberRevision !== memberRevision ||
        reviewed.tokenId !== (this.context.principal.tokenId ?? null) ||
        Date.parse(row.expires_at) <= this.context.now()
      )
        this.conflict();
      await this.ready(workspaceId, reviewed, true);
      return this.get({ workspaceId, planId });
    }
    const configuration = await this.configurations.configuration(
      workspaceId,
      configurationId,
    );
    if (configuration.revision !== configurationRevision) this.conflict();
    const { snapshot, selected } = await this.configurations.inspect(
      workspaceId,
      configuration,
      destinationIndex,
    );
    this.supported(configuration, selected);
    const resource = describeSecretResource(selected.connection.resource);
    if (resource.repositoryIds.length !== 1)
      throw new DomainError(
        "managed_configuration_invalid",
        "A managed GitHub destination must resolve to one enrolled repository.",
        503,
      );
    const desired = configuration.destinations[destinationIndex];
    if (!desired) this.conflict();
    const reviewed = reviewedSchema.parse({
      configuration,
      destinationIndex,
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      providerRef: selected.connection.row.credential_ref,
      providerIdentity: selected.connection.provider.identity,
      providerKind: selected.connection.row.provider_kind,
      connectionName: selected.connection.row.name,
      resource,
      before: snapshot,
      action: managedConfigurationAction(
        desired.desiredState,
        configuration.desiredValue,
        snapshot.item,
      ),
      writable: selected.connection.provider.writable,
    });
    await this.ready(workspaceId, reviewed, true);
    const serialized = JSON.stringify(reviewed);
    const fingerprint = "sha256:" + (await credentialHash(serialized));
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
      memberRevision,
    );
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + LIMITS.PLAN_TTL_MS,
    ).toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO action_plans
          (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
          SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
            AND EXISTS (SELECT 1 FROM managed_configurations m
              JOIN managed_configuration_destinations d ON d.workspace_id=m.workspace_id AND d.configuration_id=m.id
              JOIN secret_connections c ON c.workspace_id=d.workspace_id AND c.id=d.connection_id
              WHERE m.workspace_id=? AND m.id=? AND m.state='active' AND m.revision=?
                AND d.destination_index=? AND c.revision=? AND c.credential_ref=?)
            AND (SELECT COUNT(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=?
              AND applied_at IS NULL AND expires_at>?)<?`,
        )
        .bind(
          planId,
          workspaceId,
          this.context.principal.subject,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          serialized,
          fingerprint,
          createdAt,
          expiresAt,
          ...guard.values,
          workspaceId,
          configurationId,
          configurationRevision,
          destinationIndex,
          desired.destination.connectionRevision,
          reviewed.providerRef,
          workspaceId,
          this.context.principal.subject,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          createdAt,
          MANAGED_CONFIGURATION_LIMITS.PENDING_REVIEWS,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO managed_configuration_reviews
          (plan_id,workspace_id,configuration_id,destination_index,destination_key,repository_id)
          SELECT id,workspace_id,?,?,?,? FROM action_plans
          WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND fingerprint=?`,
        )
        .bind(
          configurationId,
          destinationIndex,
          managedDestinationKey(
            reviewed.providerKind,
            configuration.entryKind,
            desired.destination,
          ),
          resource.repositoryIds[0],
          planId,
          workspaceId,
          this.context.principal.subject,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          fingerprint,
        ),
    ]);
    const row = await this.row(workspaceId, planId);
    if (
      row.fingerprint !== fingerprint ||
      row.configuration_id !== configurationId ||
      row.destination_key !==
        managedDestinationKey(
          reviewed.providerKind,
          configuration.entryKind,
          desired.destination,
        )
    )
      this.conflict();
    await this.ready(workspaceId, reviewed, true);
    return this.get({ workspaceId, planId });
  }

  private receipt(
    reviewed: Reviewed,
    snapshot: ManagedProviderSnapshot | null,
    writeStatus: ManagedConfigurationReceipt["writeStatus"],
    reason: ManagedConfigurationReceipt["reason"],
    submittedAt: string | null,
  ): ManagedConfigurationReceipt {
    const desired =
      reviewed.configuration.destinations[reviewed.destinationIndex];
    if (!desired) this.conflict();
    const item = snapshot
      ? this.configurations.observedItem(reviewed.configuration.id, snapshot)
      : null;
    return {
      writeStatus,
      reason,
      observationStatus: snapshot
        ? managedConfigurationStatus(
            reviewed.configuration.entryKind,
            desired.desiredState,
            reviewed.configuration.desiredValue,
            item,
          )
        : MANAGED_CONFIGURATION_STATUS.UNAVAILABLE,
      item,
      observedAt: snapshot?.observedAt ?? null,
      submittedAt,
    };
  }

  private async record(
    workspaceId: string,
    operationId: string,
    reviewed: Reviewed,
    status: ManagedConfigurationOperation["status"],
    summary: string,
    receipt: ManagedConfigurationReceipt,
  ) {
    const eventId = operationId + "_" + status;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE operations SET status=?,summary=?,result_json=?,updated_at=?
          WHERE workspace_id=? AND id=? AND kind=? AND status IN ('pending','running','partial','indeterminate')`,
        )
        .bind(
          status,
          summary,
          JSON.stringify({ receipt }),
          this.timestamp(),
          workspaceId,
          operationId,
          MANAGED_CONFIGURATION_OPERATION_KIND,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity
          (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS
            (SELECT 1 FROM operations WHERE workspace_id=? AND id=? AND status=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "secrets.configuration.operation." + status,
          status === "succeeded"
            ? "Managed configuration reconciled"
            : status === "failed"
              ? "Managed configuration not changed"
              : "Managed configuration needs reconciliation",
          summary,
          this.timestamp(),
          workspaceId,
          operationId,
          status,
        ),
      ...reviewed.resource.repositoryIds.map((repositoryId) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity_repository_links
            (workspace_id,event_id,repository_id)
            SELECT ?,?,id FROM repositories WHERE workspace_id=? AND id=?
              AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
          )
          .bind(
            workspaceId,
            eventId,
            workspaceId,
            repositoryId,
            workspaceId,
            eventId,
          ),
      ),
    ]);
  }

  private summary(
    action: Reviewed["action"],
    status: ManagedConfigurationOperation["status"],
  ) {
    const target = action === MANAGED_CONFIGURATION_ACTION.NONE
      ? "No provider write was needed"
      : "The reviewed " + action + " for the managed variable";
    if (status === "succeeded")
      return target + " and live provider state matches the desired state.";
    if (status === "failed")
      return target + " was not accepted. Refresh status before trying again.";
    if (status === "partial")
      return target + " has a known or uncertain submission, but live state does not yet prove the desired outcome. Reconcile before another change.";
    return target + " may have reached the provider. Acceptance and live state are uncertain; reconcile before another change.";
  }

  async apply(input: unknown): Promise<ManagedConfigurationReview> {
    const { workspaceId, planId, fingerprint } =
      managedConfigurationApplyInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
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
    await this.ready(workspaceId, reviewed, true);
    const desired =
      reviewed.configuration.destinations[reviewed.destinationIndex];
    if (!desired) this.conflict();
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
      reviewed.memberRevision,
    );
    const operationId = crypto.randomUUID();
    const now = this.timestamp();
    const requested =
      "Accepted a reviewed " +
      reviewed.action +
      " for managed configuration " +
      reviewed.configuration.label +
      ". Provider acceptance is not yet confirmed.";
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO operations
          (id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at)
          SELECT ?,?,?,?,?,'pending',?,?,? WHERE ${guard.sql}
            AND EXISTS (SELECT 1 FROM managed_configurations m
              JOIN managed_configuration_destinations d ON d.workspace_id=m.workspace_id AND d.configuration_id=m.id
              JOIN secret_connections c ON c.workspace_id=d.workspace_id AND c.id=d.connection_id
              WHERE m.workspace_id=? AND m.id=? AND m.state='active' AND m.revision=?
                AND d.destination_index=? AND c.revision=? AND c.credential_ref=?)
            AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=?
              AND kind=? AND fingerprint=? AND applied_at IS NULL AND expires_at>?
              AND julianday(expires_at)>julianday('now'))
            AND NOT EXISTS (SELECT 1 FROM managed_configuration_reviews r JOIN operations o ON o.plan_id=r.plan_id
              WHERE r.workspace_id=? AND r.destination_key=? AND o.status IN ('pending','running','partial','indeterminate'))`,
        )
        .bind(
          operationId,
          workspaceId,
          planId,
          this.context.principal.subject,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          requested,
          now,
          now,
          ...guard.values,
          workspaceId,
          reviewed.configuration.id,
          reviewed.configuration.revision,
          reviewed.destinationIndex,
          desired.destination.connectionRevision,
          reviewed.providerRef,
          planId,
          workspaceId,
          this.context.principal.subject,
          MANAGED_CONFIGURATION_OPERATION_KIND,
          fingerprint,
          now,
          workspaceId,
          row.destination_key,
        ),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE id=? AND workspace_id=? AND applied_at IS NULL
          AND EXISTS (SELECT 1 FROM operations WHERE id=? AND plan_id=?)`,
        )
        .bind(now, planId, workspaceId, operationId, planId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity
          (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
          SELECT ?,?,?,?,'secrets.configuration.operation.requested','Managed configuration operation requested',?,?
          WHERE EXISTS (SELECT 1 FROM operations WHERE id=?)`,
        )
        .bind(
          operationId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          requested,
          now,
          operationId,
        ),
      ...reviewed.resource.repositoryIds.map((repositoryId) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity_repository_links
            (workspace_id,event_id,repository_id)
            SELECT ?,?,id FROM repositories WHERE workspace_id=? AND id=?
              AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
          )
          .bind(
            workspaceId,
            operationId,
            workspaceId,
            repositoryId,
            workspaceId,
            operationId,
          ),
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      if (await this.operation(workspaceId, planId))
        return this.get({ workspaceId, planId });
      this.conflict();
    }
    if (reviewed.action === MANAGED_CONFIGURATION_ACTION.NONE) {
      const receipt = this.receipt(
        reviewed,
        reviewed.before,
        "not-sent",
        null,
        null,
      );
      await this.record(
        workspaceId,
        operationId,
        reviewed,
        "succeeded",
        this.summary(reviewed.action, "succeeded"),
        receipt,
      );
      return this.get({ workspaceId, planId });
    }
    let submittedAt: string | null = null;
    let preflight: ManagedProviderSnapshot | null = null;
    try {
      const inspected = await this.configurations.inspect(
        workspaceId,
        reviewed.configuration,
        reviewed.destinationIndex,
      );
      preflight = inspected.snapshot;
      const currentAction = managedConfigurationAction(
        desired.desiredState,
        reviewed.configuration.desiredValue,
        preflight.item,
      );
      if (
        JSON.stringify(stableSnapshot(preflight)) !==
          JSON.stringify(stableSnapshot(reviewed.before)) ||
        currentAction !== reviewed.action
      ) {
        await this.record(
          workspaceId,
          operationId,
          reviewed,
          "failed",
          "Live provider state changed after review. No provider action was sent; refresh status and prepare a new review.",
          this.receipt(
            reviewed,
            preflight,
            "not-sent",
            "preflight_changed",
            null,
          ),
        );
        return this.get({ workspaceId, planId });
      }
      const current = await this.ready(workspaceId, reviewed, true);
      const candidateSubmittedAt = this.timestamp();
      const started = await this.db
        .prepare(
          `UPDATE operations SET status='running',summary=?,result_json=?,updated_at=?
          WHERE workspace_id=? AND id=? AND status='pending' AND ${guard.sql}
            AND EXISTS (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND state='active' AND revision=?)
            AND EXISTS (SELECT 1 FROM secret_connections WHERE workspace_id=? AND id=? AND revision=? AND credential_ref=?)`,
        )
        .bind(
          "Submitting the reviewed managed variable operation. Provider acceptance is not yet confirmed.",
          JSON.stringify({
            receipt: this.receipt(
              reviewed,
              preflight,
              "indeterminate",
              "provider_result_uncertain",
              candidateSubmittedAt,
            ),
          }),
          candidateSubmittedAt,
          workspaceId,
          operationId,
          ...guard.values,
          workspaceId,
          reviewed.configuration.id,
          reviewed.configuration.revision,
          workspaceId,
          desired.destination.connectionId,
          desired.destination.connectionRevision,
          reviewed.providerRef,
        )
        .run();
      if (!started.meta.changes) this.conflict();
      submittedAt = candidateSubmittedAt;
      const result = await current.selected.connection.provider.writeManagedVariable!(
        current.selected.connection.resource,
        preflight,
        reviewed.action,
        reviewed.configuration.desiredValue,
      );
      let observed: ManagedProviderSnapshot | null = null;
      try {
        observed = (
          await this.configurations.inspect(
            workspaceId,
            reviewed.configuration,
            reviewed.destinationIndex,
          )
        ).snapshot;
      } catch {
        observed = null;
      }
      if (observed && !sameProviderTarget(observed, reviewed.before))
        observed = null;
      const receipt = this.receipt(
        reviewed,
        observed,
        result.status,
        result.reason,
        submittedAt,
      );
      const status: ManagedConfigurationOperation["status"] =
        result.status === "rejected"
          ? "failed"
          : result.status === "accepted" &&
              receipt.observationStatus === MANAGED_CONFIGURATION_STATUS.IN_SYNC
            ? "succeeded"
            : observed
              ? "partial"
              : "indeterminate";
      await this.record(
        workspaceId,
        operationId,
        reviewed,
        status,
        this.summary(reviewed.action, status),
        receipt,
      );
    } catch {
      const status = submittedAt ? "indeterminate" : "failed";
      await this.record(
        workspaceId,
        operationId,
        reviewed,
        status,
        submittedAt
          ? "Provider acceptance or the follow-up read is uncertain. Reconcile this operation before another change."
          : "Authority or provider state changed before submission. No provider action was sent.",
        this.receipt(
          reviewed,
          preflight,
          submittedAt ? "indeterminate" : "not-sent",
          submittedAt ? "provider_result_uncertain" : "authority_changed",
          submittedAt,
        ),
      );
    }
    return this.get({ workspaceId, planId });
  }

  async reconcile(input: unknown): Promise<ManagedConfigurationReview> {
    const { workspaceId, planId } = managedConfigurationReviewInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, planId);
    const operation = await this.operation(workspaceId, planId);
    if (!operation || ["succeeded", "failed"].includes(operation.status))
      return this.get({ workspaceId, planId });
    const reviewed = this.reviewed(row);
    const current = await this.ready(workspaceId, reviewed, false);
    let snapshot: ManagedProviderSnapshot | null = null;
    try {
      snapshot = (
        await this.configurations.inspect(
          workspaceId,
          current.configuration,
          reviewed.destinationIndex,
        )
      ).snapshot;
    } catch {
      snapshot = null;
    }
    const targetChanged = Boolean(
      snapshot && !sameProviderTarget(snapshot, reviewed.before),
    );
    if (targetChanged) snapshot = null;
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const prior = z
      .object({ receipt: managedConfigurationReceiptSchema.optional() })
      .parse(JSON.parse(operation.result_json)).receipt ??
      this.fallbackReceipt(operation.status);
    const receipt = this.receipt(
      reviewed,
      snapshot,
      prior.writeStatus,
      prior.reason,
      prior.submittedAt,
    );
    const status: ManagedConfigurationOperation["status"] = !snapshot
      ? "indeterminate"
      : receipt.observationStatus === MANAGED_CONFIGURATION_STATUS.IN_SYNC
        ? "succeeded"
        : "partial";
    await this.record(
      workspaceId,
      operation.id,
      reviewed,
      status,
      status === "succeeded" && prior.writeStatus === "indeterminate"
        ? "A live provider read confirms the desired state. The original write acceptance remains unknown."
        : targetChanged
          ? "The provider target identity changed. The original outcome remains uncertain and no write was replayed."
        : this.summary(reviewed.action, status),
      receipt,
    );
    return this.get({ workspaceId, planId });
  }
}
