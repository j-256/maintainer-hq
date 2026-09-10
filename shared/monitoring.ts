import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const MONITOR_LIMITS = Object.freeze({
  CONNECTIONS: 20,
  PROVIDERS: 20,
  PAGE_SIZE: 50,
  TARGETS: 1000,
  PENDING_REVIEWS: 25,
  RESPONSE_BYTES: 2 * 1024 * 1024,
  PROVIDER_TIMEOUT_MS: 15000,
  CATALOG_BYTES: 64 * 1024,
  HISTORY: 50,
  REFRESH_MS: 60000,
  URL_BYTES: 8192,
  NOTE_BYTES: 1024,
  JSON_BYTES: 4096,
  JSON_DEPTH: 8,
});
export const MONITOR_OPERATION_KIND = "endpoint-monitor.operation";
export const MONITOR_ACTIONS = [
  "acknowledged",
  "snoozed",
  "dismissed",
] as const;
export const MONITOR_CAPABILITIES = ["read", "configure", "triage"] as const;
export const MONITOR_DEFAULTS = Object.freeze({
  failureThreshold: 2,
  method: "GET" as const,
  probeIntervalMinutes: 5,
  recoveryThreshold: 2,
  timeoutMilliseconds: 10000,
});
export const monitorIdentity = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/);
export const monitorTargetId = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.iso.datetime();
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cursor = z.string().max(1024).nullable();
const boundedText = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => new TextEncoder().encode(value).byteLength <= limit);
const monitorNote = boundedText(MONITOR_LIMITS.NOTE_BYTES)
  .trim()
  .min(1, "Leave the note empty or enter a nonblank note")
  .regex(/^[^\p{Cc}]*$/u, "Use a single-paragraph note without control characters");
const privateSuffixes = [
  "example",
  "home.arpa",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test",
];
export const monitorUrl = boundedText(MONITOR_LIMITS.URL_BYTES).refine(
  (value) => {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      return (
        value === value.trim() &&
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        hostname.includes(".") &&
        !hostname.startsWith("[") &&
        !/^\d+(?:\.\d+){3}$/.test(hostname) &&
        !privateSuffixes.some(
          (suffix) => hostname === suffix || hostname.endsWith("." + suffix),
        )
      );
    } catch {
      return false;
    }
  },
  "Use a public HTTP or HTTPS URL without credentials or a fragment",
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export function boundedJson(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MONITOR_LIMITS.JSON_DEPTH)
    return false;
  return Object.values(value).every((child) => boundedJson(child, depth + 1));
}
const jsonSubset = z
  .record(z.string(), z.json())
  .refine(
    (value) =>
      Object.keys(value).length > 0 &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MONITOR_LIMITS.JSON_BYTES &&
      boundedJson(value),
    "JSON expectations must be a nonempty object within the size and depth limits",
  );
export const monitorExpectationSchema = z
  .object({
    bodyIncludes: boundedText(1024)
      .refine((value) => value.trim().length > 0)
      .optional(),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .max(256)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
      .optional(),
    jsonSubset: jsonSubset.optional(),
    location: z
      .object({ ignoreQuery: z.boolean(), url: monitorUrl })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Add an assertion or turn off response checks",
  );
export const monitorTargetSchema = z
  .object({
    expect: monitorExpectationSchema.optional(),
    expectedStatuses: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .max(500)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    failureThreshold: z.number().int().min(1).max(10),
    id: monitorTargetId,
    method: z.enum(["GET", "HEAD"]),
    recoveryThreshold: z.number().int().min(1).max(10),
    timeoutMilliseconds: z.number().int().min(100).max(30000),
    url: monitorUrl,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.method === "HEAD" &&
      (value.expect?.bodyIncludes !== undefined ||
        value.expect?.jsonSubset !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["method"],
        message: "Body assertions require GET",
      });
    if (
      value.expect?.location &&
      (!value.expectedStatuses ||
        value.expectedStatuses.some((status) => status < 300 || status > 399))
    )
      context.addIssue({
        code: "custom",
        path: ["expectedStatuses"],
        message: "Location checks require explicit 3xx statuses",
      });
  });
export const monitorDefaultsSchema = z
  .object({
    failureThreshold: z.number().int().min(1).max(10),
    method: z.enum(["GET", "HEAD"]),
    probeIntervalMinutes: z.number().int().min(1).max(60),
    recoveryThreshold: z.number().int().min(1).max(10),
    timeoutMilliseconds: z.number().int().min(100).max(30000),
  })
  .strict();
export const monitorConfigurationSchema = z
  .object({
    defaults: monitorDefaultsSchema,
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    targets: z.array(monitorTargetSchema).max(MONITOR_LIMITS.TARGETS),
  })
  .strict();
export const monitorMetadataSchema = z
  .object({
    configFingerprint: fingerprint,
    revision: revision.refine((value) => value > 0),
    targetCount: z.number().int().min(0).max(MONITOR_LIMITS.TARGETS),
    updatedAt: timestamp,
    updatedBy: monitorIdentity,
    updatedWorkspace: monitorIdentity,
  })
  .strict();
export const monitorConnectionInput = workspaceInput
  .extend({ connectionId: idSchema })
  .strict();
export const monitorConnectionFields = z
  .object({
    name: z.string().trim().min(1).max(80),
    providerRef: idSchema,
    enabled: z.boolean(),
    projectId: idSchema.nullable(),
  })
  .strict();
export const monitorConnectionSaveInput = monitorConnectionInput
  .extend({ revision, connection: monitorConnectionFields })
  .strict();
export const monitorTargetsInput = monitorConnectionInput
  .extend({ cursor: cursor.default(null) })
  .strict();
export const monitorTargetInput = monitorConnectionInput
  .extend({ targetId: monitorTargetId })
  .strict();
export const monitorIncidentsInput = monitorTargetsInput
  .extend({
    status: z.enum(["open", "resolved", "all"]).default("open"),
    targetId: monitorTargetId.nullable().default(null),
  })
  .strict();
export const monitorIncidentInput = monitorTargetsInput
  .extend({ incidentId: monitorIdentity })
  .strict();
export const monitorChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("target"),
      action: z.enum(["create", "update", "remove"]),
      targetId: monitorTargetId,
      target: monitorTargetSchema.nullable(),
    })
    .strict()
    .refine(
      (value) =>
        value.action === "remove"
          ? value.target === null
          : value.target?.id === value.targetId,
      "Provide the exact target, or no target for removal",
    ),
  z
    .object({ kind: z.literal("defaults"), defaults: monitorDefaultsSchema })
    .strict(),
]);
const reviewFields = monitorConnectionInput.extend({
  reviewId: z.uuid(),
  connectionRevision: revision.refine((value) => value > 0),
});
export const monitorConfigurationPlanInput = reviewFields
  .extend({ configurationRevision: revision, change: monitorChangeSchema })
  .strict();
export const monitorTriagePlanInput = reviewFields
  .extend({
    incidentId: monitorIdentity,
    incidentRevision: revision.refine((value) => value > 0),
    action: z.enum(MONITOR_ACTIONS),
    note: monitorNote.nullable().default(null),
    until: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.action === "snoozed" ? value.until !== null : value.until === null,
    "Only snooze accepts a future end time",
  );
export const monitorReviewInput = workspaceInput
  .extend({ planId: z.uuid() })
  .strict();
export const monitorApplyInput = monitorReviewInput
  .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export const monitorCheckSchema = z
  .object({
    state: z.enum([
      "unobserved",
      "configuration_changed",
      "stale",
      "passed",
      "failed",
    ]),
    observedAt: timestamp.nullable(),
    lastSuccessAt: timestamp.nullable(),
    freshUntil: timestamp.nullable(),
    scheduledAt: timestamp.nullable(),
    configurationRevision: revision.nullable(),
    configurationMatches: z.boolean().nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .nullable(),
  })
  .strict();
export const monitorExecutionSchema = z
  .object({
    state: z.enum(["unobserved", "fresh", "stale"]),
    freshUntil: timestamp.nullable(),
    expectedIntervalSeconds: z.literal(60),
    retainedRunLimit: z.literal(120),
    lastRun: z
      .object({
        scheduledAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        enabled: z.boolean(),
        configurationRevision: revision.nullable(),
        configFingerprint: fingerprint.nullable(),
        probeIntervalMinutes: z.number().int().min(1).max(60).nullable(),
        targetCount: z.number().int().min(0).max(MONITOR_LIMITS.TARGETS),
        dueTargets: z.number().int().min(0).max(10),
        succeededProbes: z.number().int().min(0).max(10),
        failedProbes: z.number().int().min(0).max(10),
        phaseErrors: z.number().int().min(0).max(1000),
        deliveriesFailed: z.number().int().min(0).max(10),
        subrequests: z.number().int().min(0).max(45),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const monitorEvidenceSchema = z
  .object({
    state: z.enum([
      "unobserved",
      "exceptional",
      "incident",
      "configuration_changed",
    ]),
    observedAt: timestamp.nullable(),
    incidentId: monitorIdentity.nullable(),
    configurationMatches: z.boolean().nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    errorCode: z
      .string()
      .max(80)
      .regex(/^[a-z0-9_-]+$/)
      .nullable(),
    check: monitorCheckSchema,
  })
  .strict();
export const monitorObservedTargetSchema = monitorTargetSchema.safeExtend({
  evidence: monitorEvidenceSchema,
});
export const monitorIncidentSchema = z
  .object({
    acknowledgedAt: timestamp.nullable(),
    configFingerprint: fingerprint,
    errorCode: z
      .string()
      .max(80)
      .regex(/^[a-z0-9_-]+$/)
      .nullable(),
    failureKind: z.enum(["http", "network"]),
    failureThreshold: z.number().int().min(1).max(10),
    firstObservedAt: timestamp,
    firstStatus: z.number().int().min(100).max(599).nullable(),
    id: monitorIdentity,
    lastFailureAt: timestamp,
    latestSignal: z.enum(["probe", "cloudflare-analytics"]),
    latestStatus: z.number().int().min(100).max(599).nullable(),
    openedAt: timestamp,
    recoveryThreshold: z.number().int().min(1).max(10),
    requestCount: z.number().int().nonnegative().nullable(),
    resolutionReason: z
      .enum([
        "configuration-changed",
        "configuration-removed",
        "operator-dismissed",
        "recovered",
      ])
      .nullable(),
    resolvedAt: timestamp.nullable(),
    snoozedUntil: timestamp.nullable(),
    status: z.enum(["open", "resolved"]),
    targetId: monitorTargetId,
    targetUrl: monitorUrl,
    revision: revision.refine((value) => value > 0),
  })
  .strict();
const boundedCount = z
  .object({
    count: z.number().int().min(0).max(MONITOR_LIMITS.PAGE_SIZE),
    truncated: z.boolean(),
  })
  .strict();
const targetsSchema = z
  .object({
    readAt: timestamp,
    configuration: monitorMetadataSchema.nullable(),
    items: z.array(monitorObservedTargetSchema).max(MONITOR_LIMITS.PAGE_SIZE),
    nextCursor: cursor,
  })
  .strict();
const configurationPreview = z
  .object({
    addedIds: z.array(monitorTargetId).max(MONITOR_LIMITS.TARGETS),
    changedIds: z.array(monitorTargetId).max(MONITOR_LIMITS.TARGETS),
    removedIds: z.array(monitorTargetId).max(MONITOR_LIMITS.TARGETS),
    defaultsChanged: z.boolean(),
    expectedFingerprint: fingerprint,
    expectedRevision: revision,
    remoteFingerprint: fingerprint.nullable(),
    remoteTargetCount: z.number().int().min(0).max(MONITOR_LIMITS.TARGETS),
    targetCount: z.number().int().min(0).max(MONITOR_LIMITS.TARGETS),
    unchanged: z.boolean(),
    resultingRevision: revision.refine((value) => value > 0),
  })
  .strict();
const triagePreview = z
  .object({
    action: z.enum(MONITOR_ACTIONS),
    note: boundedText(MONITOR_LIMITS.NOTE_BYTES).nullable(),
    until: timestamp.nullable(),
    incidentId: monitorIdentity,
    targetId: monitorTargetId,
    incidentRevision: revision.refine((value) => value > 0),
    configurationRevision: revision,
    effect: z.string().max(300),
  })
  .strict();
const receiptCommon = z.object({
  id: z.uuid(),
  workspaceId: monitorIdentity,
  actorId: monitorIdentity,
  credentialId: monitorIdentity,
  credentialRevision: revision.refine((value) => value > 0),
  createdAt: timestamp,
  expiresAt: timestamp,
  appliedAt: timestamp.nullable(),
  retainUntil: timestamp,
  status: z.enum(["reviewed", "expired", "applied"]),
});
export const monitorReceiptSchema = z
  .discriminatedUnion("kind", [
    receiptCommon
      .extend({
        kind: z.literal("configuration"),
        preview: configurationPreview,
        result: monitorMetadataSchema
          .extend({
            changed: z.boolean(),
            rowsWritten: z.number().int().nonnegative().optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    receiptCommon
      .extend({
        kind: z.literal("triage"),
        preview: triagePreview,
        result: z
          .object({
            actionId: z.uuid(),
            incidentId: monitorIdentity,
            action: z.enum(MONITOR_ACTIONS),
            createdAt: timestamp,
          })
          .strict()
          .nullable(),
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.status === "applied"
        ? value.appliedAt !== null && value.result !== null
        : value.appliedAt === null && value.result === null,
    "Inconsistent operation receipt",
  );
export const monitorResultSchemas = {
  snapshot: z
    .object({
      readAt: timestamp,
      configuration: monitorMetadataSchema.nullable(),
      runtimeConfigured: z.boolean(),
      enabled: z.boolean().nullable(),
      deliveryEnabled: z.boolean().nullable(),
      analyticsEnabled: z.boolean().nullable(),
      openIncidents: boundedCount,
      pendingDeliveries: boundedCount,
      execution: monitorExecutionSchema,
    })
    .strict(),
  configuration: z
    .object({
      readAt: timestamp,
      configuration: monitorMetadataSchema
        .extend({ configuration: monitorConfigurationSchema })
        .strict()
        .nullable(),
    })
    .strict(),
  targets: targetsSchema,
  target: targetsSchema,
  incidents: z
    .object({
      readAt: timestamp,
      items: z.array(monitorIncidentSchema).max(MONITOR_LIMITS.PAGE_SIZE),
      nextCursor: cursor,
    })
    .strict(),
  incident: z
    .object({
      readAt: timestamp,
      incident: monitorIncidentSchema,
      actions: z
        .array(
          z
            .object({
              id: monitorIdentity,
              action: z.enum(MONITOR_ACTIONS),
              note: boundedText(MONITOR_LIMITS.NOTE_BYTES).nullable(),
              snoozedUntil: timestamp.nullable(),
              createdAt: timestamp,
            })
            .strict(),
        )
        .max(MONITOR_LIMITS.PAGE_SIZE),
      nextCursor: cursor,
    })
    .strict(),
  configuration_plan: monitorReceiptSchema,
  triage_plan: monitorReceiptSchema,
  operation_apply: monitorReceiptSchema,
  operation_get: monitorReceiptSchema,
};
export type MonitorCommand = keyof typeof monitorResultSchemas;
export type MonitorResult<K extends MonitorCommand> = z.infer<
  (typeof monitorResultSchemas)[K]
>;
export type MonitorTarget = z.infer<typeof monitorTargetSchema>;
export type MonitorObservedTarget = z.infer<typeof monitorObservedTargetSchema>;
export type MonitorDefaults = z.infer<typeof monitorDefaultsSchema>;
export type MonitorConfiguration = z.infer<typeof monitorConfigurationSchema>;
export type MonitorIncident = z.infer<typeof monitorIncidentSchema>;
export type MonitorReceipt = z.infer<typeof monitorReceiptSchema>;
export type MonitorChange = z.infer<typeof monitorChangeSchema>;
export type MonitorConnectionFields = z.infer<typeof monitorConnectionFields>;
export type MonitorConnection = MonitorConnectionFields & {
  id: string;
  revision: number;
  providerName: string | null;
  available: boolean;
};
export type MonitorReview = {
  id: string;
  fingerprint: string;
  connectionId: string;
  connectionName: string;
  actorMatches: boolean;
  createdAt: string;
  expiresAt: string;
  change: MonitorChange | null;
  before: MonitorTarget | MonitorDefaults | null;
  provider: Pick<
    MonitorReceipt,
    "id" | "kind" | "status" | "preview" | "result" | "expiresAt" | "appliedAt"
  > | null;
  operation: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed" | "indeterminate";
    summary: string;
    updatedAt: string;
  } | null;
};
