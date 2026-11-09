import { z } from "zod";
import { idSchema } from "./domain";

export const GITHUB_APP_LIMITS = Object.freeze({
  PRIVATE_INPUT_BYTES: 64 * 1024,
  MIN_RSA_BITS: 2048,
  JWT_SKEW_SECONDS: 60,
  JWT_LIFETIME_SECONDS: 9 * 60,
  AUTHORITY_MAX_AGE_MS: 60 * 1000,
  TOKEN_MARGIN_MS: 60 * 1000,
  TOKEN_MAX_LIFETIME_MS: 60 * 60 * 1000,
  TOKEN_BYTES: 2048,
  CACHE_ENTRIES: 100,
  SETUP_TTL_MS: 10 * 60 * 1000,
  RESPONSE_BYTES: 256 * 1024,
  REQUEST_TIMEOUT_MS: 8000,
  REPOSITORIES: 100,
  PAGE_SIZE: 100,
  MAX_PAGE: 10000,
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
