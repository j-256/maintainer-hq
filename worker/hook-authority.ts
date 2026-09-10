import { CAPABILITY, type Capability } from "../shared/domain";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export function hookActorGuard(
  context: WorkspaceService,
  workspaceId: string,
  capability: Capability = CAPABILITY.READ,
  memberRevision: number | null = null,
) {
  const principal = context.principal;
  const tokenId = principal.tokenId ?? null;
  const roles =
    capability === CAPABILITY.ADMIN || capability === CAPABILITY.SECRETS
      ? ["owner"]
      : capability === CAPABILITY.READ
        ? ["owner", "operator", "viewer"]
        : ["owner", "operator"];
  return {
    sql: `EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ? AND m.subject = ?
      AND m.role IN (SELECT value FROM json_each(?)) AND (? IS NULL OR m.revision = ?)
      AND ? = 0 AND (? IS NULL OR EXISTS (
        SELECT 1 FROM credentials c WHERE c.id = ? AND c.workspace_id = m.workspace_id
          AND c.owner_subject = m.subject AND c.revoked_at IS NULL
          AND c.expires_at > ? AND julianday(c.expires_at) > julianday('now')
          AND c.source_id IS NULL AND c.reporter_id IS NULL
          AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?)
          AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?))))`,
    values: [
      workspaceId,
      principal.subject,
      JSON.stringify(roles),
      memberRevision,
      memberRevision,
      Number(Boolean(principal.sourceId || principal.reporterId)),
      tokenId,
      tokenId,
      new Date(context.now()).toISOString(),
      CAPABILITY.READ,
      capability,
    ],
  };
}

export async function authorizeHooks(
  context: WorkspaceService,
  workspaceId: string,
  capability: Capability = CAPABILITY.READ,
): Promise<number> {
  await context.authorize(workspaceId, CAPABILITY.READ);
  if (capability !== CAPABILITY.READ)
    await context.authorize(workspaceId, capability);
  const guard = hookActorGuard(context, workspaceId, capability);
  const member = await context.db
    .prepare(
      `SELECT revision FROM members WHERE workspace_id = ? AND subject = ? AND ${guard.sql}`,
    )
    .bind(workspaceId, context.principal.subject, ...guard.values)
    .first<{ revision: number }>();
  if (!member)
    throw new DomainError(
      "forbidden",
      "Your live workspace access does not permit this operation.",
      403,
    );
  return member.revision;
}
