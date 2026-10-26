import { z } from "zod";
import {
  githubContextInput,
  githubContextResultSchema,
  githubShaSchema,
} from "./github-context";
import { githubBranchSchema } from "./github-evidence";
import { dependencyDigestSchema } from "./dependency-report";
import { providerCredentialIdSchema } from "./provider-credentials";
import {
  dependencyChangeReviewInput,
  dependencyChangeApplyInput,
  dependencyWriterSchema,
} from "./dependency-changes";
import {
  DEPENDABOT_LIMITS,
  dependabotEditsSchema,
  dependabotEntrySchema,
  dependabotEvidenceSchema,
} from "./dependabot";

export const DEPENDABOT_CHANGE_KIND = "dependabot.schedule";
export const dependabotChangeReviewInput = dependencyChangeReviewInput;
export const dependabotChangeApplyInput = dependencyChangeApplyInput;
export const dependabotChangePlanInput = githubContextInput
  .extend({
    headSha: githubShaSchema,
    fileDigest: dependencyDigestSchema,
    credentialId: providerCredentialIdSchema.optional(),
    edits: dependabotEditsSchema,
  })
  .strict();
export const dependabotChangeReviewSchema = z
  .object({
    workspaceId: githubContextInput.shape.workspaceId,
    planId: dependencyChangeReviewInput.shape.planId,
    fingerprint: dependencyDigestSchema,
    actor: z.string().max(200),
    expiresAt: z.iso.datetime(),
    state: z.enum(["ready", "stale", "expired"]),
    writer: dependencyWriterSchema.nullable(),
    basis: githubContextResultSchema
      .pick({ repository: true, source: true })
      .extend({
        observedAt: z.iso.datetime(),
        headSha: githubShaSchema,
        treeSha: githubShaSchema,
        branch: githubBranchSchema,
        file: dependabotEvidenceSchema.shape.file.unwrap(),
      })
      .strict(),
    edits: dependabotEditsSchema,
    changes: z
      .array(
        z
          .object({
            before: dependabotEntrySchema,
            after: dependabotEntrySchema,
          })
          .strict(),
      )
      .min(1)
      .max(DEPENDABOT_LIMITS.ENTRIES),
    proposedDigest: dependencyDigestSchema,
  })
  .strict();
export type DependabotChangeReview = z.infer<
  typeof dependabotChangeReviewSchema
>;
