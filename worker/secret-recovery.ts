import { CAPABILITY } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretRecoveryPlanInput,
  type SecretRecoveryContext,
} from "../shared/secrets";
import { authorizeHooks as authorize } from "./hook-authority";
import { SecretReviews, secretReviewConflict } from "./secret-reviews";
import { SecretOperations } from "./secret-operations";
import { readSecretReceipts } from "./secret-receipts";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

function newInputRequired(): never {
  throw new DomainError(
    "secret_recovery_input_unavailable",
    "The retained input expired, was discarded, or no longer matches the provider key. Deliberately supply a value in a new distribution; HQ cannot compare it with the earlier value.",
    409,
  );
}
export class SecretRecovery {
  readonly reviews: SecretReviews;
  constructor(readonly context: WorkspaceService) {
    this.reviews = new SecretReviews(context);
  }
  get db() {
    return this.context.db;
  }
  async plan(input: unknown) {
    const {
      workspaceId,
      reviewId,
      fingerprint,
      destinationIndex,
      newReviewId,
    } = secretRecoveryPlanInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const parent = await this.reviews.row(workspaceId, reviewId);
    if (
      !this.reviews.matchesActor(parent) ||
      parent.fingerprint !== fingerprint ||
      parent.stage !== "accepted" ||
      newReviewId === reviewId
    )
      secretReviewConflict();
    await new SecretOperations(this.context).settleExpired(parent);
    const receipt = (
      await readSecretReceipts(this.db, workspaceId, reviewId)
    ).find((item) => item.destinationIndex === destinationIndex);
    if (!receipt) secretReviewConflict();
    if (receipt.recoveryReviewId) {
      if (receipt.recoveryReviewId !== newReviewId)
        throw new DomainError(
          "secret_recovery_reserved",
          "This destination already has a recovery review. Inspect it or cancel it if it has not been accepted.",
          409,
        );
      return this.reviews.get({ workspaceId, reviewId: newReviewId });
    }
    if (
      receipt.phase !== "finished" ||
      (receipt.writeStatus === "accepted" &&
        receipt.observationStatus === "present")
    )
      secretReviewConflict();
    const original = this.reviews.captured(parent);
    const depth = (original.recovery?.depth ?? 0) + 1;
    if (depth > SECRET_LIMITS.RECOVERY_DEPTH)
      throw new DomainError(
        "secret_recovery_limit",
        "The bounded retained-input recovery chain is exhausted. Inspect the entire history before deliberately supplying a value in a new distribution.",
        409,
      );
    if (Date.parse(parent.input_expires_at) <= this.context.now())
      newInputRequired();
    const item = original.destinations[destinationIndex]!;
    if (item.snapshot.input.kind === "private-transient") newInputRequired();
    const payload = await this.db
      .prepare(
        "SELECT ciphertext FROM secret_payloads WHERE workspace_id=? AND review_id=? AND destination_index=?",
      )
      .bind(workspaceId, reviewId, destinationIndex)
      .first<{ ciphertext: string }>();
    if (!payload) newInputRequired();
    const selected = await this.reviews.secrets.resource(
      workspaceId,
      item.destination.connectionId,
      item.destination.target.resourceId,
    );
    if (
      selected.row.provider_kind !== item.providerKind ||
      selected.row.credential_ref !== item.providerRef ||
      selected.provider.identity !== item.providerIdentity
    )
      secretReviewConflict();
    const recovery: SecretRecoveryContext = {
      reviewId,
      destinationIndex,
      fingerprint,
      receiptRevision: receipt.revision,
      depth,
    };
    const draft = await this.reviews.draft(
      {
        workspaceId,
        reviewId: newReviewId,
        destinations: [
          { ...item.destination, connectionRevision: selected.row.revision },
        ],
        source: null,
      },
      { recovery, inputExpiresAt: parent.input_expires_at },
    );
    const row = await this.reviews.row(workspaceId, newReviewId);
    const captured = this.reviews.captured(row);
    const target = captured.destinations[0]!;
    if (
      target.providerIdentity !== item.providerIdentity ||
      target.snapshot.resourceIdentity !== item.snapshot.resourceIdentity ||
      target.snapshot.scopeIdentity !== item.snapshot.scopeIdentity ||
      target.snapshot.name !== item.snapshot.name ||
      JSON.stringify(target.snapshot.input) !==
        JSON.stringify(item.snapshot.input) ||
      !selected.provider.validateSealedInput(
        target.snapshot,
        payload.ciphertext,
      )
    ) {
      await this.reviews.cancel({ workspaceId, reviewId: newReviewId });
      newInputRequired();
    }
    if (row.stage !== "awaiting-input") {
      const reserved = await this.db
        .prepare(
          "SELECT child_review_id FROM secret_recovery_links WHERE workspace_id=? AND parent_review_id=? AND parent_destination_index=?",
        )
        .bind(workspaceId, reviewId, destinationIndex)
        .first<{ child_review_id: string }>();
      if (
        ["reviewed", "accepted"].includes(row.stage) &&
        reserved?.child_review_id === newReviewId
      )
        return this.reviews.get({ workspaceId, reviewId: newReviewId });
      secretReviewConflict();
    }
    await this.reviews.ready(row, captured);
    const inputHash = await credentialHash(
      JSON.stringify([{ destinationIndex: 0, ciphertext: payload.ciphertext }]),
    );
    const finalized =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({ draftFingerprint: draft.draftFingerprint, inputHash }),
      ));
    const guard = this.reviews.guard(row, false);
    const writeId = crypto.randomUUID();
    const now = new Date(this.context.now()).toISOString();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO secret_recovery_links (workspace_id,parent_review_id,parent_destination_index,child_review_id)
        SELECT ?,?,?,? WHERE ${guard.sql} AND EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND stage='awaiting-input' AND draft_fingerprint=? AND input_expires_at>? AND julianday(expires_at)>julianday('now'))
        AND EXISTS (SELECT 1 FROM secret_payloads WHERE workspace_id=? AND review_id=? AND destination_index=?)`,
        )
        .bind(
          workspaceId,
          reviewId,
          destinationIndex,
          newReviewId,
          ...guard.values,
          workspaceId,
          newReviewId,
          draft.draftFingerprint,
          now,
          workspaceId,
          reviewId,
          destinationIndex,
        ),
      this.db
        .prepare(
          `UPDATE secret_reviews SET stage='reviewed',fingerprint=?,input_hash=?,write_id=? WHERE workspace_id=? AND id=? AND stage='awaiting-input' AND draft_fingerprint=?
        AND ${guard.sql} AND EXISTS (SELECT 1 FROM secret_recovery_links WHERE workspace_id=? AND parent_review_id=? AND parent_destination_index=? AND child_review_id=?)`,
        )
        .bind(
          finalized,
          inputHash,
          writeId,
          workspaceId,
          newReviewId,
          draft.draftFingerprint,
          ...guard.values,
          workspaceId,
          reviewId,
          destinationIndex,
          newReviewId,
        ),
      this.db
        .prepare(
          `INSERT INTO secret_payloads (workspace_id,review_id,destination_index,ciphertext)
        SELECT workspace_id,?,0,ciphertext FROM secret_payloads WHERE workspace_id=? AND review_id=? AND destination_index=?
        AND EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          newReviewId,
          workspaceId,
          reviewId,
          destinationIndex,
          workspaceId,
          newReviewId,
          writeId,
        ),
      ...this.reviews.audit(
        row,
        writeId,
        "secrets.recovery.reviewed",
        "Retained-input recovery ready for review",
        "Prepared one exact destination using retained provider-encrypted input without extending its expiry. No provider write was attempted; an uncertain earlier write may already have applied.",
      ),
    ]);
    if (!saved[1]!.meta.changes) {
      const existing = await this.reviews.row(workspaceId, newReviewId);
      if (
        !["reviewed", "accepted"].includes(existing.stage) ||
        existing.fingerprint !== finalized
      ) {
        await this.reviews.cancel({ workspaceId, reviewId: newReviewId });
        secretReviewConflict();
      }
    }
    return this.reviews.get({ workspaceId, reviewId: newReviewId });
  }
}
