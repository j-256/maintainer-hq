import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const SECRET_LIMITS = Object.freeze({
  CONNECTIONS: 10,
  RESOURCES: 100,
  DESTINATIONS: 10,
  PAGE_SIZE: 30,
  MAX_PAGE: 100,
  INPUT_BYTES: 64 * 1024,
  UPLOAD_BYTES: 900 * 1024,
  REVIEW_RESPONSE_BYTES: 256 * 1024,
  REQUEST_MS: 15000,
  REVIEW_MS: 30 * 60 * 1000,
  LEASE_MS: 2 * 60 * 1000,
  SEND_RESERVE_MS: 20 * 1000,
  RECOVERY_DEPTH: 3,
  CLEANUP_PREPARE_MS: 60 * 1000,
  DRAFT_PREPARE_MS: 60 * 1000,
  CLEANUP_REVIEWS: 20,
  STAGED_WORKSPACE: 20,
  HISTORY_PAGE: 30,
  INVENTORY_VALUE_BYTES: 64 * 1024,
  INPUT_READ_MS: 15000,
  INPUT_RETENTION_MS: 60 * 60 * 1000,
});
export const SECRET_PROVIDER_KIND = Object.freeze({
  GITHUB: "github-actions",
  CLOUDFLARE: "cloudflare-workers",
} as const);
export const secretProviderKindSchema = z.enum([
  SECRET_PROVIDER_KIND.GITHUB,
  SECRET_PROVIDER_KIND.CLOUDFLARE,
]);
export type SecretProviderKind = z.infer<typeof secretProviderKindSchema>;
export const SECRET_ENTRY_KIND = Object.freeze({
  SECRET: "secret",
  VARIABLE: "variable",
} as const);
export const secretEntryKindSchema = z.enum([
  SECRET_ENTRY_KIND.SECRET,
  SECRET_ENTRY_KIND.VARIABLE,
]);
export type SecretEntryKind = z.infer<typeof secretEntryKindSchema>;
export const SECRET_MANAGEMENT = Object.freeze({
  HQ: "hq",
  UNMANAGED: "unmanaged",
} as const);
export const secretManagementSchema = z.enum([
  SECRET_MANAGEMENT.HQ,
  SECRET_MANAGEMENT.UNMANAGED,
]);
export type SecretManagement = z.infer<typeof secretManagementSchema>;

const opaqueName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !/[\x00-\x1f\x7f]/.test(name));
export const secretScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("organization"), name: opaqueName })
    .strict(),
  z.object({ kind: z.literal("repository") }).strict(),
  z.object({ kind: z.literal("environment"), name: opaqueName }).strict(),
  z.object({ kind: z.literal("worker") }).strict(),
]);
export const secretTargetSchema = z
  .object({ resourceId: idSchema, scope: secretScopeSchema })
  .strict();
export const secretDestinationSchema = z
  .object({
    connectionId: idSchema,
    connectionRevision: z.number().int().positive(),
    target: secretTargetSchema,
    name: opaqueName,
  })
  .strict();
export const secretConnectionFields = z
  .object({
    name: z.string().trim().min(1).max(80),
    providerKind: secretProviderKindSchema,
    providerRef: idSchema,
    resourceIds: z
      .array(idSchema)
      .min(1)
      .max(SECRET_LIMITS.RESOURCES)
      .refine((ids) => new Set(ids).size === ids.length),
    enabled: z.boolean(),
  })
  .strict();
export const secretConnectionInput = workspaceInput
  .extend({ connectionId: idSchema })
  .strict();
export const secretConnectionSaveInput = secretConnectionInput
  .extend({
    revision: z.number().int().nonnegative(),
    connection: secretConnectionFields,
  })
  .strict();
export const secretScopesInput = secretConnectionInput
  .extend({
    resourceId: idSchema,
    page: z.number().int().min(1).max(SECRET_LIMITS.MAX_PAGE).default(1),
  })
  .strict();
export const secretInventoryInput = secretConnectionInput
  .extend({
    target: secretTargetSchema,
    entryKind: secretEntryKindSchema.default(SECRET_ENTRY_KIND.SECRET),
    page: z.number().int().min(1).max(SECRET_LIMITS.MAX_PAGE).default(1),
  })
  .strict();
export const secretDraftInput = workspaceInput
  .extend({
    reviewId: idSchema,
    destinations: z
      .array(secretDestinationSchema)
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS)
      .refine(
        (items) =>
          new Set(items.map(secretDestinationKey)).size === items.length,
      ),
    source: secretDestinationSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (input) =>
      !input.source ||
      !input.destinations.some(
        (item) =>
          secretDestinationKey(item) === secretDestinationKey(input.source!),
      ),
  );
export const secretReviewInput = workspaceInput
  .extend({ reviewId: idSchema })
  .strict();
export const secretApplyInput = secretReviewInput
  .extend({ fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();
export const secretStepInput = secretReviewInput
  .extend({
    destinationIndex: z
      .number()
      .int()
      .min(0)
      .max(SECRET_LIMITS.DESTINATIONS - 1),
  })
  .strict();
export const secretRunInput = secretStepInput
  .extend({ fingerprint: secretApplyInput.shape.fingerprint })
  .strict();
export const secretRecoveryPlanInput = secretRunInput
  .extend({
    newReviewId: idSchema,
    acknowledgePossibleOverwrite: z.literal(true),
  })
  .strict();
export const secretRecoveryContextSchema = z
  .object({
    reviewId: idSchema,
    destinationIndex: secretStepInput.shape.destinationIndex,
    fingerprint: secretApplyInput.shape.fingerprint,
    receiptRevision: z.number().int().positive(),
    depth: z.number().int().min(1).max(SECRET_LIMITS.RECOVERY_DEPTH),
  })
  .strict();
export type SecretRecoveryContext = z.infer<typeof secretRecoveryContextSchema>;
export const secretHistoryInput = workspaceInput
  .extend({
    repositoryId: idSchema.optional(),
    before: z.string().max(200).optional(),
  })
  .strict();

export type SecretScope = z.infer<typeof secretScopeSchema>;
export type SecretTarget = z.infer<typeof secretTargetSchema>;
export type SecretDestination = z.infer<typeof secretDestinationSchema>;
export type SecretResource = {
  id: string;
  label: string;
  repositoryIds: string[];
};
export type SecretCapabilities = {
  entryKinds: SecretEntryKind[];
  input: "provider-sealed" | "private-transient";
  maxValueBytes: number;
  nameRule: "github-actions" | "provider-defined";
  scopeKinds: SecretScope["kind"][];
  secretMutationScopeKinds: SecretScope["kind"][];
  variableMutationScopeKinds: SecretScope["kind"][];
  valueReadableKinds: SecretEntryKind[];
  activation: "secret-update" | "worker-deployment";
  metadataVersion: "timestamps" | "opaque" | "unavailable";
  storedValueReadable: false;
};
export type SecretProviderReference = {
  id: string;
  kind: SecretProviderKind;
  name: string;
  revision: number;
  resources: SecretResource[];
  available: boolean;
  writable: boolean;
  expiresAt: string;
  capabilities: SecretCapabilities;
};
export type SecretConnection = z.infer<typeof secretConnectionFields> & {
  id: string;
  revision: number;
  resources: SecretResource[];
  available: boolean;
  writable: boolean;
  providerName: string | null;
  capabilities: SecretCapabilities | null;
};
export const secretMetadataSchema = z.object({
  name: opaqueName,
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.string().min(1).max(512).nullable(),
});
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;
const inventoryValueSchema = z
  .string()
  .max(SECRET_LIMITS.INVENTORY_VALUE_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      SECRET_LIMITS.INVENTORY_VALUE_BYTES,
  );
export const secretInventoryItemSchema = secretMetadataSchema
  .extend({
    kind: secretEntryKindSchema,
    management: secretManagementSchema,
    managedConfigurationId: idSchema.nullable().default(null),
    value: inventoryValueSchema.nullable(),
    valueFormat: z.enum(["text", "json"]).nullable(),
  })
  .superRefine((item, context) => {
    if (
      item.kind === SECRET_ENTRY_KIND.SECRET &&
      (item.value !== null || item.valueFormat !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Secret inventory cannot include stored values",
      });
    if (
      item.kind === SECRET_ENTRY_KIND.VARIABLE &&
      (item.value === null || item.valueFormat === null)
    )
      context.addIssue({
        code: "custom",
        message: "Variable inventory requires a readable value",
      });
  });
export type SecretInventoryItem = z.infer<typeof secretInventoryItemSchema>;
export const secretInputRequirementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider-sealed"),
      algorithm: z.literal("libsodium-sealed-box"),
      keyId: z.string().min(1).max(255),
      publicKey: z.string().min(1).max(255),
      maxValueBytes: z.number().int().positive().max(SECRET_LIMITS.INPUT_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("private-transient"),
      maxValueBytes: z.number().int().positive().max(SECRET_LIMITS.INPUT_BYTES),
    })
    .strict(),
]);
export const secretTargetSnapshotSchema = z
  .object({
    name: opaqueName,
    scope: secretScopeSchema,
    resourceIdentity: z.string().min(1).max(255),
    scopeIdentity: z.string().min(1).max(255).nullable(),
    resourceRevision: z.string().min(1).max(255).nullable(),
    before: secretMetadataSchema.nullable(),
    input: secretInputRequirementSchema,
    activation: z.enum(["secret-update", "worker-deployment"]),
    workerDeployment: z
      .object({
        accountId: z.string().regex(/^[a-f0-9]{32}$/),
        workerName: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-zA-Z0-9_-]+$/),
        deploymentId: z.uuid(),
        versionId: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SecretTargetSnapshot = z.infer<typeof secretTargetSnapshotSchema>;
export type SecretInputRequirement = z.infer<
  typeof secretInputRequirementSchema
>;
export const reviewedDestinationSchema = z
  .object({
    destination: secretDestinationSchema,
    providerKind: secretProviderKindSchema,
    connectionName: z.string().min(1).max(80),
    resource: z
      .object({
        id: idSchema,
        label: opaqueName,
        repositoryIds: z.array(idSchema).max(SECRET_LIMITS.RESOURCES),
      })
      .strict(),
    snapshot: secretTargetSnapshotSchema,
  })
  .strict();
export type SecretReviewedDestination = z.infer<
  typeof reviewedDestinationSchema
>;
export const secretWriteResultSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "indeterminate"]),
    reason: z
      .enum([
        "credential_read_only",
        "rate_limited",
        "provider_rejected",
        "provider_result_uncertain",
      ])
      .nullable(),
  })
  .strict();
export type SecretWriteResult = z.infer<typeof secretWriteResultSchema>;
export const secretReceiptSchema = z
  .object({
    destinationIndex: secretStepInput.shape.destinationIndex,
    phase: z.enum(["pending", "preparing", "submitted", "finished"]),
    writeStatus: z.enum(["not-sent", "accepted", "rejected", "indeterminate"]),
    reason: z
      .enum([
        "credential_read_only",
        "rate_limited",
        "provider_rejected",
        "provider_result_uncertain",
        "preflight_changed",
        "authority_changed",
        "input_expired",
        "execution_interrupted",
      ])
      .nullable(),
    observationStatus: z.enum(["unknown", "present", "absent", "unavailable"]),
    metadata: secretMetadataSchema.nullable(),
    observedAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
    recoveryReviewId: idSchema.nullable().default(null),
  })
  .strict();
export type SecretReceipt = z.infer<typeof secretReceiptSchema>;
export const secretOperationSchema = z
  .object({
    acceptedAt: z.iso.datetime(),
    leaseExpiresAt: z.iso.datetime().nullable(),
    leaseExpired: z.boolean(),
    receipts: z
      .array(secretReceiptSchema)
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
  })
  .strict();
export const secretReviewSchema = z
  .object({
    id: idSchema,
    stage: z.enum(["awaiting-input", "reviewed", "accepted", "cancelled"]),
    draftFingerprint: secretApplyInput.shape.fingerprint,
    fingerprint: secretApplyInput.shape.fingerprint.nullable(),
    actorMatches: z.boolean(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    inputExpiresAt: z.iso.datetime(),
    inputPresent: z.boolean(),
    destinations: z
      .array(reviewedDestinationSchema)
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
    source: reviewedDestinationSchema.nullable(),
    operation: secretOperationSchema.nullable().default(null),
    recovery: secretRecoveryContextSchema.nullable().default(null),
  })
  .strict();
export type SecretReview = z.infer<typeof secretReviewSchema>;
export const secretTransientReceiptSchema = z
  .object({
    inputConsumed: z.boolean(),
    review: secretReviewSchema,
  })
  .strict();
export type SecretTransientReceipt = z.infer<
  typeof secretTransientReceiptSchema
>;
export function sealedSecretIndexes(
  destinations: readonly { snapshot: { input: SecretInputRequirement } }[],
) {
  return destinations.flatMap((item, index) =>
    item.snapshot.input.kind === "provider-sealed" ? [index] : [],
  );
}
export function secretStagedInputReady(review: SecretReview) {
  return (
    sealedSecretIndexes(review.destinations).length === 0 || review.inputPresent
  );
}
export type SecretPage<T> = {
  items: T[];
  page: number;
  total: number | null;
  nextPage: number | null;
  truncated: boolean;
};
export type SecretInventory = SecretPage<SecretInventoryItem> & {
  providerKind: SecretProviderKind;
  entryKind: SecretEntryKind;
  resource: SecretResource;
  target: SecretTarget;
  resourceIdentity: string;
  scopeIdentity: string | null;
  observedAt: string;
  excludedBindings?: number;
  unsupportedBindings?: number;
  workerDeployment?: SecretTargetSnapshot["workerDeployment"] | null;
};
export type SecretScopes = SecretPage<{
  label: string;
  scope: SecretScope;
  identity: string;
}> & {
  providerKind: SecretProviderKind;
  resource: SecretResource;
  defaultScope: SecretScope;
  fixedScopes?: {
    label: string;
    scope: SecretScope;
    identity: string;
  }[];
  observedAt: string;
};
export function secretDestinationKey(destination: SecretDestination) {
  return JSON.stringify([
    destination.connectionId,
    destination.target.resourceId,
    destination.target.scope.kind,
    destination.target.scope.kind === "environment" ||
    destination.target.scope.kind === "organization"
      ? destination.target.scope.name
      : null,
    destination.name,
  ]);
}
