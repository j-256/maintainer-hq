import { CAPABILITY, ROLE_CAPABILITIES, type Role } from "../shared/domain";
import {
  SYNC_LIMITS,
  SYNC_CAPACITY,
  VIEW_COLLECTIONS,
  syncKey,
  syncRecordsSchema,
  workspaceChangesInput,
  workspaceViewInput,
  type SyncCollection,
  type SyncScope,
  type SyncUpdate,
  type WorkspaceView,
} from "../shared/workspace-sync";
import { DomainError } from "./errors";
import { authorizeHooks } from "./hook-authority";
import type { WorkspaceService } from "./service";

type RecordRow = { record_key: string; record_json: string };
type KeyRow = { collection: SyncCollection; key: string };

// Explicit projections keep private columns out of both bootstrap and delta responses
const PROJECTIONS: Record<SyncCollection, string> = {
  projects: `SELECT id AS record_key,json_object('id',id,'workspaceId',workspace_id,'name',name,'description',description,
    'lifecycle',lifecycle,'importance',importance,'importanceNote',importance_note,'portfolio',json(portfolio_json),
    'revision',revision,'updatedAt',updated_at) AS record_json
    FROM projects WHERE workspace_id=?`,
  repositories: `SELECT id AS record_key,json_object('id',id,'workspaceId',workspace_id,'fullName',full_name,
    'description',description,'projectId',project_id,'classification',classification,'lifecycle',lifecycle,
    'expectations',json(expectations_json),'revision',revision,'updatedAt',updated_at) AS record_json
    FROM repositories WHERE workspace_id=?`,
  observations: `SELECT json_array(o.source_id,o.resource_type,o.resource_id) AS record_key,
    json_object('sourceId',o.source_id,'resourceType',o.resource_type,'resourceId',o.resource_id,'name',o.name,
    'health',o.health,'summary',o.summary,'details',json(o.details_json),'observedAt',o.observed_at,
    'expiresAt',o.expires_at,'receivedAt',o.received_at,'provider',c.provider) AS record_json
    FROM observations o JOIN connections c ON c.workspace_id=o.workspace_id AND c.id=o.source_id
    WHERE o.workspace_id=? AND (c.provider NOT IN ('local','github') OR EXISTS
      (SELECT 1 FROM source_repositories s WHERE s.workspace_id=o.workspace_id AND s.source_id=o.source_id AND s.repository_id=o.resource_id))`,
  connections: `SELECT id AS record_key,'{}' AS record_json FROM connections WHERE workspace_id=?`,
  goals: `SELECT id AS record_key,json_object('id',id,'sourceId',source_id,'objective',objective,'status',status,
    'actor',actor_name,'startedAt',started_at,'reportedAt',reported_at,'receivedAt',received_at) AS record_json
    FROM goals WHERE workspace_id=?`,
};

export class WorkspaceSync {
  constructor(readonly context: WorkspaceService) {}
  private async read(
    workspaceId: string,
    scope: SyncScope,
    from?: number,
    expectedMemberRevision?: number,
  ) {
    const { db } = this.context;
    const collections = VIEW_COLLECTIONS[scope.view];
    const memberRevision = await authorizeHooks(this.context, workspaceId);
    if (
      expectedMemberRevision !== undefined &&
      expectedMemberRevision !== memberRevision
    )
      return {
        type: "reset",
        cursor: from ?? 0,
        reason: "authority_changed",
      } as const;
    for (
      let attempt = 0;
      attempt < SYNC_LIMITS.CONSISTENCY_ATTEMPTS;
      attempt++
    ) {
      const statements = [
        db
          .prepare(
            "SELECT COALESCE((SELECT cursor FROM workspace_sync_clock WHERE workspace_id=w.id),0) AS cursor,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE w.id=? AND m.subject=?",
          )
          .bind(workspaceId, this.context.principal.subject),
        db
          .prepare(
            "SELECT COALESCE(MAX(floor),0) AS floor FROM workspace_sync_retention WHERE workspace_id=? AND collection IN (SELECT value FROM json_each(?))",
          )
          .bind(workspaceId, JSON.stringify(collections)),
        db
          .prepare(
            "SELECT collection,record_key AS key FROM workspace_changes WHERE workspace_id=? AND cursor>? AND collection IN (SELECT value FROM json_each(?)) AND (? IS NULL OR collection NOT IN ('repositories','observations') OR (collection='repositories' AND record_key=?) OR CASE WHEN collection='observations' THEN json_extract(record_key,'$[2]') END=?) ORDER BY cursor,collection,record_key LIMIT ?",
          )
          .bind(
            workspaceId,
            from ?? Number.MAX_SAFE_INTEGER,
            JSON.stringify(collections),
            scope.repositoryId ?? null,
            scope.repositoryId ?? null,
            scope.repositoryId ?? null,
            SYNC_LIMITS.CHANGES + 1,
          ),
      ];
      for (const collection of collections) {
        let projection = PROJECTIONS[collection];
        const bindings: (string | number)[] = [workspaceId];
        if (scope.repositoryId && collection === "repositories") {
          projection += " AND id=?";
          bindings.push(scope.repositoryId);
        }
        if (scope.repositoryId && collection === "observations") {
          projection += " AND o.resource_type='repository' AND o.resource_id=?";
          bindings.push(scope.repositoryId);
        }
        let sql = `SELECT record_key,record_json FROM (${projection}) r`;
        if (from !== undefined) {
          sql +=
            " WHERE record_key IN (SELECT record_key FROM workspace_changes WHERE workspace_id=? AND collection=? AND cursor>?)";
          bindings.push(workspaceId, collection, from);
        }
        sql += " ORDER BY record_key LIMIT ?";
        bindings.push(
          from === undefined
            ? SYNC_CAPACITY[collection] + 1
            : SYNC_LIMITS.CHANGES + 1,
        );
        statements.push(db.prepare(sql).bind(...bindings));
      }
      const result = await db.batch(statements);
      const header = result[0].results[0] as
        | { cursor: number; name: string; role: Role }
        | undefined;
      if (!header)
        throw new DomainError(
          "forbidden",
          "Workspace access changed during the read",
          403,
        );
      const { cursor } = header;
      const floor = (result[1].results[0] as { floor: number }).floor;
      const keys = result[2].results as KeyRow[];
      if (from !== undefined && (from < floor || from > cursor))
        return { type: "reset", cursor, reason: "history_expired" } as const;
      if (from !== undefined && keys.length > SYNC_LIMITS.CHANGES)
        return { type: "reset", cursor, reason: "overflow" } as const;
      const raw: Record<string, unknown[]> = {};
      for (const [index, collection] of collections.entries()) {
        const rows = result[index + 3].results as RecordRow[];
        if (rows.length > SYNC_CAPACITY[collection])
          throw new DomainError(
            "capacity",
            `The ${collection} inventory exceeds the supported view limit`,
            409,
          );
        if (collection === "connections") {
          if (rows.length)
            raw.connections = await this.context.connections(
              { workspaceId },
              rows.map((row) => row.record_key),
            );
          else if (from === undefined) raw.connections = [];
        } else if (rows.length || from === undefined) {
          raw[collection] = rows.map((row) => JSON.parse(row.record_json));
        }
      }
      // Connection descriptors include live credential availability and cooldown state
      // A changed clock retries the read rather than attaching later data to an earlier cursor
      if (collections.includes("connections")) {
        const after = await db
          .prepare(
            "SELECT COALESCE((SELECT cursor FROM workspace_sync_clock WHERE workspace_id=?),0) AS cursor",
          )
          .bind(workspaceId)
          .first<{ cursor: number }>();
        if (after?.cursor !== cursor) continue;
      }
      if ((await authorizeHooks(this.context, workspaceId)) !== memberRevision)
        throw new DomainError(
          "forbidden",
          "Workspace access changed during the read",
          403,
        );
      const records = syncRecordsSchema.parse(raw);
      const present = new Set(
        collections.flatMap((collection) =>
          (records[collection] ?? []).map(
            (record) => collection + ":" + syncKey(collection, record),
          ),
        ),
      );
      const removals = keys.filter(
        ({ collection, key }) => !present.has(collection + ":" + key),
      );
      if (from === undefined)
        return {
          type: "bootstrap",
          cursor,
          records,
          memberRevision,
          workspace: { id: workspaceId, name: header.name, role: header.role },
        } as const;
      const update: SyncUpdate = {
        type: "delta",
        from,
        cursor,
        upserts: records,
        removals,
        generatedAt: new Date(this.context.now()).toISOString(),
      };
      if (
        new TextEncoder().encode(JSON.stringify(update)).byteLength >
        SYNC_LIMITS.FRAME_BYTES - SYNC_LIMITS.ENVELOPE_BYTES
      )
        return { type: "reset", cursor, reason: "overflow" } as const;
      return update;
    }
    const row = await db
      .prepare("SELECT cursor FROM workspace_sync_clock WHERE workspace_id=?")
      .bind(workspaceId)
      .first<{ cursor: number }>();
    return {
      type: "reset",
      cursor: row?.cursor ?? 0,
      reason: "concurrent_changes",
    } as const;
  }

  async view(input: unknown): Promise<WorkspaceView> {
    const { workspaceId, ...scope } = workspaceViewInput.parse(input);
    const result = await this.read(workspaceId, scope);
    if (result.type !== "bootstrap")
      throw new DomainError(
        "conflict",
        "This view changed while loading. Try refreshing again.",
        409,
      );
    return {
      workspace: result.workspace,
      scope,
      cursor: result.cursor,
      records: result.records,
      memberRevision: result.memberRevision,
      principal: {
        subject: this.context.principal.subject,
        displayName: this.context.principal.displayName,
      },
      capabilities: ROLE_CAPABILITIES[result.workspace.role].filter(
        (capability) =>
          !this.context.principal.scopes ||
          this.context.principal.scopes.includes(capability),
      ),
      development: this.context.development,
      generatedAt: new Date(this.context.now()).toISOString(),
    };
  }

  async changes(input: unknown): Promise<SyncUpdate> {
    const { workspaceId, cursor, memberRevision, ...scope } =
      workspaceChangesInput.parse(input);
    await this.context.authorize(workspaceId, CAPABILITY.READ);
    const result = await this.read(workspaceId, scope, cursor, memberRevision);
    if (result.type === "bootstrap")
      throw new Error("Unexpected view bootstrap");
    return result;
  }
}
