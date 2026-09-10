import { z } from "zod";
import {
  idSchema,
  repositoryFields,
  workspaceInput,
  type RepositoryFields,
} from "./domain";
import { contextReadSchema, type ContextRead } from "./github-context";

export const FLEET_DISCOVERY_LIMITS = Object.freeze({
  PAGE_SIZE: 25,
  SELECTIONS: 25,
  RESPONSE_BYTES: 256 * 1024,
  PROVIDER_BYTES: 64 * 1024,
  IDENTITY_BYTES: 32 * 1024,
  PENDING_PLANS: 10,
  CLEANUP_ROWS: 100,
  REQUESTS: 2,
  REQUEST_TIMEOUT_MS: 25000,
  CLIENT_TIMEOUT_MS: 35000,
});
export const FLEET_REVIEW_PARAM = "fleetReview";
export const FLEET_REQUEST_INTERRUPTED =
  "The enrollment request was interrupted. Recover the saved review or retry the same review ID. A submitted Apply may still finish; do not start a replacement operation until its outcome is known.";
export function fleetCommandTimeout(name: string) {
  return name === "fleet_discover" || name.startsWith("fleet_reconciliation_")
    ? FLEET_DISCOVERY_LIMITS.CLIENT_TIMEOUT_MS
    : undefined;
}
export const githubNodeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_=-]+$/);
export const githubOwnerName = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/);
const revision = z.number().int().positive().safe();
const opaqueCursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const cursorSource = z.object({ sourceId: idSchema, sourceRevision: revision });
export const fleetDiscoveryScope = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("owner"),
      owner: githubOwnerName,
      cursor: cursorSource
        .extend({ owner: githubOwnerName, after: opaqueCursor })
        .strict()
        .nullable()
        .default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("enrolled"),
      cursor: cursorSource
        .extend({ repositoryId: idSchema })
        .strict()
        .nullable()
        .default(null),
    })
    .strict(),
]);
export const fleetDiscoveryInput = workspaceInput
  .extend({
    sourceId: idSchema,
    sourceRevision: revision,
    scope: fleetDiscoveryScope,
  })
  .strict()
  .superRefine((input, context) => {
    const cursor = input.scope.cursor;
    if (
      cursor &&
      (cursor.sourceId !== input.sourceId ||
        cursor.sourceRevision !== input.sourceRevision ||
        (input.scope.kind === "owner" &&
          "owner" in cursor &&
          cursor.owner.toLowerCase() !== input.scope.owner.toLowerCase()))
    )
      context.addIssue({
        code: "custom",
        message: "Use a cursor from this source revision and discovery scope",
      });
  });
export const discoveredRepositorySchema = z
  .object({
    githubId: githubNodeId,
    fullName: repositoryFields.shape.fullName,
    description: repositoryFields.shape.description,
    archived: z.boolean(),
    private: z.boolean(),
  })
  .strict();
export type DiscoveredRepository = z.infer<typeof discoveredRepositorySchema>;
export const fleetLookupSchema = z
  .object({
    repositoryId: idSchema,
    fullName: repositoryFields.shape.fullName,
    githubId: githubNodeId.nullable(),
  })
  .strict();
export type FleetLookup = z.infer<typeof fleetLookupSchema>;
export const fleetProviderRecordSchema = z
  .object({
    repositoryId: idSchema.nullable(),
    lookupFullName: repositoryFields.shape.fullName.nullable(),
    lookupGithubId: githubNodeId.nullable(),
    read: contextReadSchema,
    repository: discoveredRepositorySchema.nullable(),
  })
  .strict();
export const fleetProviderResultSchema = z
  .object({
    observedAt: z.iso.datetime(),
    retryAt: z.iso.datetime().nullable(),
    requests: z.number().int().min(0).max(FLEET_DISCOVERY_LIMITS.REQUESTS),
    read: contextReadSchema,
    owner: githubOwnerName.nullable(),
    total: z.number().int().nonnegative().safe().nullable(),
    hasMore: z.boolean(),
    nextCursor: opaqueCursor.nullable(),
    records: z
      .array(fleetProviderRecordSchema)
      .max(FLEET_DISCOVERY_LIMITS.PAGE_SIZE),
  })
  .strict();
export type FleetProviderRecord = z.infer<typeof fleetProviderRecordSchema>;
export type FleetProviderResult = z.infer<typeof fleetProviderResultSchema>;
export type FleetDiscoveryInput = z.infer<typeof fleetDiscoveryInput>;
export type FleetDiscoveryScope = z.infer<typeof fleetDiscoveryScope>;
export type FleetDiscoverySource = {
  id: string;
  name: string;
  revision: number;
  enabled: boolean;
  configured: boolean;
};
export type FleetRepository = {
  id: string;
  fullName: string;
  projectId: string;
  revision: number;
  classification: RepositoryFields["classification"];
  lifecycle: RepositoryFields["lifecycle"];
  collected: boolean;
};
export type FleetCandidate = {
  key: string;
  provider: DiscoveredRepository | null;
  repository: FleetRepository | null;
  lookupFullName: string | null;
  read: ContextRead;
  state: "new" | "changed" | "unchanged" | "conflict" | "unavailable";
  reason:
    | "new"
    | "metadata_changed"
    | "unchanged"
    | "identity_conflict"
    | "name_conflict"
    | "ambiguous_identity"
    | "provider_unavailable";
  identity: "recorded" | "name_lookup" | "catalog";
};
export type FleetDiscoveryResult = {
  workspaceId: string;
  source: { id: string; name: string; revision: number };
  scope: FleetDiscoveryScope;
  state: "ready" | "collecting" | "waiting" | "disabled" | "not_configured";
  nextReadAt: string | null;
  evidence: Omit<FleetProviderResult, "records"> | null;
  candidates: FleetCandidate[];
  nextScope: FleetDiscoveryScope | null;
};
const selectionSchema = z
  .object({
    githubId: githubNodeId,
    fullName: repositoryFields.shape.fullName,
    lifecycle: repositoryFields.shape.lifecycle,
    repositoryId: idSchema.nullable(),
    revision: revision.nullable(),
    classification: repositoryFields.shape.classification.nullable(),
    projectId: idSchema.nullable(),
    projectRevision: revision.nullable(),
    collect: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.repositoryId === null
        ? value.revision === null &&
          value.classification !== null &&
          value.projectId !== null &&
          value.projectRevision !== null
        : value.revision !== null &&
          value.classification === null &&
          value.projectId === null &&
          value.projectRevision === null,
    "Choose tracking and a project for new repositories; preserve existing settings and provide the repository revision",
  );
export const fleetReconciliationPlanInput = workspaceInput
  .extend({
    sourceId: idSchema,
    sourceRevision: revision,
    reviewId: z.uuid(),
    selections: z
      .array(selectionSchema)
      .min(1)
      .max(FLEET_DISCOVERY_LIMITS.SELECTIONS),
  })
  .strict()
  .superRefine((input, context) => {
    const old = input.selections.filter((row) => row.repositoryId !== null);
    if (
      new Set(input.selections.map((row) => row.githubId)).size !==
        input.selections.length ||
      new Set(input.selections.map((row) => row.fullName.toLowerCase()))
        .size !== input.selections.length ||
      new Set(old.map((row) => row.repositoryId)).size !== old.length
    )
      context.addIssue({
        code: "custom",
        message: "Select each GitHub identity and HQ repository only once",
      });
  });
export const fleetReconciliationReviewInput = workspaceInput
  .extend({ planId: z.uuid() })
  .strict();
export const fleetReconciliationApplyInput = fleetReconciliationReviewInput
  .extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FleetReconciliationInput = z.infer<
  typeof fleetReconciliationPlanInput
>;
export type FleetSelection = FleetReconciliationInput["selections"][number];
export type FleetReconciliationChange = {
  repositoryId: string;
  githubId: string;
  before: (RepositoryFields & { revision: number }) | null;
  after: RepositoryFields;
  collectedBefore: boolean;
  collectedAfter: boolean;
};
export type FleetReconciliationReceipt = {
  workspaceId: string;
  planId: string;
  fingerprint: string;
  appliedAt: string;
  sourceId: string;
  sourceRevision: number;
  createdRepositoryIds: string[];
  updatedRepositoryIds: string[];
  addedToSource: string[];
  removedFromSource: string[];
};
export type FleetReconciliationReview = {
  workspaceId: string;
  workspaceName: string;
  planId: string;
  fingerprint: string;
  actor: string;
  expiresAt: string;
  observedAt: string;
  source: {
    id: string;
    name: string;
    revision: number;
    beforeCount: number;
    afterCount: number;
  };
  fields: FleetReconciliationInput;
  changes: FleetReconciliationChange[];
  state: "ready" | "stale" | "expired" | "applied";
  receipt: FleetReconciliationReceipt | null;
};
