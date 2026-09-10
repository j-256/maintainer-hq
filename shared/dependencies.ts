import { z } from "zod";
import { idSchema, repositoryFields, workspaceInput } from "./domain";
import { githubBranchSchema } from "./github-evidence";
import {
  githubContextInput,
  githubContextResultSchema,
  githubShaSchema,
  contextReadSchema,
} from "./github-context";
import { dependencyReportSchema } from "./dependency-report";
import { type DependencyFinding } from "./dependency-policy";

export const DEPENDENCIES_LIMITS = Object.freeze({
  FILE_BYTES: 1024 * 1024,
  TOTAL_BYTES: 4 * 1024 * 1024,
  TREE_ENTRIES: 12000,
  REQUESTS: 20,
  UPSTREAM_PACKAGES: 4,
  RESPONSE_BYTES: 160 * 1024,
  PAGE_SIZE: 20,
  CACHE_MS: 5 * 60 * 1000,
  CLOCK_MS: 30 * 1000,
  REVIEW_MS: 5 * 60 * 1000,
});
export const dependencyInspectionInput = githubContextInput
  .extend({
    refresh: z.boolean().default(false),
    checkUpstream: z.boolean().default(false),
    pullNumber: z.number().int().positive().max(2147483647).optional(),
  })
  .strict()
  .refine(
    (input) => !input.checkUpstream || input.refresh,
    "An upstream check requires an explicit inspection",
  );
export const dependenciesListInput = workspaceInput
  .extend({
    projectId: idSchema.optional(),
    search: z.string().trim().max(160).default(""),
    page: z.number().int().min(1).max(1000).default(1),
  })
  .strict();
export const dependencyEvidenceSchema = z
  .object({
    inspectionId: z.uuid(),
    observedAt: z.iso.datetime(),
    retryAt: z.iso.datetime().nullable(),
    requests: z.number().int().min(0).max(DEPENDENCIES_LIMITS.REQUESTS),
    upstreamRequests: z
      .number()
      .int()
      .min(0)
      .max(DEPENDENCIES_LIMITS.UPSTREAM_PACKAGES),
    elapsedMs: z.number().int().nonnegative(),
    read: contextReadSchema,
    branch: githubBranchSchema.nullable(),
    pullNumber: z.number().int().positive().nullable().default(null),
    headSha: githubShaSchema.nullable(),
    treeSha: githubShaSchema.nullable(),
    policy: z.enum(["present", "absent", "unknown"]),
    report: dependencyReportSchema.nullable(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.report &&
      (evidence.policy !== "present" ||
        evidence.read.state !== "observed" ||
        !evidence.headSha ||
        !evidence.treeSha ||
        !evidence.branch)
    )
      context.addIssue({
        code: "custom",
        message:
          "Accepted dependency evidence requires an immutable repository identity",
      });
    if (
      evidence.read.state === "observed" &&
      (evidence.policy === "unknown" ||
        (evidence.policy === "present" && !evidence.report))
    )
      context.addIssue({
        code: "custom",
        message: "Incomplete dependency evidence cannot be observed",
      });
  });
export type DependencyEvidence = z.infer<typeof dependencyEvidenceSchema>;
export const dependencyResultSchema = githubContextResultSchema
  .extend({ evidence: dependencyEvidenceSchema.nullable() })
  .strict();
export type DependencyResult = z.infer<typeof dependencyResultSchema>;
export const DEPENDENCY_LABELS = Object.freeze({
  mitigated: "Override still needed",
  vulnerable: "Affected version locked",
  review_due: "Review overdue",
  unused: "Ready for cleanup review",
  invalid: "Policy needs attention",
  resolved: "Override removed",
});
export function dependencyStatus(finding: DependencyFinding, now: number) {
  return finding.status === "mitigated" &&
    Date.parse(finding.rule.reviewBy) <= now
    ? "review_due"
    : finding.status;
}
export const dependencySummarySchema = z
  .object({
    state: z.enum([
      "unread",
      "unavailable",
      "untracked",
      "attention",
      "tracked",
    ]),
    observedAt: z.iso.datetime().nullable(),
    headSha: githubShaSchema.nullable(),
    active: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    reviewBy: z.iso.datetime().nullable(),
    stale: z.boolean(),
  })
  .strict();
export type DependencySummary = z.infer<typeof dependencySummarySchema>;
export function dependencySummary(
  result: DependencyResult | null,
  now: number,
): DependencySummary {
  const evidence = result?.evidence;
  const report = evidence?.report;
  const active =
    report?.analysis.findings.filter(
      (item) => item.rule.lifecycle === "active",
    ) ?? [];
  const due = active.filter(
    (item) => dependencyStatus(item, now) !== "mitigated",
  ).length;
  const attention = Math.max(due, report?.analysis.issues.length ?? 0);
  return {
    state:
      result && ["disabled", "not_configured"].includes(result.state)
        ? "unavailable"
        : !evidence
          ? "unread"
          : evidence.read.state !== "observed"
            ? "unavailable"
            : evidence.policy === "absent"
              ? "untracked"
              : attention
                ? "attention"
                : "tracked",
    observedAt: evidence?.observedAt ?? null,
    headSha: evidence?.headSha ?? null,
    active: active.length,
    attention,
    reviewBy: active.map((item) => item.rule.reviewBy).sort()[0] ?? null,
    stale: Boolean(
      evidence &&
      now >= Date.parse(evidence.observedAt) + DEPENDENCIES_LIMITS.CACHE_MS,
    ),
  };
}
export const dependenciesPageSchema = z
  .object({
    page: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    rows: z
      .array(
        z
          .object({
            repository: z
              .object({
                id: idSchema,
                fullName: repositoryFields.shape.fullName,
                projectId: idSchema.nullable(),
              })
              .strict(),
            source: z
              .object({ id: idSchema, name: z.string().max(120) })
              .strict()
              .nullable(),
            summary: dependencySummarySchema,
          })
          .strict(),
      )
      .max(DEPENDENCIES_LIMITS.PAGE_SIZE),
  })
  .strict();
export type DependenciesPage = z.infer<typeof dependenciesPageSchema>;
