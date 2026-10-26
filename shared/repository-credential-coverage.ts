import { z } from "zod";
import { idSchema, repositoryFields, workspaceInput } from "./domain";
import { PROVIDER_CREDENTIAL_LIMITS } from "./provider-credentials";
import { SOURCE_LIMITS } from "./sources";

export const REPOSITORY_CREDENTIAL_COVERAGE_LIMITS = Object.freeze({
  REPOSITORIES: 50,
  RESPONSE_BYTES: 128 * 1024,
  METADATA_BYTES: 1024 * 1024,
});
export const repositoryCredentialCoverageInput = workspaceInput
  .extend({
    repositoryIds: z
      .array(idSchema)
      .min(1)
      .max(REPOSITORY_CREDENTIAL_COVERAGE_LIMITS.REPOSITORIES)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each repository only once",
      ),
  })
  .strict();
const sources = z.number().int().min(0).max(SOURCE_LIMITS.SOURCES);
const credentials = z
  .number()
  .int()
  .min(0)
  .max(PROVIDER_CREDENTIAL_LIMITS.WORKSPACE);
export const repositoryCredentialCoverageSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    rows: z
      .array(
        z
          .object({
            repository: z
              .object({
                id: idSchema,
                fullName: repositoryFields.shape.fullName,
                revision: z.number().int().positive().safe(),
              })
              .strict(),
            collection: z
              .object({
                configured: sources,
                disabled: sources,
                invalidConfiguration: sources,
                credentialUnavailable: sources,
                grant: z.literal("not_verified"),
              })
              .strict(),
            maintenance: z
              .object({
                configuredForWrites: credentials,
                readOnly: credentials,
                expired: credentials,
                keyUnavailable: credentials,
                grant: z.literal("not_verified"),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(REPOSITORY_CREDENTIAL_COVERAGE_LIMITS.REPOSITORIES),
  })
  .strict();
export type RepositoryCredentialCoverage = z.infer<
  typeof repositoryCredentialCoverageSchema
>;
