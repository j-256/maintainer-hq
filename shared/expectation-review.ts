import { z } from "zod";
import { getRepositoryInput } from "./domain";

export const EXPECTATION_REVIEW_KIND = "expectations.review";
export const EXPECTATION_REVIEW_LIMITS = Object.freeze({
  OUTCOME_CHARACTERS: 1500,
});
export const expectationReviewGetInput = getRepositoryInput
  .extend({ reviewId: z.uuid() })
  .strict();
export const expectationReviewCompleteInput = expectationReviewGetInput
  .extend({
    revision: z.number().int().positive(),
    outcome: z
      .string()
      .trim()
      .min(1)
      .max(EXPECTATION_REVIEW_LIMITS.OUTCOME_CHARACTERS),
    nextReviewDate: z.iso.date().nullable(),
  })
  .strict();
export type ExpectationReviewReceipt = {
  reviewId: string;
  repositoryId: string;
  repositoryName: string;
  previousRevision: number;
  revision: number;
  previousReviewDate: string | null;
  nextReviewDate: string | null;
  outcome: string;
  completedAt: string;
};
