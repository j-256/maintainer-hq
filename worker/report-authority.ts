import { CAPABILITY, type Principal } from "../shared/domain";

export function reportActorGuard(
  workspaceId: string,
  principal: Principal,
  capability: typeof CAPABILITY.ACTIVITY | typeof CAPABILITY.GOALS,
  timestamp: string,
) {
  const tokenId = principal.tokenId ?? null;
  return {
    sql: `EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ? AND m.subject = ?
      AND m.role IN ('owner', 'operator') AND (? IS NULL OR EXISTS (
      SELECT 1 FROM credentials c WHERE c.id = ? AND c.workspace_id = m.workspace_id
      AND c.owner_subject = m.subject AND c.revoked_at IS NULL AND c.expires_at > ?
      AND julianday(c.expires_at) > julianday('now') AND c.source_id IS NULL
      AND c.reporter_id IS ? AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?))))`,
    values: [
      workspaceId,
      principal.subject,
      tokenId,
      tokenId,
      timestamp,
      principal.reporterId ?? null,
      capability,
    ],
  };
}
