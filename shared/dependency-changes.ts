import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";
import { providerCredentialIdSchema } from "./provider-credentials";
import {
  githubContextInput,
  githubContextResultSchema,
} from "./github-context";
import { githubBranchSchema } from "./github-evidence";
import { githubShaSchema } from "./github-context";
import {
  dependencyDigestSchema,
  dependencyReportSchema,
} from "./dependency-report";
import {
  dependencyOverrideSchema,
  DEPENDENCY_LIMITS,
  type DependencyOverride,
  type DependencyAnalysis,
} from "./dependency-policy";

export const DEPENDENCY_CHANGE_KIND = "dependency.change";
export const DEPENDENCY_CHANGE_LIMITS = Object.freeze({
  PENDING: 10,
  CLEANUP: 100,
  REVIEW_MS: 5 * 60 * 1000,
  DAY_MS: 86400000,
});
export const dependencyChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("renew"),
      reason: dependencyOverrideSchema.shape.reason,
      owner: dependencyOverrideSchema.shape.owner,
      reviewDays: z.number().int().min(1).max(30),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      reason: dependencyOverrideSchema.shape.reason,
    })
    .strict(),
]);
export type DependencyChange = z.infer<typeof dependencyChangeSchema>;
export const dependencyChangePlanInput = githubContextInput
  .extend({
    credentialId: providerCredentialIdSchema.optional(),
    pullNumber: z.number().int().positive().max(2147483647).optional(),
    headSha: githubShaSchema,
    policyDigest: dependencyDigestSchema,
    overrideId: dependencyOverrideSchema.shape.id,
    change: dependencyChangeSchema,
  })
  .strict();
export const dependencyWriteAccessInput = workspaceInput
  .extend({ repositoryId: idSchema })
  .strict();
export const dependencyWriteAccessSchema = z
  .object({
    credentials: z
      .array(
        z
          .object({
            id: providerCredentialIdSchema,
            revision: z.number().int().positive(),
            name: z.string().max(80),
            expiresAt: z.iso.datetime(),
            writable: z.boolean(),
            status: z.enum([
              "available",
              "expired",
              "retired",
              "key-unavailable",
            ]),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const dependencyWriterSchema =
  dependencyWriteAccessSchema.shape.credentials.element.pick({
    id: true,
    revision: true,
    name: true,
    expiresAt: true,
  });
export const dependencyChangeReviewInput = workspaceInput
  .extend({ planId: idSchema })
  .strict();
export const dependencyChangeApplyInput = dependencyChangeReviewInput
  .extend({ fingerprint: dependencyDigestSchema })
  .strict();
export const dependencyChangeBasisSchema = githubContextResultSchema
  .pick({ repository: true, source: true })
  .extend({
    observedAt: z.iso.datetime(),
    headSha: githubShaSchema,
    treeSha: githubShaSchema,
    branch: githubBranchSchema,
    pullNumber: z.number().int().positive().nullable().default(null),
    policyDigest: dependencyDigestSchema,
    files: dependencyReportSchema.shape.files,
  })
  .strict();
export const dependencyChangeReviewSchema = z
  .object({
    workspaceId: idSchema,
    planId: idSchema,
    fingerprint: dependencyDigestSchema,
    actor: z.string().max(200),
    expiresAt: z.iso.datetime(),
    state: z.enum(["ready", "stale", "expired"]),
    writer: dependencyWriterSchema.nullable().default(null),
    basis: dependencyChangeBasisSchema,
    change: dependencyChangeSchema,
    before: dependencyOverrideSchema,
    after: dependencyOverrideSchema,
  })
  .strict();
export type DependencyChangeReview = z.infer<
  typeof dependencyChangeReviewSchema
>;
export function changedDependencyRule(
  analysis: DependencyAnalysis,
  overrideId: string,
  input: DependencyChange,
  now: number,
): { before: DependencyOverride; after: DependencyOverride } {
  const change = dependencyChangeSchema.parse(input);
  const finding = analysis.findings.find((item) => item.rule.id === overrideId);
  if (!finding || finding.rule.lifecycle !== "active")
    throw new Error("Choose an active override from a complete inspection");
  if (
    analysis.issues.some(
      (issue) => !["review_due", "unused_override"].includes(issue.code),
    )
  )
    throw new Error(
      "Resolve the recorded dependency policy or lockfile problems before preparing a change",
    );
  if (
    change.kind === "remove"
      ? finding.status !== "unused" ||
        finding.matches.some((match) => match.overridden)
      : !["mitigated", "review_due"].includes(finding.status)
  )
    throw new Error(
      change.kind === "remove"
        ? "The inspected repository still needs this override; an upstream release alone does not make cleanup safe"
        : "Only a needed, mitigated override can be renewed",
    );
  const before = finding.rule;
  const after = dependencyOverrideSchema.parse(
    change.kind === "remove"
      ? { ...before, lifecycle: "removed", reason: change.reason }
      : {
          ...before,
          reason: change.reason,
          owner: change.owner,
          reviewedAt: new Date(now).toISOString(),
          reviewBy: new Date(
            now +
              Math.min(
                change.reviewDays * DEPENDENCY_CHANGE_LIMITS.DAY_MS,
                DEPENDENCY_LIMITS.REVIEW_MS,
              ),
          ).toISOString(),
        },
  );
  return { before, after };
}
