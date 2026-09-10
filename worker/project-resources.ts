import { CAPABILITY, idSchema } from "../shared/domain";
import {
  PROJECT_RESOURCE_LIMITS,
  projectResourcesInput,
  resourceProjectInput,
  resourceProjectSaveInput,
  type ProjectResource,
  type ProjectResources,
  type ResourceProject,
  type ResourceProjectReference,
} from "../shared/project-resources";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";

const TABLES = Object.freeze({
  hook: { name: "hook_associations", key: "subscription" },
  monitor: { name: "monitor_project_associations", key: "target_id" },
  secret: { name: "secret_project_associations", key: "resource_id" },
});

export function captureProjectActivity(
  db: D1Database,
  workspaceId: string,
  eventId: string,
  connectionId: string | null = null,
  kind: ResourceProjectReference["kind"] | null = null,
  resourceKey: string | null = null,
  projectIds: (string | null)[] = [],
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
    SELECT p.workspace_id,?,p.id FROM projects p WHERE p.workspace_id=? AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=p.workspace_id AND id=?) AND (
      p.id IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM activity_repository_links l JOIN repositories r ON r.workspace_id=l.workspace_id AND r.id=l.repository_id
        WHERE l.workspace_id=p.workspace_id AND l.event_id=? AND r.project_id=p.id)
      OR EXISTS (SELECT 1 FROM project_resource_associations a WHERE a.workspace_id=p.workspace_id AND a.project_id=p.id
        AND a.connection_id=? AND (? IS NULL OR a.kind=?) AND (? IS NULL OR a.resource_key=?)))`,
    )
    .bind(
      eventId,
      workspaceId,
      eventId,
      JSON.stringify(projectIds.filter(Boolean)),
      eventId,
      connectionId,
      kind,
      kind,
      resourceKey,
      resourceKey,
    );
}

export function captureSecretProjectActivity(
  db: D1Database,
  workspaceId: string,
  eventId: string,
  reviewId: string,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
    SELECT p.workspace_id,?,p.id FROM projects p WHERE p.workspace_id=?
      AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=p.workspace_id AND id=?) AND (
      EXISTS (SELECT 1 FROM activity_repository_links l JOIN repositories r ON r.workspace_id=l.workspace_id AND r.id=l.repository_id
        WHERE l.workspace_id=p.workspace_id AND l.event_id=? AND r.project_id=p.id)
      OR EXISTS (SELECT 1 FROM secret_project_associations a JOIN secret_reviews review ON review.workspace_id=a.workspace_id
        WHERE a.workspace_id=p.workspace_id AND a.project_id=p.id AND review.id=? AND (
          EXISTS (SELECT 1 FROM json_each(review.request_json,'$.destinations') destination
            WHERE json_extract(destination.value,'$.connectionId')=a.connection_id AND json_extract(destination.value,'$.target.resourceId')=a.resource_id)
          OR (json_extract(review.request_json,'$.source.connectionId')=a.connection_id AND json_extract(review.request_json,'$.source.target.resourceId')=a.resource_id))))`,
    )
    .bind(eventId, workspaceId, eventId, eventId, reviewId);
}

export class ProjectResourcesService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }

  private async reference(reference: ResourceProjectReference) {
    const { workspaceId, connectionId, kind, resourceKey } = reference;
    if (
      (kind === "monitor" &&
        !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(resourceKey)) ||
      (kind === "secret" && !idSchema.safeParse(resourceKey).success)
    )
      throw new DomainError(
        "validation",
        "Resource identity is invalid for this provider kind",
        400,
      );
    const guard = hookActorGuard(this.context, workspaceId);
    const row =
      kind === "secret"
        ? await this.db
            .prepare(
              `SELECT revision FROM secret_connections WHERE workspace_id=? AND id=? AND ${guard.sql}
          AND EXISTS (SELECT 1 FROM json_each(resources_json) resource WHERE json_extract(resource.value,'$.id')=?)`,
            )
            .bind(workspaceId, connectionId, ...guard.values, resourceKey)
            .first<{ revision: number }>()
        : await this.db
            .prepare(
              `SELECT revision FROM connections WHERE workspace_id=? AND id=? AND provider=? AND ${guard.sql}`,
            )
            .bind(
              workspaceId,
              connectionId,
              kind === "hook" ? "hookrelay" : "endpoint-monitor",
              ...guard.values,
            )
            .first<{ revision: number }>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Resource enrollment not found or workspace access changed",
        404,
      );
    return row;
  }

  async get(input: unknown): Promise<ResourceProject> {
    const reference = resourceProjectInput.parse(input);
    await authorizeHooks(this.context, reference.workspaceId);
    const connection = await this.reference(reference);
    const table = TABLES[reference.kind];
    const row = await this.db
      .prepare(
        `SELECT project_id AS projectId,revision,updated_at AS updatedAt FROM ${table.name}
      WHERE workspace_id=? AND connection_id=? AND ${table.key}=?`,
      )
      .bind(
        reference.workspaceId,
        reference.connectionId,
        reference.resourceKey,
      )
      .first<{
        projectId: string | null;
        revision: number;
        updatedAt: string | null;
      }>();
    await authorizeHooks(this.context, reference.workspaceId);
    return {
      ...reference,
      connectionRevision: connection.revision,
      projectId: row?.projectId ?? null,
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async save(input: unknown): Promise<ResourceProject> {
    const parsed = resourceProjectSaveInput.parse(input);
    const {
      workspaceId,
      connectionId,
      kind,
      resourceKey,
      projectId,
      revision,
      connectionRevision,
      projectRevision,
    } = parsed;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const before = await this.get(
      resourceProjectInput.parse({
        workspaceId,
        connectionId,
        kind,
        resourceKey,
      }),
    );
    if (
      before.revision !== revision ||
      before.connectionRevision !== connectionRevision
    )
      this.conflict();
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const table = TABLES[kind];
    const timestamp = new Date(this.context.now()).toISOString();
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const connectionSql =
      kind === "secret"
        ? "EXISTS (SELECT 1 FROM secret_connections WHERE workspace_id=? AND id=? AND revision=? AND EXISTS (SELECT 1 FROM json_each(resources_json) resource WHERE json_extract(resource.value,'$.id')=?))"
        : "EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND provider=?)";
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO ${table.name} (workspace_id,connection_id,${table.key},project_id,revision,write_id,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE ${guard.sql} AND ${connectionSql}
          AND EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND revision=?)
          AND ((?=0 AND (SELECT COUNT(*) FROM ${table.name} WHERE workspace_id=? AND connection_id=?) < ?)
            OR EXISTS (SELECT 1 FROM ${table.name} WHERE workspace_id=? AND connection_id=? AND ${table.key}=? AND revision=?))
        ON CONFLICT(workspace_id,connection_id,${table.key}) DO UPDATE SET project_id=excluded.project_id,revision=excluded.revision,write_id=excluded.write_id,updated_at=excluded.updated_at
        WHERE ${table.name}.revision=?`,
        )
        .bind(
          workspaceId,
          connectionId,
          resourceKey,
          projectId,
          revision + 1,
          writeId,
          timestamp,
          ...guard.values,
          workspaceId,
          connectionId,
          connectionRevision,
          kind === "secret"
            ? resourceKey
            : kind === "hook"
              ? "hookrelay"
              : "endpoint-monitor",
          workspaceId,
          projectId,
          projectRevision,
          revision,
          workspaceId,
          connectionId,
          PROJECT_RESOURCE_LIMITS.ASSOCIATIONS,
          workspaceId,
          connectionId,
          resourceKey,
          revision,
          revision,
        ),
      this.db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'resource.project.updated','Resource project association saved',?,? WHERE EXISTS
          (SELECT 1 FROM ${table.name} WHERE workspace_id=? AND connection_id=? AND ${table.key}=? AND write_id=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "Updated HQ project context for " +
            resourceKey +
            ". Provider configuration and permissions were not changed.",
          timestamp,
          workspaceId,
          connectionId,
          resourceKey,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT c.workspace_id,?,c.repository_id FROM project_resource_repository_context c JOIN repositories r ON r.workspace_id=c.workspace_id AND r.id=c.repository_id
        WHERE c.workspace_id=? AND c.kind=? AND c.connection_id=? AND c.resource_key=? AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          kind,
          connectionId,
          resourceKey,
          workspaceId,
          eventId,
        ),
      captureProjectActivity(
        this.db,
        workspaceId,
        eventId,
        connectionId,
        kind,
        resourceKey,
        [before.projectId, projectId],
      ),
    ]);
    if (!result[0].meta.changes) this.conflict();
    return this.get({ workspaceId, connectionId, kind, resourceKey });
  }

  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "The resource association, selected project, connection, or access changed. Keep your draft and load saved metadata before retrying.",
      409,
    );
  }

  async forProject(input: unknown): Promise<ProjectResources> {
    const { workspaceId, projectId, kind, cursor } =
      projectResourcesInput.parse(input);
    await this.context.project({ workspaceId, projectId });
    if (
      cursor &&
      (cursor.workspaceId !== workspaceId ||
        cursor.projectId !== projectId ||
        cursor.filter !== kind)
    )
      throw new DomainError(
        "invalid_cursor",
        "This resource page does not match the project or filter",
        400,
      );
    const guard = hookActorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `WITH repository_context AS MATERIALIZED (
      SELECT c.*,r.project_id FROM project_resource_repository_context c JOIN repositories r
        ON r.workspace_id=c.workspace_id AND r.id=c.repository_id WHERE c.workspace_id=?
    ), known AS (
      SELECT workspace_id,kind,connection_id,resource_key FROM project_resource_associations WHERE workspace_id=? AND project_id=?
      UNION SELECT workspace_id,kind,connection_id,resource_key FROM repository_context WHERE project_id=?
    ), enrolled AS (
      SELECT k.*,c.name AS connectionName,c.enabled AS connectionEnabled,c.revision AS connectionRevision,k.resource_key AS label
        FROM known k JOIN connections c ON c.workspace_id=k.workspace_id AND c.id=k.connection_id
        WHERE (k.kind='hook' AND c.provider='hookrelay') OR (k.kind='monitor' AND c.provider='endpoint-monitor')
      UNION ALL SELECT k.*,c.name,c.enabled,c.revision,json_extract(resource.value,'$.label')
        FROM known k JOIN secret_connections c ON c.workspace_id=k.workspace_id AND c.id=k.connection_id,json_each(c.resources_json) resource
        WHERE k.kind='secret' AND json_extract(resource.value,'$.id')=k.resource_key
    ), page AS MATERIALIZED (
      SELECT k.*,a.project_id AS projectId,COALESCE(a.project_id=?,0) AS direct
      FROM enrolled k LEFT JOIN project_resource_associations a ON a.workspace_id=k.workspace_id AND a.kind=k.kind AND a.connection_id=k.connection_id AND a.resource_key=k.resource_key
      WHERE k.workspace_id=? AND (? IS NULL OR k.kind=?) AND ${guard.sql}
        AND (?=0 OR (k.kind,k.connection_id,k.resource_key)>(?,?,?)) ORDER BY k.kind,k.connection_id,k.resource_key LIMIT ?
    ) SELECT k.kind,k.connection_id AS connectionId,k.connectionName,k.connectionEnabled,k.connectionRevision,k.resource_key AS resourceKey,k.label,k.projectId,k.direct,
      (SELECT COUNT(DISTINCT l.repository_id) FROM repository_context l
        WHERE l.workspace_id=k.workspace_id AND l.kind=k.kind AND l.connection_id=k.connection_id AND l.resource_key=k.resource_key AND l.project_id=?) AS repositoryCount,
      (SELECT COUNT(DISTINCT l.repository_id) FROM repository_context l
        WHERE l.workspace_id=k.workspace_id AND l.kind=k.kind AND l.connection_id=k.connection_id AND l.resource_key=k.resource_key AND (l.project_id IS NULL OR l.project_id!=?)) AS sharedRepositoryCount
      FROM page k ORDER BY k.kind,k.connection_id,k.resource_key`,
      )
      .bind(
        workspaceId,
        workspaceId,
        projectId,
        projectId,
        projectId,
        workspaceId,
        kind,
        kind,
        ...guard.values,
        Number(Boolean(cursor)),
        cursor?.kind ?? "",
        cursor?.connectionId ?? "",
        cursor?.resourceKey ?? "",
        PROJECT_RESOURCE_LIMITS.PAGE_SIZE + 1,
        projectId,
        projectId,
      )
      .all<
        Omit<ProjectResource, "connectionEnabled" | "direct"> & {
          connectionEnabled: number;
          direct: number;
        }
      >();
    await authorizeHooks(this.context, workspaceId);
    const items = rows.results
      .slice(0, PROJECT_RESOURCE_LIMITS.PAGE_SIZE)
      .map((row) => ({
        ...row,
        connectionEnabled: Boolean(row.connectionEnabled),
        direct: Boolean(row.direct),
      }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.results.length > PROJECT_RESOURCE_LIMITS.PAGE_SIZE && last
          ? {
              workspaceId,
              projectId,
              filter: kind,
              kind: last.kind,
              connectionId: last.connectionId,
              resourceKey: last.resourceKey,
            }
          : null,
    };
  }
}
