import { z } from "zod";
import { GITHUB_CHECK_KEYS } from "./github-evidence";

export const GITHUB_STOP_LABELS = Object.freeze({
  complete: "Complete",
  not_attempted: "Not attempted",
  configuration: "Invalid configuration",
  permission: "Access or feature unavailable",
  credential: "Credential rejected",
  redirect: "Redirect refused",
  rate_limit: "Provider cooldown",
  request_limit: "Request budget reached",
  page_limit: "Page budget reached",
  response_size: "Response too large",
  pagination_invalid: "Pagination could not be verified",
  response_invalid: "Unexpected response shape",
  timeout: "Timed out",
  interrupted: "Collection interrupted",
  provider_error: "Provider error",
  unexpected: "Unexpected runtime or network failure",
});
export type GitHubStopReason = keyof typeof GITHUB_STOP_LABELS;
export const githubStopReasonSchema = z.enum(
  Object.keys(GITHUB_STOP_LABELS) as [GitHubStopReason, ...GitHubStopReason[]],
);
const counter = z.number().int().nonnegative().max(100000);
export const githubDiagnosticsSchema = z
  .object({
    elapsedMs: z.number().int().nonnegative().max(86400000),
    requests: counter,
    pages: counter,
    endpoints: z
      .array(
        z
          .object({
            key: z.enum(GITHUB_CHECK_KEYS),
            requests: counter,
            pages: counter,
            reason: githubStopReasonSchema,
          })
          .strict(),
      )
      .length(GITHUB_CHECK_KEYS.length),
  })
  .strict();
export type GitHubDiagnostics = z.infer<typeof githubDiagnosticsSchema>;
