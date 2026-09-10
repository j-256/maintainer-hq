import { z } from "zod";
import {
  idSchema,
  observationSchema,
  providerSchema,
  repositoryFields,
  projectSchema,
  ROLES,
  LIMITS,
  type Snapshot,
} from "./domain";
import { GITHUB_REFRESH_STATES } from "./github";
import { goalStatusSchema } from "./goals";
import { SOURCE_LIMITS } from "./sources";
import type { PushTopic } from "./workspace-push";

export const SYNC_LIMITS = Object.freeze({
  HISTORY: 4096,
  CHANGES: 128,
  FRAME_BYTES: 256 * 1024,
  PROJECTS: LIMITS.MAX_PROJECTS,
  GOALS: 1000,
  CONSISTENCY_ATTEMPTS: 3,
  ENVELOPE_BYTES: 2048,
});
export const SYNC_CAPACITY = Object.freeze({
  projects: SYNC_LIMITS.PROJECTS,
  repositories: LIMITS.MAX_REPOSITORIES,
  observations: LIMITS.MAX_OBSERVATIONS,
  connections: SOURCE_LIMITS.SOURCES,
  goals: SYNC_LIMITS.GOALS,
});
export const SYNC_VIEWS = [
  "workspace",
  "overview",
  "repositories",
  "activity",
  "dependencies",
  "hooks",
  "monitoring",
  "secrets",
  "settings",
  "settings-sources",
  "settings-import",
  "preferences",
  "projects",
  "projects-activity",
  "projects-hooks",
  "projects-monitoring",
  "projects-secrets",
  "projects-releases",
  "projects-dependencies",
  "repository",
  "repository-activity",
  "repository-hooks",
  "repository-monitoring",
  "repository-secrets",
  "repository-releases",
  "repository-work",
  "repository-dependencies",
] as const;
export type SyncView = (typeof SYNC_VIEWS)[number];
export const syncScopeSchema = z
  .object({
    view: z.enum(SYNC_VIEWS),
    repositoryId: idSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.view === "repository" || value.view.startsWith("repository-")) ===
      Boolean(value.repositoryId),
    "A repository view requires its exact repository ID",
  );
export const syncCursorSchema = z.number().int().nonnegative().safe();
export const workspaceViewInput = syncScopeSchema
  .safeExtend({ workspaceId: idSchema })
  .strict();
export const workspaceChangesInput = workspaceViewInput
  .safeExtend({
    cursor: syncCursorSchema,
    memberRevision: z.number().int().positive(),
  })
  .strict();
export type SyncScope = z.infer<typeof syncScopeSchema>;
export const SYNC_COLLECTIONS = [
  "projects",
  "repositories",
  "observations",
  "connections",
  "goals",
] as const;
export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];
export const VIEW_COLLECTIONS: Record<SyncView, readonly SyncCollection[]> = {
  workspace: [],
  overview: ["projects", "repositories", "observations", "connections"],
  repositories: ["projects", "repositories", "observations"],
  dependencies: ["projects"],
  activity: ["projects", "repositories", "goals"],
  hooks: ["projects", "repositories"],
  monitoring: ["projects", "repositories"],
  secrets: ["projects", "repositories"],
  settings: ["projects", "repositories", "observations", "connections"],
  "settings-sources": ["repositories", "observations", "connections"],
  "settings-import": [],
  preferences: [],
  projects: ["projects", "repositories", "observations"],
  "projects-activity": ["projects", "repositories", "goals"],
  "projects-hooks": ["projects", "repositories"],
  "projects-monitoring": ["projects", "repositories"],
  "projects-secrets": ["projects", "repositories"],
  "projects-releases": ["projects", "repositories", "connections"],
  "projects-dependencies": ["projects", "repositories"],
  repository: ["projects", "repositories", "observations", "connections"],
  "repository-activity": ["projects", "repositories", "observations", "goals"],
  "repository-hooks": ["projects", "repositories", "observations"],
  "repository-monitoring": ["projects", "repositories", "observations"],
  "repository-secrets": ["projects", "repositories", "observations"],
  "repository-releases": ["projects", "repositories", "connections"],
  "repository-work": ["projects", "repositories", "connections"],
  "repository-dependencies": ["projects", "repositories", "connections"],
};
export const VIEW_TOPICS: Record<SyncView, readonly PushTopic[]> = {
  workspace: ["access"],
  overview: [
    "workspace",
    "sources",
    "hooks",
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  repositories: ["workspace", "access"],
  dependencies: ["workspace", "sources", "associations", "operations", "access"],
  activity: ["workspace", "activity", "access"],
  hooks: ["workspace", "hooks", "associations", "operations", "access"],
  monitoring: [
    "workspace",
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  secrets: ["workspace", "associations", "operations", "access"],
  settings: ["workspace", "sources", "access"],
  "settings-sources": ["workspace", "sources", "access"],
  "settings-import": ["workspace", "access"],
  preferences: ["access"],
  projects: ["workspace", "access"],
  "projects-activity": ["workspace", "activity", "access"],
  "projects-hooks": ["workspace", "hooks", "associations", "access"],
  "projects-monitoring": ["workspace", "monitoring", "associations", "access"],
  "projects-secrets": ["workspace", "associations", "access"],
  "projects-releases": ["workspace", "sources", "associations", "access"],
  "projects-dependencies": ["workspace", "sources", "associations", "access"],
  repository: [
    "workspace",
    "sources",
    "hooks",
    "monitoring",
    "operations",
    "associations",
    "activity",
    "access",
  ],
  "repository-activity": ["workspace", "activity", "access"],
  "repository-hooks": [
    "workspace",
    "hooks",
    "associations",
    "operations",
    "access",
  ],
  "repository-monitoring": [
    "workspace",
    "monitoring",
    "associations",
    "operations",
    "access",
  ],
  "repository-secrets": ["workspace", "associations", "operations", "access"],
  "repository-releases": ["workspace", "sources", "associations", "access"],
  "repository-work": ["workspace", "sources", "associations", "access"],
  "repository-dependencies": ["workspace", "sources", "associations", "operations", "access"],
};

const repositorySchema = repositoryFields
  .extend({
    id: idSchema,
    workspaceId: idSchema,
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();
const connectionSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    provider: providerSchema,
    lastAttemptAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    lastError: z.string().nullable(),
    credentialConfigured: z.boolean(),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    freshnessMinutes: z.number(),
    repositoryIds: z.array(idSchema),
    github: z
      .object({
        credentialRef: idSchema.nullable(),
        configurationValid: z.boolean(),
        refreshIntervalMinutes: z.number(),
        nextRefreshAt: z.string().nullable(),
        retryAt: z.string().nullable(),
        activeRefreshId: idSchema.nullable(),
        lastRefreshId: idSchema.nullable(),
        lastRefreshStatus: z.enum(GITHUB_REFRESH_STATES).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const goalSchema = z
  .object({
    id: idSchema,
    sourceId: idSchema,
    objective: z.string().max(8000),
    status: goalStatusSchema,
    actor: z.string(),
    startedAt: z.string(),
    reportedAt: z.string(),
    receivedAt: z.string(),
  })
  .strict();
export const syncRecordsSchema = z
  .object({
    projects: z.array(projectSchema).optional(),
    repositories: z.array(repositorySchema).optional(),
    observations: z
      .array(
        observationSchema
          .extend({ receivedAt: z.string(), provider: providerSchema })
          .strict(),
      )
      .optional(),
    connections: z.array(connectionSchema).optional(),
    goals: z.array(goalSchema).optional(),
  })
  .strict();
export type SyncRecords = z.infer<typeof syncRecordsSchema>;
export const syncKeySchema = z
  .object({
    collection: z.enum(SYNC_COLLECTIONS),
    key: z.string().min(1).max(350),
  })
  .strict();
export const syncDeltaSchema = z
  .object({
    type: z.literal("delta"),
    from: syncCursorSchema,
    cursor: syncCursorSchema,
    generatedAt: z.string(),
    upserts: syncRecordsSchema,
    removals: z.array(syncKeySchema).max(SYNC_LIMITS.CHANGES),
  })
  .strict()
  .refine(
    (value) => value.cursor >= value.from,
    "Cursor cannot move backwards",
  );
export const syncResetSchema = z
  .object({
    type: z.literal("reset"),
    cursor: syncCursorSchema,
    reason: z.enum([
      "history_expired",
      "overflow",
      "concurrent_changes",
      "authority_changed",
    ]),
  })
  .strict();
export const syncUpdateSchema = z.union([syncDeltaSchema, syncResetSchema]);
export type SyncDelta = z.infer<typeof syncDeltaSchema>;
export type SyncUpdate = z.infer<typeof syncUpdateSchema>;
export const workspaceViewSchema = z
  .object({
    workspace: z
      .object({ id: idSchema, name: z.string(), role: z.enum(ROLES) })
      .strict(),
    capabilities: z.array(z.string()),
    principal: z
      .object({ subject: z.string(), displayName: z.string() })
      .strict(),
    development: z.boolean(),
    generatedAt: z.string(),
    cursor: syncCursorSchema,
    memberRevision: z.number().int().positive(),
    scope: syncScopeSchema,
    records: syncRecordsSchema,
  })
  .strict();
export type WorkspaceView = Omit<
  z.infer<typeof workspaceViewSchema>,
  "capabilities"
> &
  Pick<Snapshot, "capabilities">;

export function syncKey(
  collection: SyncCollection,
  record: SyncRecords[SyncCollection] extends (infer T)[] | undefined
    ? T
    : never,
): string {
  if (
    collection === "observations" &&
    "sourceId" in record &&
    "resourceType" in record
  )
    return JSON.stringify([
      record.sourceId,
      record.resourceType,
      record.resourceId,
    ]);
  return "id" in record ? record.id : "";
}
export function viewSnapshot(view: WorkspaceView): Snapshot {
  return {
    ...view,
    projects: [],
    repositories: [],
    observations: [],
    connections: [],
    goals: [],
    activity: [],
    ...view.records,
  };
}
export function sameScope(left: SyncScope, right: SyncScope) {
  return left.view === right.view && left.repositoryId === right.repositoryId;
}
export function viewQueryKey(
  workspaceId: string | undefined,
  scope: SyncScope,
) {
  return [
    "workspace",
    workspaceId,
    "view",
    scope.view,
    scope.repositoryId ?? null,
  ] as const;
}
