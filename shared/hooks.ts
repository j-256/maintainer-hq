import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const HOOK_LIMITS = Object.freeze({
  CONNECTIONS: 20,
  PROVIDERS: 20,
  PAGE_SIZE: 25,
  PENDING_REVIEWS: 25,
  RESPONSE_BYTES: 2 * 1024 * 1024,
  PROVIDER_TIMEOUT_MS: 15000,
  CATALOG_BYTES: 64 * 1024,
  HISTORY: 50,
  ASSOCIATIONS: 1000,
  HEALTH_SAMPLE: 1000,
  REFRESH_MS: 60000,
});
export const HOOK_RETRY_KIND = "hookrelay.delivery.retry";
export const HOOK_POLICY_KIND = "hookrelay.subscription.policy";
export const HOOK_DELIVERY_STATES = [
  "pending",
  "queued",
  "processing",
  "retrying",
  "delivered",
  "filtered",
  "exhausted",
] as const;
export const hookIdentity = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_.:@-]+$/);
export const hookName = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const timestamp = z.iso.datetime();
export const hookCursor = z
  .object({
    updatedAt: timestamp,
    eventId: hookIdentity,
    sinkName: hookName,
  })
  .strict();
export const hookConnectionInput = workspaceInput
  .extend({ connectionId: idSchema })
  .strict();
export const hookConnectionFields = z
  .object({
    name: z.string().trim().min(1).max(80),
    providerRef: idSchema,
    enabled: z.boolean(),
    projectId: idSchema.nullable(),
  })
  .strict();
export const hookConnectionSaveInput = hookConnectionInput
  .extend({
    revision: z.number().int().nonnegative(),
    connection: hookConnectionFields,
  })
  .strict();
export const hookSubscriptionsInput = hookConnectionInput
  .extend({
    cursor: z.string().max(8192).nullable().default(null),
  })
  .strict();
export const hookDeliveriesInput = hookConnectionInput
  .extend({
    status: z.enum(HOOK_DELIVERY_STATES).nullable().default(null),
    subscription: hookName.nullable().default(null),
    cursor: hookCursor.nullable().default(null),
  })
  .strict();
export const hookDeliveryInput = hookConnectionInput
  .extend({
    eventId: hookIdentity,
    sinkName: hookName,
  })
  .strict();
export const hookRetryPlanInput = hookDeliveryInput
  .extend({
    reviewId: z.uuid(),
    connectionRevision: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    updatedAt: timestamp,
  })
  .strict();
export const hookRetryInput = workspaceInput
  .extend({ planId: z.uuid() })
  .strict();
export const hookRetryApplyInput = hookRetryInput
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const hookAssociationGetInput = hookConnectionInput
  .extend({ subscription: hookName })
  .strict();
export const hookAssociationInput = hookAssociationGetInput
  .extend({
    revision: z.number().int().nonnegative(),
    projectId: idSchema,
  })
  .strict();

export const HOOK_POLICY_LIMITS = Object.freeze({
  DESTINATIONS: 100,
  PATTERNS: 100,
  PATTERN_LENGTH: 160,
});
export const HOOK_SEVERITIES = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
] as const;
const uniquePolicyValues = <T>(values: T[]) =>
  new Set(values).size === values.length;
const HOOK_EVENT_TYPE_PATTERN = "[a-z0-9_-](?:[a-z0-9_.:/-]*[a-z0-9_-])?";
const policyPatterns = z
  .array(
    z
      .string()
      .min(1)
      .max(HOOK_POLICY_LIMITS.PATTERN_LENGTH)
      .regex(new RegExp(`^(?:\\*|${HOOK_EVENT_TYPE_PATTERN}(?:\\.\\*)?)$`)),
  )
  .min(1)
  .max(HOOK_POLICY_LIMITS.PATTERNS)
  .refine(uniquePolicyValues);
const policySeverities = z
  .array(z.enum(HOOK_SEVERITIES))
  .min(1)
  .max(HOOK_SEVERITIES.length)
  .refine(uniquePolicyValues);
const policyTypeFilter = z
  .object({
    include: policyPatterns.optional(),
    exclude: policyPatterns.optional(),
  })
  .strict()
  .refine(
    (value) => value.include !== undefined || value.exclude !== undefined,
  );
const policySeverityFilter = z
  .object({
    include: policySeverities.optional(),
    exclude: policySeverities.optional(),
  })
  .strict()
  .refine(
    (value) => value.include !== undefined || value.exclude !== undefined,
  );
export const hookPolicyFilterSchema = z
  .object({
    eventTypes: policyTypeFilter.optional(),
    severities: policySeverityFilter.optional(),
  })
  .strict()
  .refine(
    (value) => value.eventTypes !== undefined || value.severities !== undefined,
  );
export const hookPolicySchema = z
  .object({
    enabled: z.boolean(),
    sinks: z
      .array(hookName)
      .max(HOOK_POLICY_LIMITS.DESTINATIONS)
      .refine(uniquePolicyValues),
    filter: hookPolicyFilterSchema.nullable(),
    sinkFilters: z.record(hookName, hookPolicyFilterSchema),
  })
  .strict()
  .refine((value) =>
    Object.keys(value.sinkFilters).every((name) => value.sinks.includes(name)),
  );
export const hookAuthorityId = z.string().regex(/^[a-f0-9]{32}$/);
const hookAuthoritySchema = z.object({
  authorityId: hookAuthorityId,
  revision: z.number().int().nonnegative(),
  mode: z.enum(["legacy", "active"]),
});
export const hookConfigurationSchema = hookAuthoritySchema
  .extend({
    canConfigure: z.boolean(),
    supported: z
      .object({ policy: z.boolean(), create: z.boolean(), retire: z.boolean() })
      .strict(),
    observedAt: timestamp,
  })
  .strict();
export const hookPolicySubscriptionSchema = z
  .object({
    resourceId: z.uuid(),
    name: hookName,
    source: hookName,
    policy: hookPolicySchema,
  })
  .strict();
export const hookPolicyDestinationSchema = z
  .object({
    resourceId: z.uuid(),
    name: hookName,
    type: hookName,
    retired: z.boolean(),
  })
  .strict();
export const hookPolicyDetailSchema = hookAuthoritySchema
  .extend(hookPolicySubscriptionSchema.shape)
  .extend({ observedAt: timestamp })
  .strict();
export const hookPolicyPageInput = hookConnectionInput
  .extend({
    authorityId: hookAuthorityId,
    revision: z.number().int().nonnegative(),
    cursor: z.uuid().nullable().default(null),
  })
  .strict();
export const hookPolicyDetailInput = hookConnectionInput
  .extend({ resourceId: z.uuid() })
  .strict();
export const hookPolicyPlanInput = hookPolicyDetailInput
  .extend({
    reviewId: z.uuid(),
    connectionRevision: z.number().int().positive(),
    authorityId: hookAuthorityId,
    revision: z.number().int().nonnegative(),
    policy: hookPolicySchema,
  })
  .strict();
export const hookPolicyReceiptSchema = z
  .object({
    planId: z.uuid(),
    authorityId: hookAuthorityId,
    revision: z.number().int().nonnegative(),
    resourceId: z.uuid(),
    resourceName: hookName,
    status: z.enum(["ready", "accepted", "expired", "conflict"]),
    before: hookPolicySchema,
    after: hookPolicySchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    receipt: z
      .object({
        operationId: z.uuid(),
        revision: z.number().int().positive(),
        acceptedAt: timestamp,
      })
      .strict()
      .nullable(),
    effect: z.literal("future-ingress-policy"),
  })
  .strict()
  .refine((value) =>
    value.status === "accepted"
      ? value.receipt?.operationId === value.planId &&
        value.receipt.revision === value.revision + 1
      : value.receipt === null,
  );

export const hookDeliverySchema = z
  .object({
    eventId: hookIdentity,
    sinkName: hookName,
    generation: z.number().int().nonnegative(),
    status: z.enum(HOOK_DELIVERY_STATES),
    attempts: z.number().int().nonnegative(),
    decisionReason: z
      .enum(["source-record-only", "subscription-filter", "sink-filter"])
      .nullable(),
    updatedAt: timestamp,
    deliveredAt: timestamp.nullable(),
    receivedAt: timestamp,
    subscription: hookName,
    source: hookName,
  })
  .strict();
export const hookSubscriptionSchema = z
  .object({
    name: hookName,
    source: hookName,
    enabled: z.boolean(),
    sinks: z.array(hookName).max(100),
  })
  .strict();
export const hookReceiptSchema = z
  .object({
    planId: z.uuid(),
    eventId: hookIdentity,
    sinkName: hookName,
    generation: z.number().int().nonnegative(),
    updatedAt: timestamp,
    createdAt: timestamp,
    expiresAt: timestamp,
    state: z.enum(["review", "accepted", "expired"]),
    acceptedAt: timestamp.nullable(),
    acceptedGeneration: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.state === "accepted"
        ? value.acceptedAt !== null &&
          value.acceptedGeneration === value.generation + 1
        : value.acceptedAt === null && value.acceptedGeneration === null,
    { message: "Inconsistent provider receipt" },
  );
export const hookSignalSchema = z
  .object({
    code: z.enum([
      "ingress-payload-too-large",
      "ingress-rate-limited",
      "ingress-adapter-missing",
      "ingress-authentication-rejected",
      "ingress-parse-rejected",
      "ingress-persistence-rejected",
      "delivery-exhausted",
      "delivery-stale",
      "retention-prune-rejected",
    ]),
    severity: z.enum(["debug", "info", "warning", "error", "critical"]),
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    occurrences: z.number().int().positive(),
    resolvedAt: timestamp.nullable(),
  })
  .strict();
export const hookSnapshotSchema = z
  .object({
    observedAt: timestamp,
    deliveries: z
      .object({
        totals: z.record(
          z.enum(HOOK_DELIVERY_STATES),
          z.number().int().nonnegative(),
        ),
        sampled: z.number().int().nonnegative().max(HOOK_LIMITS.HEALTH_SAMPLE),
        limit: z.literal(HOOK_LIMITS.HEALTH_SAMPLE),
        truncated: z.boolean(),
      })
      .strict()
      .refine(
        (value) =>
          Object.values(value.totals).reduce((sum, n) => sum + n, 0) ===
          value.sampled,
      ),
    signals: z
      .object({
        items: z.array(hookSignalSchema).max(HOOK_LIMITS.PAGE_SIZE),
        truncated: z.boolean(),
      })
      .strict(),
    lastRetentionAt: timestamp.nullable(),
  })
  .strict();
export const hookSubscriptionsSchema = z
  .object({
    items: z.array(hookSubscriptionSchema).max(HOOK_LIMITS.PAGE_SIZE),
    nextCursor: z.string().max(8192).nullable(),
    disappeared: z.number().int().nonnegative().max(HOOK_LIMITS.PAGE_SIZE),
    observedAt: timestamp,
  })
  .strict();
export const hookDeliveriesSchema = z
  .object({
    items: z.array(hookDeliverySchema).max(HOOK_LIMITS.PAGE_SIZE),
    nextCursor: hookCursor.nullable(),
    scanned: z.number().int().nonnegative().max(HOOK_LIMITS.PAGE_SIZE),
    observedAt: timestamp,
    pagination: z.literal("live-updated-desc"),
  })
  .strict();
export const hookResultSchemas = {
  snapshot: hookSnapshotSchema,
  subscriptions: hookSubscriptionsSchema,
  deliveries: hookDeliveriesSchema,
  delivery: hookDeliverySchema,
  retry_plan: hookReceiptSchema,
  retry_apply: hookReceiptSchema,
  retry_get: hookReceiptSchema,
  configuration: hookConfigurationSchema,
  configuration_subscriptions: hookAuthoritySchema
    .extend({
      items: z.array(hookPolicySubscriptionSchema).max(HOOK_LIMITS.PAGE_SIZE),
      nextCursor: z.uuid().nullable(),
      observedAt: timestamp,
    })
    .strict(),
  configuration_subscription: hookPolicyDetailSchema,
  configuration_sinks: hookAuthoritySchema
    .extend({
      items: z.array(hookPolicyDestinationSchema).max(HOOK_LIMITS.PAGE_SIZE),
      nextCursor: z.uuid().nullable(),
      observedAt: timestamp,
    })
    .strict(),
  configuration_policy_plan: hookPolicyReceiptSchema,
  configuration_policy_apply: hookPolicyReceiptSchema,
  configuration_policy_get: hookPolicyReceiptSchema,
};
export type HookCommand = keyof typeof hookResultSchemas;
export type HookResult<K extends HookCommand> = z.infer<
  (typeof hookResultSchemas)[K]
>;
export type HookDelivery = z.infer<typeof hookDeliverySchema>;
export type HookSubscription = z.infer<typeof hookSubscriptionSchema>;
export type HookReceipt = z.infer<typeof hookReceiptSchema>;
export type HookSnapshot = z.infer<typeof hookSnapshotSchema>;
export type HookPolicy = z.infer<typeof hookPolicySchema>;
export type HookPolicyFilter = z.infer<typeof hookPolicyFilterSchema>;
export type HookPolicyReceipt = z.infer<typeof hookPolicyReceiptSchema>;
export type HookPolicySubscription = z.infer<
  typeof hookPolicySubscriptionSchema
>;
export type HookPolicyDestination = z.infer<typeof hookPolicyDestinationSchema>;
export type HookConfiguration = z.infer<typeof hookConfigurationSchema>;
export type HookConfigurationAvailability =
  | { status: "supported"; configuration: HookConfiguration }
  | { status: "unsupported"; configuration: null };
export type HookPolicyReview = {
  id: string;
  fingerprint: string;
  connectionId: string;
  connectionName: string;
  resourceId: string;
  actorMatches: boolean;
  createdAt: string;
  expiresAt: string;
  provider: HookPolicyReceipt | null;
  operation: HookReview["operation"];
};
export type HookConnectionFields = z.infer<typeof hookConnectionFields>;
export type HookConnection = HookConnectionFields & {
  id: string;
  revision: number;
  providerName: string | null;
  available: boolean;
};
export type HookAssociation = {
  subscription: string;
  projectId: string | null;
  revision: number;
};
export type HookReview = {
  id: string;
  fingerprint: string;
  connectionId: string;
  connectionName: string;
  actorMatches: boolean;
  eventId: string;
  sinkName: string;
  generation: number;
  updatedAt: string;
  createdAt: string;
  expiresAt: string;
  provider: HookReceipt | null;
  operation: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed" | "indeterminate";
    summary: string;
    updatedAt: string;
  } | null;
};
