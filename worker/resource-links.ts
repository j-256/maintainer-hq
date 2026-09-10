import { CAPABILITY } from "../shared/domain";
import {
  RESOURCE_KIND,
  RESOURCE_LINK_LIMITS,
  repositoryResourcesInput,
  resourceLinksSaveInput,
  resourceReferenceInput,
  type RepositoryResource,
  type RepositoryResources,
  type ResourceLinks,
  type ResourceReference,
} from "../shared/resource-links";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import { captureProjectActivity } from "./project-resources";
import type { WorkspaceService } from "./service";

const identitySql =
  "workspace_id=? AND kind=? AND connection_id=? AND resource_key=?";
function identityValues(reference: ResourceReference) {
  return [
    reference.workspaceId,
    reference.kind,
    reference.connectionId,
    reference.resourceKey,
  ];
}

export function captureResourceActivity(
  db: D1Database,
  workspaceId: string,
  eventId: string,
  connectionId: string,
  kind: ResourceReference["kind"] | null = null,
  resourceKey: string | null = null,
) {
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO activity_repository_links (workspace_id,event_id,repository_id)
    SELECT workspace_id,?,repository_id FROM repository_resource_links
    WHERE workspace_id=? AND connection_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR resource_key=?)
      AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
      )
      .bind(
        eventId,
        workspaceId,
        connectionId,
        kind,
        kind,
        resourceKey,
        resourceKey,
        workspaceId,
        eventId,
      ),
    captureProjectActivity(
      db,
      workspaceId,
      eventId,
      connectionId,
      kind,
      resourceKey,
    ),
  ];
}

export function copyActivityContext(
  db: D1Database,
  workspaceId: string,
  sourceEventId: string,
  eventId: string,
) {
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO activity_repository_links (workspace_id,event_id,repository_id)
    SELECT workspace_id,?,repository_id FROM activity_repository_links
    WHERE workspace_id=? AND event_id=? AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
      )
      .bind(eventId, workspaceId, sourceEventId, workspaceId, eventId),
    db
      .prepare(
        `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
      SELECT workspace_id,?,project_id FROM activity_project_links WHERE workspace_id=? AND event_id=?
        AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
      )
      .bind(eventId, workspaceId, sourceEventId, workspaceId, eventId),
  ];
}

export class ResourceLinksService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }

  private async reference(reference: ResourceReference) {
    const provider =
      reference.kind === RESOURCE_KIND.HOOK ? "hookrelay" : "endpoint-monitor";
    const guard = hookActorGuard(this.context, reference.workspaceId);
    const row = await this.db
      .prepare(
        `SELECT revision FROM connections
      WHERE workspace_id=? AND id=? AND provider=? AND ${guard.sql}`,
      )
      .bind(
        reference.workspaceId,
        reference.connectionId,
        provider,
        ...guard.values,
      )
      .first<{ revision: number }>();
    if (!row) {
      throw new DomainError(
        "not_found",
        "Resource connection not found or access changed.",
        404,
      );
    }
    if (
      reference.kind === RESOURCE_KIND.MONITOR &&
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(reference.resourceKey)
    ) {
      throw new DomainError(
        "validation",
        "Monitor target identity is invalid.",
        400,
      );
    }
    return row;
  }

  async get(input: unknown): Promise<ResourceLinks> {
    const reference = resourceReferenceInput.parse(input);
    await authorizeHooks(this.context, reference.workspaceId);
    const connection = await this.reference(reference);
    const [metadata, links] = await this.db.batch([
      this.db
        .prepare(
          `SELECT revision,updated_at AS updatedAt FROM repository_resource_associations WHERE ${identitySql}`,
        )
        .bind(...identityValues(reference)),
      this.db
        .prepare(
          `SELECT repository_id AS repositoryId FROM repository_resource_links WHERE ${identitySql} ORDER BY repository_id`,
        )
        .bind(...identityValues(reference)),
    ]);
    await authorizeHooks(this.context, reference.workspaceId);
    const row = metadata.results[0] as
      { revision: number; updatedAt: string } | undefined;
    return {
      ...reference,
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
      connectionRevision: connection.revision,
      repositoryIds: (links.results as { repositoryId: string }[]).map(
        (value) => value.repositoryId,
      ),
    };
  }

  async forResources(
    workspaceId: string,
    kind: ResourceReference["kind"],
    connectionId: string,
    resourceKeys: string[],
  ) {
    if (resourceKeys.length > RESOURCE_LINK_LIMITS.REPOSITORIES) {
      throw new DomainError(
        "capacity",
        "Resource association read exceeds the supported page size.",
        400,
      );
    }
    await authorizeHooks(this.context, workspaceId);
    const keys = [...new Set(resourceKeys)];
    if (!keys.length) return [];
    const reference = resourceReferenceInput.parse({
      workspaceId,
      kind,
      connectionId,
      resourceKey: keys[0],
    });
    const connection = await this.reference(reference);
    const rows = await this.db
      .prepare(
        `SELECT a.resource_key AS resourceKey,a.revision,a.updated_at AS updatedAt,l.repository_id AS repositoryId
      FROM repository_resource_associations a LEFT JOIN repository_resource_links l
        ON l.workspace_id=a.workspace_id AND l.kind=a.kind AND l.connection_id=a.connection_id AND l.resource_key=a.resource_key
      WHERE a.workspace_id=? AND a.kind=? AND a.connection_id=? AND a.resource_key IN (SELECT value FROM json_each(?))
      ORDER BY a.resource_key,l.repository_id`,
      )
      .bind(workspaceId, kind, connectionId, JSON.stringify(keys))
      .all<{
        resourceKey: string;
        revision: number;
        updatedAt: string;
        repositoryId: string | null;
      }>();
    const result = new Map<string, ResourceLinks>(
      keys.map((resourceKey) => [
        resourceKey,
        {
          ...reference,
          resourceKey,
          revision: 0,
          connectionRevision: connection.revision,
          repositoryIds: [],
          updatedAt: null,
        },
      ]),
    );
    for (const row of rows.results) {
      const value = result.get(row.resourceKey)!;
      value.revision = row.revision;
      value.updatedAt = row.updatedAt;
      if (row.repositoryId) value.repositoryIds.push(row.repositoryId);
    }
    await authorizeHooks(this.context, workspaceId);
    return [...result.values()];
  }

  async save(input: unknown): Promise<ResourceLinks> {
    const parsed = resourceLinksSaveInput.parse(input);
    const { workspaceId, revision } = parsed;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const connection = await this.reference(parsed);
    if (connection.revision !== parsed.connectionRevision) {
      throw new DomainError(
        "revision_conflict",
        "The resource connection changed. Load saved links and review the connection again.",
        409,
      );
    }
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const now = new Date(this.context.now()).toISOString();
    const repositoryIds = JSON.stringify([...parsed.repositoryIds].sort());
    const applied = `EXISTS (SELECT 1 FROM repository_resource_associations WHERE ${identitySql} AND write_id=?)`;
    const appliedValues = [...identityValues(parsed), writeId];
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO repository_resource_associations
        (workspace_id,kind,connection_id,resource_key,revision,write_id,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}
          AND EXISTS (SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=?)
          AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS
            (SELECT 1 FROM repositories r WHERE r.workspace_id=? AND r.id=j.value))
          AND ((?=0 AND (SELECT COUNT(*) FROM repository_resource_associations WHERE workspace_id=?) < ?)
            OR EXISTS (SELECT 1 FROM repository_resource_associations WHERE ${identitySql} AND revision=?))
        ON CONFLICT(workspace_id,kind,connection_id,resource_key) DO UPDATE SET
          revision=excluded.revision,write_id=excluded.write_id,updated_at=excluded.updated_at
        WHERE repository_resource_associations.revision=?`,
        )
        .bind(
          ...identityValues(parsed),
          revision + 1,
          writeId,
          now,
          ...guard.values,
          workspaceId,
          parsed.connectionId,
          parsed.connectionRevision,
          repositoryIds,
          workspaceId,
          revision,
          workspaceId,
          RESOURCE_LINK_LIMITS.ASSOCIATIONS,
          ...identityValues(parsed),
          revision,
          revision,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${applied}`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "resource.repositories.updated",
          "Repository links saved",
          "Updated the repositories related to " +
            parsed.resourceKey +
            ". Provider configuration was not changed.",
          now,
          ...appliedValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links (workspace_id,event_id,repository_id)
        SELECT ?,?,repositoryId FROM (
          SELECT repository_id AS repositoryId FROM repository_resource_links WHERE ${identitySql}
          UNION SELECT value AS repositoryId FROM json_each(?)
        ) WHERE ${applied}`,
        )
        .bind(
          workspaceId,
          eventId,
          ...identityValues(parsed),
          repositoryIds,
          ...appliedValues,
        ),
      this.db
        .prepare(
          `DELETE FROM repository_resource_links WHERE ${identitySql} AND ${applied}`,
        )
        .bind(...identityValues(parsed), ...appliedValues),
      this.db
        .prepare(
          `INSERT INTO repository_resource_links (workspace_id,kind,connection_id,resource_key,repository_id)
        SELECT ?,?,?,?,value FROM json_each(?) WHERE ${applied}`,
        )
        .bind(...identityValues(parsed), repositoryIds, ...appliedValues),
      captureProjectActivity(
        this.db,
        workspaceId,
        eventId,
        parsed.connectionId,
        parsed.kind,
        parsed.resourceKey,
      ),
    ]);
    if (!result[0]!.meta.changes) {
      throw new DomainError(
        "revision_conflict",
        "Repository links, access, or capacity changed. Keep your draft and load saved links before trying again.",
        409,
      );
    }
    return this.get(
      resourceReferenceInput.parse({
        workspaceId,
        kind: parsed.kind,
        connectionId: parsed.connectionId,
        resourceKey: parsed.resourceKey,
      }),
    );
  }

  async forRepository(input: unknown): Promise<RepositoryResources> {
    const { workspaceId, repositoryId, kind, cursor } =
      repositoryResourcesInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    if (
      !(await this.db
        .prepare("SELECT 1 FROM repositories WHERE workspace_id=? AND id=?")
        .bind(workspaceId, repositoryId)
        .first())
    ) {
      throw new DomainError("not_found", "Repository not found.", 404);
    }
    if (
      cursor &&
      (cursor.workspaceId !== workspaceId ||
        cursor.repositoryId !== repositoryId ||
        cursor.filter !== kind)
    ) {
      throw new DomainError(
        "invalid_cursor",
        "This resource page does not match the repository or filter.",
        400,
      );
    }
    const guard = hookActorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT l.kind,l.connection_id AS connectionId,l.resource_key AS resourceKey,
      c.name AS connectionName,c.enabled AS connectionEnabled,c.revision AS connectionRevision,a.revision,a.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM repository_resource_links related WHERE related.workspace_id=l.workspace_id
        AND related.kind=l.kind AND related.connection_id=l.connection_id AND related.resource_key=l.resource_key) AS repositoryCount
      FROM repository_resource_links l JOIN connections c ON c.workspace_id=l.workspace_id AND c.id=l.connection_id
      JOIN repository_resource_associations a ON a.workspace_id=l.workspace_id AND a.kind=l.kind
        AND a.connection_id=l.connection_id AND a.resource_key=l.resource_key
      WHERE l.workspace_id=? AND l.repository_id=? AND (? IS NULL OR l.kind=?) AND ${guard.sql}
        AND (?=0 OR (l.kind,l.connection_id,l.resource_key) > (?,?,?))
      ORDER BY l.kind,l.connection_id,l.resource_key LIMIT ?`,
      )
      .bind(
        workspaceId,
        repositoryId,
        kind,
        kind,
        ...guard.values,
        Number(Boolean(cursor)),
        cursor?.kind ?? "",
        cursor?.connectionId ?? "",
        cursor?.resourceKey ?? "",
        RESOURCE_LINK_LIMITS.PAGE_SIZE + 1,
      )
      .all<
        Omit<RepositoryResource, "connectionEnabled"> & {
          connectionEnabled: number;
        }
      >();
    const items = rows.results
      .slice(0, RESOURCE_LINK_LIMITS.PAGE_SIZE)
      .map((row) => ({
        ...row,
        connectionEnabled: Boolean(row.connectionEnabled),
      }));
    const last = items.at(-1);
    await authorizeHooks(this.context, workspaceId);
    return {
      items,
      nextCursor:
        rows.results.length > RESOURCE_LINK_LIMITS.PAGE_SIZE && last
          ? {
              workspaceId,
              repositoryId,
              filter: kind,
              kind: last.kind,
              connectionId: last.connectionId,
              resourceKey: last.resourceKey,
            }
          : null,
    };
  }
}
