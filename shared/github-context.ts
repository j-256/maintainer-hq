import { z } from "zod";
import { idSchema, repositoryFields, workspaceInput } from "./domain";
import { githubStopReasonSchema } from "./github-diagnostics";

export const GITHUB_CONTEXT_LIMITS = Object.freeze({
  CACHE_MS: 5 * 60 * 1000,
  LEASE_MS: 30 * 1000,
  RESPONSE_BYTES: 32 * 1024,
  READS_PER_WINDOW: 10,
  BUDGET_WINDOW_MS: 60 * 1000,
});
export const githubContextInput = workspaceInput
  .extend({ repositoryId: idSchema, sourceId: idSchema })
  .strict();
export const githubShaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const CONTEXT_READ_LABELS = Object.freeze({
  observed: "Observed",
  unobserved: "Not read",
  unavailable: "Unavailable",
  error: "Read failed",
  limited: "Read limit reached",
  rate_limited: "Provider cooldown",
});
export const contextReadSchema = z
  .object({
    state: z.enum([
      "observed",
      "unobserved",
      "unavailable",
      "error",
      "limited",
      "rate_limited",
    ]),
    reason: githubStopReasonSchema,
  })
  .strict();
export type ContextRead = z.infer<typeof contextReadSchema>;
const revision = z.number().int().positive().safe();
export const githubContextResultSchema = z
  .object({
    repository: z
      .object({
        id: idSchema,
        fullName: repositoryFields.shape.fullName,
        revision,
      })
      .strict(),
    source: z
      .object({ id: idSchema, name: z.string().max(120), revision })
      .strict(),
    state: z.enum([
      "ready",
      "collecting",
      "waiting",
      "disabled",
      "not_configured",
    ]),
    nextReadAt: z.iso.datetime().nullable(),
  })
  .strict();
export type GitHubContextResult<T> = z.infer<
  typeof githubContextResultSchema
> & { evidence: T | null };

export function githubRepositoryUrl(fullName: string) {
  const parsed = repositoryFields.shape.fullName.parse(fullName);
  return (
    "https://github.com/" + parsed.split("/").map(encodeURIComponent).join("/")
  );
}
