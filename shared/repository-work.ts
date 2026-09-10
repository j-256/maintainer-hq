import { z } from "zod";
import {
  GITHUB_CONTEXT_LIMITS,
  contextReadSchema,
  githubContextInput,
  githubContextResultSchema,
  githubRepositoryUrl,
  githubShaSchema,
} from "./github-context";

export const WORK_LIMITS = Object.freeze({
  ...GITHUB_CONTEXT_LIMITS,
  RECENT_PULLS: 10,
  OLDEST_PULLS: 10,
  PULLS: 20,
  ISSUES: 10,
  REQUESTS: 2,
  RESPONSE_BYTES: 64 * 1024,
  PAGE_SIZE: 10,
  AGING_DAYS: 30,
  DAY_MS: 24 * 60 * 60 * 1000,
});
const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime();
export const workTitleSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const workLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_\[\]-]+$/);
export const REVIEW_LABELS = Object.freeze({
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
});
export const CHECK_LABELS = Object.freeze({
  ERROR: "Checks errored",
  EXPECTED: "Checks expected",
  FAILURE: "Checks failing",
  PENDING: "Checks pending",
  SUCCESS: "Checks passed",
});
export const reviewDecisionSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);
export const workCheckSchema = z.enum([
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
]);
export const workItemSchema = z
  .object({
    number: count.min(1),
    title: workTitleSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .refine((item) => Date.parse(item.updatedAt) >= Date.parse(item.createdAt));
export const pullWorkSchema = workItemSchema
  .safeExtend({
    draft: z.boolean(),
    headSha: githubShaSchema,
    author: z
      .object({ login: workLoginSchema, bot: z.boolean() })
      .strict()
      .nullable(),
    dependencyBot: z.enum(["dependabot", "renovate"]).nullable(),
    review: contextReadSchema
      .extend({
        decision: reviewDecisionSchema.nullable(),
        requested: count.nullable(),
      })
      .strict(),
    checks: contextReadSchema
      .extend({ status: workCheckSchema.nullable() })
      .strict(),
  })
  .refine(
    (item) =>
      item.dependencyBot === null ||
      (item.author?.bot === true && item.author.login === item.dependencyBot),
  );
export const workEvidenceSchema = z
  .object({
    observedAt: timestamp,
    retryAt: timestamp.nullable(),
    requests: count.max(WORK_LIMITS.REQUESTS),
    pulls: contextReadSchema
      .extend({
        total: count.nullable(),
        hasMore: z.boolean(),
        records: z.array(pullWorkSchema).max(WORK_LIMITS.PULLS),
      })
      .strict(),
    issues: contextReadSchema
      .extend({
        enabled: z.boolean().nullable(),
        total: count.nullable(),
        hasMore: z.boolean(),
        records: z.array(workItemSchema).max(WORK_LIMITS.ISSUES),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["pulls", "issues"] as const) {
      const collection = value[key];
      const valid =
        collection.state === "observed"
          ? collection.reason === "complete" &&
            collection.total !== null &&
            collection.total >= collection.records.length &&
            collection.hasMore ===
              collection.total > collection.records.length &&
            new Set(collection.records.map((item) => item.number)).size ===
              collection.records.length
          : collection.total === null &&
            !collection.hasMore &&
            collection.records.length === 0;
      if (!valid)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Work coverage is inconsistent",
        });
    }
    if ((value.issues.state === "observed") !== (value.issues.enabled !== null))
      context.addIssue({
        code: "custom",
        path: ["issues", "enabled"],
        message: "Issue availability is inconsistent",
      });
    for (const [index, item] of value.pulls.records.entries()) {
      if (
        item.review.state === "observed"
          ? item.review.reason !== "complete"
          : item.review.decision !== null || item.review.requested !== null
      )
        context.addIssue({
          code: "custom",
          path: ["pulls", "records", index, "review"],
          message: "Review coverage is inconsistent",
        });
      if (
        item.checks.state === "observed"
          ? item.checks.reason !== "complete"
          : item.checks.status !== null
      )
        context.addIssue({
          code: "custom",
          path: ["pulls", "records", index, "checks"],
          message: "Check coverage is inconsistent",
        });
    }
  });
export type WorkEvidence = z.infer<typeof workEvidenceSchema>;
export type PullWork = z.infer<typeof pullWorkSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export const workInput = githubContextInput;
export const workResultSchema = githubContextResultSchema
  .extend({ evidence: workEvidenceSchema.nullable() })
  .strict();
export type WorkResult = z.infer<typeof workResultSchema>;
export const WORK_FILTERS = Object.freeze({
  all: "All sampled PRs",
  review: "Pending review",
  failing: "Failing checks",
  dependencies: "Dependency bots",
  aging: "Aging work",
});
export type WorkFilter = keyof typeof WORK_FILTERS;
export function workAgeDays(value: string, now: number) {
  return Math.max(
    0,
    Math.floor((now - Date.parse(value)) / WORK_LIMITS.DAY_MS),
  );
}
export function pendingWorkReview(item: PullWork) {
  return (
    item.review.state === "observed" &&
    (item.review.decision === "REVIEW_REQUIRED" ||
      (item.review.requested ?? 0) > 0)
  );
}
export function failingWorkChecks(item: PullWork) {
  return (
    item.checks.state === "observed" &&
    (item.checks.status === "ERROR" || item.checks.status === "FAILURE")
  );
}
export function filterWork(items: PullWork[], filter: WorkFilter, now: number) {
  return items.filter((item) =>
    filter === "review"
      ? pendingWorkReview(item)
      : filter === "failing"
        ? failingWorkChecks(item)
        : filter === "dependencies"
          ? item.dependencyBot !== null
          : filter === "aging"
            ? workAgeDays(item.createdAt, now) >= WORK_LIMITS.AGING_DAYS
            : true,
  );
}
export function workItemUrl(
  fullName: string,
  kind: "pull" | "issues",
  number: number,
) {
  return (
    githubRepositoryUrl(fullName) +
    "/" +
    kind +
    "/" +
    count.min(1).parse(number)
  );
}
