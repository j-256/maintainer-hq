import { z } from "zod";
import { idSchema, workspaceInput } from "./domain";
import type { HookReview } from "./hooks";

export const HOOK_SETUP_KIND = "hookrelay.github.setup";
export const HOOK_SETUP_DESTINATIONS = 25;
export const HOOK_SETUP_EVENTS = [
  "push",
  "pull_request",
  "issues",
  "release",
  "workflow_run",
  "check_run",
  "check_suite",
  "repository",
  "deployment_status",
] as const;
const name = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const events = z
  .array(z.enum(HOOK_SETUP_EVENTS))
  .min(1)
  .max(HOOK_SETUP_EVENTS.length)
  .refine((values) => new Set(values).size === values.length);
const sinks = z
  .array(name)
  .min(1)
  .max(HOOK_SETUP_DESTINATIONS)
  .refine((values) => new Set(values).size === values.length);
const timestamp = z.iso.datetime();
export const hookSetupConnectionInput = workspaceInput
  .extend({ connectionId: idSchema })
  .strict();
export const hookSetupPlanInput = hookSetupConnectionInput
  .extend({
    repositoryId: idSchema,
    repositoryRevision: z.number().int().positive(),
    connectionRevision: z.number().int().positive(),
    reviewId: z.uuid(),
    authorityId: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.number().int().nonnegative(),
    resourceId: z.uuid().nullable(),
    name,
    events,
    sinks,
  })
  .strict();
export const hookSetupStatusInput = hookSetupConnectionInput
  .extend({ resourceId: z.uuid() })
  .strict();
export const hookSetupConfigurationSchema = z
  .object({
    authorityId: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.number().int().nonnegative(),
    mode: z.enum(["legacy", "active"]),
    canCreate: z.boolean(),
    reason: z.enum([
      "ready",
      "inactive",
      "grant_required",
      "provider_setup_required",
    ]),
    observedAt: timestamp,
  })
  .strict();
export const hookSetupReceiptSchema = z
  .object({
    planId: z.uuid(),
    resourceId: z.uuid(),
    name,
    repository: z.string().max(240),
    events,
    sinks,
    action: z.enum(["create", "install"]),
    status: z.enum([
      "ready",
      "configured",
      "installing",
      "installed",
      "rejected",
      "indeterminate",
      "expired",
      "conflict",
    ]),
    errorCode: z
      .enum(["github_rejected", "github_unavailable", "github_limited"])
      .nullable(),
    createdAt: timestamp,
    expiresAt: timestamp,
    updatedAt: timestamp,
    routingConfigured: z.boolean(),
    webhookInstalled: z.boolean(),
    webhookId: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.webhookInstalled === (value.status === "installed") &&
      (!value.webhookInstalled ||
        (value.routingConfigured && value.webhookId !== null)),
  );
export const hookSetupStatusSchema = z
  .object({
    resourceId: z.uuid(),
    name,
    routingConfigured: z.boolean(),
    webhook: z.enum([
      "installed",
      "missing",
      "changed",
      "unverified",
      "unavailable",
      "limited",
    ]),
    deliveredAt: timestamp.nullable(),
    observedAt: timestamp,
  })
  .strict();
export const hookSetupResults = {
  github_setup_configuration: hookSetupConfigurationSchema,
  github_setup_plan: hookSetupReceiptSchema,
  github_setup_apply: hookSetupReceiptSchema,
  github_setup_get: hookSetupReceiptSchema,
  github_setup_status: hookSetupStatusSchema,
};
export type HookSetupReceipt = z.infer<typeof hookSetupReceiptSchema>;
export type HookSetupConfiguration = z.infer<
  typeof hookSetupConfigurationSchema
>;
export type HookSetupStatus = z.infer<typeof hookSetupStatusSchema>;
export type HookSetupReview = {
  id: string;
  fingerprint: string;
  connectionId: string;
  connectionName: string;
  repositoryId: string;
  repositoryName: string;
  actorMatches: boolean;
  createdAt: string;
  expiresAt: string;
  linked: boolean;
  provider: HookSetupReceipt | null;
  operation: HookReview["operation"];
};
