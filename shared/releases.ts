import { z } from "zod";
import { githubBranchSchema } from "./github-evidence";
import {
  GITHUB_CONTEXT_LIMITS,
  githubContextInput,
  githubShaSchema,
  CONTEXT_READ_LABELS,
  contextReadSchema,
  githubContextResultSchema,
  githubRepositoryUrl,
} from "./github-context";
export { githubRepositoryUrl } from "./github-context";

export const RELEASE_LIMITS = Object.freeze({
  ...GITHUB_CONTEXT_LIMITS,
  DEPLOYMENTS: 5,
  REQUESTS: 2,
});
export const releaseInput = githubContextInput;
export const releaseShaSchema = githubShaSchema;
const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime();
export const RELEASE_READ_LABELS = CONTEXT_READ_LABELS;
export const releaseReadSchema = contextReadSchema;
export const releaseRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    tag: githubBranchSchema,
    publishedAt: timestamp,
    sha: releaseShaSchema.nullable(),
  })
  .strict();
export const DEPLOYMENT_STATUS_LABELS = Object.freeze({
  ERROR: "Error",
  FAILURE: "Failed",
  INACTIVE: "Inactive",
  IN_PROGRESS: "In progress",
  PENDING: "Pending",
  QUEUED: "Queued",
  SUCCESS: "Succeeded",
  WAITING: "Waiting",
});
export const deploymentStatusSchema = z.enum([
  "ERROR",
  "FAILURE",
  "INACTIVE",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "SUCCESS",
  "WAITING",
]);
export const deploymentRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    sha: releaseShaSchema,
    environment: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\u0000-\u001f\u007f]+$/)
      .nullable(),
    createdAt: timestamp,
    status: deploymentStatusSchema.nullable(),
    statusAt: timestamp.nullable(),
  })
  .strict()
  .refine((value) => (value.status === null) === (value.statusAt === null));
export const releaseComparisonSchema = z
  .object({
    baseSha: releaseShaSchema,
    headSha: releaseShaSchema,
    status: z.enum(["ahead", "behind", "diverged", "identical"]),
    aheadBy: count,
    behindBy: count,
  })
  .strict()
  .refine((value) =>
    value.status === "identical"
      ? value.aheadBy === 0 && value.behindBy === 0
      : value.status === "ahead"
        ? value.aheadBy > 0 && value.behindBy === 0
        : value.status === "behind"
          ? value.aheadBy === 0 && value.behindBy > 0
          : value.aheadBy > 0 && value.behindBy > 0,
  );
export const releaseEvidenceSchema = z
  .object({
    observedAt: timestamp,
    retryAt: timestamp.nullable(),
    requests: count.max(RELEASE_LIMITS.REQUESTS),
    head: z
      .object({ branch: githubBranchSchema, sha: releaseShaSchema })
      .strict()
      .nullable(),
    release: releaseReadSchema
      .extend({ record: releaseRecordSchema.nullable() })
      .strict(),
    deployments: releaseReadSchema
      .extend({
        total: count.nullable(),
        hasMore: z.boolean(),
        records: z
          .array(deploymentRecordSchema)
          .max(RELEASE_LIMITS.DEPLOYMENTS),
      })
      .strict(),
    comparison: releaseReadSchema
      .extend({ record: releaseComparisonSchema.nullable() })
      .strict(),
  })
  .strict();
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;
export type ReleaseRead = z.infer<typeof releaseReadSchema>;
export const releaseResultSchema = githubContextResultSchema
  .extend({ evidence: releaseEvidenceSchema.nullable() })
  .strict();
export type ReleaseResult = z.infer<typeof releaseResultSchema>;

export function releaseProviderLinks(
  fullName: string,
  evidence: ReleaseEvidence | null,
) {
  const base = githubRepositoryUrl(fullName);
  const release = evidence?.release.record;
  const comparison = evidence?.comparison.record;
  return {
    releases: base + "/releases",
    release: release
      ? base + "/releases/tag/" + encodeURIComponent(release.tag)
      : null,
    deployments: base + "/deployments",
    comparison: comparison
      ? base + "/compare/" + comparison.baseSha + "..." + comparison.headSha
      : null,
  };
}
