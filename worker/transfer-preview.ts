import {
  CAPABILITY,
  LIMITS,
  workspaceInput,
  type Role,
  type Workspace,
} from "../shared/domain";
import { MEMBERSHIP_LIMITS } from "../shared/membership";
import { SOURCE_LIMITS } from "../shared/sources";
import { HOOK_POLICY_KIND, HOOK_RETRY_KIND } from "../shared/hooks";
import { MANAGED_CONFIGURATION_OPERATION_KIND } from "../shared/managed-configurations";
import { MONITOR_OPERATION_KIND } from "../shared/monitoring";
import {
  TRANSFER_LIMITS,
  TRANSFER_VERSION,
  projectTransferPreviewInput,
  type TransferAccessChange,
  type TransferCredentialAccess,
  type TransferDestinationSource,
  type TransferDestinations,
  type TransferInvitation,
  type TransferIssue,
  type TransferPreview,
  type TransferRepository,
  type TransferResource,
  type TransferSource,
} from "../shared/project-transfers";
import { DomainError } from "./errors";
import { hookActorGuard } from "./hook-authority";
import { PROJECT_FIELDS_SQL, projectFromRow } from "./projects";
import type { WorkspaceService } from "./service";

export function transferConflict(): never {
  throw new DomainError(
    "transfer_conflict",
    "The transfer review changed, expired, or lost its original authority. Keep your choices, inspect the saved result, and prepare a new review before trying again.",
    409,
  );
}
export function transferCapacity(): never {
  throw new DomainError(
    "transfer_capacity",
    "This transfer exceeds the bounded review size. No metadata was moved. Reduce or separate its dependencies before reviewing again.",
    409,
  );
}
export async function transferOwner(
  context: WorkspaceService,
  workspaceId: string,
): Promise<Workspace> {
  await context.authorize(workspaceId, CAPABILITY.ADMIN);
  if (
    context.principal.scopes &&
    !context.principal.scopes.includes(CAPABILITY.READ)
  )
    throw new DomainError(
      "forbidden",
      "This credential cannot review workspace access",
      403,
    );
  const guard = hookActorGuard(context, workspaceId, CAPABILITY.ADMIN);
  const workspace = await context.db
    .prepare(
      `SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id
    WHERE w.id=? AND m.subject=? AND ${guard.sql}`,
    )
    .bind(workspaceId, context.principal.subject, ...guard.values)
    .first<Workspace>();
  if (!workspace)
    throw new DomainError(
      "forbidden",
      "Your live workspace access does not permit this transfer",
      403,
    );
  return workspace;
}
export async function transferClocks(
  context: WorkspaceService,
  source: string,
  destination: string,
) {
  const rows = (
    await context.db
      .prepare(
        "SELECT workspace_id AS workspaceId,revision FROM workspace_transfer_clock WHERE workspace_id IN (?,?) ORDER BY workspace_id",
      )
      .bind(source, destination)
      .all<{ workspaceId: string; revision: number }>()
  ).results;
  const sourceRevision = rows.find(
    (row) => row.workspaceId === source,
  )?.revision;
  const destinationRevision = rows.find(
    (row) => row.workspaceId === destination,
  )?.revision;
  if (!sourceRevision || !destinationRevision) transferConflict();
  return { source: sourceRevision, destination: destinationRevision };
}
export async function transferDestinations(
  context: WorkspaceService,
  input: unknown,
): Promise<TransferDestinations> {
  const { workspaceId } = workspaceInput.parse(input);
  await transferOwner(context, workspaceId);
  if (context.principal.workspaceId || context.principal.tokenId)
    return { workspaces: [], restriction: "workspace-credential" };
  const workspaces = (
    await context.db
      .prepare(
        "SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.subject=? AND m.role='owner' AND w.id<>? ORDER BY w.name,w.id LIMIT ?",
      )
      .bind(
        context.principal.subject,
        workspaceId,
        TRANSFER_LIMITS.DESTINATIONS + 1,
      )
      .all<Workspace>()
  ).results;
  if (workspaces.length > TRANSFER_LIMITS.DESTINATIONS) transferCapacity();
  await transferOwner(context, workspaceId);
  return { workspaces, restriction: null };
}

type MembershipRow = {
  workspaceId: string;
  subject: string;
  displayName: string;
  role: Role;
};
type SourceLinkRow = {
  sourceId: string;
  name: string;
  provider: string;
  revision: number;
  enabled: number;
  repositoryId: string;
  remainingRepositoryCount: number;
};
type CountRow = {
  destinationProjects: number;
  destinationRepositories: number;
  duplicateProject: number;
  duplicateRepository: number;
  providerReviews: number;
  providerOperations: number;
  secretCustody: number;
  managedConfigurations: number;
};

export async function buildTransferPreview(
  context: WorkspaceService,
  input: unknown,
): Promise<TransferPreview> {
  const fields = projectTransferPreviewInput.parse(input);
  const { workspaceId, projectId, destinationWorkspaceId } = fields;
  const source = await transferOwner(context, workspaceId);
  const destination = await transferOwner(context, destinationWorkspaceId);
  if (context.principal.tokenId || context.principal.workspaceId)
    throw new DomainError(
      "transfer_session_required",
      "Use an owner session with live membership in both workspaces. A workspace credential cannot cross its enrollment boundary.",
      403,
    );
  const { db } = context;
  const timestamp = new Date(context.now()).toISOString();
  const revisions = await transferClocks(
    context,
    workspaceId,
    destinationWorkspaceId,
  );
  const providerKinds = JSON.stringify([
    HOOK_RETRY_KIND,
    HOOK_POLICY_KIND,
    MONITOR_OPERATION_KIND,
    MANAGED_CONFIGURATION_OPERATION_KIND,
  ]);
  const rows = await db.batch([
    db
      .prepare(
        `SELECT ${PROJECT_FIELDS_SQL} FROM projects WHERE workspace_id=? AND id=?`,
      )
      .bind(workspaceId, projectId),
    db
      .prepare(
        "SELECT id,full_name AS fullName,revision FROM repositories WHERE workspace_id=? AND project_id=? ORDER BY id LIMIT ?",
      )
      .bind(workspaceId, projectId, TRANSFER_LIMITS.REPOSITORIES + 1),
    db
      .prepare(
        "SELECT workspace_id AS workspaceId,subject,display_name AS displayName,role FROM members WHERE workspace_id IN (?,?) ORDER BY workspace_id,subject LIMIT ?",
      )
      .bind(
        workspaceId,
        destinationWorkspaceId,
        TRANSFER_LIMITS.ACCESS_ENTRIES + 1,
      ),
    db
      .prepare(
        "SELECT workspace_id AS workspaceId,email,role,expires_at AS expiresAt FROM invitations WHERE workspace_id IN (?,?) AND state='pending' AND expires_at>? ORDER BY workspace_id,email LIMIT ?",
      )
      .bind(
        workspaceId,
        destinationWorkspaceId,
        timestamp,
        2 * MEMBERSHIP_LIMITS.PENDING_INVITATIONS + 1,
      ),
    db
      .prepare(
        "SELECT workspace_id AS workspaceId,name,owner_subject AS owner,automation_profile AS profile,source_id AS sourceId,scopes_json AS scopesJson,expires_at AS expiresAt FROM credentials WHERE workspace_id IN (?,?) AND revoked_at IS NULL AND expires_at>? ORDER BY workspace_id,id LIMIT ?",
      )
      .bind(
        workspaceId,
        destinationWorkspaceId,
        timestamp,
        TRANSFER_LIMITS.CREDENTIALS + 1,
      ),
    db
      .prepare(
        `SELECT c.id AS sourceId,c.name,c.provider,c.revision,c.enabled,s.repository_id AS repositoryId,
      (SELECT COUNT(*) FROM source_repositories other JOIN repositories r ON r.workspace_id=other.workspace_id AND r.id=other.repository_id WHERE other.workspace_id=c.workspace_id AND other.source_id=c.id AND (r.project_id IS NULL OR r.project_id<>?)) AS remainingRepositoryCount
      FROM source_repositories s JOIN connections c ON c.workspace_id=s.workspace_id AND c.id=s.source_id JOIN repositories r ON r.workspace_id=s.workspace_id AND r.id=s.repository_id
      WHERE s.workspace_id=? AND r.project_id=? ORDER BY c.id,r.id LIMIT ?`,
      )
      .bind(
        projectId,
        workspaceId,
        projectId,
        TRANSFER_LIMITS.SOURCE_LINKS + 1,
      ),
    db
      .prepare(
        `SELECT c.id,c.name,c.provider,c.revision,c.enabled,(SELECT COUNT(*) FROM source_repositories s WHERE s.workspace_id=c.workspace_id AND s.source_id=c.id) AS repositoryCount
      FROM connections c WHERE c.workspace_id=? AND c.provider IN ('github','local') ORDER BY c.id LIMIT ?`,
      )
      .bind(destinationWorkspaceId, SOURCE_LIMITS.SOURCES + 1),
    db
      .prepare(
        "SELECT source_id AS sourceId,repository_id AS repositoryId FROM source_repositories WHERE workspace_id=? AND source_id IN (SELECT json_extract(value,'$.destinationSourceId') FROM json_each(?)) ORDER BY source_id,repository_id LIMIT ?",
      )
      .bind(
        destinationWorkspaceId,
        JSON.stringify(fields.sourceBindings),
        TRANSFER_LIMITS.SOURCE_LINKS + 1,
      ),
    db
      .prepare(
        "SELECT id,name,provider,revision FROM connections WHERE workspace_id=? AND json_extract(configuration_json,'$.projectId')=? ORDER BY id LIMIT ?",
      )
      .bind(workspaceId, projectId, SOURCE_LIMITS.SOURCES + 1),
    db
      .prepare(
        `WITH repository_context AS MATERIALIZED (
      SELECT c.*,r.project_id FROM project_resource_repository_context c JOIN repositories r ON r.workspace_id=c.workspace_id AND r.id=c.repository_id WHERE c.workspace_id=?
    ), known AS (
      SELECT kind,connection_id,resource_key FROM project_resource_associations WHERE workspace_id=? AND project_id=?
      UNION SELECT kind,connection_id,resource_key FROM repository_context WHERE project_id=?
    ) SELECT k.kind,k.connection_id AS connectionId,COALESCE(c.name,s.name,k.connection_id) AS connectionName,k.resource_key AS resourceKey,
      EXISTS(SELECT 1 FROM project_resource_associations a WHERE a.workspace_id=? AND a.kind=k.kind AND a.connection_id=k.connection_id AND a.resource_key=k.resource_key AND a.project_id=?) AS direct,
      (SELECT COUNT(DISTINCT repository_id) FROM repository_context r WHERE r.kind=k.kind AND r.connection_id=k.connection_id AND r.resource_key=k.resource_key AND (r.project_id IS NULL OR r.project_id<>?)) AS sharedRepositoryCount
      FROM known k LEFT JOIN connections c ON c.workspace_id=? AND c.id=k.connection_id AND k.kind<>'secret'
      LEFT JOIN secret_connections s ON s.workspace_id=? AND s.id=k.connection_id AND k.kind='secret'
      ORDER BY k.kind,k.connection_id,k.resource_key LIMIT ?`,
      )
      .bind(
        workspaceId,
        workspaceId,
        projectId,
        projectId,
        workspaceId,
        projectId,
        projectId,
        workspaceId,
        workspaceId,
        TRANSFER_LIMITS.RESOURCES + 1,
      ),
    db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM projects WHERE workspace_id=?) AS destinationProjects,
      (SELECT COUNT(*) FROM repositories WHERE workspace_id=?) AS destinationRepositories,
      EXISTS(SELECT 1 FROM projects d JOIN projects s ON s.name=d.name WHERE s.workspace_id=? AND s.id=? AND d.workspace_id=?) AS duplicateProject,
      EXISTS(SELECT 1 FROM repositories d JOIN repositories s ON s.full_name=d.full_name COLLATE NOCASE WHERE s.workspace_id=? AND s.project_id=? AND d.workspace_id=?) AS duplicateRepository,
      (SELECT COUNT(*) FROM action_plans WHERE workspace_id IN (?,?) AND kind IN (SELECT value FROM json_each(?)) AND applied_at IS NULL AND expires_at>?) AS providerReviews,
      (SELECT COUNT(*) FROM operations WHERE workspace_id IN (?,?) AND status IN ('pending','running','partial','indeterminate')) AS providerOperations,
      (SELECT COUNT(*) FROM secret_reviews r WHERE r.workspace_id IN (?,?) AND (
        EXISTS(SELECT 1 FROM secret_payloads p WHERE p.workspace_id=r.workspace_id AND p.review_id=r.id)
        OR (r.stage IN ('awaiting-input','reviewed') AND r.expires_at>?)
        OR EXISTS(SELECT 1 FROM secret_receipts p WHERE p.workspace_id=r.workspace_id AND p.review_id=r.id AND (p.phase<>'finished' OR p.write_status='indeterminate'))
        OR EXISTS(SELECT 1 FROM secret_cleanup_reviews p WHERE p.workspace_id=r.workspace_id AND p.distribution_review_id=r.id AND (p.phase IN ('preparing','submitted') OR p.write_status='indeterminate' OR (p.phase='reviewed' AND p.expires_at>?)))
      )) AS secretCustody,
      (SELECT COUNT(*) FROM managed_configuration_destinations d
        JOIN managed_configurations m ON m.workspace_id=d.workspace_id AND m.id=d.configuration_id
        JOIN repositories r ON r.workspace_id=d.workspace_id AND r.id=d.resource_id
        WHERE d.workspace_id=? AND m.state='active' AND r.project_id=?) AS managedConfigurations`,
      )
      .bind(
        destinationWorkspaceId,
        destinationWorkspaceId,
        workspaceId,
        projectId,
        destinationWorkspaceId,
        workspaceId,
        projectId,
        destinationWorkspaceId,
        workspaceId,
        destinationWorkspaceId,
        providerKinds,
        timestamp,
        workspaceId,
        destinationWorkspaceId,
        workspaceId,
        destinationWorkspaceId,
        timestamp,
        timestamp,
        workspaceId,
        projectId,
      ),
    db
      .prepare(
        `SELECT j.workspace_id AS workspaceId,j.source_id AS sourceId,j.id FROM github_refreshes j WHERE j.status IN ('queued','running') AND (
      (j.workspace_id=? AND (EXISTS(SELECT 1 FROM source_repositories s JOIN repositories r ON r.workspace_id=s.workspace_id AND r.id=s.repository_id WHERE s.workspace_id=j.workspace_id AND s.source_id=j.source_id AND r.project_id=?)
        OR EXISTS(SELECT 1 FROM github_refresh_items i JOIN repositories r ON r.id=i.repository_id AND r.workspace_id=i.workspace_id WHERE i.workspace_id=j.workspace_id AND i.refresh_id=j.id AND r.project_id=?)))
      OR (j.workspace_id=? AND j.source_id IN (SELECT json_extract(value,'$.destinationSourceId') FROM json_each(?)))
    ) ORDER BY j.workspace_id,j.id LIMIT ?`,
      )
      .bind(
        workspaceId,
        projectId,
        projectId,
        destinationWorkspaceId,
        JSON.stringify(fields.sourceBindings),
        2 * SOURCE_LIMITS.SOURCES + 1,
      ),
  ]);
  const rawProject = rows[0].results[0];
  if (!rawProject)
    throw new DomainError(
      "not_found",
      "Project not found in the source workspace",
      404,
    );
  const project = projectFromRow(
    rawProject as Parameters<typeof projectFromRow>[0],
  );
  if (project.revision !== fields.projectRevision) transferConflict();
  const repositories = rows[1].results as TransferRepository[];
  const members = rows[2].results as MembershipRow[];
  const invitations = rows[3].results as TransferInvitation[];
  const credentialRows = rows[4].results as (Omit<
    TransferCredentialAccess,
    "scopes"
  > & { scopesJson: string })[];
  const sourceLinks = rows[5].results as SourceLinkRow[];
  const destinationSources = (
    rows[6].results as (Omit<TransferDestinationSource, "enabled"> & {
      enabled: number;
    })[]
  ).map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  const destinationLinks = rows[7].results as {
    sourceId: string;
    repositoryId: string;
  }[];
  const clearConnectionContext = rows[8]
    .results as TransferPreview["clearConnectionContext"];
  const resources = (
    rows[9].results as (Omit<TransferResource, "direct"> & { direct: number })[]
  ).map((row) => ({ ...row, direct: Boolean(row.direct) }));
  const counts = rows[10].results[0] as CountRow;
  const activeRefreshes = rows[11].results as {
    workspaceId: string;
    sourceId: string;
    id: string;
  }[];
  if (
    repositories.length > TRANSFER_LIMITS.REPOSITORIES ||
    members.length > TRANSFER_LIMITS.ACCESS_ENTRIES ||
    invitations.length > 2 * MEMBERSHIP_LIMITS.PENDING_INVITATIONS ||
    credentialRows.length > TRANSFER_LIMITS.CREDENTIALS ||
    sourceLinks.length > TRANSFER_LIMITS.SOURCE_LINKS ||
    destinationLinks.length > TRANSFER_LIMITS.SOURCE_LINKS ||
    destinationSources.length > SOURCE_LIMITS.SOURCES ||
    clearConnectionContext.length > SOURCE_LIMITS.SOURCES ||
    resources.length > TRANSFER_LIMITS.RESOURCES
  )
    transferCapacity();
  const sourceMap = new Map<string, TransferSource>();
  for (const row of sourceLinks) {
    let source = sourceMap.get(row.sourceId);
    if (!source) {
      source = {
        id: row.sourceId,
        name: row.name,
        provider: row.provider,
        revision: row.revision,
        enabled: Boolean(row.enabled),
        repositoryIds: [],
        remainingRepositoryCount: row.remainingRepositoryCount,
        destinationSourceId:
          fields.sourceBindings.find(
            (binding) => binding.sourceId === row.sourceId,
          )?.destinationSourceId ?? null,
        willDisable: Boolean(row.enabled) && row.remainingRepositoryCount === 0,
      };
      sourceMap.set(row.sourceId, source);
    }
    source.repositoryIds.push(row.repositoryId);
  }
  if (sourceMap.size > TRANSFER_LIMITS.SOURCE_BINDINGS) transferCapacity();
  const sources = [...sourceMap.values()];
  const blockers: TransferIssue[] = [];
  const block = (code: string, title: string, message: string) =>
    blockers.push({ code, title, message });
  if (counts.duplicateProject)
    block(
      "project_name_conflict",
      "Project name already exists",
      "Rename one of the projects in its ordinary editor, then review the move again.",
    );
  if (counts.duplicateRepository)
    block(
      "repository_conflict",
      "A repository is already enrolled at the destination",
      "Resolve the duplicate enrollment explicitly. This move does not merge or replace repository identities.",
    );
  if (
    counts.destinationProjects >= LIMITS.MAX_PROJECTS ||
    counts.destinationRepositories + repositories.length >
      LIMITS.MAX_REPOSITORIES
  )
    block(
      "workspace_capacity",
      "Destination workspace is full",
      "The destination must have capacity for the project and all of its repositories.",
    );
  for (const binding of fields.sourceBindings)
    if (!sourceMap.has(binding.sourceId))
      block(
        "unknown_source_binding",
        "A selected source is no longer linked",
        "Keep your choices and refresh the review. Mappings cannot add an unrelated source or expand the moving project.",
      );
  for (const source of sources) {
    if (!["github", "local"].includes(source.provider)) {
      block(
        "unsupported_source",
        "Source enrollment needs separate resolution",
        source.name + " does not support metadata-only source rebinding.",
      );
      continue;
    }
    const destination = destinationSources.find(
      (candidate) => candidate.id === source.destinationSourceId,
    );
    if (!destination) {
      block(
        "missing_source_binding",
        "Choose a destination source",
        "Select an existing " +
          source.provider +
          " source for " +
          source.name +
          ". Its credentials remain owned by its workspace.",
      );
      continue;
    }
    if (destination.provider !== source.provider)
      block(
        "source_provider_mismatch",
        "Source providers do not match",
        source.name + " must be rebound to the same provider kind.",
      );
  }
  for (const destination of destinationSources) {
    const mapped = sources.filter(
      (source) => source.destinationSourceId === destination.id,
    );
    if (!mapped.length) continue;
    const combined = new Set([
      ...destinationLinks
        .filter((link) => link.sourceId === destination.id)
        .map((link) => link.repositoryId),
      ...mapped.flatMap((source) => source.repositoryIds),
    ]);
    if (combined.size > SOURCE_LIMITS.REPOSITORIES)
      block(
        "source_capacity",
        "Destination source is full",
        destination.name +
          " cannot enroll all of these repositories within its supported limit.",
      );
  }
  for (const resource of resources)
    block(
      resource.sharedRepositoryCount
        ? "shared_provider_resource"
        : "provider_resource_resolution",
      resource.sharedRepositoryCount
        ? "Shared provider resource needs explicit resolution"
        : "Provider resource needs explicit resolution",
      resource.connectionName +
        " / " +
        resource.resourceKey +
        " (" +
        resource.kind +
        ") stays under its workspace's provider authority. Its association cannot be moved, copied, or silently dropped by this transfer.",
    );
  if (counts.providerReviews)
    block(
      "provider_review_pending",
      "A provider review is still open",
      "Finish the open Hookrelay or Monitoring reviews in these workspaces, or let them expire, before crossing this access boundary.",
    );
  if (counts.providerOperations)
    block(
      "provider_operation_unresolved",
      "A provider operation needs reconciliation",
      "Resolve pending, running, partial, or indeterminate operations in these workspaces. Moving metadata does not cancel external work.",
    );
  if (activeRefreshes.length)
    block(
      "source_refresh_active",
      "An affected source is refreshing",
      "Wait for affected GitHub source refreshes to finish, or cancel them through their own reviewed controls, then refresh this review.",
    );
  if (counts.secretCustody)
    block(
      "secret_custody",
      "Secrets work or retained private input remains",
      "Finish or cancel open Secrets reviews, reconcile uncertain writes or cleanup, and allow retained private input to be removed in these workspaces. The transfer never copies secret material.",
    );
  if (counts.managedConfigurations)
    block(
      "managed_configuration_active",
      "Managed configuration targets this project",
      "Stop management for each affected secret or variable before moving the project. Provider values remain unchanged and can be adopted again in the destination workspace.",
    );
  const access: TransferAccessChange[] = [];
  for (const subject of [
    ...new Set(members.map((row) => row.subject)),
  ].sort()) {
    const before = members.find(
      (row) => row.workspaceId === workspaceId && row.subject === subject,
    );
    const after = members.find(
      (row) =>
        row.workspaceId === destinationWorkspaceId && row.subject === subject,
    );
    access.push({
      subject,
      displayName: (after ?? before)!.displayName,
      sourceRole: before?.role ?? null,
      destinationRole: after?.role ?? null,
      effect: !before
        ? "gain"
        : !after
          ? "lose"
          : before.role !== after.role
            ? "change"
            : "retain",
    });
  }
  const credentials = credentialRows.map(({ scopesJson, ...row }) => ({
    ...row,
    scopes: JSON.parse(scopesJson) as string[],
  }));
  await transferOwner(context, workspaceId);
  await transferOwner(context, destinationWorkspaceId);
  const after = await transferClocks(
    context,
    workspaceId,
    destinationWorkspaceId,
  );
  if (
    after.source !== revisions.source ||
    after.destination !== revisions.destination
  )
    transferConflict();
  const preview: TransferPreview = {
    version: TRANSFER_VERSION,
    source,
    destination,
    revisions,
    project,
    repositories,
    sources,
    destinationSources,
    clearConnectionContext,
    resources,
    access,
    invitations,
    credentials,
    blockers,
    ready: !blockers.length,
    historyPolicy: "original-workspace-only",
    evidencePolicy: "fresh-destination-collection",
  };
  if (
    new TextEncoder().encode(JSON.stringify(preview)).length >
    TRANSFER_LIMITS.SNAPSHOT_BYTES
  )
    transferCapacity();
  return preview;
}
