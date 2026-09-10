import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";
import { githubBranchSchema } from "./github-evidence";
import { githubShaSchema } from "./github-context";
import { dependencyDigestSchema } from "./dependency-report";
import {
  dependencyManifestPathSchema,
  DEPENDENCY_POLICY_PATH,
} from "./dependency-policy";

export const DEPENDENCY_OPERATION_LIMITS = Object.freeze({
  REQUESTS: 6,
  REQUEST_MS: 6000,
  RESPONSE_BYTES: 2 * 1024 * 1024,
  REQUEST_BYTES: 2 * 1024 * 1024,
  EXECUTION_MS: 60000,
  RECONCILE_MS: 60000,
  FILES: 2,
  HISTORY_PAGE: 20,
  HISTORY: 1000,
  STARTS_PER_WINDOW: 10,
  START_WINDOW_MS: 5 * 60 * 1000,
});
export const dependencyOperationInput = workspaceInput
  .extend({ planId: idSchema })
  .strict();
export const dependencyOperationsInput = workspaceInput
  .extend({ repositoryId: idSchema, before: z.string().max(500).optional() })
  .strict();
export const dependencyPhaseSchema = z.enum([
  "checking",
  "tree",
  "commit",
  "branch",
  "pull_request",
  "finished",
]);
export const dependencyOperationSchema = z
  .object({
    id: idSchema,
    planId: idSchema,
    repositoryId: idSchema,
    status: z.enum([
      "running",
      "succeeded",
      "failed",
      "partial",
      "indeterminate",
    ]),
    phase: dependencyPhaseSchema,
    reason: z.enum([
      "checking",
      "complete",
      "evidence_changed",
      "access_changed",
      "provider_rejected",
      "provider_unavailable",
      "outcome_unknown",
      "interrupted",
      "branch_only",
      "identity_changed",
      "not_found",
    ]),
    branch: githubBranchSchema,
    treeSha: githubShaSchema.nullable(),
    commitSha: githubShaSchema.nullable(),
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        merged: z.boolean(),
        headSha: githubShaSchema,
      })
      .strict()
      .nullable(),
    files: z
      .array(
        z
          .object({
            path: z.union([
              z.literal(DEPENDENCY_POLICY_PATH),
              dependencyManifestPathSchema,
            ]),
            beforeDigest: dependencyDigestSchema,
            afterDigest: dependencyDigestSchema,
          })
          .strict(),
      )
      .max(DEPENDENCY_OPERATION_LIMITS.FILES),
    requests: z.number().int().min(0).max(32),
    elapsedMs: z.number().int().nonnegative(),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    executionExpiresAt: z.iso.datetime(),
    observedAt: z.iso.datetime().nullable(),
    nextReconcileAt: z.iso.datetime().nullable(),
  })
  .strict();
export type DependencyOperation = z.infer<typeof dependencyOperationSchema>;
export const DEPENDENCY_OPERATION_REASONS: Record<
  DependencyOperation["reason"],
  string
> = {
  checking: "Checking the reviewed commit and authority",
  complete:
    "Pull request verified. Merge, CI, and deployment remain separate outcomes",
  evidence_changed:
    "The inspected files or base commit changed. No further writes were sent",
  access_changed:
    "The original access is no longer valid. No further writes were sent",
  provider_rejected:
    "GitHub rejected this step. Earlier completed steps remain recorded",
  provider_unavailable:
    "Provider evidence is unavailable. No further writes were sent",
  outcome_unknown:
    "The last write may have succeeded. Check the same operation before taking further action",
  interrupted:
    "Execution stopped without a final receipt. Check the same operation; do not blindly repeat the write",
  branch_only:
    "The reviewed branch exists, but no matching pull request was verified. Inspect the branch on GitHub",
  identity_changed:
    "The branch or pull request differs from the reviewed change. Reconcile it on GitHub",
  not_found:
    "No matching published branch or pull request was found. Unreferenced Git objects may remain",
};
