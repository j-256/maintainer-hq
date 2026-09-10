import { CAPABILITY, workspaceInput } from "../shared/domain";
import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
  updatePreferencesInput,
  type PreferenceRecord,
} from "../shared/preferences";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export class PreferenceService {
  constructor(readonly context: WorkspaceService) {}

  async own(): Promise<PreferenceRecord> {
    const row = await this.context.db
      .prepare(
        "SELECT preferences_json AS data, revision, updated_at AS updatedAt FROM user_preferences WHERE subject=?",
      )
      .bind(this.context.principal.subject)
      .first<{
        data: string;
        revision: number;
        updatedAt: string;
      }>();
    return row
      ? {
          preferences: preferencesSchema.parse(JSON.parse(row.data)),
          revision: row.revision,
          updatedAt: row.updatedAt,
        }
      : {
          preferences: { ...DEFAULT_PREFERENCES },
          revision: 0,
          updatedAt: null,
        };
  }

  async get(input: unknown) {
    const { workspaceId } = workspaceInput.parse(input);
    await this.context.authorize(workspaceId);
    return this.own();
  }

  async update(input: unknown): Promise<PreferenceRecord> {
    const { workspaceId, preferences, revision } =
      updatePreferencesInput.parse(input);
    await this.context.authorize(workspaceId, CAPABILITY.READ);
    await this.context.authorize(workspaceId, CAPABILITY.PREFERENCES);
    const principal = this.context.principal;
    const timestamp = new Date(this.context.now()).toISOString();
    const tokenId = principal.tokenId ?? null;
    const guard = `EXISTS (SELECT 1 FROM members m WHERE m.workspace_id=? AND m.subject=?
      AND m.role IN ('owner','operator','viewer') AND (? IS NULL OR EXISTS (
        SELECT 1 FROM credentials c WHERE c.id=? AND c.workspace_id=m.workspace_id
        AND c.owner_subject=m.subject AND c.revoked_at IS NULL AND c.expires_at>?
        AND julianday(c.expires_at)>julianday('now') AND c.source_id IS NULL
        AND c.reporter_id IS NULL
        AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value=?)
        AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value=?))))`;
    const result = await this.context.db
      .prepare(
        `INSERT INTO user_preferences (subject,preferences_json,revision,updated_at)
       SELECT ?,?,?,? WHERE ${guard}
       AND (?=0 OR EXISTS (SELECT 1 FROM user_preferences WHERE subject=? AND revision=?))
       ON CONFLICT(subject) DO UPDATE SET preferences_json=excluded.preferences_json,
       revision=excluded.revision,updated_at=excluded.updated_at
       WHERE user_preferences.revision=?`,
      )
      .bind(
        principal.subject,
        JSON.stringify(preferences),
        revision + 1,
        timestamp,
        workspaceId,
        principal.subject,
        tokenId,
        tokenId,
        timestamp,
        CAPABILITY.READ,
        CAPABILITY.PREFERENCES,
        revision,
        principal.subject,
        revision,
        revision,
      )
      .run();
    if (!result.meta.changes) {
      throw new DomainError(
        "revision_conflict",
        "Your preferences changed elsewhere or access changed. Load saved preferences before saving again. Your draft is still here.",
        409,
      );
    }
    return { preferences, revision: revision + 1, updatedAt: timestamp };
  }
}
