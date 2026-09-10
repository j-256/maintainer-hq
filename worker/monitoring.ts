import { CAPABILITY, workspaceInput } from "../shared/domain";
import {
  MONITOR_LIMITS,
  monitorConnectionInput,
  monitorConnectionFields,
  monitorConnectionSaveInput,
  monitorTargetInput,
  monitorTargetsInput,
  monitorIncidentInput,
  monitorIncidentsInput,
  type MonitorConnection,
  type MonitorConnectionFields,
} from "../shared/monitoring";
import {
  authorizeHooks as authorizeOperator,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  callMonitorProvider,
  monitorProvider,
  monitorProviderReferences,
} from "./monitoring-client";
import {
  captureResourceActivity,
  ResourceLinksService,
} from "./resource-links";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export type MonitorConnectionRow = {
  id: string;
  name: string;
  enabled: number;
  revision: number;
  credential_ref: string;
  configuration_json: string;
};
const columns = "id,name,enabled,revision,credential_ref,configuration_json";
export class MonitoringService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  async connection(workspaceId: string, connectionId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${columns} FROM connections WHERE workspace_id=? AND id=? AND provider='endpoint-monitor' AND ${guard.sql}`,
      )
      .bind(workspaceId, connectionId, ...guard.values)
      .first<MonitorConnectionRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Monitoring connection not found or access changed.",
        404,
      );
    return row;
  }
  describe(row: MonitorConnectionRow, workspaceId: string): MonitorConnection {
    let fields: MonitorConnectionFields;
    try {
      fields = monitorConnectionFields.parse({
        name: row.name,
        enabled: Boolean(row.enabled),
        providerRef: row.credential_ref,
        projectId: JSON.parse(row.configuration_json).projectId ?? null,
      });
    } catch {
      throw new DomainError(
        "monitoring_configuration_invalid",
        "Monitoring connection metadata is invalid. Ask the workspace owner to repair it.",
        503,
      );
    }
    const reference = monitorProviderReferences(
      this.context.env,
      workspaceId,
    ).find((value) => value.id === fields.providerRef);
    return {
      ...fields,
      id: row.id,
      revision: row.revision,
      providerName: reference?.name ?? null,
      available: Boolean(reference?.available),
    };
  }
  async list(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const guard = actorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT ${columns} FROM connections WHERE workspace_id=? AND provider='endpoint-monitor' AND ${guard.sql} ORDER BY name,id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, MONITOR_LIMITS.CONNECTIONS + 1)
      .all<MonitorConnectionRow>();
    if (rows.results.length > MONITOR_LIMITS.CONNECTIONS)
      throw new DomainError(
        "capacity",
        "Monitoring connections exceed the supported workspace limit.",
        409,
      );
    await authorizeOperator(this.context, workspaceId);
    return rows.results.map((row) => this.describe(row, workspaceId));
  }
  async providers(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeOperator(this.context, workspaceId, CAPABILITY.ADMIN);
    return monitorProviderReferences(this.context.env, workspaceId);
  }
  async save(input: unknown) {
    const { workspaceId, connectionId, revision, connection } =
      monitorConnectionSaveInput.parse(input);
    const memberRevision = await authorizeOperator(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const existing =
      revision > 0 ? await this.connection(workspaceId, connectionId) : null;
    if (existing?.credential_ref !== connection.providerRef)
      await monitorProvider(
        this.context.env,
        workspaceId,
        connection.providerRef,
      );
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO connections (workspace_id,id,name,provider,configuration_json,credential_ref,enabled,revision,write_id)
        SELECT ?,?,?,'endpoint-monitor',?,?,?,?,? WHERE ${guard.sql}
          AND (? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND id=?))
          AND ((?=0 AND (SELECT COUNT(*) FROM connections WHERE workspace_id=? AND provider='endpoint-monitor')<?)
            OR EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND provider='endpoint-monitor' AND revision=?))
        ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,configuration_json=excluded.configuration_json,
          credential_ref=excluded.credential_ref,enabled=excluded.enabled,revision=excluded.revision,write_id=excluded.write_id
        WHERE connections.provider='endpoint-monitor' AND connections.revision=?`,
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
          MONITOR_LIMITS.CONNECTIONS,
          workspaceId,
          connectionId,
          revision,
          revision,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'monitoring.connection.updated','Monitoring connection saved',?,? WHERE EXISTS
          (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "Updated the HQ connection to " +
            connection.name +
            ". Probe configuration and notifications were not changed.",
          new Date(this.context.now()).toISOString(),
          workspaceId,
          connectionId,
          writeId,
        ),
      ...captureResourceActivity(
        this.db,
        workspaceId,
        eventId,
        connectionId,
        "monitor",
      ),
    ]);
    if (!result[0]!.meta.changes)
      throw new DomainError(
        "revision_conflict",
        "Connection, project, capacity, or access changed. Keep your draft and load saved settings before saving again.",
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
        "monitoring_connection_disabled",
        "This HQ connection is disabled. The provider's probes and notifications have not been paused.",
        409,
      );
    const provider = await monitorProvider(
      this.context.env,
      workspaceId,
      row.credential_ref,
    );
    return { row, provider };
  }
  async unchanged(workspaceId: string, row: MonitorConnectionRow) {
    await authorizeOperator(this.context, workspaceId);
    const current = await this.connection(workspaceId, row.id);
    if (current.revision !== row.revision || !current.enabled)
      throw new DomainError(
        "revision_conflict",
        "The monitoring connection changed during this read. Refresh before continuing.",
        409,
      );
  }
  async snapshot(input: unknown) {
    const { workspaceId, connectionId } = monitorConnectionInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "snapshot",
      workspaceId,
    );
    await this.unchanged(workspaceId, row);
    return response;
  }
  async configuration(input: unknown) {
    const { workspaceId, connectionId } = monitorConnectionInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "configuration",
      workspaceId,
    );
    await this.unchanged(workspaceId, row);
    return response;
  }
  async targets(input: unknown) {
    const { workspaceId, connectionId, cursor } =
      monitorTargetsInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "targets",
      workspaceId,
      { cursor },
    );
    const repositoryLinks = await new ResourceLinksService(
      this.context,
    ).forResources(
      workspaceId,
      "monitor",
      connectionId,
      response.result.items.map((value) => value.id),
    );
    await this.unchanged(workspaceId, row);
    return { ...response, repositoryLinks };
  }
  async target(input: unknown) {
    const { workspaceId, connectionId, targetId } =
      monitorTargetInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "target",
      workspaceId,
      { targetId },
    );
    if (
      response.result.items.length !== 1 ||
      response.result.items[0]?.id !== targetId
    )
      throw new DomainError(
        "monitoring_response_invalid",
        "The provider did not return the exact selected target.",
        503,
      );
    const repositoryLinks = await new ResourceLinksService(
      this.context,
    ).forResources(workspaceId, "monitor", connectionId, [targetId]);
    await this.unchanged(workspaceId, row);
    return { ...response, repositoryLinks };
  }
  async incidents(input: unknown) {
    const { workspaceId, connectionId, targetId, ...filters } =
      monitorIncidentsInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "incidents",
      workspaceId,
      { ...filters, ...(targetId ? { targetId } : {}) },
    );
    if (
      response.result.items.some(
        (item) =>
          (targetId && item.targetId !== targetId) ||
          (filters.status !== "all" && item.status !== filters.status),
      )
    )
      throw new DomainError(
        "monitoring_response_invalid",
        "The provider returned incidents outside the requested selection.",
        503,
      );
    await this.unchanged(workspaceId, row);
    return response;
  }
  async incident(input: unknown) {
    const { workspaceId, connectionId, ...identity } =
      monitorIncidentInput.parse(input);
    await authorizeOperator(this.context, workspaceId);
    const { row, provider } = await this.active(workspaceId, connectionId);
    const response = await callMonitorProvider(
      provider,
      "incident",
      workspaceId,
      identity,
    );
    if (response.result.incident.id !== identity.incidentId)
      throw new DomainError(
        "monitoring_response_invalid",
        "The provider did not return the exact selected incident.",
        503,
      );
    await this.unchanged(workspaceId, row);
    return response;
  }
}
