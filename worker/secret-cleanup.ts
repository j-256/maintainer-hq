import { CAPABILITY } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretWriteResultSchema,
  type SecretMetadata,
  type SecretWriteResult,
} from "../shared/secrets";
import {
  secretCleanupInput,
  secretCleanupPlanInput,
  secretCleanupApplyInput,
  secretCleanupHistoryInput,
  secretCleanupReviewSchema,
  type SecretCleanupReview,
  type SecretCleanupReceipt,
} from "../shared/secret-cleanup";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  SecretReviews,
  describeCapturedSecret,
  secretReviewConflict,
} from "./secret-reviews";
import {
  capturedSecretGuard,
  connectCapturedSecrets,
} from "./secret-authority";
import { SecretOperations } from "./secret-operations";
import { secretAdapter } from "./secret-adapter-registry";
import {
  captureSecretCleanupEvidence,
  secretCleanupEvidenceSchema,
  secretCleanupPathGuard,
} from "./secret-cleanup-evidence";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { captureSecretProjectActivity } from "./project-resources";
import type { WorkspaceService } from "./service";

type CleanupRow = {
  workspace_id: string;
  id: string;
  distribution_review_id: string;
  actor_subject: string;
  actor_name: string;
  actor_token_id: string | null;
  member_revision: number;
  request_hash: string;
  captured_json: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  phase: SecretCleanupReceipt["phase"];
  write_status: SecretCleanupReceipt["writeStatus"];
  reason: SecretCleanupReceipt["reason"];
  observation_status: SecretCleanupReceipt["observationStatus"];
  metadata_json: string | null;
  observed_at: string | null;
  submitted_at: string | null;
  updated_at: string;
  revision: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  write_id: string;
};
export class SecretCleanup {
  readonly reviews: SecretReviews;
  constructor(readonly context: WorkspaceService) {
    this.reviews = new SecretReviews(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private matchesActor(row: CleanupRow) {
    return (
      row.actor_subject === this.context.principal.subject &&
      row.actor_token_id === (this.context.principal.tokenId ?? null)
    );
  }
  private captured(row: CleanupRow) {
    return secretCleanupEvidenceSchema.parse(JSON.parse(row.captured_json));
  }
  private async row(workspaceId: string, cleanupId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT * FROM secret_cleanup_reviews WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, cleanupId, ...guard.values)
      .first<CleanupRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Source-removal review not found or access changed.",
        404,
      );
    return row;
  }
  async get(input: unknown): Promise<SecretCleanupReview> {
    const { workspaceId, cleanupId } = secretCleanupInput.parse(input);
    await authorize(this.context, workspaceId);
    const row = await this.row(workspaceId, cleanupId);
    const evidence = this.captured(row);
    await authorize(this.context, workspaceId);
    return secretCleanupReviewSchema.parse({
      id: row.id,
      reviewId: row.distribution_review_id,
      fingerprint: row.fingerprint,
      actorMatches: this.matchesActor(row),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      source: describeCapturedSecret(evidence.source),
      destinations: evidence.destinations.map((item) => ({
        originalDestinationIndex: item.originalDestinationIndex,
        reviewId: item.path.at(-1)!.reviewId,
        destination: describeCapturedSecret(item.destination),
        metadata: item.metadata,
      })),
      receipt: {
        phase: row.phase,
        writeStatus: row.write_status,
        reason: row.reason,
        observationStatus: row.observation_status,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
        observedAt: row.observed_at,
        submittedAt: row.submitted_at,
        updatedAt: row.updated_at,
        revision: row.revision,
        leaseExpiresAt: row.lease_expires_at,
        leaseExpired:
          row.lease_expires_at !== null &&
          Date.parse(row.lease_expires_at) <= this.context.now(),
      },
    });
  }
  async history(input: unknown) {
    const { workspaceId, reviewId, before } =
      secretCleanupHistoryInput.parse(input);
    await authorize(this.context, workspaceId);
    await this.reviews.row(workspaceId, reviewId);
    let cursor: { createdAt: string; id: string } | null = null;
    if (before) {
      try {
        const value = JSON.parse(atob(before)) as {
          createdAt: unknown;
          id: unknown;
        };
        cursor = {
          createdAt: secretCleanupReviewSchema.shape.createdAt.parse(
            value.createdAt,
          ),
          id: secretCleanupInput.shape.cleanupId.parse(value.id),
        };
      } catch {
        throw new DomainError(
          "validation",
          "Select a valid source-removal history page.",
          400,
        );
      }
    }
    const result = await this.db
      .prepare(
        `SELECT id,phase,write_status AS writeStatus,observation_status AS observationStatus,created_at AS createdAt
      FROM secret_cleanup_reviews WHERE workspace_id=? AND distribution_review_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        workspaceId,
        reviewId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        SECRET_LIMITS.HISTORY_PAGE + 1,
      )
      .all<{
        id: string;
        phase: CleanupRow["phase"];
        writeStatus: CleanupRow["write_status"];
        observationStatus: CleanupRow["observation_status"];
        createdAt: string;
      }>();
    await authorize(this.context, workspaceId);
    const items = result.results.slice(0, SECRET_LIMITS.HISTORY_PAGE);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        result.results.length > SECRET_LIMITS.HISTORY_PAGE && last
          ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id }))
          : null,
    };
  }
  private guard(row: CleanupRow, ownLeaseId: string | null = null) {
    const evidence = this.captured(row);
    const authority = capturedSecretGuard(
      this.context,
      row.workspace_id,
      row.member_revision,
      [
        evidence.source,
        ...evidence.destinations.map((item) => item.destination),
      ],
    );
    const path = secretCleanupPathGuard(
      row.workspace_id,
      evidence,
      this.timestamp(),
      ownLeaseId,
    );
    return {
      sql: `${authority.sql} AND ${path.sql}`,
      values: [...authority.values, ...path.values],
    };
  }
  private async ready(row: CleanupRow, ownLeaseId: string | null = null) {
    if (
      !this.matchesActor(row) ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      secretReviewConflict();
    if (
      (await authorize(this.context, row.workspace_id, CAPABILITY.SECRETS)) !==
      row.member_revision
    )
      secretReviewConflict();
    const evidence = this.captured(row);
    const providers = await connectCapturedSecrets(
      this.context,
      row.workspace_id,
      [
        evidence.source,
        ...evidence.destinations.map((item) => item.destination),
      ],
    );
    const guard = this.guard(row, ownLeaseId);
    if (
      !(await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first())
    )
      secretReviewConflict();
    return providers[0]!;
  }
  private audit(
    row: CleanupRow,
    writeId: string,
    type: string,
    title: string,
    summary: string,
  ) {
    const eventId = crypto.randomUUID();
    return [
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM secret_cleanup_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          eventId,
          row.workspace_id,
          this.context.principal.subject,
          this.context.principal.displayName,
          type,
          title,
          summary,
          this.timestamp(),
          row.workspace_id,
          row.id,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links (workspace_id,event_id,repository_id) SELECT workspace_id,?,repository_id FROM secret_review_repositories
        WHERE workspace_id=? AND review_id=? AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          eventId,
          row.workspace_id,
          row.distribution_review_id,
          row.workspace_id,
          eventId,
        ),
      captureSecretProjectActivity(
        this.db,
        row.workspace_id,
        eventId,
        row.distribution_review_id,
      ),
    ];
  }
  async plan(input: unknown) {
    const request = secretCleanupPlanInput.parse(input);
    const { workspaceId, reviewId, fingerprint, cleanupId } = request;
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    const requestHash = await credentialHash(JSON.stringify(request));
    const existing = await this.db
      .prepare(
        "SELECT * FROM secret_cleanup_reviews WHERE workspace_id=? AND id=?",
      )
      .bind(workspaceId, cleanupId)
      .first<CleanupRow>();
    if (existing) {
      if (!this.matchesActor(existing) || existing.request_hash !== requestHash)
        secretReviewConflict();
      return this.get({ workspaceId, cleanupId });
    }
    const root = await this.reviews.row(workspaceId, reviewId);
    if (root.fingerprint !== fingerprint) secretReviewConflict();
    const evidence = await captureSecretCleanupEvidence(this.context, root);
    const now = this.timestamp();
    const expires = new Date(
      this.context.now() + SECRET_LIMITS.REVIEW_MS,
    ).toISOString();
    const reviewedFingerprint =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({
          requestHash,
          evidence,
          actor: this.context.principal.subject,
          tokenId: this.context.principal.tokenId ?? null,
          memberRevision,
          createdAt: now,
          expiresAt: expires,
        }),
      ));
    const row: CleanupRow = {
      workspace_id: workspaceId,
      id: cleanupId,
      distribution_review_id: reviewId,
      actor_subject: this.context.principal.subject,
      actor_name: this.context.principal.displayName,
      actor_token_id: this.context.principal.tokenId ?? null,
      member_revision: memberRevision,
      request_hash: requestHash,
      captured_json: JSON.stringify(evidence),
      fingerprint: reviewedFingerprint,
      created_at: now,
      expires_at: expires,
      phase: "reviewed",
      write_status: "not-sent",
      reason: null,
      observation_status: "unknown",
      metadata_json: null,
      observed_at: null,
      submitted_at: null,
      updated_at: now,
      revision: 1,
      lease_id: null,
      lease_expires_at: null,
      write_id: crypto.randomUUID(),
    };
    await this.ready(row);
    const guard = this.guard(row);
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO secret_cleanup_reviews
        (workspace_id,id,distribution_review_id,actor_subject,actor_name,actor_token_id,member_revision,request_hash,captured_json,fingerprint,created_at,expires_at,phase,write_status,observation_status,updated_at,write_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reviewed','not-sent','unknown',?,? WHERE ${guard.sql}
        AND (SELECT COUNT(*) FROM secret_cleanup_reviews WHERE workspace_id=? AND phase IN ('reviewed','preparing','submitted') AND expires_at>?)<?`,
        )
        .bind(
          workspaceId,
          cleanupId,
          reviewId,
          row.actor_subject,
          row.actor_name,
          row.actor_token_id,
          memberRevision,
          requestHash,
          row.captured_json,
          reviewedFingerprint,
          now,
          expires,
          now,
          row.write_id,
          ...guard.values,
          workspaceId,
          now,
          SECRET_LIMITS.CLEANUP_REVIEWS,
        ),
      ...this.audit(
        row,
        row.write_id,
        "secrets.cleanup.reviewed",
        "Source removal ready for review",
        "Prepared a separate source-removal review after checking accepted destination writes and fresh metadata. This is not an atomic move or a value-equality check.",
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      const current = await this.db
        .prepare(
          "SELECT * FROM secret_cleanup_reviews WHERE workspace_id=? AND id=?",
        )
        .bind(workspaceId, cleanupId)
        .first<CleanupRow>();
      if (
        !current ||
        current.request_hash !== requestHash ||
        !this.matchesActor(current)
      )
        secretReviewConflict();
    }
    return this.get({ workspaceId, cleanupId });
  }
  private leaseGuard(row: CleanupRow, leaseId: string, reserve = 0) {
    return {
      sql: `EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_id=?
        AND lease_expires_at>? AND julianday(lease_expires_at)>julianday('now',?))`,
      values: [
        row.workspace_id,
        row.distribution_review_id,
        leaseId,
        new Date(this.context.now() + reserve).toISOString(),
        "+" + reserve / 1000 + " seconds",
      ],
    };
  }
  private async release(row: CleanupRow, leaseId: string) {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_operations SET lease_id=NULL,lease_expires_at=NULL WHERE workspace_id=? AND review_id=? AND lease_id=?
        AND EXISTS (SELECT 1 FROM secret_cleanup_reviews WHERE workspace_id=? AND id=? AND phase='finished' AND lease_id=?)`,
        )
        .bind(
          row.workspace_id,
          row.distribution_review_id,
          leaseId,
          row.workspace_id,
          row.id,
          leaseId,
        ),
      this.db
        .prepare(
          "UPDATE secret_cleanup_reviews SET lease_id=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=? AND phase='finished' AND lease_id=?",
        )
        .bind(row.workspace_id, row.id, leaseId),
    ]);
  }
  private async settleExpired(row: CleanupRow) {
    const guard = actorGuard(
      this.context,
      row.workspace_id,
      CAPABILITY.SECRETS,
    );
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_cleanup_reviews SET phase='finished',write_status=CASE WHEN phase='submitted' THEN 'indeterminate' ELSE write_status END,
        reason='execution_interrupted',updated_at=?,revision=revision+1,write_id=? WHERE workspace_id=? AND id=? AND phase IN ('preparing','submitted') AND lease_expires_at<=? AND ${guard.sql}`,
        )
        .bind(
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          this.timestamp(),
          ...guard.values,
        ),
      ...this.audit(
        row,
        writeId,
        "secrets.cleanup.interrupted",
        "Source-removal execution interrupted",
        "The execution lease expired. A submitted deletion remains indeterminate and was not retried.",
      ),
    ]);
    if (row.lease_id) await this.release(row, row.lease_id);
  }
  private async record(
    row: CleanupRow,
    leaseId: string,
    result:
      | SecretWriteResult
      | { status: "not-sent"; reason: SecretCleanupReceipt["reason"] },
  ) {
    const lease = this.leaseGuard(row, leaseId);
    const writeId = crypto.randomUUID();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_cleanup_reviews SET phase='finished',write_status=?,reason=?,updated_at=?,revision=revision+1,write_id=?
        WHERE workspace_id=? AND id=? AND phase=? AND lease_id=? AND ${lease.sql}`,
        )
        .bind(
          result.status,
          result.reason,
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          result.status === "not-sent" ? "preparing" : "submitted",
          leaseId,
          ...lease.values,
        ),
      ...this.audit(
        row,
        writeId,
        "secrets.cleanup.receipt",
        "Source-removal receipt recorded",
        result.status === "accepted"
          ? "The provider accepted source removal. Destination value equality and atomic scope transfer are not guaranteed."
          : result.status === "not-sent"
            ? "Source removal was not submitted. Inspect changed state before preparing another review."
            : result.status === "rejected"
              ? "The provider rejected source removal. No automatic retry was made."
              : "Source-removal acceptance is uncertain. An absent name cannot prove which request removed it.",
      ),
    ]);
    return Boolean(saved[0]!.meta.changes);
  }
  private async observe(
    row: CleanupRow,
    metadata: SecretMetadata | null,
    status: SecretCleanupReceipt["observationStatus"],
    leaseId: string | null,
  ) {
    const authority = actorGuard(
      this.context,
      row.workspace_id,
      CAPABILITY.SECRETS,
    );
    const lease = leaseId
      ? this.leaseGuard(row, leaseId)
      : {
          sql: "NOT EXISTS (SELECT 1 FROM secret_cleanup_reviews WHERE workspace_id=? AND id=? AND lease_expires_at>?)",
          values: [row.workspace_id, row.id, this.timestamp()],
        };
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_cleanup_reviews SET observation_status=?,metadata_json=?,observed_at=?,updated_at=?,revision=revision+1,write_id=?
        WHERE workspace_id=? AND id=? AND phase='finished' AND revision=? AND ${authority.sql} AND ${lease.sql}`,
        )
        .bind(
          status,
          metadata ? JSON.stringify(metadata) : null,
          this.timestamp(),
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          row.revision,
          ...authority.values,
          ...lease.values,
        ),
      ...this.audit(
        row,
        writeId,
        "secrets.cleanup.observed",
        "Source metadata observed",
        "Recorded source metadata separately from the deletion receipt. Absence does not prove acceptance of an uncertain deletion.",
      ),
    ]);
  }
  async apply(input: unknown) {
    const { workspaceId, cleanupId, fingerprint } =
      secretCleanupApplyInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, cleanupId);
    if (!this.matchesActor(row) || row.fingerprint !== fingerprint)
      secretReviewConflict();
    await this.settleExpired(row);
    if (row.phase !== "reviewed") return this.get({ workspaceId, cleanupId });
    await this.ready(row);
    const root = await this.reviews.row(
      workspaceId,
      row.distribution_review_id,
    );
    await new SecretOperations(this.context).settleExpired(root);
    const guard = this.guard(row);
    const leaseId = crypto.randomUUID();
    const now = this.timestamp();
    const leaseUntil = new Date(
      this.context.now() + SECRET_LIMITS.LEASE_MS,
    ).toISOString();
    const claimed = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_operations SET lease_id=?,lease_expires_at=? WHERE workspace_id=? AND review_id=? AND lease_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND lease_expires_at>?)
        AND EXISTS (SELECT 1 FROM secret_cleanup_reviews WHERE workspace_id=? AND id=? AND phase='reviewed' AND fingerprint=? AND expires_at>? AND julianday(expires_at)>julianday('now')) AND ${guard.sql}`,
        )
        .bind(
          leaseId,
          leaseUntil,
          workspaceId,
          row.distribution_review_id,
          workspaceId,
          now,
          workspaceId,
          cleanupId,
          fingerprint,
          now,
          ...guard.values,
        ),
      this.db
        .prepare(
          `UPDATE secret_cleanup_reviews SET phase='preparing',lease_id=?,lease_expires_at=?,updated_at=?,revision=revision+1,write_id=? WHERE workspace_id=? AND id=? AND phase='reviewed'
        AND EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_id=?)`,
        )
        .bind(
          leaseId,
          leaseUntil,
          now,
          leaseId,
          workspaceId,
          cleanupId,
          workspaceId,
          row.distribution_review_id,
          leaseId,
        ),
      ...this.audit(
        row,
        leaseId,
        "secrets.cleanup.requested",
        "Source removal requested",
        "Persisted source-removal intent before provider effects. Rechecking all reviewed evidence before submission.",
      ),
    ]);
    if (!claimed[0]!.meta.changes) return this.get({ workspaceId, cleanupId });
    let submitted = false;
    let recorded = false;
    try {
      const current = await captureSecretCleanupEvidence(this.context, root);
      if (JSON.stringify(current) !== row.captured_json) secretReviewConflict();
      const provider = await this.ready(row, leaseId);
      const authority = this.guard(row, leaseId);
      const lease = this.leaseGuard(
        row,
        leaseId,
        SECRET_LIMITS.SEND_RESERVE_MS,
      );
      const marked = await this.db
        .prepare(
          `UPDATE secret_cleanup_reviews SET phase='submitted',submitted_at=?,updated_at=?,revision=revision+1
        WHERE workspace_id=? AND id=? AND phase='preparing' AND lease_id=? AND expires_at>? AND julianday(expires_at)>julianday('now') AND ${authority.sql} AND ${lease.sql}`,
        )
        .bind(
          this.timestamp(),
          this.timestamp(),
          workspaceId,
          cleanupId,
          leaseId,
          this.timestamp(),
          ...authority.values,
          ...lease.values,
        )
        .run();
      if (!marked.meta.changes) secretReviewConflict();
      submitted = true;
      const evidence = this.captured(row);
      const result = secretWriteResultSchema.parse(
        await provider.remove(
          evidence.source.resource,
          evidence.source.snapshot,
        ),
      );
      recorded = await this.record(row, leaseId, result);
      if (recorded && result.status === "accepted") {
        const written = await this.row(workspaceId, cleanupId);
        try {
          await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
          const metadata = await provider.observe(
            evidence.source.resource,
            evidence.source.snapshot,
          );
          await this.observe(
            written,
            metadata,
            metadata ? "present" : "absent",
            leaseId,
          );
        } catch {
          await this.observe(written, null, "unavailable", leaseId);
        }
      }
    } catch {
      if (!recorded)
        await this.record(
          row,
          leaseId,
          submitted
            ? { status: "indeterminate", reason: "provider_result_uncertain" }
            : { status: "not-sent", reason: "preflight_changed" },
        );
    } finally {
      await this.release(row, leaseId);
    }
    return this.get({ workspaceId, cleanupId });
  }
  async reconcile(input: unknown) {
    const { workspaceId, cleanupId } = secretCleanupInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const original = await this.row(workspaceId, cleanupId);
    if (!this.matchesActor(original)) secretReviewConflict();
    await this.settleExpired(original);
    const row = await this.row(workspaceId, cleanupId);
    if (row.phase !== "finished") return this.get({ workspaceId, cleanupId });
    const source = this.captured(row).source;
    const provider = await secretAdapter(source.providerKind).connect(
      this.context,
      workspaceId,
      source.providerRef,
    );
    if (provider.identity !== source.providerIdentity) secretReviewConflict();
    await provider.checkResources([source.resource]);
    let metadata: SecretMetadata | null = null;
    let status: SecretCleanupReceipt["observationStatus"] = "unavailable";
    try {
      metadata = await provider.observe(source.resource, source.snapshot);
      status = metadata ? "present" : "absent";
    } catch {
      /* Preserve unknown evidence without replaying DELETE */
    }
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    await this.observe(row, metadata, status, null);
    return this.get({ workspaceId, cleanupId });
  }
}
