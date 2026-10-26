import { z } from "zod";
import { idSchema, repositoryFields, workspaceInput } from "./domain";
import {
  githubContextInput,
  githubContextResultSchema,
  githubShaSchema,
  contextReadSchema,
} from "./github-context";
import { githubBranchSchema } from "./github-evidence";
import { dependencyDigestSchema } from "./dependency-report";

export const DEPENDABOT_PATHS = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
] as const;
export const DEPENDABOT_TIME = Object.freeze({
  MINUTE_MS: 60 * 1000,
  MINUTES_PER_DAY: 24 * 60,
  DAYS_PER_WEEK: 7,
  WINDOW_MARGIN_DAYS: 2,
});
export const DEPENDABOT_LIMITS = Object.freeze({
  FILE_BYTES: 128 * 1024,
  EVIDENCE_BYTES: 128 * 1024,
  RESPONSE_BYTES: 2 * 1024 * 1024,
  ENTRIES: 64,
  DIRECTORIES: 16,
  YAML_NODES: 4096,
  TREE_ENTRIES: 10000,
  REQUESTS: 4,
  PAGE_SIZE: 10,
  INVENTORY_REPOSITORIES: 500,
  REFRESH_CONCURRENCY: 2,
  CACHE_MS: 5 * 60 * 1000,
  CLOCK_MS: 30000,
  PROJECTION_ENTRIES: 2000,
  CANDIDATES_PER_ENTRY: 256,
  OCCURRENCES_PER_ENTRY: 128,
  OCCURRENCES_TOTAL: 4096,
});
export const DEPENDABOT_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const DEPENDABOT_INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "semiannually",
  "yearly",
  "cron",
] as const;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const dependabotScheduleSchema = z
  .object({
    interval: z.enum(DEPENDABOT_INTERVALS),
    day: z.enum(DEPENDABOT_DAYS).optional(),
    time: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    timezone: text(100).optional(),
    cronjob: text(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.day && value.interval !== "weekly")
      context.addIssue({
        code: "custom",
        message: "Day applies only to weekly schedules",
        path: ["day"],
      });
    if (
      value.interval === "cron"
        ? !value.cronjob || value.time !== undefined || value.day !== undefined
        : value.cronjob !== undefined
    )
      context.addIssue({
        code: "custom",
        message:
          "Use a cron expression for cron schedules and day/time for standard intervals",
        path: ["cronjob"],
      });
  });
export type DependabotSchedule = z.infer<typeof dependabotScheduleSchema>;
export const dependabotMemberSchema = z
  .object({
    ecosystem: text(80),
    directories: z.array(text(256)).min(1).max(DEPENDABOT_LIMITS.DIRECTORIES),
    targetBranch: githubBranchSchema.nullable(),
  })
  .strict();
export const dependabotEntrySchema = z
  .object({
    id: z.string().regex(/^sha256:[a-f0-9]{64}:(?:update|group):\d+$/),
    owner: z.enum(["update", "group"]),
    group: text(100).nullable(),
    members: z
      .array(dependabotMemberSchema)
      .min(1)
      .max(DEPENDABOT_LIMITS.ENTRIES),
    schedule: dependabotScheduleSchema.nullable(),
    editable: z.boolean(),
    issue: z.enum(["unsupported_schedule", "ambiguous_group"]).nullable(),
  })
  .strict();
export type DependabotEntry = z.infer<typeof dependabotEntrySchema>;
export const dependabotEditSchema = z
  .object({
    entryId: dependabotEntrySchema.shape.id,
    schedule: dependabotScheduleSchema,
  })
  .strict();
export type DependabotEdit = z.infer<typeof dependabotEditSchema>;
export const dependabotEditsSchema = z
  .array(dependabotEditSchema)
  .min(1)
  .max(DEPENDABOT_LIMITS.ENTRIES)
  .refine(
    (items) => new Set(items.map((item) => item.entryId)).size === items.length,
    "Edit each schedule only once",
  );
export const dependabotInspectionInput = githubContextInput
  .extend({ refresh: z.boolean().default(false) })
  .strict();
export const dependabotListInput = workspaceInput
  .extend({
    projectId: idSchema.optional(),
    page: z.number().int().min(1).max(1000).default(1),
  })
  .strict();
export const dependabotEvidenceSchema = z
  .object({
    inspectionId: idSchema,
    observedAt: z.iso.datetime(),
    retryAt: z.iso.datetime().nullable(),
    requests: z.number().int().min(0).max(DEPENDABOT_LIMITS.REQUESTS),
    elapsedMs: z.number().int().nonnegative(),
    read: contextReadSchema,
    branch: githubBranchSchema.nullable(),
    headSha: githubShaSchema.nullable(),
    treeSha: githubShaSchema.nullable(),
    configuration: z.enum([
      "unknown",
      "missing",
      "present",
      "ambiguous",
      "malformed",
      "unsupported",
      "limited",
    ]),
    file: z
      .object({
        path: z.enum(DEPENDABOT_PATHS),
        digest: dependencyDigestSchema,
        blobSha: githubShaSchema,
        mode: z.enum(["100644", "100755"]),
      })
      .strict()
      .nullable(),
    entries: z.array(dependabotEntrySchema).max(DEPENDABOT_LIMITS.ENTRIES),
  })
  .strict();
export type DependabotEvidence = z.infer<typeof dependabotEvidenceSchema>;
export const dependabotResultSchema = githubContextResultSchema
  .extend({ evidence: dependabotEvidenceSchema.nullable() })
  .strict();
export type DependabotResult = z.infer<typeof dependabotResultSchema>;
export const dependabotInventoryRowSchema = z
  .object({
    repository: z
      .object({
        id: idSchema,
        fullName: repositoryFields.shape.fullName,
        projectId: idSchema.nullable(),
      })
      .strict(),
    source: z
      .object({ id: idSchema, name: text(120) })
      .strict()
      .nullable(),
    result: dependabotResultSchema.nullable(),
  })
  .strict();
export type DependabotInventoryRow = z.infer<
  typeof dependabotInventoryRowSchema
>;
export const dependabotPageSchema = z
  .object({
    page: z.number().int().positive(),
    pageSize: z.literal(DEPENDABOT_LIMITS.PAGE_SIZE),
    total: z.number().int().nonnegative(),
    rows: z
      .array(dependabotInventoryRowSchema)
      .max(DEPENDABOT_LIMITS.PAGE_SIZE),
  })
  .strict();
export type DependabotPage = z.infer<typeof dependabotPageSchema>;
export function validDependabotTimezone(value: string) {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function dependabotScheduleLabel(schedule: DependabotSchedule | null) {
  if (!schedule) return "Unsupported schedule";
  if (schedule.interval === "cron")
    return schedule.cronjob! + " (" + (schedule.timezone ?? "UTC") + ")";
  const day =
    schedule.interval === "weekly" ? " on " + (schedule.day ?? "monday") : "";
  return (
    schedule.interval +
    day +
    (schedule.time
      ? " at " + schedule.time + " " + (schedule.timezone ?? "UTC")
      : " (Time assigned by GitHub)")
  );
}
