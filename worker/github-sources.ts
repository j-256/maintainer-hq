import { CAPABILITY } from "../shared/domain";
import {
  GITHUB_REFRESH_LIMITS,
  githubConfigurationSchema,
  githubCredentialListInput,
  githubEnrollInput,
  githubUpdateInput,
  githubRefreshActive,
  type GitHubSource,
  type GitHubSourceFields,
  type GitHubRefreshState,
} from "../shared/github";
import { SOURCE_LIMITS, sourceInput } from "../shared/sources";
import { DomainError } from "./errors";
import {
  githubCredential,
  githubCredentialIdentity,
  githubCredentialReferences,
} from "./github-credentials";
import { githubActorGuard, type GitHubContext } from "./github-authority";
import type { Env } from "./types";

export type GitHubSourceRow = {
  id: string;
  name: string;
  revision: number;
  enabled: number;
  freshness_minutes: number;
  configuration_json: string;
  credential_ref: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  next_refresh_at: string | null;
  last_refresh_id: string | null;
  last_refresh_status: GitHubRefreshState | null;
};
export const GITHUB_SOURCE_SELECT = [
  "SELECT s.id, s.name, s.revision, s.enabled, s.freshness_minutes, s.configuration_json,",
  "s.credential_ref, s.last_attempt_at, s.last_success_at, s.last_error, s.next_refresh_at,",
  "s.last_refresh_id, j.status AS last_refresh_status FROM connections s",
  "LEFT JOIN github_refreshes j ON j.workspace_id = s.workspace_id AND j.id = s.last_refresh_id",
  "WHERE s.workspace_id = ? AND s.provider = 'github'",
].join(" ");

export async function describeGitHubSources(
  env: Env,
  workspaceId: string,
  rows: GitHubSourceRow[],
  scopes: { source_id: string; repository_id: string }[],
  now: number,
): Promise<GitHubSource[]> {
  const credentials = new Map(
    await Promise.all(
      [...new Set(rows.map((row) => row.credential_ref))].map(
        async (reference) =>
          [
            reference,
            await githubCredentialIdentity(env, workspaceId, reference),
          ] as const,
      ),
    ),
  );
  const hashes = [
    ...new Set(
      [...credentials.values()].flatMap((value) => (value ? [value.hash] : [])),
    ),
  ];
  const cooldowns = hashes.length
    ? (
        await env.HQ_DB.prepare(
          "SELECT credential_hash, retry_at FROM github_cooldowns WHERE credential_hash IN (SELECT value FROM json_each(?)) AND retry_at > ?",
        )
          .bind(JSON.stringify(hashes), new Date(now).toISOString())
          .all<{ credential_hash: string; retry_at: string }>()
      ).results
    : [];
  return rows.map((row) => {
    let configuration: unknown;
    try {
      configuration = JSON.parse(row.configuration_json);
    } catch {
      configuration = null;
    }
    const parsed = githubConfigurationSchema.safeParse(configuration);
    const credential = credentials.get(row.credential_ref);
    return {
      id: row.id,
      name: row.name,
      provider: "github",
      revision: row.revision,
      enabled: Boolean(row.enabled),
      freshnessMinutes: row.freshness_minutes,
      repositoryIds: scopes
        .filter((scope) => scope.source_id === row.id)
        .map((scope) => scope.repository_id),
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      credentialConfigured: Boolean(credential),
      github: {
        credentialRef: row.credential_ref,
        configurationValid: parsed.success,
        refreshIntervalMinutes: parsed.success
          ? parsed.data.refreshIntervalMinutes
          : GITHUB_REFRESH_LIMITS.DEFAULT_INTERVAL_MINUTES,
        nextRefreshAt: row.next_refresh_at,
        retryAt:
          cooldowns.find(
            (cooldown) => cooldown.credential_hash === credential?.hash,
          )?.retry_at ?? null,
        activeRefreshId:
          row.last_refresh_status &&
          githubRefreshActive(row.last_refresh_status)
            ? row.last_refresh_id
            : null,
        lastRefreshId: row.last_refresh_id,
        lastRefreshStatus: row.last_refresh_status,
      },
    };
  });
}

export class GitHubSources {
  constructor(readonly context: GitHubContext) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  async row(workspaceId: string, sourceId: string) {
    const row = await this.db
      .prepare(GITHUB_SOURCE_SELECT + " AND s.id = ?")
      .bind(workspaceId, sourceId)
      .first<GitHubSourceRow>();
    if (!row)
      throw new DomainError("not_found", "GitHub source not found", 404);
    return row;
  }
  async scopes(workspaceId: string, sourceId: string) {
    return (
      await this.db
        .prepare(
          "SELECT source_id, repository_id FROM source_repositories WHERE workspace_id = ? AND source_id = ? ORDER BY repository_id",
        )
        .bind(workspaceId, sourceId)
        .all<{ source_id: string; repository_id: string }>()
    ).results;
  }
  async get(input: unknown): Promise<GitHubSource> {
    const { workspaceId, sourceId } = sourceInput.parse(input);
    await this.context.authorize(workspaceId);
    return (
      await describeGitHubSources(
        this.context.env,
        workspaceId,
        [await this.row(workspaceId, sourceId)],
        await this.scopes(workspaceId, sourceId),
        this.context.now(),
      )
    )[0];
  }
  async credentialReferences(input: unknown) {
    const { workspaceId } = githubCredentialListInput.parse(input);
    await this.admin(workspaceId);
    return githubCredentialReferences(this.context.env, workspaceId);
  }
  private async admin(workspaceId: string) {
    await this.context.authorize(workspaceId, CAPABILITY.ADMIN);
    await this.context.authorize(workspaceId, CAPABILITY.READ);
  }
  private async validate(
    workspaceId: string,
    source: GitHubSourceFields,
    previousRef?: string | null,
  ) {
    const total = await this.db
      .prepare(
        "SELECT count(*) FROM repositories WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(workspaceId, JSON.stringify(source.repositoryIds))
      .first<number>("count(*)");
    if (total !== source.repositoryIds.length)
      throw new DomainError(
        "validation",
        "Choose repositories enrolled in this workspace",
        400,
      );
    if (
      source.credentialRef &&
      source.credentialRef !== previousRef &&
      !githubCredential(this.context.env, workspaceId, source.credentialRef)
    )
      throw new DomainError(
        "validation",
        "Choose an available GitHub credential for this workspace, or save without one",
        400,
      );
  }
  private actorGuard(workspaceId: string) {
    const { principal } = this.context;
    return githubActorGuard(
      workspaceId,
      principal.subject,
      principal.tokenId ?? null,
      this.timestamp(),
      true,
    );
  }
  private audit(
    workspaceId: string,
    sourceId: string,
    writeId: string,
    type: string,
    title: string,
    summary: string,
  ) {
    return this.db
      .prepare(
        "INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)",
      )
      .bind(
        crypto.randomUUID(),
        workspaceId,
        this.context.principal.subject,
        this.context.principal.displayName,
        type,
        title,
        summary,
        this.timestamp(),
        workspaceId,
        sourceId,
        writeId,
      );
  }
  private scopeInsert(
    workspaceId: string,
    sourceId: string,
    ids: string[],
    writeId: string,
  ) {
    return this.db
      .prepare(
        "INSERT INTO source_repositories (workspace_id, source_id, repository_id) SELECT ?, ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)",
      )
      .bind(
        workspaceId,
        sourceId,
        JSON.stringify(ids),
        workspaceId,
        sourceId,
        writeId,
      );
  }
  async enroll(input: unknown) {
    const { workspaceId, sourceId, source } = githubEnrollInput.parse(input);
    await this.admin(workspaceId);
    await this.validate(workspaceId, source);
    const writeId = crypto.randomUUID();
    const guard = this.actorGuard(workspaceId);
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO connections (workspace_id, id, name, provider, revision, enabled, freshness_minutes, credential_ref, configuration_json, write_id, next_refresh_at) SELECT ?, ?, ?, 'github', 1, ?, ?, ?, ?, ?, ? WHERE " +
            guard.sql +
            " AND (SELECT count(*) FROM connections WHERE workspace_id = ?) < ? ON CONFLICT (workspace_id, id) DO NOTHING",
        )
        .bind(
          workspaceId,
          sourceId,
          source.name,
          Number(source.enabled),
          source.freshnessMinutes,
          source.credentialRef,
          JSON.stringify({
            refreshIntervalMinutes: source.refreshIntervalMinutes,
          }),
          writeId,
          this.timestamp(),
          ...guard.values,
          workspaceId,
          SOURCE_LIMITS.SOURCES,
        ),
      this.scopeInsert(workspaceId, sourceId, source.repositoryIds, writeId),
      this.audit(
        workspaceId,
        sourceId,
        writeId,
        "github.source.enrolled",
        "GitHub source enrolled",
        source.name +
          ": read-only collection is limited to selected repositories",
      ),
    ]);
    if (!result[0].meta.changes) {
      await this.admin(workspaceId);
      const occupied = await this.db
        .prepare(
          "SELECT provider FROM connections WHERE workspace_id = ? AND id = ?",
        )
        .bind(workspaceId, sourceId)
        .first<{ provider: string }>();
      if (!occupied)
        throw new DomainError(
          "capacity",
          "Source enrollment was not accepted. Check workspace capacity and your access before retrying.",
          409,
        );
      if (occupied.provider !== "github")
        throw new DomainError(
          "revision_conflict",
          "This source ID belongs to another provider",
          409,
        );
      const existing = await this.get({ workspaceId, sourceId });
      const actual: GitHubSourceFields = {
        name: existing.name,
        enabled: existing.enabled,
        freshnessMinutes: existing.freshnessMinutes,
        repositoryIds: [...existing.repositoryIds].sort(),
        credentialRef: existing.github.credentialRef,
        refreshIntervalMinutes: existing.github.refreshIntervalMinutes,
      };
      if (
        existing.revision !== 1 ||
        JSON.stringify(actual) !==
          JSON.stringify({
            name: source.name,
            enabled: source.enabled,
            freshnessMinutes: source.freshnessMinutes,
            repositoryIds: [...source.repositoryIds].sort(),
            credentialRef: source.credentialRef,
            refreshIntervalMinutes: source.refreshIntervalMinutes,
          })
      )
        throw new DomainError(
          "revision_conflict",
          "This source ID already belongs to different settings",
          409,
        );
    }
    return this.get({ workspaceId, sourceId });
  }
  async update(input: unknown) {
    const { workspaceId, sourceId, revision, source } =
      githubUpdateInput.parse(input);
    await this.admin(workspaceId);
    const previous = await this.row(workspaceId, sourceId);
    await this.validate(workspaceId, source, previous.credential_ref);
    const writeId = crypto.randomUUID();
    const now = this.timestamp();
    const guard = this.actorGuard(workspaceId);
    const changed =
      "EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)";
    const identity = [workspaceId, sourceId, writeId];
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE connections SET name = ?, enabled = ?, freshness_minutes = ?, credential_ref = ?, configuration_json = ?, revision = revision + 1, write_id = ?, next_refresh_at = ? WHERE workspace_id = ? AND id = ? AND provider = 'github' AND revision = ? AND " +
            guard.sql,
        )
        .bind(
          source.name,
          Number(source.enabled),
          source.freshnessMinutes,
          source.credentialRef,
          JSON.stringify({
            refreshIntervalMinutes: source.refreshIntervalMinutes,
          }),
          writeId,
          now,
          workspaceId,
          sourceId,
          revision,
          ...guard.values,
        ),
      this.db
        .prepare(
          "DELETE FROM source_repositories WHERE workspace_id = ? AND source_id = ? AND " +
            changed,
        )
        .bind(workspaceId, sourceId, ...identity),
      this.scopeInsert(workspaceId, sourceId, source.repositoryIds, writeId),
      this.db
        .prepare(
          "UPDATE observations SET expires_at = min(expires_at, CASE WHEN ? OR resource_id NOT IN (SELECT value FROM json_each(?)) THEN ? ELSE strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, ?) END) WHERE workspace_id = ? AND source_id = ? AND " +
            changed,
        )
        .bind(
          Number(
            !source.enabled || source.credentialRef !== previous.credential_ref,
          ),
          JSON.stringify(source.repositoryIds),
          now,
          "+" + source.freshnessMinutes + " minutes",
          workspaceId,
          sourceId,
          ...identity,
        ),
      this.db
        .prepare(
          "UPDATE github_refresh_items SET status = 'cancelled', summary = 'Source settings changed; start a refresh with the saved scope', updated_at = ?, lease_id = NULL, lease_until = NULL WHERE workspace_id = ? AND refresh_id IN (SELECT id FROM github_refreshes WHERE workspace_id = ? AND source_id = ? AND status IN ('queued', 'running')) AND status IN ('queued', 'running') AND " +
            changed,
        )
        .bind(now, workspaceId, workspaceId, sourceId, ...identity),
      this.db
        .prepare(
          "UPDATE github_refreshes SET status = 'cancelled', summary = 'Source settings changed; start a refresh with the saved scope', completed_at = ?, write_id = ? WHERE workspace_id = ? AND source_id = ? AND status IN ('queued', 'running') AND " +
            changed,
        )
        .bind(now, writeId, workspaceId, sourceId, ...identity),
      this.audit(
        workspaceId,
        sourceId,
        writeId,
        "github.source.updated",
        "GitHub source settings saved",
        source.name +
          ": scope and freshness policy applied; in-flight refresh work cancelled",
      ),
    ]);
    if (!results[0].meta.changes)
      throw new DomainError(
        "revision_conflict",
        "This GitHub source changed while you were editing. Your draft has not been saved.",
        409,
      );
    return this.get({ workspaceId, sourceId });
  }
}
