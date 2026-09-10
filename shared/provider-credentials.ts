import { z } from "zod";
import { idSchema, repositoryFields, workspaceInput } from "./domain";
import {
  SECRET_ENTRY_KIND,
  SECRET_LIMITS,
  secretEntryKindSchema,
  SECRET_PROVIDER_KIND,
  type SecretEntryKind,
  secretScopeSchema,
  type SecretScope,
} from "./secrets";

export const PROVIDER_CREDENTIAL_KIND = Object.freeze({
  ...SECRET_PROVIDER_KIND,
  REPOSITORY: "github-repositories",
} as const);
export type ProviderCredentialKind =
  (typeof PROVIDER_CREDENTIAL_KIND)[keyof typeof PROVIDER_CREDENTIAL_KIND];
export const PROVIDER_CREDENTIAL_LABELS: Record<
  ProviderCredentialKind,
  string
> = {
  "github-actions": "GitHub Actions",
  "cloudflare-workers": "Cloudflare Workers",
  "github-repositories": "GitHub repository maintenance",
};

const TOKEN_BYTES = 2048;
const INPUT_ENVELOPE_BYTES = 64;
export const PROVIDER_CREDENTIAL_LIMITS = Object.freeze({
  WORKSPACE: 20,
  HISTORY_PAGE: 30,
  RESOURCES: 100,
  PENDING_REVIEWS: 10,
  REVIEW_MS: 5 * 60 * 1000,
  TOKEN_BYTES,
  INPUT_BYTES: TOKEN_BYTES * 2 + INPUT_ENVELOPE_BYTES,
  INPUT_MS: 15000,
  REQUEST_MS: 30000,
  RESPONSE_BYTES: 128 * 1024,
  KEY_BYTES: 32,
  NONCE_BYTES: 12,
  TAG_BITS: 128,
  KEYRING_BYTES: 4096,
  KEYRING_KEYS: 4,
  CIPHERTEXT_BYTES: 4096,
});
export const MANAGED_CREDENTIAL_PREFIX = "managed-";
export const providerCredentialIdSchema = idSchema.refine((value) =>
  value.startsWith(MANAGED_CREDENTIAL_PREFIX),
);
export const cloudflareAccountIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const cloudflareWorkerNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9_-]+$/);
const commonFields = z.object({
  name: z.string().trim().min(1).max(80),
  expiresAt: z.iso.datetime(),
  writable: z.boolean(),
});
const githubNames = z
  .array(repositoryFields.shape.fullName)
  .min(1)
  .max(PROVIDER_CREDENTIAL_LIMITS.RESOURCES)
  .refine(
    (names) =>
      new Set(names.map((name) => name.toLowerCase())).size === names.length,
  );
const workerNames = z
  .array(cloudflareWorkerNameSchema)
  .min(1)
  .max(PROVIDER_CREDENTIAL_LIMITS.RESOURCES)
  .refine((names) => new Set(names).size === names.length);
export const providerCredentialFieldsSchema = z.discriminatedUnion(
  "providerKind",
  [
    commonFields
      .extend({
        providerKind: z.literal(PROVIDER_CREDENTIAL_KIND.REPOSITORY),
        scope: z.object({ repositoryNames: githubNames }).strict(),
      })
      .strict(),
    commonFields
      .extend({
        providerKind: z.literal(SECRET_PROVIDER_KIND.GITHUB),
        scope: z.object({ repositoryNames: githubNames }).strict(),
      })
      .strict(),
    commonFields
      .extend({
        providerKind: z.literal(SECRET_PROVIDER_KIND.CLOUDFLARE),
        scope: z
          .object({ accountId: cloudflareAccountIdSchema, workerNames })
          .strict(),
      })
      .strict(),
  ],
);
export type ProviderCredentialFields = z.infer<
  typeof providerCredentialFieldsSchema
>;
export const providerCredentialSelectionInput = workspaceInput
  .extend({
    credentialId: providerCredentialIdSchema,
  })
  .strict();
export const providerCredentialsListInput = workspaceInput
  .extend({
    purpose: z.enum(["secrets", "repositories"]).default("secrets"),
    retired: z.boolean().default(false),
    before: z.string().min(1).max(300).optional(),
  })
  .strict();
export const providerCredentialChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("save"),
      settings: providerCredentialFieldsSchema,
      replaceToken: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("retire") }).strict(),
]);
export const providerCredentialPlanInput = providerCredentialSelectionInput
  .extend({
    revision: z.number().int().nonnegative(),
    change: providerCredentialChangeSchema,
  })
  .strict();
export const providerCredentialReviewInput = workspaceInput
  .extend({
    planId: idSchema,
  })
  .strict();
export const providerCredentialApplyInput = providerCredentialReviewInput
  .extend({
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const providerCredentialVerifyInput = providerCredentialSelectionInput
  .extend({
    revision: z.number().int().positive(),
    resourceName: z.string().min(1).max(150),
    scope: secretScopeSchema.optional(),
    entryKind: secretEntryKindSchema.default(SECRET_ENTRY_KIND.SECRET),
  })
  .strict();
export type ProviderCredential = {
  id: string;
  revision: number;
  settings: ProviderCredentialFields;
  status: "available" | "expired" | "retired" | "key-unavailable";
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};
export const providerCredentialReviewSchema = z
  .object({
    id: idSchema,
    credentialId: providerCredentialIdSchema,
    revision: z.number().int().nonnegative(),
    change: providerCredentialChangeSchema,
    previousSettings: providerCredentialFieldsSchema.nullable().optional(),
    fingerprint: providerCredentialApplyInput.shape.fingerprint,
    expiresAt: z.iso.datetime(),
    appliedAt: z.iso.datetime().nullable(),
    actorMatches: z.boolean(),
    connections: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().max(80),
            revision: z.number().int().positive(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(SECRET_LIMITS.CONNECTIONS),
    pendingReviews: z.number().int().nonnegative(),
    unsettledDestinations: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderCredentialReview = z.infer<
  typeof providerCredentialReviewSchema
>;
export const providerCredentialInputReceiptSchema = z
  .object({
    submitted: z.boolean(),
    review: providerCredentialReviewSchema,
  })
  .strict();
export type ProviderCredentialVerification = {
  credentialId: string;
  revision: number;
  providerKind: ProviderCredentialKind;
  resourceName: string;
  scope: SecretScope;
  entryKind: SecretEntryKind;
  verifiedAt: string;
  evidence:
    | "secret-metadata-readable"
    | "variable-values-readable"
    | "repository-readable";
  writePermissionVerified: false;
};

export function providerResourceNames(
  credential: Pick<ProviderCredential, "settings">,
) {
  return credential.settings.providerKind === SECRET_PROVIDER_KIND.CLOUDFLARE
    ? credential.settings.scope.workerNames
    : credential.settings.scope.repositoryNames;
}
