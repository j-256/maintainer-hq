import { z } from "zod";
import { idSchema, workspaceInput, type Connection } from "./domain";
import { sourceFields, sourceInput } from "./sources";
import { GITHUB_LIMITS, type GitHubEvidence } from "./github-evidence";
import type { GitHubDiagnostics } from "./github-diagnostics";
import type { GitHubEvidenceChange } from "./github-refresh-summary";

const ACCEPTANCE_MARGIN_MS = 5000;

export const GITHUB_REFRESH_LIMITS = Object.freeze({
  REPOSITORIES: 100,
  MIN_INTERVAL_MINUTES: 5,
  MAX_INTERVAL_MINUTES: 720,
  DEFAULT_INTERVAL_MINUTES: 15,
  DEFAULT_FRESHNESS_MINUTES: 30,
  MANUAL_INTERVAL_MS: 60000,
  LEASE_MS: 45000,
  JOB_MAX_AGE_MS: 60 * 60 * 1000,
  MAX_ATTEMPTS: 3,
  HTTP_ITEMS: 1,
  HTTP_BUDGET_MS: 25000,
  CRON_ITEMS: 20,
  CRON_BUDGET_MS: 120000,
  CRON_ITEM_RESERVE_MS:
    GITHUB_LIMITS.REPOSITORY_TIMEOUT_MS + ACCEPTANCE_MARGIN_MS,
  DUE_SOURCES: 20,
  RECOVERY_JOBS: 40,
  HISTORY: 20,
  RETENTION_DAYS: 7,
  MINUTE_MS: 60000,
  DAY_MS: 86400000,
});
export const githubConfigurationSchema = z
  .object({
    refreshIntervalMinutes: z
      .number()
      .int()
      .min(GITHUB_REFRESH_LIMITS.MIN_INTERVAL_MINUTES)
      .max(GITHUB_REFRESH_LIMITS.MAX_INTERVAL_MINUTES),
  })
  .strict();
export const githubSourceFields = sourceFields
  .safeExtend({
    repositoryIds: z
      .array(idSchema)
      .max(GITHUB_REFRESH_LIMITS.REPOSITORIES)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each repository only once",
      ),
    credentialRef: idSchema.nullable(),
    refreshIntervalMinutes:
      githubConfigurationSchema.shape.refreshIntervalMinutes,
  })
  .strict()
  .refine(
    (source) => source.freshnessMinutes >= 2 * source.refreshIntervalMinutes,
    {
      path: ["freshnessMinutes"],
      message:
        "Allow at least two refresh intervals before evidence becomes stale",
    },
  );
export const githubEnrollInput = sourceInput
  .extend({ source: githubSourceFields })
  .strict();
export const githubUpdateInput = githubEnrollInput
  .extend({ revision: z.number().int().positive() })
  .strict();
export const githubRefreshInput = sourceInput
  .extend({
    revision: z.number().int().positive(),
    refreshId: idSchema,
  })
  .strict();
export const githubRefreshGetInput = sourceInput
  .extend({ refreshId: idSchema })
  .strict();
export const githubRefreshListInput = sourceInput
  .extend({
    limit: z
      .number()
      .int()
      .min(1)
      .max(GITHUB_REFRESH_LIMITS.HISTORY)
      .default(GITHUB_REFRESH_LIMITS.HISTORY),
  })
  .strict();
export const githubCredentialListInput = workspaceInput;
export const GITHUB_REFRESH_STATES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export type GitHubRefreshState = (typeof GITHUB_REFRESH_STATES)[number];
export type GitHubSourceFields = z.infer<typeof githubSourceFields>;
export type GitHubConnectionStatus = {
  credentialRef: string | null;
  configurationValid: boolean;
  refreshIntervalMinutes: number;
  nextRefreshAt: string | null;
  retryAt: string | null;
  activeRefreshId: string | null;
  lastRefreshId: string | null;
  lastRefreshStatus: GitHubRefreshState | null;
};
export type GitHubSource = Connection & {
  provider: "github";
  github: GitHubConnectionStatus;
};
export type GitHubCredentialReference = { id: string; name: string };
export type GitHubRefreshItem = {
  repositoryId: string;
  fullName: string;
  status: GitHubRefreshState;
  attempts: number;
  summary: string;
  updatedAt: string;
  observedAt: string | null;
  evidence: GitHubEvidence | null;
  diagnostics: GitHubDiagnostics | null;
  changes?: GitHubEvidenceChange[] | null;
};
export type GitHubRefresh = {
  id: string;
  sourceId: string;
  sourceRevision: number;
  actor: string;
  trigger: "manual" | "scheduled";
  status: GitHubRefreshState;
  summary: string;
  createdAt: string;
  completedAt: string | null;
  total: number;
  finished: number;
  items?: GitHubRefreshItem[];
};
export function githubRefreshActive(status: GitHubRefreshState) {
  return status === "queued" || status === "running";
}

const SCHEDULE_GRACE_MS = 2 * GITHUB_REFRESH_LIMITS.MINUTE_MS;
export function githubScheduleNotice(
  source: GitHubSource,
  now: number,
): string | null {
  if (
    !source.enabled ||
    !source.credentialConfigured ||
    !source.github.configurationValid ||
    !Number.isFinite(now)
  )
    return null;
  if (source.github.retryAt && Date.parse(source.github.retryAt) > now)
    return null;
  if (source.github.activeRefreshId) {
    const drainAllowance =
      Math.ceil(
        source.repositoryIds.length / GITHUB_REFRESH_LIMITS.CRON_ITEMS,
      ) *
      Math.max(
        GITHUB_REFRESH_LIMITS.MINUTE_MS,
        GITHUB_REFRESH_LIMITS.CRON_BUDGET_MS,
      );
    if (
      source.lastAttemptAt &&
      now - Date.parse(source.lastAttemptAt) >
        drainAllowance + SCHEDULE_GRACE_MS
    )
      return "Collection is taking longer than the queue allowance. Inspect the active receipt for progress or recovery; completion is not guaranteed by the refresh interval.";
    return null;
  }
  if (
    source.github.nextRefreshAt &&
    now - Date.parse(source.github.nextRefreshAt) > SCHEDULE_GRACE_MS
  )
    return "Scheduled collection is overdue and no refresh is active. Check the scheduler and its batch diagnostics.";
  return null;
}
