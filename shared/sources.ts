import { z } from "zod";
import {
  idSchema,
  workspaceInput,
  type Connection,
  type Observation,
} from "./domain";

export const SOURCE_LIMITS = Object.freeze({
  SOURCES: 100,
  REPOSITORIES: 100,
  ACTIVE_CREDENTIALS: 10,
  MIN_FRESHNESS_MINUTES: 5,
  MAX_FRESHNESS_MINUTES: 1440,
  DEFAULT_FRESHNESS_MINUTES: 15,
  REPORT_INTERVAL_MS: 5000,
  RECEIPT_DAYS: 7,
  DAY_MS: 86400000,
  MINUTE_MS: 60000,
});
export const sourceFields = z
  .object({
    name: z.string().trim().min(1).max(80),
    repositoryIds: z
      .array(idSchema)
      .max(SOURCE_LIMITS.REPOSITORIES)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each repository only once",
      ),
    freshnessMinutes: z
      .number()
      .int()
      .min(SOURCE_LIMITS.MIN_FRESHNESS_MINUTES)
      .max(SOURCE_LIMITS.MAX_FRESHNESS_MINUTES),
    enabled: z.boolean(),
  })
  .strict()
  .refine((source) => !source.enabled || source.repositoryIds.length > 0, {
    path: ["repositoryIds"],
    message: "Choose at least one repository before enabling a source",
  });
export const sourceInput = workspaceInput
  .extend({ sourceId: idSchema })
  .strict();
export const enrollSourceInput = sourceInput
  .extend({ source: sourceFields })
  .strict();
export const updateSourceInput = enrollSourceInput
  .extend({ revision: z.number().int().positive() })
  .strict();
export const issuePublisherCredentialInput = sourceInput
  .extend({
    revision: z.number().int().positive(),
    credentialId: idSchema,
    name: z.string().trim().min(1).max(80),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  })
  .strict();
export const revokePublisherCredentialInput = sourceInput
  .extend({ credentialId: idSchema })
  .strict();
export const localObservationSchema = z
  .object({
    repositoryId: idSchema,
    observedAt: z.iso.datetime(),
    branch: z.string().min(1).max(100),
    dirty: z.boolean(),
    ahead: z.number().int().min(0).max(100000),
  })
  .strict();
export const publishObservationsInput = sourceInput
  .extend({
    reportId: idSchema,
    observations: z
      .array(localObservationSchema)
      .min(1)
      .max(SOURCE_LIMITS.REPOSITORIES)
      .refine(
        (items) =>
          new Set(items.map((item) => item.repositoryId)).size === items.length,
        "Report each repository only once",
      ),
  })
  .strict();
export type SourceFields = z.infer<typeof sourceFields>;
export type PublisherCredential = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export type IssuedPublisherCredential = {
  credential: PublisherCredential;
  token: string;
};
export type PublicationReceipt = {
  reportId: string;
  sourceId: string;
  receivedAt: string;
  accepted: number;
};

export function sourceFreshness(
  source: Connection,
  observations: Observation[],
  now = Date.now(),
) {
  if (!source.enabled)
    return {
      label: "Disabled",
      detail:
        "Publishing is stopped. Existing credentials cannot submit reports.",
      state: "disabled",
    };
  if (!source.credentialConfigured)
    return {
      label: "No active credential",
      detail: "Create a publisher credential to let this source send updates.",
      state: "unknown",
    };
  const evidence = observations.filter(
    (item) =>
      item.sourceId === source.id &&
      source.repositoryIds.includes(item.resourceId),
  );
  const fresh = evidence.filter((item) => Date.parse(item.expiresAt) > now);
  if (!evidence.length)
    return {
      label: "Awaiting first report",
      detail: "Enrollment alone does not confirm that a publisher is running.",
      state: "unknown",
    };
  if (!fresh.length)
    return {
      label: "Reports stale",
      detail:
        "The last observations have expired. The publisher may be offline.",
      state: "stale",
    };
  if (fresh.length < source.repositoryIds.length)
    return {
      label: "Partially observed",
      detail: `${fresh.length} of ${source.repositoryIds.length} repositories have fresh local observations.`,
      state: "partial",
    };
  return {
    label: "Reports current",
    detail:
      "All selected repositories have fresh local observations. This does not verify CI or security.",
    state: "fresh",
  };
}
