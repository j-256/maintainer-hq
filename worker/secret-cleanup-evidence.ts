import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretMetadataSchema,
  secretApplyInput,
} from "../shared/secrets";
import {
  capturedDestinationSchema,
  capturedSecretKey,
  SecretReviews,
  secretReviewConflict,
  type CapturedSecretDestination,
  type SecretReviewRow,
} from "./secret-reviews";
import { readSecretReceipts } from "./secret-receipts";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

const pathEntrySchema = z
  .object({
    reviewId: idSchema,
    destinationIndex: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    fingerprint: secretApplyInput.shape.fingerprint,
    recoveryReviewId: idSchema.nullable(),
  })
  .strict();
export const secretCleanupEvidenceSchema = z
  .object({
    source: capturedDestinationSchema,
    destinations: z
      .array(
        z
          .object({
            originalDestinationIndex: z
              .number()
              .int()
              .min(0)
              .max(SECRET_LIMITS.DESTINATIONS - 1),
            destination: capturedDestinationSchema,
            metadata: secretMetadataSchema,
            path: z
              .array(pathEntrySchema)
              .min(1)
              .max(SECRET_LIMITS.RECOVERY_DEPTH + 1),
          })
          .strict(),
      )
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
  })
  .strict();
export type SecretCleanupEvidence = z.infer<typeof secretCleanupEvidenceSchema>;

export function secretCleanupBudget(context: WorkspaceService) {
  const logicalStart = context.now();
  const realStart = Date.now();
  return () => {
    if (
      Math.max(context.now() - logicalStart, Date.now() - realStart) >=
      SECRET_LIMITS.CLEANUP_PREPARE_MS
    )
      throw new DomainError(
        "secret_cleanup_deadline",
        "Source-removal preparation exceeded its bounded read window. No source deletion was sent. Inspect state before preparing another review.",
        409,
      );
  };
}
export async function captureSecretCleanupEvidence(
  context: WorkspaceService,
  root: SecretReviewRow,
  checkBudget = secretCleanupBudget(context),
): Promise<SecretCleanupEvidence> {
  const reviews = new SecretReviews(context);
  const original = reviews.captured(root);
  if (root.stage !== "accepted" || !original.source || original.recovery)
    secretReviewConflict();
  async function fresh(item: CapturedSecretDestination) {
    checkBudget();
    const selected = await reviews.secrets.resource(
      root.workspace_id,
      item.destination.connectionId,
      item.destination.target.resourceId,
    );
    if (
      selected.row.provider_kind !== item.providerKind ||
      selected.row.credential_ref !== item.providerRef ||
      selected.provider.identity !== item.providerIdentity
    )
      secretReviewConflict();
    const snapshot = await reviews.capture(root.workspace_id, {
      ...item.destination,
      connectionRevision: selected.row.revision,
    });
    checkBudget();
    if (capturedSecretKey(snapshot) !== capturedSecretKey(item))
      secretReviewConflict();
    return snapshot;
  }
  const source = await fresh(original.source);
  if (
    !source.snapshot.before?.version ||
    !original.source.snapshot.before?.version ||
    JSON.stringify(source.snapshot.before) !==
      JSON.stringify(original.source.snapshot.before)
  )
    throw new DomainError(
      "secret_cleanup_source_changed",
      "The source metadata changed or has no comparable version. This distribution does not authorize removing a changed or unverifiable source.",
      409,
    );
  const destinations: SecretCleanupEvidence["destinations"] = [];
  for (const [
    originalDestinationIndex,
    originalDestination,
  ] of original.destinations.entries()) {
    let row = root;
    let index = originalDestinationIndex;
    const path: SecretCleanupEvidence["destinations"][number]["path"] = [];
    for (let depth = 0; depth <= SECRET_LIMITS.RECOVERY_DEPTH; depth++) {
      checkBudget();
      const captured = reviews.captured(row);
      const receipt = (
        await readSecretReceipts(context.db, root.workspace_id, row.id)
      ).find((item) => item.destinationIndex === index);
      const destination = captured.destinations[index];
      if (
        !row.fingerprint ||
        !receipt ||
        receipt.phase !== "finished" ||
        !destination ||
        capturedSecretKey(destination) !==
          capturedSecretKey(originalDestination) ||
        destination.providerIdentity !== originalDestination.providerIdentity ||
        JSON.stringify(destination.snapshot.input) !==
          JSON.stringify(originalDestination.snapshot.input)
      )
        secretReviewConflict();
      path.push({
        reviewId: row.id,
        destinationIndex: index,
        revision: receipt.revision,
        fingerprint: row.fingerprint,
        recoveryReviewId: receipt.recoveryReviewId,
      });
      if (receipt.recoveryReviewId) {
        const child = await reviews.row(
          root.workspace_id,
          receipt.recoveryReviewId,
        );
        const recovery = reviews.captured(child).recovery;
        if (
          !recovery ||
          recovery.reviewId !== row.id ||
          recovery.destinationIndex !== index ||
          recovery.fingerprint !== row.fingerprint ||
          child.stage !== "accepted"
        )
          secretReviewConflict();
        row = child;
        index = 0;
        continue;
      }
      if (
        receipt.writeStatus !== "accepted" ||
        receipt.observationStatus !== "present" ||
        !receipt.metadata?.version
      )
        throw new DomainError(
          "secret_cleanup_destination_unconfirmed",
          "Every destination needs a recorded accepted write and observed metadata before source removal can be reviewed. Reconcile uncertain work; name presence alone is insufficient.",
          409,
        );
      const current = await fresh(destination);
      if (
        JSON.stringify(current.snapshot.before) !==
        JSON.stringify(receipt.metadata)
      )
        throw new DomainError(
          "secret_cleanup_destination_changed",
          "Destination metadata changed after verification. Source removal was not prepared.",
          409,
        );
      destinations.push({
        originalDestinationIndex,
        destination: current,
        metadata: receipt.metadata,
        path,
      });
      break;
    }
  }
  if (destinations.length !== original.destinations.length)
    secretReviewConflict();
  return secretCleanupEvidenceSchema.parse({ source, destinations });
}

export function secretCleanupPathGuard(
  workspaceId: string,
  evidence: SecretCleanupEvidence,
  now: string,
  ownLeaseId: string | null = null,
) {
  const path = evidence.destinations.flatMap((item) => item.path);
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) i WHERE NOT EXISTS (SELECT 1 FROM secret_receipts p JOIN secret_reviews r ON r.workspace_id=p.workspace_id AND r.id=p.review_id
      WHERE p.workspace_id=? AND p.review_id=json_extract(i.value,'$.reviewId') AND p.destination_index=json_extract(i.value,'$.destinationIndex')
      AND p.revision=json_extract(i.value,'$.revision') AND p.phase='finished' AND r.fingerprint=json_extract(i.value,'$.fingerprint')
      AND (SELECT child_review_id FROM secret_recovery_links l WHERE l.workspace_id=p.workspace_id AND l.parent_review_id=p.review_id AND l.parent_destination_index=p.destination_index) IS json_extract(i.value,'$.recoveryReviewId')))
      AND NOT EXISTS (SELECT 1 FROM secret_operations o JOIN json_each(?) i ON o.review_id=json_extract(i.value,'$.reviewId') WHERE o.workspace_id=? AND o.lease_expires_at>? AND o.lease_id IS NOT ?)`,
    values: [
      JSON.stringify(path),
      workspaceId,
      JSON.stringify(path),
      workspaceId,
      now,
      ownLeaseId,
    ],
  };
}
