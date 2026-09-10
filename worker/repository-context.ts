import { z } from "zod";
import { getRepositoryInput, idSchema } from "../shared/domain";
import {
  REPOSITORY_CONTEXT_LIMITS,
  type RepositoryContext,
} from "../shared/repository-context";
import { resourceKindSchema } from "../shared/resource-links";
import { secretProviderKindSchema } from "../shared/secrets";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";

const count = z.number().int().nonnegative();
const enabled = z.union([z.literal(0), z.literal(1)]).transform(Boolean);
const resourceRow = z.object({
  kind: resourceKindSchema,
  connectionId: idSchema,
  connectionName: z.string().max(120),
  connectionEnabled: enabled,
  connectionRevision: z.number().int().positive(),
  resourceKey: z.string().min(1).max(160),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  repositoryCount: count,
  total: count,
});
const secretRow = z.object({
  connectionId: idSchema,
  connectionName: z.string().max(80),
  connectionEnabled: enabled,
  providerKind: secretProviderKindSchema,
  resourceId: idSchema,
  label: z.string().min(1).max(255),
  repositoryCount: count,
  identityMatches: enabled,
  total: count,
});

export async function repositoryContext(
  context: WorkspaceService,
  input: unknown,
): Promise<RepositoryContext> {
  const { workspaceId, repositoryId } = getRepositoryInput.parse(input);
  await authorizeHooks(context, workspaceId);
  const guard = hookActorGuard(context, workspaceId);
  const repository = () =>
    context.db
      .prepare(
        `SELECT revision FROM repositories WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, repositoryId, ...guard.values)
      .first<{ revision: number }>();
  const before = await repository();
  if (!before) throw new DomainError("not_found", "Repository not found.", 404);
  const [resources, secrets] = await context.db.batch([
    context.db
      .prepare(
        `WITH linked AS (
          SELECT l.workspace_id,l.kind,l.connection_id,l.resource_key,
            c.name AS connectionName,c.enabled AS connectionEnabled,c.revision AS connectionRevision,
            a.revision,a.updated_at AS updatedAt,
            COUNT(*) OVER (PARTITION BY l.kind) AS total,
            ROW_NUMBER() OVER (PARTITION BY l.kind ORDER BY c.name,l.connection_id,l.resource_key) AS position
          FROM repository_resource_links l
          JOIN connections c ON c.workspace_id=l.workspace_id AND c.id=l.connection_id
            AND c.provider=CASE l.kind WHEN 'hook' THEN 'hookrelay' ELSE 'endpoint-monitor' END
          JOIN repository_resource_associations a ON a.workspace_id=l.workspace_id AND a.kind=l.kind
            AND a.connection_id=l.connection_id AND a.resource_key=l.resource_key
          WHERE l.workspace_id=? AND l.repository_id=? AND ${guard.sql}
        ) SELECT kind,connection_id AS connectionId,resource_key AS resourceKey,
          connectionName,connectionEnabled,connectionRevision,revision,updatedAt,total,
          (SELECT COUNT(*) FROM repository_resource_links related WHERE related.workspace_id=linked.workspace_id
            AND related.kind=linked.kind AND related.connection_id=linked.connection_id
            AND related.resource_key=linked.resource_key) AS repositoryCount
        FROM linked WHERE position<=? ORDER BY kind,position`,
      )
      .bind(
        workspaceId,
        repositoryId,
        ...guard.values,
        REPOSITORY_CONTEXT_LIMITS.RESOURCE_PREVIEW,
      ),
    context.db
      .prepare(
        `SELECT c.id AS connectionId,c.name AS connectionName,c.enabled AS connectionEnabled,
          c.provider_kind AS providerKind,json_extract(resource.value,'$.id') AS resourceId,
          json_extract(resource.value,'$.label') AS label,
          json_array_length(resource.value,'$.repositories') AS repositoryCount,
          EXISTS (SELECT 1 FROM json_each(resource.value,'$.repositories') binding
            WHERE json_extract(binding.value,'$.id')=r.id
              AND json_extract(binding.value,'$.fullName')=r.full_name COLLATE NOCASE) AS identityMatches,
          COUNT(*) OVER () AS total
        FROM secret_connections c,json_each(c.resources_json) resource
        JOIN repositories r ON r.workspace_id=c.workspace_id AND r.id=?
        WHERE c.workspace_id=? AND ${guard.sql}
          AND EXISTS (SELECT 1 FROM json_each(resource.value,'$.repositories') binding
            WHERE json_extract(binding.value,'$.id')=r.id)
        ORDER BY c.name,c.id,json_extract(resource.value,'$.id') LIMIT ?`,
      )
      .bind(
        repositoryId,
        workspaceId,
        ...guard.values,
        REPOSITORY_CONTEXT_LIMITS.RESOURCE_PREVIEW,
      ),
  ]);
  await authorizeHooks(context, workspaceId);
  const after = await repository();
  if (!after) throw new DomainError("not_found", "Repository not found.", 404);
  if (after.revision !== before.revision)
    throw new DomainError(
      "conflict",
      "The repository changed while reading its links. Refresh to try again.",
      409,
    );
  const resourceRows = z.array(resourceRow).safeParse(resources.results);
  const secretRows = z.array(secretRow).safeParse(secrets.results);
  if (!resourceRows.success || !secretRows.success)
    throw new DomainError(
      "metadata_unavailable",
      "Linked resource metadata could not be read. Open the resource section to inspect its configuration.",
      503,
    );
  const links = (kind: "hook" | "monitor") => {
    const rows = resourceRows.data.filter((row) => row.kind === kind);
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(({ total: _total, ...item }) => item),
    };
  };
  return {
    repositoryId,
    generatedAt: new Date(context.now()).toISOString(),
    hooks: links("hook"),
    monitoring: links("monitor"),
    secrets: {
      total: secretRows.data[0]?.total ?? 0,
      items: secretRows.data.map(({ total: _total, ...item }) => item),
    },
  };
}
