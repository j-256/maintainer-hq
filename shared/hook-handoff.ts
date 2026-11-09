import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";

export const HOOK_HANDOFF_KIND = "hookrelay.github.handoff";
export const HANDOFF_PROFILES = ["activity", "stars", "alerts"] as const;
export const HANDOFF_PRIVATE_BYTES = 128 * 1024;
const profile = z.enum(HANDOFF_PROFILES);
const timestamp = z.iso.datetime();
const name = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const sinks = z.array(name).min(1).max(25).refine(values => new Set(values).size === values.length);
const repositoryName = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
export function normalizeHandoffRepository(value: string): string {
  let repository = value.trim();
  if (/^https?:/i.test(repository)) {
    const match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/?$/i.exec(repository);
    if (!match) throw new Error("Use an exact HTTPS github.com repository URL");
    repository = match[1]!;
  }
  if (!repositoryName.safeParse(repository).success || [".", ".."].includes(repository.split("/")[1]!)) throw new Error("Use an exact owner/repository");
  return repository;
}
export const handoffRepository = z.string().trim().max(512).refine(value => {
  try { normalizeHandoffRepository(value); return true; } catch { return false; }
}, "Use an exact owner/repository or HTTPS github.com repository URL");
export const handoffConnectionInput = workspaceInput.extend({ connectionId: idSchema }).strict();
export const handoffRepositoryInput = handoffConnectionInput.extend({ repository: handoffRepository }).strict();
export const handoffPlanInput = handoffRepositoryInput.extend({
  reviewId: z.uuid(), connectionRevision: z.number().int().positive(), projectId: idSchema, projectRevision: z.number().int().positive(),
  savedRepositoryId: idSchema.optional(), savedRepositoryRevision: z.number().int().positive().optional(),
  authorityId: z.string().regex(/^[a-f0-9]{32}$/), revision: z.number().int().nonnegative(), profile, sinks,
}).strict().refine(value => Boolean(value.savedRepositoryId) === Boolean(value.savedRepositoryRevision));
export const handoffStatusInput = handoffConnectionInput.extend({ resourceId: z.uuid() }).strict();
export const handoffExportInput = handoffConnectionInput.extend({ repositoryId: z.uuid() }).strict();
export const handoffRecordSchema = z.object({
  hmac: z.object({ name: z.string().regex(/^HMAC_GITHUB_[A-Z0-9_]+$/), value: z.string().min(1).max(4096) }).strict(),
  slugs: z.object({ activity: z.string().min(20).max(256), stars: z.string().min(20).max(256), alerts: z.string().min(20).max(256) }).strict(),
  profiles: z.array(profile).min(1).max(3).refine(values => new Set(values).size === values.length).optional(), state: z.literal("active"),
}).strict();
export const handoffAdoptionInput = handoffPlanInput.safeExtend({ record: handoffRecordSchema }).strict();
export const handoffReceiptSchema = z.object({
  planId: z.uuid(), repositoryId: z.uuid(), resourceId: z.uuid(), repository: repositoryName, name, profile,
  profiles: z.array(profile).min(1).max(3), sinks, action: z.enum(["create", "adopt"]), status: z.enum(["ready", "configured", "expired", "conflict"]),
  routingConfigured: z.boolean(), createdAt: timestamp, expiresAt: timestamp, updatedAt: timestamp,
}).strict();
export const handoffConfigurationSchema = z.object({ authorityId: z.string().regex(/^[a-f0-9]{32}$/), revision: z.number().int().nonnegative(), mode: z.enum(["legacy", "active"]),
  canCreate: z.boolean(), canReveal: z.boolean(), reason: z.enum(["ready", "inactive", "grant_required", "provider_setup_required"]), observedAt: timestamp }).strict();
export const handoffRepositorySchema = z.object({ repository: repositoryName, repositoryId: z.uuid().nullable(),
  resources: z.array(z.object({ resourceId: z.uuid(), profile, authMode: z.enum(["environment", "bundle"]) }).strict()).max(3), adoptionRequired: z.boolean(), observedAt: timestamp }).strict();
export const handoffStatusSchema = z.object({ resourceId: z.uuid(), repository: repositoryName, profile, routingConfigured: z.boolean(), credentialAvailable: z.boolean(),
  pingAt: timestamp.nullable(), deliveredAt: timestamp.nullable(), sample: z.object({ events: z.number().int().nonnegative(), limit: z.number().int().positive().max(1000), truncated: z.boolean() }).strict(), observedAt: timestamp }).strict();
export const handoffRevealSchema = z.object({ resourceId: z.uuid(), repository: repositoryName, profile, url: z.url().max(2048), secret: z.string().min(1).max(4096),
  events: z.array(z.string().max(80)).min(1).max(30), contentType: z.literal("application/json"), sslVerification: z.literal(true), settingsUrl: z.url().max(2048) }).strict().refine(value => {
    const url = new URL(value.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && /^\/hook\/github\/[A-Za-z0-9_-]+$/.test(url.pathname) && value.settingsUrl === `https://github.com/${value.repository}/settings/hooks/new`;
  });
export const handoffExportSchema = z.object({ version: z.literal(1), repository: repositoryName, origin: z.url().max(2048),
  record: handoffRecordSchema.extend({ provider: z.object({ kind: z.literal("hookrelay-handoff-v1"), authorityId: z.string().regex(/^[a-f0-9]{32}$/), workspaceId: idSchema,
    repositoryId: z.uuid(), bundleRevision: z.literal(1), resources: z.object({ activity: z.object({ resourceId: z.uuid(), authMode: z.enum(["environment", "bundle"]) }).strict().optional(), stars: z.object({ resourceId: z.uuid(), authMode: z.enum(["environment", "bundle"]) }).strict().optional(), alerts: z.object({ resourceId: z.uuid(), authMode: z.enum(["environment", "bundle"]) }).strict().optional() }).strict() }).strict() }).strict(),
  routes: z.array(z.record(z.string(), z.unknown())).min(1).max(3), exportedAt: timestamp }).strict();
export const handoffResults = { github_handoff_configuration: handoffConfigurationSchema, github_handoff_repository: handoffRepositorySchema,
  github_handoff_plan: handoffReceiptSchema, github_handoff_apply: handoffReceiptSchema, github_handoff_get: handoffReceiptSchema, github_handoff_status: handoffStatusSchema };
export type HandoffReceipt = z.infer<typeof handoffReceiptSchema>;
export type HandoffReveal = z.infer<typeof handoffRevealSchema>;
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;
export const handoffReviewSchema = z.object({ id: z.uuid(), fingerprint: z.string().max(100), connectionId: idSchema, connectionName: name, projectId: idSchema, repository: repositoryName,
  actorMatches: z.boolean(), createdAt: timestamp, expiresAt: timestamp, linked: z.boolean(), provider: handoffReceiptSchema.nullable(),
  operation: z.object({ id: z.uuid(), status: z.enum(["pending", "running", "succeeded", "partial", "failed", "indeterminate"]), summary: z.string().max(1000), updatedAt: timestamp }).strict().nullable() }).strict();
export type HandoffReview = z.infer<typeof handoffReviewSchema>;
