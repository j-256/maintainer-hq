import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const HOOK_LIFECYCLE_KIND = "hookrelay.resource.lifecycle";
export const HOOK_LIFECYCLE_PRIVATE_BYTES = 16384;
const MAX_OBSERVED_EVENTS = 100;
export { HOOK_SETUP_EVENTS as HOOK_LIFECYCLE_EVENTS } from "./hook-setup";
import { HOOK_SETUP_EVENTS } from "./hook-setup";
const name = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const authority = z.string().regex(/^[a-f0-9]{32}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const sinkType = z.enum(["discord", "ntfy", "webhook"]);
const repository = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/).refine(value => ![".", ".."].includes(value.split("/")[1]!));
const events = z.array(z.enum(HOOK_SETUP_EVENTS)).min(1).max(HOOK_SETUP_EVENTS.length).refine(value => new Set(value).size === value.length);
const resource = { resourceId: z.uuid() };
export const lifecycleChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("destination-create"), name, type: sinkType }).strict(),
  z.object({ kind: z.literal("destination-update"), ...resource, replaceCredentials: z.boolean() }).strict(),
  z.object({ kind: z.literal("destination-retire"), ...resource }).strict(),
  z.object({ kind: z.literal("destination-restore"), ...resource }).strict(),
  z.object({ kind: z.literal("subscription-retire"), ...resource }).strict(),
  z.object({ kind: z.literal("subscription-restore"), ...resource }).strict(),
  z.object({ kind: z.literal("github-hook-adopt"), ...resource, repository, hookId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ kind: z.literal("github-hook-update"), ...resource, events, active: z.boolean() }).strict(),
  z.object({ kind: z.literal("github-hook-delete"), ...resource }).strict(),
]);
export const lifecycleConfigurationSchema = z.object({ authorityId: authority, revision: z.number().int().nonnegative(), mode: z.enum(["legacy", "active"]), canProvision: z.boolean(), canConfigure: z.boolean(), canSupplyPrivate: z.boolean(), canManageHooks: z.boolean(), reason: z.enum(["ready", "inactive", "grant_required", "custody_required"]), observedAt: z.iso.datetime() }).strict();
const summary = z.object({ resourceId: z.uuid(), name, type: z.string().min(1).max(40).optional(), retired: z.boolean().optional(), repository: repository.optional(), hookId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), events: z.array(z.string().min(1).max(80)).max(MAX_OBSERVED_EVENTS).optional(), active: z.boolean().optional(), signingVerified: z.boolean().optional() }).strict();
const outcomeStatus = z.enum(["unchanged", "pending", "applied", "failed", "indeterminate", "not_requested"]);
export const lifecycleReceiptSchema = z.object({
  id: z.uuid(), authorityId: authority, revision: z.number().int().nonnegative(), fingerprint,
  state: z.enum(["ready", "submitting", "applied", "failed", "indeterminate", "expired"]), change: lifecycleChangeSchema,
  before: summary.nullable(), after: summary.nullable(), affectedSubscriptions: z.array(z.object({ resourceId: z.uuid(), name }).strict()).max(1000),
  privateInputRequired: z.boolean(), privateInputReceived: z.boolean(), expiresAt: z.iso.datetime(), outcome: z.object({ configuration: outcomeStatus, upstream: outcomeStatus, errorCode: z.string().regex(/^[a-z0-9_]{1,80}$/).optional() }).strict().nullable(), observedAt: z.iso.datetime(),
}).strict();
export const lifecycleReviewSchema = lifecycleReceiptSchema.extend({
  workspaceId: idSchema, connectionId: idSchema, connectionName: name, actorMatches: z.boolean(), canSupplyPrivate: z.boolean(), createdAt: z.iso.datetime(),
  operation: z.object({ id: z.uuid(), status: z.enum(["pending", "running", "succeeded", "partial", "failed", "indeterminate"]), summary: z.string().max(1000), updatedAt: z.iso.datetime() }).strict().nullable(),
}).strict();
export const lifecycleConnectionInput = workspaceInput.extend({ connectionId: idSchema }).strict();
export const lifecyclePlanInput = lifecycleConnectionInput.extend({ connectionRevision: z.number().int().positive(), planId: z.uuid(), authorityId: authority, revision: z.number().int().nonnegative(), change: lifecycleChangeSchema }).strict();
export const lifecycleSelectionInput = workspaceInput.extend({ planId: z.uuid(), fingerprint }).strict();
export const lifecyclePrivateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("discord"), url: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal("ntfy"), server: z.string().min(1).max(4096).optional(), topic: z.string().min(1).max(4096), token: z.string().min(1).max(4096).optional() }).strict(),
  z.object({ type: z.literal("webhook"), url: z.string().min(1).max(4096), signingSecret: z.string().min(1).max(4096) }).strict(),
]);
export const lifecycleInputReceiptSchema = z.object({ planId: z.uuid(), state: lifecycleReceiptSchema.shape.state, privateInputReceived: z.boolean(), submitted: z.boolean() }).strict();
export const lifecycleResults = { lifecycle_configuration: lifecycleConfigurationSchema, lifecycle_plan: lifecycleReceiptSchema, lifecycle_get: lifecycleReceiptSchema, lifecycle_apply: lifecycleReceiptSchema };
export type LifecycleChange = z.infer<typeof lifecycleChangeSchema>;
export type LifecycleConfiguration = z.infer<typeof lifecycleConfigurationSchema>;
export type LifecycleReceipt = z.infer<typeof lifecycleReceiptSchema>;
export type LifecycleReview = z.infer<typeof lifecycleReviewSchema>;
