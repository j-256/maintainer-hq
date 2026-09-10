import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";
import {
  SECRET_LIMITS,
  secretApplyInput,
  secretReviewInput,
  secretMetadataSchema,
  secretReceiptSchema,
  reviewedDestinationSchema,
} from "./secrets";

export const secretCleanupInput = workspaceInput
  .extend({ cleanupId: idSchema })
  .strict();
export const secretCleanupPlanInput = secretApplyInput
  .extend({ cleanupId: idSchema, acknowledgeNonAtomicMove: z.literal(true) })
  .strict();
export const secretCleanupApplyInput = secretCleanupInput
  .extend({ fingerprint: secretApplyInput.shape.fingerprint })
  .strict();
export const secretCleanupHistoryInput = secretReviewInput
  .extend({ before: z.string().max(200).optional() })
  .strict();
export const secretCleanupReceiptSchema = secretReceiptSchema
  .omit({ destinationIndex: true, recoveryReviewId: true })
  .extend({
    phase: z.enum(["reviewed", "preparing", "submitted", "finished"]),
    leaseExpiresAt: z.iso.datetime().nullable(),
    leaseExpired: z.boolean(),
  })
  .strict();
export const secretCleanupReviewSchema = z
  .object({
    id: idSchema,
    reviewId: idSchema,
    fingerprint: secretApplyInput.shape.fingerprint,
    actorMatches: z.boolean(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    source: reviewedDestinationSchema,
    destinations: z
      .array(
        z
          .object({
            originalDestinationIndex: z
              .number()
              .int()
              .min(0)
              .max(SECRET_LIMITS.DESTINATIONS - 1),
            reviewId: idSchema,
            destination: reviewedDestinationSchema,
            metadata: secretMetadataSchema,
          })
          .strict(),
      )
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
    receipt: secretCleanupReceiptSchema,
  })
  .strict();
export type SecretCleanupReview = z.infer<typeof secretCleanupReviewSchema>;
export type SecretCleanupReceipt = z.infer<typeof secretCleanupReceiptSchema>;
