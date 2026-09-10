import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  ATTENTION_LIMITS,
  attentionConnectionInput,
  attentionPage,
  workspaceAttention,
  workspaceAttentionInput,
  type AttentionConnection,
  type AttentionItem,
} from "../shared/attention";
import {
  hookAttention,
  monitorAttention,
  operationalItem,
} from "../shared/attention-operations";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import { HooksService } from "./hooks";
import { MonitoringService } from "./monitoring";
import type { WorkspaceService } from "./service";

function bounded<T>(value: T): T {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    ATTENTION_LIMITS.RESPONSE_BYTES
  )
    throw new DomainError(
      "capacity",
      "This attention response exceeds its safe size. Narrow the selection or open the resource workspace.",
      409,
    );
  return value;
}

export async function readWorkspaceAttention(
  context: WorkspaceService,
  input: unknown,
) {
  const { workspaceId, ...filter } = workspaceAttentionInput.parse(input);
  const view = await context.workspaceView({ workspaceId, view: "overview" });
  const records = {
    workspace: view.workspace,
    projects: view.records.projects ?? [],
    repositories: view.records.repositories ?? [],
    observations: view.records.observations ?? [],
    connections: view.records.connections ?? [],
  };
  const now = context.now();
  const result = bounded({
    ...attentionPage(workspaceAttention(records, now), records, filter, now),
    generatedAt: new Date(now).toISOString(),
    operationalEvidenceIncluded: false,
  });
  if ((await authorizeHooks(context, workspaceId)) !== view.memberRevision)
    throw new DomainError(
      "forbidden",
      "Workspace access changed during this read.",
      403,
    );
  return result;
}

export async function readAttentionConnection(
  context: WorkspaceService,
  input: unknown,
): Promise<AttentionConnection> {
  const { workspaceId, connectionId, revision } =
    attentionConnectionInput.parse(input);
  const memberRevision = await authorizeHooks(context, workspaceId);
  const guard = hookActorGuard(context, workspaceId, undefined, memberRevision);
  const readConnection = () =>
    context.db
      .prepare(
        `SELECT id,name,provider,revision,enabled FROM connections WHERE workspace_id=? AND id=? AND provider IN ('hookrelay','endpoint-monitor') AND ${guard.sql}`,
      )
      .bind(workspaceId, connectionId, ...guard.values)
      .first<{
        id: string;
        name: string;
        provider: "hookrelay" | "endpoint-monitor";
        revision: number;
        enabled: number;
      }>();
  const connection = await readConnection();
  if (!connection)
    throw new DomainError(
      "not_found",
      "Operational connection not found or access changed.",
      404,
    );
  if (connection.revision !== revision)
    throw new DomainError(
      "revision_conflict",
      "The connection changed. Refresh its settings before reading attention.",
      409,
    );
  let now = context.now();
  const kind = connection.provider === "hookrelay" ? "hook" : "monitor";
  const selected = { workspaceId, connectionId };
  let result: { items: AttentionItem[]; limited: boolean };
  if (!connection.enabled) {
    result = {
      items: [
        operationalItem(workspaceId, connection, kind, now, {
          id: "disabled",
          category: "coverage",
          title: "HQ connection disabled",
          reason:
            "HQ cannot read this provider while its connection is disabled. This does not pause the provider or establish resource health.",
        }),
      ],
      limited: false,
    };
  } else if (kind === "hook") {
    const service = new HooksService(context);
    const [snapshot, deliveries] = await Promise.all([
      service.snapshot(selected),
      service.deliveries({
        ...selected,
        status: "exhausted",
        subscription: null,
        cursor: null,
      }),
    ]);
    if (deliveries.result.items.some((item) => item.status !== "exhausted"))
      throw new DomainError(
        "provider_response_invalid",
        "The provider returned deliveries outside the requested attention selection.",
        503,
      );
    now = context.now();
    result = hookAttention(
      workspaceId,
      connection,
      snapshot.result,
      deliveries.result,
      now,
    );
  } else {
    const service = new MonitoringService(context);
    const [snapshot, targets, incidents] = await Promise.all([
      service.snapshot(selected),
      service.targets({ ...selected, cursor: null }),
      service.incidents({
        ...selected,
        status: "open",
        targetId: null,
        cursor: null,
      }),
    ]);
    now = context.now();
    result = monitorAttention(
      workspaceId,
      connection,
      snapshot.result,
      targets.result,
      incidents.result,
      now,
    );
  }
  const keys = [
    ...new Set(
      result.items.flatMap((item) =>
        item.resourceKey === null ? [] : [item.resourceKey],
      ),
    ),
  ];
  const rows = await context.db
    .prepare(
      `SELECT l.resource_key AS resourceKey,l.repository_id AS repositoryId,r.project_id AS projectId
      FROM repository_resource_links l JOIN repositories r ON r.workspace_id=l.workspace_id AND r.id=l.repository_id
      WHERE l.workspace_id=? AND l.connection_id=? AND l.kind=? AND l.resource_key IN (SELECT value FROM json_each(?)) AND ${guard.sql}
      UNION SELECT a.resource_key AS resourceKey,NULL AS repositoryId,a.project_id AS projectId
      FROM project_resource_associations a JOIN projects p ON p.workspace_id=a.workspace_id AND p.id=a.project_id
      WHERE a.workspace_id=? AND a.connection_id=? AND a.kind=? AND a.resource_key IN (SELECT value FROM json_each(?)) AND ${guard.sql}
      ORDER BY resourceKey,repositoryId,projectId LIMIT ?`,
    )
    .bind(
      workspaceId,
      connectionId,
      kind,
      JSON.stringify(keys),
      ...guard.values,
      workspaceId,
      connectionId,
      kind,
      JSON.stringify(keys),
      ...guard.values,
      ATTENTION_LIMITS.CONTEXT_ROWS + 1,
    )
    .all();
  if (rows.results.length > ATTENTION_LIMITS.CONTEXT_ROWS)
    throw new DomainError(
      "capacity",
      "Resource links exceed the attention preview limit. Inspect the individual resource workspace.",
      409,
    );
  const metadata = z
    .array(
      z.object({
        resourceKey: z.string().max(160),
        repositoryId: idSchema.nullable(),
        projectId: idSchema.nullable(),
      }),
    )
    .safeParse(rows.results);
  if (!metadata.success)
    throw new DomainError(
      "metadata_unavailable",
      "Attention resource links could not be read safely.",
      503,
    );
  for (const item of result.items) {
    const links = metadata.data.filter(
      (row) => row.resourceKey === item.resourceKey,
    );
    item.repositoryIds = [
      ...new Set(
        links.flatMap((row) => (row.repositoryId ? [row.repositoryId] : [])),
      ),
    ];
    item.projectIds = [
      ...new Set(
        links.flatMap((row) => (row.projectId ? [row.projectId] : [])),
      ),
    ];
  }
  if ((await authorizeHooks(context, workspaceId)) !== memberRevision)
    throw new DomainError(
      "forbidden",
      "Workspace access changed during this read.",
      403,
    );
  const after = await readConnection();
  if (
    !after ||
    after.revision !== revision ||
    after.enabled !== connection.enabled
  )
    throw new DomainError(
      "revision_conflict",
      "The connection changed during this read. Refresh before using its evidence.",
      409,
    );
  return bounded({
    connectionId,
    revision,
    readAt: new Date(now).toISOString(),
    ...result,
  });
}
