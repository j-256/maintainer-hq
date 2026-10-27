import { z } from "zod";
import { CAPABILITY } from "../shared/domain";
import { GITHUB_CONTEXT_LIMITS as READ_LIMITS } from "../shared/github-context";
import { DEPENDENCY_CHANGE_LIMITS as LIMITS } from "../shared/dependency-changes";
import {
  DEPENDABOT_LIMITS,
  validDependabotTimezone,
} from "../shared/dependabot";
import { supportedDependabotCron } from "../shared/dependabot-cron";
import {
  DEPENDABOT_CHANGE_KIND as KIND,
  dependabotChangePlanInput,
  dependabotChangeReviewInput,
  dependabotChangeReviewSchema,
  type DependabotChangeReview,
} from "../shared/dependabot-changes";
import { readRepositoryDependabot } from "./dependabot";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { githubCredentialIdentity } from "./github-credentials";
import { dependencyHash } from "./dependency-client";
import { dependencyCredential } from "./dependency-credentials";
import { readDependabotBlob } from "./dependabot-client";
import { GitHubReader } from "./github-client";
import { editDependabotDocument } from "./dependabot-yaml";
import { repositoryReviewGuard } from "./repository-review-authority";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export const storedDependabotReviewSchema = z
  .object({
    review: dependabotChangeReviewSchema.omit({
      planId: true,
      fingerprint: true,
      expiresAt: true,
      state: true,
    }),
    memberRevision: z.number().int().positive(),
    tokenId: z.string().nullable(),
    credentialRef: z.string(),
    credentialHash: z.string(),
    writerIdentity: z.string().nullable(),
  })
  .strict();
export type StoredDependabotReview = z.infer<
  typeof storedDependabotReviewSchema
>;
function conflict(): never {
  throw new DomainError(
    "revision_conflict",
    "Schedule evidence or access changed. Refresh the repository and prepare a fresh review.",
    409,
  );
}
export class DependabotChanges {
  constructor(readonly context: WorkspaceService) {}
  async plan(input: unknown): Promise<DependabotChangeReview> {
    const fields = dependabotChangePlanInput.parse(input);
    const { workspaceId, sourceId, repositoryId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.OPERATE,
    );
    for (const { schedule } of fields.edits) {
      if (
        (schedule.timezone && !validDependabotTimezone(schedule.timezone)) ||
        (schedule.interval === "cron" &&
          !supportedDependabotCron(schedule.cronjob!))
      )
        throw new DomainError(
          "validation",
          "Choose a valid timezone and a supported five-field cron expression.",
          400,
        );
    }
    const result = await readRepositoryDependabot(this.context, {
      workspaceId,
      sourceId,
      repositoryId,
    });
    const e = result.evidence,
      now = this.context.now();
    if (
      result.state !== "ready" ||
      e?.read.state !== "observed" ||
      e.configuration !== "present" ||
      !e.file ||
      !e.headSha ||
      !e.treeSha ||
      !e.branch ||
      now - Date.parse(e.observedAt) >= DEPENDABOT_LIMITS.CACHE_MS ||
      Date.parse(e.observedAt) > now ||
      e.headSha !== fields.headSha ||
      e.file.digest !== fields.fileDigest
    )
      conflict();
    const source = await this.context.db
      .prepare(
        "SELECT credential_ref FROM connections WHERE workspace_id=? AND id=? AND revision=?",
      )
      .bind(workspaceId, sourceId, result.source.revision)
      .first<{ credential_ref: string }>();
    const credential = source
      ? await githubCredentialIdentity(
          this.context.env,
          workspaceId,
          source.credential_ref,
        )
      : null;
    if (!credential || !source) conflict();
    const writer = fields.credentialId
      ? await dependencyCredential(
          this.context,
          workspaceId,
          fields.credentialId,
          result.repository.fullName,
        )
      : null;
    const stored: StoredDependabotReview = {
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      credentialRef: source.credential_ref,
      credentialHash: credential.hash,
      writerIdentity: writer?.identity ?? null,
      review: {
        workspaceId,
        actor: this.context.principal.displayName,
        writer: writer
          ? {
              id: fields.credentialId!,
              name: writer.settings.name,
              revision: writer.revision,
              expiresAt: writer.settings.expiresAt,
            }
          : null,
        basis: {
          repository: result.repository,
          source: result.source,
          observedAt: e.observedAt,
          headSha: e.headSha,
          treeSha: e.treeSha,
          branch: e.branch,
          file: e.file,
        },
        edits: fields.edits,
        changes: fields.edits.map((edit) => {
          const before = e.entries.find((entry) => entry.id === edit.entryId);
          if (!before?.editable) conflict();
          return { before, after: { ...before, schedule: edit.schedule } };
        }),
        proposedDigest: e.file.digest,
      },
    };
    const guard = await repositoryReviewGuard(this.context, stored);
    const timestamp = new Date(now).toISOString();
    const windowStart =
      Math.floor(now / READ_LIMITS.BUDGET_WINDOW_MS) *
      READ_LIMITS.BUDGET_WINDOW_MS;
    const claim = await this.context.db.batch([
      this.context.db
        .prepare(
          `INSERT INTO github_context_budgets (credential_hash,window_start,reads) SELECT ?,?,0 WHERE ${guard.sql} ON CONFLICT(credential_hash) DO UPDATE SET window_start=excluded.window_start,reads=0 WHERE github_context_budgets.window_start<excluded.window_start`,
        )
        .bind(credential.hash, windowStart, ...guard.values),
      this.context.db
        .prepare(
          `UPDATE github_context_budgets SET reads=reads+1 WHERE credential_hash=? AND window_start=? AND reads<? AND NOT EXISTS(SELECT 1 FROM github_cooldowns WHERE credential_hash=? AND retry_at>?) AND ${guard.sql}`,
        )
        .bind(
          credential.hash,
          windowStart,
          READ_LIMITS.READS_PER_WINDOW,
          credential.hash,
          timestamp,
          ...guard.values,
        ),
    ]);
    if (!claim[1].meta.changes)
      throw new DomainError(
        "conflict",
        "Schedule review read budget or access is unavailable. Wait one minute or follow the provider cooldown before preparing another review.",
        409,
      );
    const reader = new GitHubReader(credential.token, {
      now: this.context.now,
      maxRequests: 1,
    });
    let text: string;
    try {
      await this.assert(stored);
      text = await readDependabotBlob(
        reader,
        "/repos/" +
          result.repository.fullName
            .split("/")
            .map(encodeURIComponent)
            .join("/"),
        { sha: e.file.blobSha },
      );
    } catch {
      if (reader.retryAt !== null)
        await this.context.db
          .prepare(
            `INSERT INTO github_cooldowns(credential_hash,retry_at) SELECT ?,? WHERE ${guard.sql} ON CONFLICT(credential_hash) DO UPDATE SET retry_at=MAX(github_cooldowns.retry_at,excluded.retry_at)`,
          )
          .bind(
            credential.hash,
            new Date(reader.retryAt).toISOString(),
            ...guard.values,
          )
          .run();
      throw new DomainError(
        "conflict",
        "The pinned schedule file could not be verified. Refresh the repository or follow its provider cooldown.",
        409,
      );
    }
    if ((await dependencyHash(text)) !== e.file.digest) conflict();
    try {
      stored.review.proposedDigest = await dependencyHash(
        editDependabotDocument(text, e.file.digest, fields.edits),
      );
    } catch {
      throw new DomainError(
        "validation",
        "These schedules cannot be changed safely, or no schedule changed. Inspect the selected entries again.",
        400,
      );
    }
    const serialized = JSON.stringify(
      storedDependabotReviewSchema.parse(stored),
    );
    const fingerprint = await dependencyHash(serialized),
      planId = crypto.randomUUID();
    const expiresAt = new Date(now + LIMITS.REVIEW_MS).toISOString();
    const finalGuard = await repositoryReviewGuard(this.context, stored);
    const saved = await this.context.db.batch([
      this.context.db
        .prepare(
          `DELETE FROM action_plans WHERE id IN(SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM operations WHERE plan_id=action_plans.id) LIMIT ?) AND ${finalGuard.sql}`,
        )
        .bind(
          workspaceId,
          this.context.principal.subject,
          KIND,
          timestamp,
          LIMITS.CLEANUP,
          ...finalGuard.values,
        ),
      this.context.db
        .prepare(
          `INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE ${finalGuard.sql} AND EXISTS(SELECT 1 FROM github_dependabot_cache WHERE workspace_id=? AND source_id=? AND repository_id=? AND json_extract(result_json,'$.headSha')=? AND json_extract(result_json,'$.file.digest')=?) AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
        )
        .bind(
          planId,
          workspaceId,
          this.context.principal.subject,
          KIND,
          serialized,
          fingerprint,
          timestamp,
          expiresAt,
          ...finalGuard.values,
          workspaceId,
          sourceId,
          repositoryId,
          e.headSha,
          e.file.digest,
          workspaceId,
          this.context.principal.subject,
          KIND,
          timestamp,
          LIMITS.PENDING,
        ),
    ]);
    if (!saved[1].meta.changes) conflict();
    return this.review({ workspaceId, planId });
  }
  private async assert(stored: StoredDependabotReview) {
    const catalog = this.context.env.GITHUB_CREDENTIALS;
    const guard = await repositoryReviewGuard(this.context, stored);
    const found = await this.context.db
      .prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.values)
      .first();
    if (
      !found ||
      catalog !== this.context.env.GITHUB_CREDENTIALS ||
      (this.context.principal.expiresAt !== undefined &&
        this.context.principal.expiresAt <= this.context.now())
    )
      conflict();
    return found;
  }
  async load(workspaceId: string, planId: string) {
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const actor = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.context.db
      .prepare(
        `SELECT input_json,fingerprint,expires_at FROM action_plans WHERE workspace_id=? AND id=? AND kind=? AND actor_subject=? AND ${actor.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        KIND,
        this.context.principal.subject,
        ...actor.values,
      )
      .first<{ input_json: string; fingerprint: string; expires_at: string }>();
    if (!row)
      throw new DomainError(
        "not_found",
        "This schedule review is not available to this workspace and identity.",
        404,
      );
    const stored = storedDependabotReviewSchema.parse(
      JSON.parse(row.input_json),
    );
    if (
      stored.review.workspaceId !== workspaceId ||
      stored.tokenId !== (this.context.principal.tokenId ?? null) ||
      (await dependencyHash(row.input_json)) !== row.fingerprint
    )
      conflict();
    return { row, stored };
  }
  async review(input: unknown): Promise<DependabotChangeReview> {
    const { workspaceId, planId } = dependabotChangeReviewInput.parse(input);
    const { row, stored } = await this.load(workspaceId, planId);
    let matches = true;
    try {
      await this.assert(stored);
    } catch {
      matches = false;
    }
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    return dependabotChangeReviewSchema.parse({
      ...stored.review,
      planId,
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
      state:
        Date.parse(row.expires_at) <= this.context.now()
          ? "expired"
          : matches
            ? "ready"
            : "stale",
    });
  }
}
