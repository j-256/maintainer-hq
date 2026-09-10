import { CAPABILITY } from "../shared/domain";
import {
  GITHUB_REFRESH_LIMITS,
  githubConfigurationSchema,
  githubRefreshInput,
  githubRefreshGetInput,
  githubRefreshListInput,
  githubRefreshActive,
  type GitHubRefresh,
  type GitHubRefreshItem,
  type GitHubRefreshState,
} from "../shared/github";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { githubActorGuard, type GitHubContext } from "./github-authority";
import { githubCredentialIdentity } from "./github-credentials";
import { GitHubSources } from "./github-sources";
import type { Env } from "./types";
import type { GitHubCollection } from "./github-client";
import { githubChangesSchema } from "../shared/github-refresh-summary";

const SCHEDULE_STATE_CONFLICTS = new Set([
  "revision_conflict",
  "refresh_conflict",
  "disabled",
  "not_found",
  "rate_limited",
]);

export type GitHubJobRow = {
  workspace_id: string;
  id: string;
  source_id: string;
  source_revision: number;
  credential_ref: string;
  credential_hash: string;
  actor_subject: string;
  actor_name: string;
  actor_token_id: string | null;
  trigger: "manual" | "scheduled";
  input_hash: string;
  status: GitHubRefreshState;
  summary: string;
  changed: number;
  created_at: string;
  completed_at: string | null;
  write_id: string;
  total: number;
  finished: number;
};
export const GITHUB_JOB_SELECT = [
  "SELECT j.*, (SELECT count(*) FROM github_refresh_items i",
  "WHERE i.workspace_id = j.workspace_id AND i.refresh_id = j.id) AS total,",
  "(SELECT count(*) FROM github_refresh_items i WHERE i.workspace_id = j.workspace_id",
  "AND i.refresh_id = j.id AND i.status NOT IN ('queued', 'running')) AS finished",
  "FROM github_refreshes j WHERE j.workspace_id = ?",
].join(" ");
export function describeGitHubJob(row: GitHubJobRow): GitHubRefresh {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    actor: row.actor_name,
    trigger: row.trigger,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    total: row.total,
    finished: row.finished,
  };
}
export function captureGitHubActivity(
  db: D1Database,
  workspaceId: string,
  refreshId: string,
  eventId: string,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO activity_repository_links(workspace_id,event_id,repository_id)
      SELECT workspace_id,?,repository_id FROM github_refresh_items
      WHERE workspace_id=? AND refresh_id=?
        AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
    )
    .bind(eventId, workspaceId, refreshId, workspaceId, eventId);
}

export function githubJobAudit(
  db: D1Database,
  workspaceId: string,
  refreshId: string,
  writeId: string,
  type: string,
  title: string,
  now: string,
  manualOnly = false,
) {
  const eventId = crypto.randomUUID();
  return [
    db
      .prepare(
        "INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, github_source_id, github_refresh_id, github_source_name) SELECT ?, j.workspace_id, j.actor_subject, j.actor_name, ?, ? || ': ' || s.name, j.summary, NULL, ?, j.source_id, j.id, s.name FROM github_refreshes j JOIN connections s ON s.workspace_id = j.workspace_id AND s.id = j.source_id WHERE j.workspace_id = ? AND j.id = ? AND j.write_id = ?" +
          (manualOnly
            ? " AND j.trigger = 'manual'"
            : " AND (j.trigger = 'manual' OR j.changed > 0)"),
      )
      .bind(eventId, type, title, now, workspaceId, refreshId, writeId),
    captureGitHubActivity(db, workspaceId, refreshId, eventId),
  ];
}

export async function readGitHubRefreshItems(
  db: D1Database,
  workspaceId: string,
  refreshId: string,
): Promise<GitHubRefreshItem[]> {
  const items = (
    await db
      .prepare(
        "SELECT repository_id, full_name, status, attempts, summary, updated_at, observed_at, result_json, changes_json FROM github_refresh_items WHERE workspace_id = ? AND refresh_id = ? ORDER BY full_name LIMIT ?",
      )
      .bind(workspaceId, refreshId, GITHUB_REFRESH_LIMITS.REPOSITORIES + 1)
      .all<{
        repository_id: string;
        full_name: string;
        status: GitHubRefreshState;
        attempts: number;
        summary: string;
        updated_at: string;
        observed_at: string | null;
        result_json: string | null;
        changes_json: string | null;
      }>()
  ).results;
  if (items.length > GITHUB_REFRESH_LIMITS.REPOSITORIES)
    throw new DomainError(
      "capacity",
      "Refresh scope exceeds the supported limit",
      409,
    );
  return items.map((item) => {
    const result = item.result_json
      ? (JSON.parse(item.result_json) as GitHubCollection)
      : null;
    return {
      repositoryId: item.repository_id,
      fullName: item.full_name,
      status: item.status,
      attempts: item.attempts,
      summary: item.summary,
      updatedAt: item.updated_at,
      observedAt: item.observed_at,
      evidence: result?.details.github ?? null,
      diagnostics: result?.diagnostics ?? null,
      changes:
        item.changes_json === null
          ? null
          : githubChangesSchema.parse(JSON.parse(item.changes_json)),
    };
  });
}

export class GitHubJobs {
  constructor(readonly context: GitHubContext) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private async operate(workspaceId: string) {
    await this.context.authorize(workspaceId, CAPABILITY.OPERATE);
    await this.context.authorize(workspaceId, CAPABILITY.READ);
  }
  async row(workspaceId: string, refreshId: string) {
    return this.db
      .prepare(GITHUB_JOB_SELECT + " AND j.id = ?")
      .bind(workspaceId, refreshId)
      .first<GitHubJobRow>();
  }
  async get(input: unknown): Promise<GitHubRefresh> {
    const { workspaceId, sourceId, refreshId } =
      githubRefreshGetInput.parse(input);
    await this.context.authorize(workspaceId);
    const row = await this.row(workspaceId, refreshId);
    if (!row || row.source_id !== sourceId)
      throw new DomainError("not_found", "GitHub refresh not found", 404);
    return this.detail(row);
  }
  private async detail(row: GitHubJobRow): Promise<GitHubRefresh> {
    return {
      ...describeGitHubJob(row),
      items: await readGitHubRefreshItems(this.db, row.workspace_id, row.id),
    };
  }
  async list(input: unknown) {
    const { workspaceId, sourceId, limit } =
      githubRefreshListInput.parse(input);
    await this.context.authorize(workspaceId);
    await new GitHubSources(this.context).row(workspaceId, sourceId);
    return (
      await this.db
        .prepare(
          GITHUB_JOB_SELECT +
            " AND j.source_id = ? ORDER BY j.created_at DESC, j.id DESC LIMIT ?",
        )
        .bind(workspaceId, sourceId, limit)
        .all<GitHubJobRow>()
    ).results.map(describeGitHubJob);
  }
  async refresh(input: unknown) {
    const parsed = githubRefreshInput.parse(input);
    await this.operate(parsed.workspaceId);
    const result = await this.start(parsed, false);
    this.context.kickGitHub?.();
    return result;
  }
  async start(
    input: ReturnType<typeof githubRefreshInput.parse>,
    scheduled: boolean,
  ): Promise<GitHubRefresh> {
    const { workspaceId, sourceId, revision, refreshId } = input;
    const trigger = scheduled ? "scheduled" : "manual";
    const hash = await credentialHash(JSON.stringify({ sourceId, revision }));
    const existing = await this.row(workspaceId, refreshId);
    if (existing) {
      if (
        existing.input_hash !== hash ||
        existing.actor_subject !== this.context.principal.subject ||
        existing.trigger !== trigger
      )
        throw new DomainError(
          "idempotency_conflict",
          "This refresh ID belongs to another request",
          409,
        );
      return this.detail(existing);
    }
    const sources = new GitHubSources(this.context);
    const source = await sources.row(workspaceId, sourceId);
    if (source.revision !== revision)
      throw new DomainError(
        "revision_conflict",
        "Review the saved GitHub source before starting a refresh",
        409,
      );
    if (!source.enabled)
      throw new DomainError(
        "disabled",
        "Enable this GitHub source before refreshing it",
        409,
      );
    let configuration: unknown;
    try {
      configuration = JSON.parse(source.configuration_json);
    } catch {
      configuration = null;
    }
    const parsed = githubConfigurationSchema.safeParse(configuration);
    if (!parsed.success)
      throw new DomainError(
        "not_configured",
        "An owner must repair this GitHub source's settings",
        409,
      );
    const credential = await githubCredentialIdentity(
      this.context.env,
      workspaceId,
      source.credential_ref,
    );
    if (!credential)
      throw new DomainError(
        "not_configured",
        "No workspace-bound GitHub credential is configured for this source",
        409,
      );
    const scopes = await sources.scopes(workspaceId, sourceId);
    if (!scopes.length || scopes.length > GITHUB_REFRESH_LIMITS.REPOSITORIES)
      throw new DomainError(
        "capacity",
        "Select repositories within the supported GitHub source limit",
        409,
      );
    const now = this.timestamp();
    const due = new Date(
      this.context.now() +
        parsed.data.refreshIntervalMinutes * GITHUB_REFRESH_LIMITS.MINUTE_MS,
    ).toISOString();
    const cooldown = await this.db
      .prepare(
        "SELECT retry_at FROM github_cooldowns WHERE credential_hash = ? AND retry_at > ?",
      )
      .bind(credential.hash, now)
      .first<{ retry_at: string }>();
    if (cooldown)
      throw new DomainError(
        "rate_limited",
        "GitHub requested a cooldown. Inspect the source's retry time before refreshing.",
        429,
      );
    const guard = scheduled
      ? { sql: "1", values: [] }
      : githubActorGuard(
          workspaceId,
          this.context.principal.subject,
          this.context.principal.tokenId ?? null,
          now,
        );
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          [
            "INSERT INTO github_refreshes (workspace_id, id, source_id, source_revision, credential_ref, credential_hash,",
            "actor_subject, actor_name, actor_token_id, trigger, input_hash, status, summary, created_at, write_id)",
            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ? WHERE",
            guard.sql,
            "AND EXISTS (SELECT 1 FROM connections s WHERE s.workspace_id = ? AND s.id = ?",
            "AND s.provider = 'github' AND s.enabled = 1 AND s.revision = ?",
            "AND (s.last_attempt_at IS NULL OR s.last_attempt_at <= ?))",
            "AND NOT EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND source_id = ? AND status IN ('queued', 'running'))",
            "AND NOT EXISTS (SELECT 1 FROM github_cooldowns WHERE credential_hash = ? AND retry_at > ?)",
            "ON CONFLICT DO NOTHING",
          ].join(" "),
        )
        .bind(
          workspaceId,
          refreshId,
          sourceId,
          revision,
          source.credential_ref,
          credential.hash,
          this.context.principal.subject,
          this.context.principal.displayName,
          this.context.principal.tokenId ?? null,
          trigger,
          hash,
          source.name + ": refresh queued",
          now,
          writeId,
          ...guard.values,
          workspaceId,
          sourceId,
          revision,
          new Date(
            this.context.now() - GITHUB_REFRESH_LIMITS.MANUAL_INTERVAL_MS,
          ).toISOString(),
          workspaceId,
          sourceId,
          credential.hash,
          now,
        ),
      this.db
        .prepare(
          [
            "INSERT INTO github_refresh_items (workspace_id, refresh_id, repository_id, full_name, status, summary, updated_at)",
            "SELECT s.workspace_id, ?, r.id, r.full_name, 'queued', 'Waiting for collection', ?",
            "FROM source_repositories s JOIN repositories r ON r.workspace_id = s.workspace_id AND r.id = s.repository_id",
            "WHERE s.workspace_id = ? AND s.source_id = ? AND EXISTS",
            "(SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND write_id = ?)",
          ].join(" "),
        )
        .bind(
          refreshId,
          now,
          workspaceId,
          sourceId,
          workspaceId,
          refreshId,
          writeId,
        ),
      this.db
        .prepare(
          [
            "UPDATE connections SET last_attempt_at = ?, next_refresh_at = ?, last_refresh_id = ?",
            "WHERE workspace_id = ? AND id = ? AND EXISTS",
            "(SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND write_id = ?)",
          ].join(" "),
        )
        .bind(
          now,
          due,
          refreshId,
          workspaceId,
          sourceId,
          workspaceId,
          refreshId,
          writeId,
        ),
      ...githubJobAudit(
        this.db,
        workspaceId,
        refreshId,
        writeId,
        "github.refresh.started",
        "GitHub refresh started",
        now,
        true,
      ),
    ]);
    if (!results[0].meta.changes) {
      const saved = await this.row(workspaceId, refreshId);
      if (
        saved &&
        saved.input_hash === hash &&
        saved.actor_subject === this.context.principal.subject &&
        saved.trigger === trigger
      )
        return this.detail(saved);
      throw new DomainError(
        "refresh_conflict",
        "This source changed, has an active refresh, or is cooling down. Inspect its status before retrying.",
        409,
      );
    }
    return this.detail((await this.row(workspaceId, refreshId))!);
  }
  async cancel(input: unknown) {
    const { workspaceId, sourceId, refreshId } =
      githubRefreshGetInput.parse(input);
    await this.operate(workspaceId);
    const before = await this.row(workspaceId, refreshId);
    if (!before || before.source_id !== sourceId)
      throw new DomainError("not_found", "GitHub refresh not found", 404);
    if (!githubRefreshActive(before.status)) return this.detail(before);
    const now = this.timestamp();
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const guard = githubActorGuard(
      workspaceId,
      this.context.principal.subject,
      this.context.principal.tokenId ?? null,
      now,
    );
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE github_refreshes SET status = 'cancelled', summary = 'Refresh cancelled by a workspace operator', completed_at = ?, write_id = ? WHERE workspace_id = ? AND id = ? AND status IN ('queued', 'running') AND " +
            guard.sql,
        )
        .bind(now, writeId, workspaceId, refreshId, ...guard.values),
      this.db
        .prepare(
          "UPDATE github_refresh_items SET status = 'cancelled', summary = 'Refresh cancelled by a workspace operator', updated_at = ?, lease_id = NULL, lease_until = NULL WHERE workspace_id = ? AND refresh_id = ? AND status IN ('queued', 'running') AND EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND write_id = ?)",
        )
        .bind(now, workspaceId, refreshId, workspaceId, refreshId, writeId),
      this.db
        .prepare(
          "INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, github_source_id, github_refresh_id, github_source_name) SELECT ?, ?, ?, ?, 'github.refresh.cancelled', 'GitHub refresh cancelled: ' || s.name, j.summary, NULL, ?, j.source_id, j.id, s.name FROM github_refreshes j JOIN connections s ON s.workspace_id = j.workspace_id AND s.id = j.source_id WHERE j.workspace_id = ? AND j.id = ? AND j.write_id = ?",
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          now,
          workspaceId,
          refreshId,
          writeId,
        ),
      captureGitHubActivity(this.db, workspaceId, refreshId, eventId),
    ]);
    return this.detail((await this.row(workspaceId, refreshId))!);
  }
}

export async function scheduleGitHubSources(
  env: Env,
  now: () => number = Date.now,
) {
  const context: GitHubContext = {
    env,
    db: env.HQ_DB,
    now,
    principal: {
      subject: "system:github-collector",
      displayName: "Scheduled GitHub collector",
    },
    authorize: async () => {
      throw new DomainError(
        "forbidden",
        "Scheduled collection has no operator access",
        403,
      );
    },
  };
  const jobs = new GitHubJobs(context);
  const stamp = new Date(now()).toISOString();
  const sources = (
    await env.HQ_DB.prepare(
      [
        "SELECT s.workspace_id, s.id, s.revision, s.configuration_json FROM connections s",
        "WHERE s.provider = 'github' AND s.enabled = 1 AND (s.next_refresh_at IS NULL OR s.next_refresh_at <= ?)",
        "AND (s.last_attempt_at IS NULL OR s.last_attempt_at <= ?)",
        "AND NOT EXISTS (SELECT 1 FROM github_refreshes j WHERE j.workspace_id = s.workspace_id AND j.source_id = s.id AND j.status IN ('queued', 'running'))",
        "ORDER BY s.next_refresh_at, s.workspace_id, s.id LIMIT ?",
      ].join(" "),
    )
      .bind(
        stamp,
        new Date(now() - GITHUB_REFRESH_LIMITS.MANUAL_INTERVAL_MS).toISOString(),
        GITHUB_REFRESH_LIMITS.DUE_SOURCES,
      )
      .all<{
        workspace_id: string;
        id: string;
        revision: number;
        configuration_json: string;
      }>()
  ).results;
  for (const source of sources) {
    try {
      await jobs.start(
        {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          revision: source.revision,
          refreshId: crypto.randomUUID(),
        },
        true,
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (SCHEDULE_STATE_CONFLICTS.has(error.code)) continue;
      const retry = new Date(
        now() +
          GITHUB_REFRESH_LIMITS.DEFAULT_INTERVAL_MINUTES *
            GITHUB_REFRESH_LIMITS.MINUTE_MS,
      ).toISOString();
      await env.HQ_DB.prepare(
        "UPDATE connections SET last_error = ?, next_refresh_at = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND source_id = ? AND status IN ('queued', 'running'))",
      )
        .bind(
          error.message,
          retry,
          source.workspace_id,
          source.id,
          source.revision,
          source.workspace_id,
          source.id,
        )
        .run();
    }
  }
}
