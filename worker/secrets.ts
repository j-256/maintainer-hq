import { z } from "zod";
import { CAPABILITY, workspaceInput } from "../shared/domain";
import {
  SECRET_LIMITS,
  SECRET_MANAGEMENT,
  secretConnectionSaveInput,
  secretInventoryInput,
  secretInventoryItemSchema,
  secretScopesInput,
  type SecretConnection,
  type SecretProviderKind,
  type SecretProviderReference,
  type SecretScope,
} from "../shared/secrets";
import { managedDestinationKey } from "../shared/managed-configurations";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  describeSecretResource,
  secretResourceBindingSchema,
  type SecretResourceBinding,
} from "./secret-adapters";
import { secretAdapter, secretAdapters } from "./secret-adapter-registry";
import { DomainError } from "./errors";
import { captureProjectActivity } from "./project-resources";
import { providerCredentialGuard } from "./provider-credential-store";
import type { WorkspaceService } from "./service";

const resourceBindings = z
  .array(secretResourceBindingSchema)
  .min(1)
  .max(SECRET_LIMITS.RESOURCES)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  );
export type SecretConnectionRow = {
  id: string;
  name: string;
  provider_kind: SecretProviderKind;
  credential_ref: string;
  resources_json: string;
  enabled: number;
  revision: number;
};
const COLUMNS =
  "id,name,provider_kind,credential_ref,resources_json,enabled,revision";

function sameScope(left: SecretScope, right: SecretScope) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "environment" || left.kind === "organization")
    return right.kind === left.kind && right.name === left.name;
  return true;
}

export class SecretsService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }

  async connection(workspaceId: string, connectionId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM secret_connections WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, connectionId, ...guard.values)
      .first<SecretConnectionRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Secrets connection not found or access changed.",
        404,
      );
    return row;
  }

  bindings(row: SecretConnectionRow): SecretResourceBinding[] {
    try {
      return resourceBindings.parse(JSON.parse(row.resources_json));
    } catch {
      throw new DomainError(
        "secret_configuration_invalid",
        "Secrets resource enrollment is invalid. Ask the workspace owner to repair it.",
        503,
      );
    }
  }

  async references(workspaceId: string) {
    return (
      await Promise.all(
        secretAdapters.map((adapter) =>
          adapter.references(this.context, workspaceId),
        ),
      )
    ).flat();
  }

  describe(
    row: SecretConnectionRow,
    references: SecretProviderReference[],
  ): SecretConnection {
    const provider = references.find(
      (item) =>
        item.kind === row.provider_kind && item.id === row.credential_ref,
    );
    const resources = this.bindings(row).map(describeSecretResource);
    const available = Boolean(
      provider?.available &&
      resources.every((item) =>
        provider.resources.some(
          (candidate) =>
            candidate.id === item.id && candidate.label === item.label,
        ),
      ),
    );
    return {
      id: row.id,
      name: row.name,
      providerKind: row.provider_kind,
      providerRef: row.credential_ref,
      enabled: Boolean(row.enabled),
      revision: row.revision,
      resourceIds: resources.map((item) => item.id),
      resources,
      providerName: provider?.name ?? null,
      available,
      writable: Boolean(available && provider?.writable),
      capabilities: provider?.capabilities ?? null,
    };
  }

  async list(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorize(this.context, workspaceId);
    const guard = actorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM secret_connections WHERE workspace_id=? AND ${guard.sql} ORDER BY name,id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, SECRET_LIMITS.CONNECTIONS + 1)
      .all<SecretConnectionRow>();
    if (rows.results.length > SECRET_LIMITS.CONNECTIONS)
      throw new DomainError(
        "capacity",
        "Secrets connections exceed the supported workspace limit.",
        409,
      );
    const references = await this.references(workspaceId);
    await authorize(this.context, workspaceId);
    return rows.results.map((row) => this.describe(row, references));
  }

  async providers(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.ADMIN);
    const references = await this.references(workspaceId);
    await authorize(this.context, workspaceId, CAPABILITY.ADMIN);
    return references;
  }

  async save(input: unknown) {
    const { workspaceId, connectionId, revision, connection } =
      secretConnectionSaveInput.parse(input);
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const existing = revision
      ? await this.connection(workspaceId, connectionId)
      : null;
    if (existing && existing.revision !== revision)
      throw new DomainError(
        "revision_conflict",
        "Secrets connection changed. Keep your draft and load saved settings.",
        409,
      );
    if (existing && existing.provider_kind !== connection.providerKind)
      throw new DomainError(
        "secret_provider_conflict",
        "Create a separate connection when changing provider type.",
        409,
      );
    const provider = await secretAdapter(connection.providerKind).connect(
      this.context,
      workspaceId,
      connection.providerRef,
    );
    const resources = resourceBindings.parse(
      await provider.selectResources(connection.resourceIds),
    );
    const repositoryBindings = resources.flatMap(
      (resource) => resource.repositories,
    );
    const repositoryIds = [
      ...new Set(
        [
          ...repositoryBindings,
          ...(existing
            ? this.bindings(existing).flatMap(
                (resource) => resource.repositories,
              )
            : []),
        ].map((item) => item.id),
      ),
    ];
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = new Date(this.context.now()).toISOString();
    const credentialGuard = providerCredentialGuard(
      workspaceId,
      connection.providerKind,
      connection.providerRef,
      provider.identity,
    );
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO secret_connections (workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND ${credentialGuard.sql}
          AND NOT EXISTS (SELECT 1 FROM json_each(?) b WHERE NOT EXISTS
            (SELECT 1 FROM repositories r WHERE r.workspace_id=? AND r.id=json_extract(b.value,'$.id') AND r.full_name=json_extract(b.value,'$.fullName')))
          AND ((?=0 AND (SELECT COUNT(*) FROM secret_connections WHERE workspace_id=?)<?)
            OR EXISTS (SELECT 1 FROM secret_connections WHERE workspace_id=? AND id=? AND revision=?))
        ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,credential_ref=excluded.credential_ref,resources_json=excluded.resources_json,
          enabled=excluded.enabled,revision=excluded.revision,write_id=excluded.write_id
          WHERE secret_connections.revision=? AND secret_connections.provider_kind=excluded.provider_kind
          AND NOT EXISTS (SELECT 1 FROM managed_configuration_destinations d
            JOIN managed_configurations m ON m.workspace_id=d.workspace_id AND m.id=d.configuration_id
            WHERE d.workspace_id=secret_connections.workspace_id AND d.connection_id=secret_connections.id
              AND m.state='active' AND d.resource_id NOT IN
                (SELECT json_extract(value,'$.id') FROM json_each(?)))`,
        )
        .bind(
          workspaceId,
          connectionId,
          connection.name,
          connection.providerKind,
          connection.providerRef,
          JSON.stringify(resources),
          Number(connection.enabled),
          revision + 1,
          writeId,
          ...guard.values,
          ...credentialGuard.values,
          JSON.stringify(repositoryBindings),
          workspaceId,
          revision,
          workspaceId,
          SECRET_LIMITS.CONNECTIONS,
          workspaceId,
          connectionId,
          revision,
          revision,
          JSON.stringify(resources),
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'secrets.connection.updated','Secrets connection saved',?,? WHERE EXISTS
          (SELECT 1 FROM secret_connections WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "Updated HQ enrollment for " +
            connection.name +
            ". No provider secret was changed.",
          now,
          workspaceId,
          connectionId,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links (workspace_id,event_id,repository_id)
        SELECT ?,?,r.id FROM repositories r WHERE r.workspace_id=? AND r.id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          workspaceId,
          eventId,
          workspaceId,
          JSON.stringify(repositoryIds),
          workspaceId,
          eventId,
        ),
      captureProjectActivity(
        this.db,
        workspaceId,
        eventId,
        connectionId,
        "secret",
      ),
    ]);
    if (!result[0]!.meta.changes)
      throw new DomainError(
        "revision_conflict",
        "Secrets enrollment or workspace authority changed. Keep your draft and refresh saved settings.",
        409,
      );
    return this.describe(
      await this.connection(workspaceId, connectionId),
      await this.references(workspaceId),
    );
  }

  async resource(
    workspaceId: string,
    connectionId: string,
    resourceId: string,
  ) {
    const row = await this.connection(workspaceId, connectionId);
    if (!row.enabled)
      throw new DomainError(
        "secret_connection_disabled",
        "This Secrets connection is disabled.",
        409,
      );
    const resource = this.bindings(row).find((item) => item.id === resourceId);
    if (!resource)
      throw new DomainError(
        "secret_resource_denied",
        "This resource is not enrolled in the selected Secrets connection.",
        403,
      );
    const adapter = secretAdapter(row.provider_kind);
    const provider = await adapter.connect(
      this.context,
      workspaceId,
      row.credential_ref,
    );
    await provider.checkResources([resource]);
    return { row, resource, adapter, provider };
  }

  async scopes(input: unknown) {
    const { workspaceId, connectionId, resourceId, page } =
      secretScopesInput.parse(input);
    await authorize(this.context, workspaceId);
    const selected = await this.resource(workspaceId, connectionId, resourceId);
    const result = await selected.provider.scopes(selected.resource, page);
    await this.recheck(
      workspaceId,
      selected.row,
      selected.resource,
      selected.provider.identity,
    );
    return result;
  }

  async inventory(input: unknown) {
    const { workspaceId, connectionId, target, entryKind, page } =
      secretInventoryInput.parse(input);
    await authorize(this.context, workspaceId);
    const selected = await this.resource(
      workspaceId,
      connectionId,
      target.resourceId,
    );
    if (!selected.adapter.capabilities.scopeKinds.includes(target.scope.kind))
      throw new DomainError(
        "secret_scope_invalid",
        "This provider does not support the selected scope.",
        400,
      );
    if (!selected.adapter.capabilities.entryKinds.includes(entryKind))
      throw new DomainError(
        "secret_inventory_kind_invalid",
        "This provider does not support the selected inventory kind.",
        400,
      );
    const result = await selected.provider.inventory(
      selected.resource,
      target.scope,
      entryKind,
      page,
    );
    const items = z
      .array(secretInventoryItemSchema)
      .max(SECRET_LIMITS.PAGE_SIZE)
      .safeParse(result.items);
    if (
      !items.success ||
      result.providerKind !== selected.adapter.kind ||
      result.entryKind !== entryKind ||
      result.resource.id !== target.resourceId ||
      result.target.resourceId !== target.resourceId ||
      !sameScope(result.target.scope, target.scope) ||
      result.page !== page ||
      items.data.some((item) => item.kind !== entryKind)
    )
      throw new DomainError(
        "secret_provider_invalid",
        "The provider adapter returned an invalid configuration inventory. No partial result was accepted.",
        503,
      );
    await this.recheck(
      workspaceId,
      selected.row,
      selected.resource,
      selected.provider.identity,
    );
    const managedKeys = items.data.map((item) =>
      managedDestinationKey(result.providerKind, entryKind, {
        connectionId,
        connectionRevision: selected.row.revision,
        target,
        name: item.name,
      }),
    );
    const managed = managedKeys.length
      ? (
          await this.db
            .prepare(
              `SELECT d.destination_key AS destinationKey,d.configuration_id AS configurationId
            FROM managed_configuration_destinations d
            JOIN managed_configurations m ON m.workspace_id=d.workspace_id AND m.id=d.configuration_id
            WHERE d.workspace_id=? AND m.state='active'
              AND d.destination_key IN (SELECT value FROM json_each(?))`,
            )
            .bind(
              workspaceId,
              JSON.stringify(managedKeys),
            )
            .all<{ destinationKey: string; configurationId: string }>()
        ).results
      : [];
    await authorize(this.context, workspaceId);
    return {
      ...result,
      items: items.data.map((item, index) => {
        const configuration = managed.find(
          (candidate) => candidate.destinationKey === managedKeys[index],
        );
        return configuration
          ? {
              ...item,
              management: SECRET_MANAGEMENT.HQ,
              managedConfigurationId: configuration.configurationId,
            }
          : item;
      }),
    };
  }

  async recheck(
    workspaceId: string,
    row: SecretConnectionRow,
    resource: SecretResourceBinding,
    providerIdentity: string,
  ) {
    await authorize(this.context, workspaceId);
    const current = await this.connection(workspaceId, row.id);
    if (
      current.revision !== row.revision ||
      !current.enabled ||
      current.provider_kind !== row.provider_kind
    )
      throw new DomainError(
        "revision_conflict",
        "Secrets enrollment or provider authority changed during the read. Refresh before continuing.",
        409,
      );
    const provider = await secretAdapter(current.provider_kind).connect(
      this.context,
      workspaceId,
      current.credential_ref,
    );
    if (provider.identity !== providerIdentity)
      throw new DomainError(
        "revision_conflict",
        "Secrets provider authority changed during the read. Refresh before continuing.",
        409,
      );
    await provider.checkResources([resource]);
  }
}
