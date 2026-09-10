import { CAPABILITY, workspaceInput } from "../shared/domain";
import {
  HOOK_LIMITS,
  hookAssociationInput,
  hookAssociationGetInput,
  hookConnectionFields,
  hookConnectionSaveInput,
  hookConnectionInput,
  hookDeliveriesInput,
  hookDeliveryInput,
  hookSubscriptionsInput,
  type HookAssociation,
  type HookConnection,
  type HookConnectionFields,
} from "../shared/hooks";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  callHookProvider,
  hookProvider,
  hookProviderActor,
  hookProviderReferences,
} from "./hook-client";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";
import {
  captureResourceActivity,
  ResourceLinksService,
} from "./resource-links";

export type HookConnectionRow = {
  id: string;
  name: string;
  enabled: number;
  revision: number;
  credential_ref: string;
  configuration_json: string;
};
const connectionFields =
  "id, name, enabled, revision, credential_ref, configuration_json";
export class HooksService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }

  async connection(
    workspaceId: string,
    connectionId: string,
  ): Promise<HookConnectionRow> {
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${connectionFields} FROM connections WHERE workspace_id = ? AND id = ? AND provider = 'hookrelay' AND ${guard.sql}`,
      )
      .bind(workspaceId, connectionId, ...guard.values)
      .first<HookConnectionRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Hookrelay connection not found or access changed.",
        404,
      );
    return row;
  }
  describe(row: HookConnectionRow, workspaceId: string): HookConnection {
    let fields: HookConnectionFields;
    try {
      const configuration = JSON.parse(row.configuration_json);
      fields = hookConnectionFields.parse({
        name: row.name,
        enabled: Boolean(row.enabled),
        providerRef: row.credential_ref,
        projectId: configuration.projectId ?? null,
      });
    } catch {
      throw new DomainError(
        "hooks_configuration_invalid",
        "Hookrelay connection metadata is invalid. Ask the workspace owner to repair it.",
        503,
      );
    }
    const provider = hookProviderReferences(this.context.env, workspaceId).find(
      (value) => value.id === fields.providerRef,
    );
    return {
      ...fields,
      id: row.id,
      revision: row.revision,
      providerName: provider?.name ?? null,
      available: Boolean(provider?.available),
    };
  }
  async list(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const guard = hookActorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT ${connectionFields} FROM connections WHERE workspace_id = ? AND provider = 'hookrelay' AND ${guard.sql} ORDER BY name, id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, HOOK_LIMITS.CONNECTIONS + 1)
      .all<HookConnectionRow>();
    if (rows.results.length > HOOK_LIMITS.CONNECTIONS)
      throw new DomainError(
        "capacity",
        "Hooks connections exceed the supported workspace limit.",
        409,
      );
    return rows.results.map((row) => this.describe(row, workspaceId));
  }
  async providers(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.ADMIN);
    return hookProviderReferences(this.context.env, workspaceId);
  }
  private audit(
    workspaceId: string,
    title: string,
    summary: string,
    writeId: string,
    connectionId: string,
    subscription: string | null = null,
  ) {
    const eventId = crypto.randomUUID();
    const association = subscription !== null;
    return [
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
       SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ${association ? "hook_associations" : "connections"} WHERE workspace_id = ? AND write_id = ?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          association ? "hook.association.updated" : "hook.connection.updated",
          title,
          summary,
          this.timestamp(),
          workspaceId,
          writeId,
        ),
      ...captureResourceActivity(
        this.db,
        workspaceId,
        eventId,
        connectionId,
        "hook",
        subscription,
      ),
    ];
  }
  async save(input: unknown): Promise<HookConnection> {
    const fields = hookConnectionSaveInput.parse(input);
    const { workspaceId, connectionId, connection, revision } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const existing =
      revision > 0 ? await this.connection(workspaceId, connectionId) : null;
    if (existing?.credential_ref !== connection.providerRef) {
      await hookProvider(this.context.env, workspaceId, connection.providerRef);
    }
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO connections (workspace_id,id,name,provider,configuration_json,credential_ref,enabled,revision,write_id)
         SELECT ?,?,?,'hookrelay',?,?,?,?,? WHERE ${guard.sql}
           AND (? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE workspace_id = ? AND id = ?))
           AND ((? = 0 AND (SELECT COUNT(*) FROM connections WHERE workspace_id = ? AND provider = 'hookrelay') < ?)
             OR EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND provider = 'hookrelay' AND revision = ?))
         ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,configuration_json=excluded.configuration_json,
           credential_ref=excluded.credential_ref,enabled=excluded.enabled,revision=excluded.revision,write_id=excluded.write_id
         WHERE connections.provider='hookrelay' AND connections.revision=?`,
        )
        .bind(
          workspaceId,
          connectionId,
          connection.name,
          JSON.stringify({ projectId: connection.projectId }),
          connection.providerRef,
          Number(connection.enabled),
          revision + 1,
          writeId,
          ...guard.values,
          connection.projectId,
          workspaceId,
          connection.projectId,
          revision,
          workspaceId,
          HOOK_LIMITS.CONNECTIONS,
          workspaceId,
          connectionId,
          revision,
          revision,
        ),
      ...this.audit(
        workspaceId,
        "Hookrelay connection saved",
        "Updated the HQ connection to " +
          connection.name +
          ". Provider-owned routes and sinks were not changed.",
        writeId,
        connectionId,
      ),
    ]);
    if (!results[0]!.meta.changes)
      throw new DomainError(
        "revision_conflict",
        "Connection, project, capacity, or access changed. Load saved settings before saving again; keep your draft.",
        409,
      );
    return this.describe(
      await this.connection(workspaceId, connectionId),
      workspaceId,
    );
  }
  async active(workspaceId: string, connectionId: string) {
    const row = await this.connection(workspaceId, connectionId);
    if (!row.enabled)
      throw new DomainError(
        "hooks_connection_disabled",
        "This HQ connection is disabled. Hookrelay itself has not been paused.",
        409,
      );
    const provider = await hookProvider(
      this.context.env,
      workspaceId,
      row.credential_ref,
    );
    return { row, provider };
  }
  async snapshot(input: unknown) {
    const { workspaceId, connectionId } = hookConnectionInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callHookProvider(
      provider,
      "snapshot",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
    );
    await authorizeHooks(this.context, workspaceId);
    await this.unchanged(workspaceId, row);
    return { ...response, connection: this.describe(row, workspaceId) };
  }
  async unchanged(workspaceId: string, row: HookConnectionRow) {
    const current = await this.connection(workspaceId, row.id);
    if (current.revision !== row.revision || !current.enabled)
      throw new DomainError(
        "revision_conflict",
        "The Hookrelay connection changed during the request. Refresh before continuing.",
        409,
      );
  }
  async subscriptions(input: unknown) {
    const { workspaceId, connectionId, cursor } =
      hookSubscriptionsInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callHookProvider(
      provider,
      "subscriptions",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      { cursor },
    );
    await authorizeHooks(this.context, workspaceId);
    await this.unchanged(workspaceId, row);
    const names = response.result.items.map((value) => value.name);
    const associations = await this.db
      .prepare(
        "SELECT subscription,project_id AS projectId,revision FROM hook_associations WHERE workspace_id=? AND connection_id=? AND subscription IN (SELECT value FROM json_each(?))",
      )
      .bind(workspaceId, connectionId, JSON.stringify(names))
      .all<HookAssociation>();
    const repositoryLinks = await new ResourceLinksService(
      this.context,
    ).forResources(workspaceId, "hook", connectionId, names);
    await this.unchanged(workspaceId, row);
    return { ...response, associations: associations.results, repositoryLinks };
  }
  async deliveries(input: unknown) {
    const { workspaceId, connectionId, ...filters } =
      hookDeliveriesInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callHookProvider(
      provider,
      "deliveries",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      filters,
    );
    await authorizeHooks(this.context, workspaceId);
    await this.unchanged(workspaceId, row);
    return response;
  }
  async delivery(input: unknown) {
    const { workspaceId, connectionId, ...identity } =
      hookDeliveryInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callHookProvider(
      provider,
      "delivery",
      workspaceId,
      await hookProviderActor(this.context.principal.subject),
      identity,
    );
    await authorizeHooks(this.context, workspaceId);
    await this.unchanged(workspaceId, row);
    return response;
  }
  async association(input: unknown): Promise<HookAssociation> {
    const { workspaceId, connectionId, subscription } =
      hookAssociationGetInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    await this.connection(workspaceId, connectionId);
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT subscription,project_id AS projectId,revision FROM hook_associations
       WHERE workspace_id=? AND connection_id=? AND subscription=? AND ${guard.sql}`,
      )
      .bind(workspaceId, connectionId, subscription, ...guard.values)
      .first<HookAssociation>();
    await authorizeHooks(this.context, workspaceId);
    return row ?? { subscription, projectId: null, revision: 0 };
  }
  async associate(input: unknown): Promise<HookAssociation> {
    const { workspaceId, connectionId, subscription, revision, projectId } =
      hookAssociationInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const connection = await this.connection(workspaceId, connectionId);
    const project = await this.context.project({ workspaceId, projectId });
    const saved = await this.context.resourceProjectSave({
      workspaceId,
      kind: "hook",
      connectionId,
      resourceKey: subscription,
      revision,
      connectionRevision: connection.revision,
      projectId,
      projectRevision: project.revision,
    });
    return {
      subscription,
      projectId: saved.projectId,
      revision: saved.revision,
    };
  }
}
