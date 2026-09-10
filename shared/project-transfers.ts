import { z } from "zod";
import {
  getProjectInput,
  idSchema,
  workspaceInput,
  type Project,
  type Role,
  type Workspace,
} from "./domain";

export const TRANSFER_LIMITS = Object.freeze({
  REPOSITORIES: 100,
  SOURCE_BINDINGS: 20,
  SOURCE_LINKS: 2000,
  RESOURCES: 100,
  DESTINATIONS: 50,
  ACCESS_ENTRIES: 200,
  CREDENTIALS: 200,
  PENDING_REVIEWS: 20,
  RETAINED_REVIEWS: 500,
  SNAPSHOT_BYTES: 256 * 1024,
  REVIEW_TTL_MS: 5 * 60 * 1000,
  REVIEW_RETENTION_MS: 24 * 60 * 60 * 1000,
});
export const TRANSFER_VERSION = 1;
const sourceBinding = z
  .object({ sourceId: idSchema, destinationSourceId: idSchema })
  .strict();
const fields = getProjectInput
  .extend({
    destinationWorkspaceId: idSchema,
    projectRevision: z.number().int().positive(),
    sourceBindings: z
      .array(sourceBinding)
      .max(TRANSFER_LIMITS.SOURCE_BINDINGS)
      .default([]),
  })
  .strict();
const distinct = (input: z.infer<typeof fields>) =>
  input.workspaceId !== input.destinationWorkspaceId &&
  new Set(input.sourceBindings.map((item) => item.sourceId)).size ===
    input.sourceBindings.length;
export const projectTransferPreviewInput = fields.refine(
  distinct,
  "Choose another workspace and map each source only once",
);
export const projectTransferPlanInput = fields
  .extend({ reviewId: z.uuid() })
  .strict()
  .refine(distinct, "Choose another workspace and map each source only once");
export const projectTransferReviewInput = workspaceInput
  .extend({ reviewId: z.uuid() })
  .strict();
export const projectTransferApplyInput = projectTransferReviewInput
  .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const departedResourceInput = workspaceInput
  .extend({ kind: z.enum(["project", "repository"]), resourceId: idSchema })
  .strict();

export type TransferFields = z.infer<typeof projectTransferPreviewInput>;
export type TransferDestinations = {
  workspaces: Workspace[];
  restriction: "workspace-credential" | null;
};
export type TransferRepository = {
  id: string;
  fullName: string;
  revision: number;
};
export type TransferSource = {
  id: string;
  name: string;
  provider: string;
  revision: number;
  enabled: boolean;
  repositoryIds: string[];
  remainingRepositoryCount: number;
  destinationSourceId: string | null;
  willDisable: boolean;
};
export type TransferDestinationSource = {
  id: string;
  name: string;
  provider: "github" | "local";
  revision: number;
  enabled: boolean;
  repositoryCount: number;
};
export type TransferAccessChange = {
  subject: string;
  displayName: string;
  sourceRole: Role | null;
  destinationRole: Role | null;
  effect: "gain" | "lose" | "change" | "retain";
};
export type TransferInvitation = {
  workspaceId: string;
  email: string;
  role: Role;
  expiresAt: string;
};
export type TransferCredentialAccess = {
  workspaceId: string;
  name: string;
  owner: string;
  profile: string | null;
  sourceId: string | null;
  scopes: string[];
  expiresAt: string;
};
export type TransferResource = {
  kind: "hook" | "monitor" | "secret";
  connectionId: string;
  connectionName: string;
  resourceKey: string;
  direct: boolean;
  sharedRepositoryCount: number;
};
export type TransferIssue = { code: string; title: string; message: string };
export type TransferPreview = {
  version: typeof TRANSFER_VERSION;
  source: Workspace;
  destination: Workspace;
  revisions: { source: number; destination: number };
  project: Project;
  repositories: TransferRepository[];
  sources: TransferSource[];
  destinationSources: TransferDestinationSource[];
  clearConnectionContext: {
    id: string;
    name: string;
    provider: string;
    revision: number;
  }[];
  resources: TransferResource[];
  access: TransferAccessChange[];
  invitations: TransferInvitation[];
  credentials: TransferCredentialAccess[];
  blockers: TransferIssue[];
  ready: boolean;
  historyPolicy: "original-workspace-only";
  evidencePolicy: "fresh-destination-collection";
};
export type TransferReceipt = {
  reviewId: string;
  projectId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  projectRevision: number;
  repositoryIds: string[];
  completedAt: string;
  status: "succeeded";
};
export type TransferReview = {
  reviewId: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  actor: string;
  fields: TransferFields;
  preview: TransferPreview;
  state: "reviewed" | "expired" | "stale" | "applied";
  receipt: TransferReceipt | null;
};
export type DepartedResourceContext = {
  kind: "project" | "repository";
  resourceId: string;
  name: string;
  projectId: string;
  movedAt: string;
  historyPolicy: "original-workspace-only";
};
