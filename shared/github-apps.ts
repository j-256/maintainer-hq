import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const GITHUB_APP_LIMITS = Object.freeze({
  PRIVATE_INPUT_BYTES: 64 * 1024,
  MIN_RSA_BITS: 2048,
  JWT_SKEW_SECONDS: 60,
  JWT_LIFETIME_SECONDS: 9 * 60,
  AUTHORITY_MAX_AGE_MS: 60 * 1000,
  AUTHORITY_REQUESTS: 2,
  COOLDOWN_MAX_MS: 24 * 60 * 60 * 1000,
  TOKEN_MARGIN_MS: 60 * 1000,
  TOKEN_MAX_LIFETIME_MS: 60 * 60 * 1000,
  TOKEN_BYTES: 2048,
  WEBHOOK_SECRET_BYTES: 2048,
  CACHE_ENTRIES: 100,
  SETUP_TTL_MS: 10 * 60 * 1000,
  RESPONSE_BYTES: 256 * 1024,
  REQUEST_TIMEOUT_MS: 8000,
  REPOSITORIES: 100,
  PAGE_SIZE: 100,
  MAX_PAGE: 10000,
  SETUP_PERMIT_BYTES: 32768,
  SETUP_PERMITS: 100,
  REGISTRATIONS: 100,
  PENDING_REVIEWS: 20,
  GRANTS: 100,
  CREDENTIAL_CATALOG_BYTES: 512 * 1024,
  INPUT_REQUEST_TIMEOUT_MS: 25000,
});
export const GITHUB_CAPABILITY = Object.freeze({
  COLLECTION: "collection",
  MAINTENANCE: "repository-maintenance",
  CONFIGURATION_READ: "configuration-read",
  CONFIGURATION_WRITE: "configuration-write",
} as const);
export const githubCapabilitySchema = z.enum([
  GITHUB_CAPABILITY.COLLECTION,
  GITHUB_CAPABILITY.MAINTENANCE,
  GITHUB_CAPABILITY.CONFIGURATION_READ,
  GITHUB_CAPABILITY.CONFIGURATION_WRITE,
]);
export type GitHubCapability = z.infer<typeof githubCapabilitySchema>;
export const githubCapabilitiesSchema = z
  .array(githubCapabilitySchema)
  .min(1)
  .max(Object.keys(GITHUB_CAPABILITY).length)
  .refine(
    (values) => new Set(values).size === values.length,
    "Choose each capability only once",
  );
export const githubAuthReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token"), reference: idSchema }).strict(),
  z.object({ kind: z.literal("app"), grantId: idSchema }).strict(),
]);
export type GitHubAuthReference = z.infer<typeof githubAuthReferenceSchema>;
export const githubProviderIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const githubKeyFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const githubRepositoryNameSchema = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
export const githubAppMetadataSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(80),
    appId: githubProviderIdSchema,
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
    visibility: z.enum(["private", "public"]),
    capabilities: githubCapabilitiesSchema,
    revision: z.number().int().positive(),
    state: z.enum(["active", "disconnected"]),
    keyFingerprint: githubKeyFingerprintSchema,
    lifecycleIngress: z.enum(["ready", "requires_webhook_secret", "disabled"]),
  })
  .strict();
export type GitHubAppMetadata = z.infer<typeof githubAppMetadataSchema>;
const readWrite = z.enum(["read", "write"]);
export const githubAppPermissionsSchema = z
  .object({
    metadata: z.literal("read").optional(),
    contents: readWrite.optional(),
    checks: z.literal("read").optional(),
    statuses: z.literal("read").optional(),
    pull_requests: readWrite.optional(),
    issues: z.literal("read").optional(),
    deployments: z.literal("read").optional(),
    vulnerability_alerts: z.literal("read").optional(),
    security_events: z.literal("read").optional(),
    secret_scanning_alerts: z.literal("read").optional(),
    actions: z.literal("read").optional(),
    secrets: readWrite.optional(),
    variables: readWrite.optional(),
    environments: readWrite.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type GitHubAppPermissions = z.infer<typeof githubAppPermissionsSchema>;
const PROFILES: Record<GitHubCapability, GitHubAppPermissions> = {
  collection: {
    metadata: "read",
    contents: "read",
    checks: "read",
    statuses: "read",
    pull_requests: "read",
    issues: "read",
    deployments: "read",
    vulnerability_alerts: "read",
    security_events: "read",
    secret_scanning_alerts: "read",
  },
  "repository-maintenance": {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  },
  "configuration-read": {
    metadata: "read",
    actions: "read",
    secrets: "read",
    variables: "read",
    environments: "read",
  },
  "configuration-write": {
    metadata: "read",
    actions: "read",
    secrets: "write",
    variables: "write",
    environments: "write",
  },
};
export function githubAppPermissions(
  capabilities: readonly GitHubCapability[],
): GitHubAppPermissions {
  const result: Record<string, "read" | "write"> = {};
  for (const capability of githubCapabilitiesSchema.parse(capabilities)) {
    for (const [permission, level] of Object.entries(PROFILES[capability])) {
      if (level && result[permission] !== "write") result[permission] = level;
    }
  }
  return githubAppPermissionsSchema.parse(result);
}

export const githubAppRegistrationFieldsSchema = githubAppMetadataSchema.pick({
  name: true,
  appId: true,
  visibility: true,
  capabilities: true,
});
export const githubAppListInput = workspaceInput
  .extend({
    scope: z.enum(["administration", "workspace"]),
  })
  .strict();
export const githubAppRegistrationPlanInput = workspaceInput
  .extend({
    registrationId: idSchema,
    revision: z.number().int().nonnegative(),
    change: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("save"),
          fields: githubAppRegistrationFieldsSchema,
          replaceKey: z.boolean(),
        })
        .strict(),
      z.object({ kind: z.literal("rotate") }).strict(),
      z.object({ kind: z.literal("disconnect") }).strict(),
    ]),
  })
  .strict();
export const githubAppRegistrationSelectionInput = workspaceInput
  .extend({
    planId: idSchema,
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const githubAppSetupPermitRevokeInput = workspaceInput
  .extend({
    permitId: idSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export type GitHubAppRegistrationFields = z.infer<
  typeof githubAppRegistrationFieldsSchema
>;
export type GitHubAppRegistrationPlanInput = z.infer<
  typeof githubAppRegistrationPlanInput
>;
export type GitHubAppRegistrationSelection = z.infer<
  typeof githubAppRegistrationSelectionInput
>;
export const githubAppRegistrationReviewSchema = z
  .object({
    id: idSchema,
    registrationId: idSchema,
    revision: z.number().int().nonnegative(),
    change: githubAppRegistrationPlanInput.shape.change,
    fingerprint: githubAppRegistrationSelectionInput.shape.fingerprint,
    expiresAt: z.iso.datetime(),
    privateInputRequired: z.boolean(),
    applied: z.boolean(),
    expired: z.boolean(),
    impact: z
      .object({
        affectedWorkspaceIds: z
          .array(idSchema)
          .max(GITHUB_APP_LIMITS.GRANTS + 1),
      })
      .strict(),
    registration: githubAppMetadataSchema.nullable(),
  })
  .strict();
export type GitHubAppRegistrationReview = z.infer<
  typeof githubAppRegistrationReviewSchema
>;
export const githubAppManifestStartInput = workspaceInput
  .extend({
    registrationId: idSchema,
    name: githubAppRegistrationFieldsSchema.shape.name,
    visibility: githubAppRegistrationFieldsSchema.shape.visibility,
    capabilities: githubCapabilitiesSchema,
    account: z
      .object({
        login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
        type: z.enum(["User", "Organization"]),
      })
      .strict(),
  })
  .strict();
export const githubAppManifestGetInput = workspaceInput
  .extend({ attemptId: idSchema })
  .strict();
export type GitHubAppManifestStartInput = z.infer<
  typeof githubAppManifestStartInput
>;
export type GitHubAppManifestAttempt = {
  id: string;
  registrationId: string;
  state:
    "pending" | "conversion_claimed" | "complete" | "indeterminate" | "expired";
  expiresAt: string;
  browserUrl: string;
  registration: GitHubAppMetadata | null;
  recovery: "none" | "protected_import_required";
};

export const githubAppInstallationsInput = workspaceInput
  .extend({
    registrationId: idSchema,
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .optional(),
  })
  .strict();
export const githubAppRepositoriesInput = githubAppInstallationsInput
  .extend({ installationId: githubProviderIdSchema })
  .strict();
export type GitHubAppRepositoryPage = {
  items: { id: number; fullName: string; ownerId: number; private: boolean }[];
  nextCursor: string | null;
  limited: boolean;
};
export const githubAppConnectionRequestInput = workspaceInput
  .extend({
    requestId: idSchema,
    requestedCapabilities: githubCapabilitiesSchema,
  })
  .strict();
export const githubAppConnectionRequestsInput = workspaceInput
  .extend({ scope: z.enum(["workspace", "administration"]) })
  .strict();
export const githubAppGrantPlanInput = workspaceInput
  .extend({
    targetWorkspaceId: idSchema,
    registrationId: idSchema,
    installationId: githubProviderIdSchema,
    grantId: idSchema,
    revision: z.number().int().nonnegative(),
    repositoryIds: z
      .array(githubProviderIdSchema)
      .min(1)
      .max(GITHUB_APP_LIMITS.REPOSITORIES)
      .refine((ids) => new Set(ids).size === ids.length),
    capabilities: githubCapabilitiesSchema,
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export const githubAppGrantRevokeInput = workspaceInput
  .extend({
    grantId: idSchema,
    revision: z.number().int().positive(),
    targetWorkspaceId: idSchema.optional(),
  })
  .strict();
export const githubAppGrantListInput = workspaceInput.strict();
export const githubAppRepositoryIdentitySchema = z
  .object({
    id: githubProviderIdSchema,
    fullName: githubRepositoryNameSchema,
    ownerId: githubProviderIdSchema,
    private: z.boolean(),
  })
  .strict();
export const githubAppGrantSchema = z
  .object({
    id: idSchema,
    workspaceId: idSchema,
    credentialRef: idSchema,
    registrationId: idSchema,
    appId: githubProviderIdSchema,
    appName: z.string().min(1).max(80),
    installationId: githubProviderIdSchema,
    account: z
      .object({
        id: githubProviderIdSchema,
        login: z.string().min(1).max(100),
        type: z.enum(["User", "Organization"]),
      })
      .strict(),
    repositories: z
      .array(githubAppRepositoryIdentitySchema)
      .min(1)
      .max(GITHUB_APP_LIMITS.REPOSITORIES),
    capabilities: githubCapabilitiesSchema,
    revision: z.number().int().positive(),
    state: z.enum(["active", "revoked", "expired"]),
    expiresAt: z.iso.datetime().nullable(),
    issuerSubject: z.string().min(1).max(300),
    acceptedBy: z.string().min(1).max(300),
    acceptedAt: z.iso.datetime(),
  })
  .strict();
export type GitHubAppGrant = z.infer<typeof githubAppGrantSchema>;
export type GitHubAppGrantReview = {
  id: string;
  fingerprint: string;
  targetWorkspaceId: string;
  registrationId: string;
  installationId: number;
  grantId: string;
  revision: number;
  kind: "offer" | "revoke";
  repositories: z.infer<typeof githubAppRepositoryIdentitySchema>[];
  capabilities: GitHubCapability[];
  expiresAt: string;
  grantExpiresAt: string | null;
  state: "offered" | "active" | "revoked" | "expired";
  grant: GitHubAppGrant | null;
};
