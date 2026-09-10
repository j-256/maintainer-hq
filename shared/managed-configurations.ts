import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";
import {
  SECRET_ENTRY_KIND,
  SECRET_LIMITS,
  SECRET_PROVIDER_KIND,
  secretDestinationKey,
  secretDestinationSchema,
  secretEntryKindSchema,
  secretInventoryItemSchema,
  secretMetadataSchema,
  type SecretDestination,
  type SecretEntryKind,
  type SecretInventoryItem,
  type SecretProviderKind,
  type SecretResource,
} from "./secrets";

export const MANAGED_CONFIGURATION_LIMITS = Object.freeze({
  CONFIGURATIONS: 100,
  DESTINATIONS: SECRET_LIMITS.DESTINATIONS,
  LABEL_LENGTH: 80,
  VALUE_BYTES: SECRET_LIMITS.INVENTORY_VALUE_BYTES,
  PENDING_REVIEWS: 20,
  HISTORY: 30,
});
export const MANAGED_CONFIGURATION_CUSTODY = Object.freeze({
  NONE: "none",
} as const);
export const MANAGED_CONFIGURATION_DESIRED_STATE = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
} as const);
export const MANAGED_CONFIGURATION_STATUS = Object.freeze({
  IN_SYNC: "in-sync",
  MISSING: "missing",
  DRIFTED: "drifted",
  UNEXPECTED: "unexpected",
  UNVERIFIABLE: "unverifiable",
  UNAVAILABLE: "unavailable",
} as const);
export const MANAGED_CONFIGURATION_ACTION = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  NONE: "none",
} as const);
export const MANAGED_CONFIGURATION_OPERATION_KIND =
  "secrets.managed-configuration.reconcile";

export const managedConfigurationDesiredStateSchema = z.enum([
  MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
  MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT,
]);
export const managedConfigurationStatusSchema = z.enum([
  MANAGED_CONFIGURATION_STATUS.IN_SYNC,
  MANAGED_CONFIGURATION_STATUS.MISSING,
  MANAGED_CONFIGURATION_STATUS.DRIFTED,
  MANAGED_CONFIGURATION_STATUS.UNEXPECTED,
  MANAGED_CONFIGURATION_STATUS.UNVERIFIABLE,
  MANAGED_CONFIGURATION_STATUS.UNAVAILABLE,
]);
export const managedConfigurationActionSchema = z.enum([
  MANAGED_CONFIGURATION_ACTION.CREATE,
  MANAGED_CONFIGURATION_ACTION.UPDATE,
  MANAGED_CONFIGURATION_ACTION.DELETE,
  MANAGED_CONFIGURATION_ACTION.NONE,
]);
const desiredValueSchema = z
  .string()
  .max(MANAGED_CONFIGURATION_LIMITS.VALUE_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      MANAGED_CONFIGURATION_LIMITS.VALUE_BYTES,
  );
export const managedConfigurationDestinationSchema = z
  .object({
    destination: secretDestinationSchema,
    desiredState: managedConfigurationDesiredStateSchema,
  })
  .strict();
const destinationsSchema = z
  .array(managedConfigurationDestinationSchema)
  .min(1)
  .max(MANAGED_CONFIGURATION_LIMITS.DESTINATIONS)
  .refine(
    (items) =>
      new Set(items.map((item) => secretDestinationKey(item.destination)))
        .size === items.length,
    "Choose distinct managed destinations",
  );
export const managedConfigurationFieldsSchema = z.discriminatedUnion(
  "entryKind",
  [
    z
      .object({
        label: z.string().trim().min(1).max(
          MANAGED_CONFIGURATION_LIMITS.LABEL_LENGTH,
        ),
        entryKind: z.literal(SECRET_ENTRY_KIND.SECRET),
        custody: z.literal(MANAGED_CONFIGURATION_CUSTODY.NONE),
        desiredValue: z.null(),
        destinations: destinationsSchema,
      })
      .strict(),
    z
      .object({
        label: z.string().trim().min(1).max(
          MANAGED_CONFIGURATION_LIMITS.LABEL_LENGTH,
        ),
        entryKind: z.literal(SECRET_ENTRY_KIND.VARIABLE),
        custody: z.literal(MANAGED_CONFIGURATION_CUSTODY.NONE),
        desiredValue: desiredValueSchema,
        destinations: destinationsSchema,
      })
      .strict(),
  ],
);
export const managedConfigurationListInput = workspaceInput.strict();
export const managedConfigurationInput = workspaceInput
  .extend({ configurationId: idSchema })
  .strict();
export const managedConfigurationSaveInput = managedConfigurationInput
  .extend({
    revision: z.number().int().nonnegative(),
    requestId: idSchema,
    configuration: managedConfigurationFieldsSchema,
  })
  .strict();
export const managedConfigurationStopInput = managedConfigurationInput
  .extend({
    revision: z.number().int().positive(),
    requestId: idSchema,
  })
  .strict();
export const managedConfigurationPlanInput = managedConfigurationInput
  .extend({
    configurationRevision: z.number().int().positive(),
    destinationIndex: z
      .number()
      .int()
      .min(0)
      .max(MANAGED_CONFIGURATION_LIMITS.DESTINATIONS - 1),
    planId: idSchema,
  })
  .strict();
export const managedConfigurationReviewInput = workspaceInput
  .extend({ planId: idSchema })
  .strict();
export const managedConfigurationHistoryInput = workspaceInput
  .extend({ repositoryId: idSchema.optional() })
  .strict();
export const managedConfigurationApplyInput = managedConfigurationReviewInput
  .extend({ fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();

export type ManagedConfigurationDestination = z.infer<
  typeof managedConfigurationDestinationSchema
>;
export type ManagedConfigurationFields = z.infer<
  typeof managedConfigurationFieldsSchema
>;
export const managedConfigurationSchema = managedConfigurationFieldsSchema.and(
  z
    .object({
      id: idSchema,
      revision: z.number().int().positive(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
);
export type ManagedConfiguration = z.infer<typeof managedConfigurationSchema>;
const managedObservedValueSchema = z
  .string()
  .max(MANAGED_CONFIGURATION_LIMITS.VALUE_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      MANAGED_CONFIGURATION_LIMITS.VALUE_BYTES,
  );
export const managedObservedItemSchema = secretMetadataSchema
  .extend({
    kind: secretEntryKindSchema,
    value: managedObservedValueSchema.nullable(),
    valueFormat: z.enum(["text", "json"]).nullable(),
  })
  .superRefine((item, context) => {
    if (
      item.kind === SECRET_ENTRY_KIND.SECRET &&
      (item.value !== null || item.valueFormat !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Secret observations cannot include stored values",
      });
    if (
      item.kind === SECRET_ENTRY_KIND.VARIABLE &&
      (item.value === null || item.valueFormat === null)
    )
      context.addIssue({
        code: "custom",
        message: "Variable observations require a readable value",
      });
  });
export type ManagedObservedItem = z.infer<typeof managedObservedItemSchema>;
export const managedProviderSnapshotSchema = z
  .object({
    name: z.string().min(1).max(255),
    entryKind: secretEntryKindSchema,
    scope: secretDestinationSchema.shape.target.shape.scope,
    resourceIdentity: z.string().min(1).max(255),
    scopeIdentity: z.string().min(1).max(255).nullable(),
    resourceRevision: z.string().min(1).max(255).nullable(),
    item: managedObservedItemSchema.nullable(),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type ManagedProviderSnapshot = z.infer<
  typeof managedProviderSnapshotSchema
>;
export type ManagedConfigurationObservation = {
  destinationIndex: number;
  status: z.infer<typeof managedConfigurationStatusSchema>;
  item: SecretInventoryItem | null;
  observedAt: string;
  error: { code: string; message: string } | null;
};
export type ManagedConfigurationStatus = {
  configuration: ManagedConfiguration;
  observations: ManagedConfigurationObservation[];
};
export type ManagedConfigurationReviewedTarget = {
  configurationId: string;
  configurationLabel: string;
  configurationRevision: number;
  entryKind: SecretEntryKind;
  custody: "none";
  desiredValue: string | null;
  desired: ManagedConfigurationDestination;
  providerKind: SecretProviderKind;
  connectionName: string;
  resource: SecretResource;
  before: ManagedProviderSnapshot;
  action: z.infer<typeof managedConfigurationActionSchema>;
  writable: boolean;
};
export const managedConfigurationReceiptSchema = z
  .object({
    writeStatus: z.enum([
      "not-sent",
      "accepted",
      "rejected",
      "indeterminate",
    ]),
    reason: z
      .enum([
        "credential_read_only",
        "rate_limited",
        "provider_rejected",
        "provider_result_uncertain",
        "preflight_changed",
        "authority_changed",
      ])
      .nullable(),
    observationStatus: managedConfigurationStatusSchema,
    item: secretInventoryItemSchema.nullable(),
    observedAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ManagedConfigurationReceipt = z.infer<
  typeof managedConfigurationReceiptSchema
>;
export type ManagedConfigurationOperation = {
  id: string;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "indeterminate";
  summary: string;
  createdAt: string;
  updatedAt: string;
  receipt: ManagedConfigurationReceipt;
};
export type ManagedConfigurationReview = ManagedConfigurationReviewedTarget & {
  id: string;
  fingerprint: string;
  actorMatches: boolean;
  createdAt: string;
  expiresAt: string;
  operation: ManagedConfigurationOperation | null;
};

export function managedDestinationKey(
  providerKind: SecretProviderKind,
  entryKind: SecretEntryKind,
  destination: SecretDestination,
) {
  const scope = destination.target.scope;
  const scopeName =
    scope.kind === "environment" || scope.kind === "organization"
      ? providerKind === SECRET_PROVIDER_KIND.GITHUB
        ? scope.name.toLowerCase()
        : scope.name
      : null;
  return JSON.stringify([
    providerKind,
    entryKind,
    destination.target.resourceId,
    scope.kind,
    scopeName,
    destination.name,
  ]);
}

export function managedConfigurationStatus(
  entryKind: SecretEntryKind,
  desiredState: ManagedConfigurationDestination["desiredState"],
  desiredValue: string | null,
  item: Pick<SecretInventoryItem, "value"> | null,
) {
  if (desiredState === MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT)
    return item
      ? MANAGED_CONFIGURATION_STATUS.UNEXPECTED
      : MANAGED_CONFIGURATION_STATUS.IN_SYNC;
  if (!item) return MANAGED_CONFIGURATION_STATUS.MISSING;
  if (entryKind === SECRET_ENTRY_KIND.SECRET)
    return MANAGED_CONFIGURATION_STATUS.UNVERIFIABLE;
  return item.value === desiredValue
    ? MANAGED_CONFIGURATION_STATUS.IN_SYNC
    : MANAGED_CONFIGURATION_STATUS.DRIFTED;
}

export function managedConfigurationAction(
  desiredState: ManagedConfigurationDestination["desiredState"],
  desiredValue: string | null,
  before: Pick<SecretInventoryItem, "value"> | null,
) {
  if (desiredState === MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT)
    return before
      ? MANAGED_CONFIGURATION_ACTION.DELETE
      : MANAGED_CONFIGURATION_ACTION.NONE;
  if (!before) return MANAGED_CONFIGURATION_ACTION.CREATE;
  return before.value === desiredValue
    ? MANAGED_CONFIGURATION_ACTION.NONE
    : MANAGED_CONFIGURATION_ACTION.UPDATE;
}
