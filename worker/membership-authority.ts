import { CAPABILITY } from "../shared/domain";

export function membershipActorGuard(
  workspaceId: string,
  subject: string,
  tokenId: string | null,
  now: string,
) {
  return {
    sql: `EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ? AND m.subject = ? AND m.role = 'owner'
      AND (? IS NULL OR EXISTS (SELECT 1 FROM credentials c WHERE c.id = ?
      AND c.workspace_id = m.workspace_id AND c.owner_subject = m.subject
      AND c.revoked_at IS NULL AND c.expires_at > ? AND julianday(c.expires_at) > julianday('now')
      AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?)
      AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?))))`,
    values: [
      workspaceId,
      subject,
      tokenId,
      tokenId,
      now,
      CAPABILITY.READ,
      CAPABILITY.ADMIN,
    ],
  };
}

export const INVITER_AUTHORITY_SQL = `EXISTS (SELECT 1 FROM members m
  WHERE m.workspace_id = i.workspace_id AND m.subject = i.inviter_subject AND m.role = 'owner'
  AND (i.inviter_token_id IS NULL OR EXISTS (SELECT 1 FROM credentials c WHERE c.id = i.inviter_token_id
  AND c.workspace_id = m.workspace_id AND c.owner_subject = m.subject AND c.revoked_at IS NULL
  AND julianday(c.expires_at) > julianday('now')
  AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = 'read')
  AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = 'workspace:admin'))))`;
