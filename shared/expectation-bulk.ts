import { z } from "zod";
import {
  expectationSchema,
  idSchema,
  workspaceInput,
  type Expectations,
} from "./domain";

export const EXPECTATION_BULK_LIMITS = Object.freeze({
  REPOSITORIES: 50,
  PAGE_SIZE: 25,
  INPUT_BYTES: 60 * 1024,
  REVIEW_BYTES: 256 * 1024,
  PENDING_PLANS: 10,
  CLEANUP_ROWS: 100,
  REQUEST_TIMEOUT_MS: 15000,
});
export const EXPECTATION_REVIEW_PARAM = "expectationReview";
export const EXPECTATION_KEYS = [
  "ci",
  "security",
  "monitoring",
  "hooks",
  "visibility",
  "reviewDate",
  "note",
] as const;
export type ExpectationKey = (typeof EXPECTATION_KEYS)[number];
export type ExpectationPatch = Partial<Expectations>;
export const EXPECTATION_PRESETS = [
  {
    id: "ci-security",
    name: "CI and security",
    description:
      "Require passing CI and security checks. Keep other expectations unchanged.",
    patch: { ci: "required", security: "required" },
  },
  {
    id: "running-service",
    name: "Running service",
    description:
      "Require CI, security and endpoint monitoring. Keep hooks and other fields unchanged.",
    patch: { ci: "required", security: "required", monitoring: "required" },
  },
  {
    id: "observe-only",
    name: "Observe only",
    description:
      "Do not require CI, security, monitoring or hooks here. Observed problems remain visible.",
    patch: {
      ci: "unmanaged",
      security: "unmanaged",
      monitoring: "unmanaged",
      hooks: "unmanaged",
    },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  description: string;
  patch: ExpectationPatch;
}[];

export const expectationPatchSchema = expectationSchema
  .partial()
  .refine(
    (patch) => EXPECTATION_KEYS.some((key) => patch[key] !== undefined),
    "Choose at least one expectation field to change",
  );
export const expectationBulkPlanInput = workspaceInput
  .extend({
    repositories: z
      .array(
        z
          .object({
            repositoryId: idSchema,
            revision: z.number().int().positive(),
            patch: expectationPatchSchema,
          })
          .strict(),
      )
      .min(1)
      .max(EXPECTATION_BULK_LIMITS.REPOSITORIES),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      new Set(input.repositories.map((row) => row.repositoryId)).size !==
      input.repositories.length
    )
      context.addIssue({
        code: "custom",
        message: "Select each repository only once",
        path: ["repositories"],
      });
    if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      EXPECTATION_BULK_LIMITS.INPUT_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Select fewer repositories or shorten the selected notes",
      });
  });
export const expectationBulkReviewInput = workspaceInput
  .extend({ planId: idSchema })
  .strict();
export const expectationBulkApplyInput = expectationBulkReviewInput
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ExpectationBulkFields = z.infer<typeof expectationBulkPlanInput>;
export type ExpectationBulkRow = {
  repositoryId: string;
  fullName: string;
  revision: number;
  before: Expectations;
  after: Expectations;
  changed: ExpectationKey[];
};
export type ExpectationBulkReceipt = {
  workspaceId: string;
  planId: string;
  fingerprint: string;
  appliedAt: string;
  changedRepositoryIds: string[];
  unchangedRepositoryIds: string[];
};
export type ExpectationBulkReview = {
  fields: ExpectationBulkFields;
  workspaceId: string;
  workspaceName: string;
  planId: string;
  fingerprint: string;
  actor: string;
  expiresAt: string;
  rows: ExpectationBulkRow[];
  state: "ready" | "stale" | "expired" | "applied";
  receipt: ExpectationBulkReceipt | null;
};

export function changedExpectationFields(
  before: Expectations,
  after: Expectations,
) {
  return EXPECTATION_KEYS.filter((key) => before[key] !== after[key]);
}

export function patchExpectations(
  before: Expectations,
  patch: ExpectationPatch,
): Expectations {
  const defined = Object.fromEntries(
    EXPECTATION_KEYS.filter((key) => patch[key] !== undefined).map((key) => [
      key,
      patch[key],
    ]),
  );
  return expectationSchema.parse({ ...before, ...defined });
}
