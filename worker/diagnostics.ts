import { z } from "zod";
import { githubDiagnosticsSchema } from "../shared/github-diagnostics";
import { contextReadSchema } from "../shared/github-context";
import { DEPENDENCIES_LIMITS } from "../shared/dependencies";
import { dependencyOperationSchema } from "../shared/dependency-operations";

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const elapsed = z.number().int().nonnegative().max(86400000);
const context = z.object({
  runId: z.uuid(),
  workspaceId: identity,
  sourceId: identity,
  refreshId: identity,
  repositoryId: identity,
});
const diagnosticSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("hq.hooks.setup"),
      action: z.enum(["apply", "reconcile"]),
      reference: z.uuid(),
      workspaceId: identity,
      repositoryId: identity,
      state: z.enum([
        "ready",
        "configured",
        "installing",
        "installed",
        "rejected",
        "indeterminate",
        "expired",
        "conflict",
        "unavailable",
      ]),
      linked: z.boolean(),
      reason: z
        .enum(["github_rejected", "github_unavailable", "github_limited"])
        .nullable(),
      elapsedMs: elapsed,
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.dependencies.operation"),
      action: z.enum(["submit", "reconcile"]),
      reference: z.uuid(),
      workspaceId: identity,
      repositoryId: identity,
      phase: dependencyOperationSchema.shape.phase,
      status: dependencyOperationSchema.shape.status,
      reason: dependencyOperationSchema.shape.reason,
      requests: dependencyOperationSchema.shape.requests,
      elapsedMs: elapsed,
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.dependencies.inspected"),
      reference: z.uuid(),
      workspaceId: identity,
      sourceId: identity,
      repositoryId: identity,
      state: contextReadSchema.shape.state,
      reason: contextReadSchema.shape.reason,
      requests: z.number().int().min(0).max(DEPENDENCIES_LIMITS.REQUESTS),
      upstreamRequests: z
        .number()
        .int()
        .min(0)
        .max(DEPENDENCIES_LIMITS.UPSTREAM_PACKAGES),
      elapsedMs: elapsed,
      outcome: z.enum(["passed", "failed", "untracked", "unavailable"]),
      upstreamIncomplete: z.boolean(),
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.secrets.cleanup.interrupted"),
      expiredInputMayRemain: z.literal(true),
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.push.interrupted"),
      pendingRetained: z.literal(true),
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.request.failed"),
      reference: z.uuid(),
      operation: z.string().regex(/^[a-z_]{1,80}$/),
      status: z.number().int().min(400).max(599),
      classification: z.enum(["domain", "validation", "unexpected"]),
      elapsedMs: elapsed,
    })
    .strict(),
  context.extend({ event: z.literal("hq.github.repository.started") }).strict(),
  context
    .extend({
      event: z.literal("hq.github.repository.completed"),
      status: z.enum(["succeeded", "partial", "failed"]),
      receiptRecorded: z.boolean(),
      evidenceStored: z.boolean(),
      capacityLimited: z.boolean(),
      diagnostics: githubDiagnosticsSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal("hq.github.batch.completed"),
      runId: z.uuid(),
      trigger: z.enum(["scheduled", "background"]),
      processed: z.number().int().nonnegative(),
      elapsedMs: elapsed,
      stopReason: z.enum([
        "drained",
        "item_limit",
        "time_limit",
        "claim_lost",
        "unexpected",
      ]),
      failed: z.boolean(),
    })
    .strict(),
]);
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export function emitDiagnostic(event: Diagnostic) {
  try {
    const parsed = diagnosticSchema.safeParse(event);
    if (!parsed.success) return;
    const value = { schemaVersion: 1, ...parsed.data };
    if (
      (value.event === "hq.request.failed" && value.status >= 500) ||
      (value.event === "hq.github.batch.completed" && value.failed)
    )
      console.error(value);
    else if (
      (value.event === "hq.hooks.setup" &&
        (value.state !== "installed" || !value.linked)) ||
      (value.event === "hq.dependencies.operation" &&
        value.status !== "succeeded") ||
      (value.event === "hq.dependencies.inspected" &&
        (value.state !== "observed" ||
          value.outcome === "failed" ||
          value.upstreamIncomplete)) ||
      value.event === "hq.push.interrupted" ||
      value.event === "hq.secrets.cleanup.interrupted" ||
      value.event === "hq.request.failed" ||
      (value.event === "hq.github.repository.completed" &&
        (value.status !== "succeeded" ||
          !value.receiptRecorded ||
          value.capacityLimited))
    )
      console.warn(value);
    else console.log(value);
  } catch {
    // Diagnostics never change operation acceptance or hide the original failure
  }
}
