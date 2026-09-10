import {
  observationSchema,
  LIMITS as WORKSPACE_LIMITS,
} from "../shared/domain";
import { GITHUB_REFRESH_LIMITS as LIMITS } from "../shared/github";
import { GITHUB_JOB_AUTHORITY_SQL } from "./github-authority";
import { collectGitHub, type GitHubCollection } from "./github-client";
import { githubCredentialIdentity } from "./github-credentials";
import {
  githubJobAudit,
  readGitHubRefreshItems,
  scheduleGitHubSources,
} from "./github-jobs";
import { githubRefreshSummary } from "../shared/github-refresh-summary";
import { GITHUB_CHANGE_SQL } from "./github-changes";
import type { Env } from "./types";
import { emitDiagnostic } from "./diagnostics";
import { deliverWorkspacePush } from "./workspace-push";

type RunnerOptions = {
  now?: () => number;
  wallNow?: () => number;
  fetch?: typeof fetch;
  maxItems?: number;
  budgetMs?: number;
  runId?: string;
  trigger?: "scheduled" | "background";
};
type Job = {
  workspace_id: string;
  id: string;
  source_id: string;
  credential_ref: string;
  credential_hash: string;
  created_at: string;
};
type Item = Job & {
  repository_id: string;
  full_name: string;
  freshness_minutes: number;
};
const ACTIVE = "('queued', 'running')";
// The bound timestamp also supports deterministic expiry checks in tests
const VALID_JOB = [
  "j.status IN " + ACTIVE,
  "AND EXISTS (SELECT 1 FROM connections s WHERE s.workspace_id = j.workspace_id",
  "AND s.id = j.source_id AND s.provider = 'github' AND s.enabled = 1",
  "AND s.revision = j.source_revision AND s.credential_ref = j.credential_ref)",
  "AND " + GITHUB_JOB_AUTHORITY_SQL,
  "AND (j.trigger = 'scheduled' OR j.actor_token_id IS NULL OR EXISTS",
  "(SELECT 1 FROM credentials c WHERE c.id = j.actor_token_id AND c.expires_at > ?))",
  "AND NOT EXISTS (SELECT 1 FROM github_refresh_items pinned",
  "WHERE pinned.workspace_id = j.workspace_id AND pinned.refresh_id = j.id AND NOT EXISTS",
  "(SELECT 1 FROM source_repositories scope JOIN repositories r",
  "ON r.workspace_id = scope.workspace_id AND r.id = scope.repository_id",
  "WHERE scope.workspace_id = j.workspace_id AND scope.source_id = j.source_id",
  "AND r.id = pinned.repository_id AND r.full_name = pinned.full_name COLLATE NOCASE))",
].join(" ");
const ITEM_VALID =
  "EXISTS (SELECT 1 FROM github_refreshes j WHERE j.workspace_id = i.workspace_id AND j.id = i.refresh_id AND " +
  VALID_JOB +
  ")";

class GitHubRunner {
  readonly db: D1Database;
  readonly now: () => number;
  constructor(
    readonly env: Env,
    readonly options: RunnerOptions,
  ) {
    this.db = env.HQ_DB;
    this.now = options.now ?? Date.now;
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  private async stop(
    job: Job,
    status: "cancelled" | "failed",
    summary: string,
  ) {
    const now = this.timestamp();
    const writeId = crypto.randomUUID();
    const saved =
      "EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND write_id = ?)";
    const identity = [job.workspace_id, job.id, writeId];
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE github_refreshes SET status = ?, summary = ?, completed_at = ?, write_id = ?, changed = changed + CASE WHEN EXISTS (SELECT 1 FROM connections s WHERE s.workspace_id = github_refreshes.workspace_id AND s.id = github_refreshes.source_id AND s.last_error IS NOT ?) THEN 1 ELSE 0 END WHERE workspace_id = ? AND id = ? AND status IN " +
            ACTIVE,
        )
        .bind(status, summary, now, writeId, summary, job.workspace_id, job.id),
      this.db
        .prepare(
          "UPDATE github_refresh_items SET status = ?, summary = ?, updated_at = ?, lease_id = NULL, lease_until = NULL WHERE workspace_id = ? AND refresh_id = ? AND status IN " +
            ACTIVE +
            " AND " +
            saved,
        )
        .bind(status, summary, now, job.workspace_id, job.id, ...identity),
      this.db
        .prepare(
          "UPDATE connections SET last_error = ? WHERE workspace_id = ? AND id = ? AND last_refresh_id = ? AND " +
            saved,
        )
        .bind(summary, job.workspace_id, job.source_id, job.id, ...identity),
      ...githubJobAudit(
        this.db,
        job.workspace_id,
        job.id,
        writeId,
        "github.refresh." + status,
        "GitHub refresh " + status,
        now,
      ),
    ]);
  }
  async recover() {
    const jobs = (
      await this.db
        .prepare(
          "SELECT workspace_id, id, source_id, credential_ref, credential_hash, created_at FROM github_refreshes WHERE status IN " +
            ACTIVE +
            " ORDER BY created_at LIMIT ?",
        )
        .bind(LIMITS.RECOVERY_JOBS)
        .all<Job>()
    ).results;
    for (const job of jobs) {
      const credential = await githubCredentialIdentity(
        this.env,
        job.workspace_id,
        job.credential_ref,
      );
      const valid = await this.db
        .prepare(
          "SELECT 1 FROM github_refreshes j WHERE j.workspace_id = ? AND j.id = ? AND " +
            VALID_JOB,
        )
        .bind(job.workspace_id, job.id, this.timestamp())
        .first();
      if (!valid || !credential || credential.hash !== job.credential_hash) {
        await this.stop(
          job,
          "cancelled",
          "Source scope, credential, repository identity, or operator access changed. Start a new refresh after reviewing settings.",
        );
        continue;
      }
      if (this.now() - Date.parse(job.created_at) >= LIMITS.JOB_MAX_AGE_MS) {
        await this.stop(
          job,
          "failed",
          "Refresh exceeded its recovery window. Inspect the source and start a new refresh.",
        );
        continue;
      }
      await this.db
        .prepare(
          [
            "UPDATE github_refresh_items SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,",
            "summary = CASE WHEN attempts >= ? THEN 'Collection interrupted repeatedly; start a new refresh' ELSE 'Interrupted collection queued for recovery' END,",
            "updated_at = ?, lease_id = NULL, lease_until = NULL WHERE workspace_id = ? AND refresh_id = ?",
            "AND status = 'running' AND lease_until <= ?",
            "AND EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND status IN " +
              ACTIVE +
              ")",
          ].join(" "),
        )
        .bind(
          LIMITS.MAX_ATTEMPTS,
          LIMITS.MAX_ATTEMPTS,
          this.timestamp(),
          job.workspace_id,
          job.id,
          this.timestamp(),
          job.workspace_id,
          job.id,
        )
        .run();
      await this.finish(job);
    }
    const cutoff = new Date(
      this.now() - LIMITS.RETENTION_DAYS * LIMITS.DAY_MS,
    ).toISOString();
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM github_refreshes WHERE completed_at < ? AND status NOT IN " +
            ACTIVE +
            " AND NOT EXISTS (SELECT 1 FROM connections s WHERE s.workspace_id = github_refreshes.workspace_id AND s.last_refresh_id = github_refreshes.id)",
        )
        .bind(cutoff),
      this.db
        .prepare("DELETE FROM github_cooldowns WHERE retry_at <= ?")
        .bind(this.timestamp()),
    ]);
  }
  private async finish(job: Job) {
    const now = this.timestamp();
    const writeId = crypto.randomUUID();
    const totals = await this.db
      .prepare(
        "SELECT count(*) AS total, sum(status = 'succeeded') AS succeeded, sum(status = 'failed') AS failed, sum(status IN " +
          ACTIVE +
          ") AS pending FROM github_refresh_items WHERE workspace_id = ? AND refresh_id = ?",
      )
      .bind(job.workspace_id, job.id)
      .first<{
        total: number;
        succeeded: number;
        failed: number;
        pending: number;
      }>();
    if (!totals || totals.pending) return;
    const status =
      totals.total > 0 && totals.succeeded === totals.total
        ? "succeeded"
        : !totals.total || totals.failed === totals.total
          ? "failed"
          : "partial";
    const { summary, outcome } = githubRefreshSummary(
      await readGitHubRefreshItems(this.db, job.workspace_id, job.id),
    );
    const collectionError = status === "succeeded" ? null : outcome;
    const saved =
      "EXISTS (SELECT 1 FROM github_refreshes WHERE workspace_id = ? AND id = ? AND write_id = ?)";
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE github_refreshes AS j SET status = ?, summary = ?, completed_at = ?, write_id = ?, changed = changed + CASE WHEN EXISTS (SELECT 1 FROM connections s WHERE s.workspace_id = j.workspace_id AND s.id = j.source_id AND s.last_error IS NOT ?) THEN 1 ELSE 0 END WHERE j.workspace_id = ? AND j.id = ? AND " +
            VALID_JOB +
            " AND NOT EXISTS (SELECT 1 FROM github_refresh_items i WHERE i.workspace_id = j.workspace_id AND i.refresh_id = j.id AND i.status IN " +
            ACTIVE +
            ")",
        )
        .bind(
          status,
          summary,
          now,
          writeId,
          collectionError,
          job.workspace_id,
          job.id,
          now,
        ),
      this.db
        .prepare(
          "UPDATE connections SET last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END, last_error = ? WHERE workspace_id = ? AND id = ? AND last_refresh_id = ? AND " +
            saved,
        )
        .bind(
          status,
          now,
          collectionError,
          job.workspace_id,
          job.source_id,
          job.id,
          job.workspace_id,
          job.id,
          writeId,
        ),
      ...githubJobAudit(
        this.db,
        job.workspace_id,
        job.id,
        writeId,
        "github.refresh.completed",
        "GitHub refresh completed",
        now,
      ),
    ]);
  }
  private async candidate() {
    return this.db
      .prepare(
        [
          "SELECT j.workspace_id, j.id, j.source_id, j.credential_ref, j.credential_hash, j.created_at,",
          "i.repository_id, i.full_name, s.freshness_minutes FROM github_refresh_items i",
          "JOIN github_refreshes j ON j.workspace_id = i.workspace_id AND j.id = i.refresh_id",
          "JOIN connections s ON s.workspace_id = j.workspace_id AND s.id = j.source_id",
          "WHERE i.status = 'queued' AND " + VALID_JOB,
          "AND NOT EXISTS (SELECT 1 FROM github_cooldowns c WHERE c.credential_hash = j.credential_hash AND c.retry_at > ?)",
          "AND NOT EXISTS (SELECT 1 FROM github_refresh_items running WHERE running.workspace_id = i.workspace_id AND running.refresh_id = i.refresh_id AND running.status = 'running')",
          "ORDER BY i.updated_at, j.created_at, i.repository_id LIMIT 1",
        ].join(" "),
      )
      .bind(this.timestamp(), this.timestamp())
      .first<Item>();
  }
  private async accept(item: Item, lease: string, result: GitHubCollection) {
    const credential = await githubCredentialIdentity(
      this.env,
      item.workspace_id,
      item.credential_ref,
    );
    if (!credential || credential.hash !== item.credential_hash) {
      await this.stop(
        item,
        "cancelled",
        "The server-side GitHub credential changed. Start a new refresh.",
      );
      return {
        receiptRecorded: false,
        evidenceStored: false,
        capacityLimited: false,
      };
    }
    const now = this.timestamp();
    const evidence = observationSchema.parse({
      sourceId: item.source_id,
      resourceId: item.repository_id,
      resourceType: "repository",
      name: item.full_name,
      health: result.health,
      summary: result.summary,
      observedAt: result.observedAt,
      expiresAt: new Date(
        Date.parse(result.observedAt) +
          item.freshness_minutes * LIMITS.MINUTE_MS,
      ).toISOString(),
      details: result.details,
    });
    const saved =
      "EXISTS (SELECT 1 FROM github_refresh_items WHERE workspace_id = ? AND refresh_id = ? AND repository_id = ? AND lease_id = ? AND status = ?)";
    const identity = [
      item.workspace_id,
      item.id,
      item.repository_id,
      lease,
      result.status,
    ];
    const details = JSON.stringify(evidence.details);
    const written = await this.db.batch([
      this.db
        .prepare(
          "UPDATE github_refresh_items AS i SET status = ?, summary = ?, result_json = ?, observed_at = ?, updated_at = ?, changes_json = " +
            GITHUB_CHANGE_SQL +
            ", lease_until = NULL WHERE workspace_id = ? AND refresh_id = ? AND repository_id = ? AND status = 'running' AND lease_id = ? AND lease_until > ? AND " +
            ITEM_VALID,
        )
        .bind(
          result.status,
          result.summary,
          JSON.stringify(result),
          result.observedAt,
          now,
          JSON.stringify(evidence),
          item.workspace_id,
          item.id,
          item.repository_id,
          lease,
          now,
          now,
        ),
      this.db
        .prepare(
          "UPDATE github_refreshes SET changed = changed + 1 WHERE workspace_id = ? AND id = ? AND " +
            saved +
            " AND NOT EXISTS (SELECT 1 FROM observations WHERE workspace_id = ? AND source_id = ? AND resource_type = 'repository' AND resource_id = ? AND (observed_at > ? OR (details_json = ? AND health = ? AND summary = ?)))",
        )
        .bind(
          item.workspace_id,
          item.id,
          ...identity,
          item.workspace_id,
          item.source_id,
          item.repository_id,
          result.observedAt,
          details,
          result.health,
          result.summary,
        ),
      this.db
        .prepare(
          [
            "INSERT INTO observations (workspace_id, source_id, resource_type, resource_id, name, health, summary, details_json, observed_at, received_at, expires_at)",
            "SELECT ?, ?, 'repository', ?, ?, ?, ?, ?, ?, ?, ? WHERE " + saved,
            "AND ((SELECT count(*) FROM observations WHERE workspace_id = ?) < ? OR EXISTS (SELECT 1 FROM observations WHERE workspace_id = ? AND source_id = ? AND resource_type = 'repository' AND resource_id = ?))",
            "ON CONFLICT (workspace_id, source_id, resource_type, resource_id) DO UPDATE SET",
            "name = excluded.name, health = excluded.health, summary = excluded.summary, details_json = excluded.details_json,",
            "observed_at = excluded.observed_at, received_at = excluded.received_at, expires_at = excluded.expires_at",
            "WHERE observations.observed_at <= excluded.observed_at",
          ].join(" "),
        )
        .bind(
          item.workspace_id,
          item.source_id,
          item.repository_id,
          evidence.name,
          evidence.health,
          evidence.summary,
          details,
          evidence.observedAt,
          now,
          evidence.expiresAt,
          ...identity,
          item.workspace_id,
          WORKSPACE_LIMITS.MAX_OBSERVATIONS,
          item.workspace_id,
          item.source_id,
          item.repository_id,
        ),
      this.db
        .prepare(
          "UPDATE github_refresh_items SET status = 'failed', changes_json = NULL, summary = 'Workspace evidence capacity reached. Review source scope before retrying.' WHERE workspace_id = ? AND refresh_id = ? AND repository_id = ? AND " +
            saved +
            " AND NOT EXISTS (SELECT 1 FROM observations WHERE workspace_id = ? AND source_id = ? AND resource_type = 'repository' AND resource_id = ?)",
        )
        .bind(
          item.workspace_id,
          item.id,
          item.repository_id,
          ...identity,
          item.workspace_id,
          item.source_id,
          item.repository_id,
        ),
      ...(result.retryAt
        ? [
            this.db
              .prepare(
                "INSERT INTO github_cooldowns (credential_hash, retry_at) VALUES (?, ?) ON CONFLICT (credential_hash) DO UPDATE SET retry_at = max(retry_at, excluded.retry_at)",
              )
              .bind(item.credential_hash, result.retryAt),
          ]
        : []),
    ]);
    await this.finish(item);
    return {
      receiptRecorded: Boolean(written[0].meta.changes),
      evidenceStored: Boolean(written[2].meta.changes),
      capacityLimited: Boolean(written[3].meta.changes),
    };
  }
  async run() {
    const wallNow = this.options.wallNow ?? Date.now;
    const started = wallNow();
    const trigger = this.options.trigger ?? "background";
    const runId = this.options.runId ?? crypto.randomUUID();
    let stopReason:
      "drained" | "item_limit" | "time_limit" | "claim_lost" | "unexpected" =
      "drained";
    let failed = false;
    const budget = Math.min(
      this.options.budgetMs ?? LIMITS.HTTP_BUDGET_MS,
      LIMITS.CRON_BUDGET_MS,
    );
    const maximum = Math.min(
      this.options.maxItems ?? LIMITS.HTTP_ITEMS,
      LIMITS.CRON_ITEMS,
    );
    const reserve = trigger === "scheduled" ? LIMITS.CRON_ITEM_RESERVE_MS : 1;
    const remaining = () => budget - (wallNow() - started);
    let processed = 0;
    try {
      await this.recover();
      if (trigger === "scheduled")
        await scheduleGitHubSources(this.env, this.now);
      while (processed < maximum) {
        if (remaining() < reserve) {
          stopReason = "time_limit";
          break;
        }
        const item = await this.candidate();
        if (!item) break;
        const credential = await githubCredentialIdentity(
          this.env,
          item.workspace_id,
          item.credential_ref,
        );
        if (!credential || credential.hash !== item.credential_hash) {
          await this.stop(
            item,
            "cancelled",
            "The server-side GitHub credential changed. Start a new refresh.",
          );
          processed++;
          continue;
        }
        if (remaining() < reserve) {
          stopReason = "time_limit";
          break;
        }
        const now = this.timestamp();
        const lease = crypto.randomUUID();
        const claimed = await this.db.batch([
          this.db
            .prepare(
              [
                "UPDATE github_refresh_items AS i SET status = 'running', summary = 'Reading GitHub evidence', attempts = attempts + 1, lease_id = ?, lease_until = ?, updated_at = ?",
                "WHERE workspace_id = ? AND refresh_id = ? AND repository_id = ? AND status = 'queued' AND attempts < ? AND " +
                  ITEM_VALID,
                "AND NOT EXISTS (SELECT 1 FROM github_refresh_items running WHERE running.workspace_id = i.workspace_id AND running.refresh_id = i.refresh_id AND running.status = 'running')",
                "AND NOT EXISTS (SELECT 1 FROM github_cooldowns WHERE credential_hash = ? AND retry_at > ?)",
              ].join(" "),
            )
            .bind(
              lease,
              new Date(this.now() + LIMITS.LEASE_MS).toISOString(),
              now,
              item.workspace_id,
              item.id,
              item.repository_id,
              LIMITS.MAX_ATTEMPTS,
              now,
              item.credential_hash,
              now,
            ),
          this.db
            .prepare(
              "UPDATE github_refreshes SET status = 'running', summary = 'Reading GitHub evidence' WHERE workspace_id = ? AND id = ? AND status IN " +
                ACTIVE +
                " AND EXISTS (SELECT 1 FROM github_refresh_items WHERE workspace_id = ? AND refresh_id = ? AND lease_id = ?)",
            )
            .bind(
              item.workspace_id,
              item.id,
              item.workspace_id,
              item.id,
              lease,
            ),
        ]);
        if (!claimed[0].meta.changes) {
          stopReason = "claim_lost";
          break;
        }
        await deliverWorkspacePush(this.env, item.workspace_id);
        processed++;
        const diagnosticContext = {
          runId,
          workspaceId: item.workspace_id,
          sourceId: item.source_id,
          refreshId: item.id,
          repositoryId: item.repository_id,
        };
        emitDiagnostic({
          event: "hq.github.repository.started",
          ...diagnosticContext,
        });
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          Math.max(1, remaining()),
        );
        try {
          const result = await collectGitHub(item.full_name, credential.token, {
            now: this.now,
            fetch: this.options.fetch,
            signal: controller.signal,
          });
          const acceptance = await this.accept(item, lease, result);
          emitDiagnostic({
            event: "hq.github.repository.completed",
            ...diagnosticContext,
            status: result.status,
            ...acceptance,
            diagnostics: result.diagnostics,
          });
        } finally {
          clearTimeout(timer);
          await deliverWorkspacePush(this.env, item.workspace_id);
        }
      }
      if (stopReason === "drained" && processed >= maximum)
        stopReason = "item_limit";
      await this.recover();
      return { processed };
    } catch (error) {
      stopReason = "unexpected";
      failed = true;
      throw error;
    } finally {
      await deliverWorkspacePush(this.env);
      emitDiagnostic({
        event: "hq.github.batch.completed",
        runId,
        trigger,
        processed,
        elapsedMs: Math.max(0, wallNow() - started),
        stopReason,
        failed,
      });
    }
  }
}

export function runGitHubJobs(env: Env, options: RunnerOptions = {}) {
  return new GitHubRunner(env, options).run();
}
export function runGitHubScheduled(env: Env, options: RunnerOptions = {}) {
  return runGitHubJobs(env, {
    ...options,
    maxItems: LIMITS.CRON_ITEMS,
    budgetMs: LIMITS.CRON_BUDGET_MS,
    trigger: "scheduled",
  });
}
