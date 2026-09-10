import {
  CAPABILITY,
  type Capability,
  type Principal,
  type Workspace,
} from "../shared/domain";
import type { Env } from "./types";

export type GitHubContext = {
  env: Env;
  db: D1Database;
  principal: Principal;
  now: () => number;
  authorize: (
    workspaceId: string,
    capability?: Capability,
  ) => Promise<Workspace>;
  kickGitHub?: () => void;
};
export function githubActorGuard(
  workspaceId: string,
  subject: string,
  tokenId: string | null,
  now: string,
  admin = false,
) {
  return {
    sql: [
      "EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ? AND m.subject = ?",
      admin ? "AND m.role = 'owner'" : "AND m.role IN ('owner', 'operator')",
      "AND (? IS NULL OR EXISTS (SELECT 1 FROM credentials c WHERE c.id = ?",
      "AND c.workspace_id = m.workspace_id AND c.owner_subject = m.subject",
      "AND c.revoked_at IS NULL AND c.expires_at > ?",
      "AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      "AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?)",
      "AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = ?))))",
    ].join(" "),
    values: [
      workspaceId,
      subject,
      tokenId,
      tokenId,
      now,
      admin ? CAPABILITY.ADMIN : CAPABILITY.OPERATE,
      CAPABILITY.READ,
    ],
  };
}
export const GITHUB_JOB_AUTHORITY_SQL = [
  "(j.trigger = 'scheduled' OR EXISTS (SELECT 1 FROM members m",
  "WHERE m.workspace_id = j.workspace_id AND m.subject = j.actor_subject",
  "AND m.role IN ('owner', 'operator') AND (j.actor_token_id IS NULL OR EXISTS",
  "(SELECT 1 FROM credentials c WHERE c.id = j.actor_token_id",
  "AND c.workspace_id = j.workspace_id AND c.owner_subject = j.actor_subject",
  "AND c.revoked_at IS NULL AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  "AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = 'providers:operate')",
  "AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = 'read')))))",
].join(" ");
