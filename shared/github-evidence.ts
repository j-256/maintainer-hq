import { z } from "zod";

const SCALAR_REQUESTS = 3;
const PAGINATED_ENDPOINTS = 3;
const MAX_PAGES = 5;

export const GITHUB_LIMITS = Object.freeze({
  API_ORIGIN: "https://api.github.com",
  WEB_ORIGIN: "https://github.com",
  API_VERSION: "2026-03-10",
  PAGE_SIZE: 100,
  MAX_PAGES,
  MAX_REQUESTS: SCALAR_REQUESTS + PAGINATED_ENDPOINTS * MAX_PAGES,
  RESPONSE_BYTES: 2 * 1024 * 1024,
  LINK_HEADER_BYTES: 4096,
  CURSOR_LENGTH: 512,
  REQUEST_TIMEOUT_MS: 6000,
  REPOSITORY_TIMEOUT_MS: 20000,
  MIN_BACKOFF_MS: 60000,
  MAX_BACKOFF_MS: 24 * 60 * 60 * 1000,
});

export const GITHUB_CHECK_KEYS = [
  "repository",
  "head",
  "checks",
  "statuses",
  "dependabot",
  "codeScanning",
  "secretScanning",
] as const;
export const GITHUB_SECURITY_KEYS = [
  "dependabot",
  "codeScanning",
  "secretScanning",
] as const;
export const GITHUB_CHECK_LABELS = Object.freeze({
  repository: "Repository access",
  head: "Default branch head",
  checks: "Check runs",
  statuses: "Commit statuses",
  dependabot: "Dependabot",
  codeScanning: "Code scanning",
  secretScanning: "Secret scanning",
});
export const githubCheckSchema = z
  .object({
    key: z.enum(GITHUB_CHECK_KEYS),
    state: z.enum([
      "observed",
      "unobserved",
      "unavailable",
      "error",
      "limited",
      "rate_limited",
    ]),
    summary: z.string().max(240),
    count: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
export const githubBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
  .refine((name) => ![".", ".."].includes(name), "Invalid default branch");
export const githubEvidenceSchema = z
  .object({
    defaultBranch: githubBranchSchema.optional(),
    headSha: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
      .optional(),
    checks: z
      .array(githubCheckSchema)
      .length(GITHUB_CHECK_KEYS.length)
      .refine(
        (checks) =>
          new Set(checks.map((check) => check.key)).size ===
          GITHUB_CHECK_KEYS.length,
        "Each GitHub evidence category must be reported once",
      ),
  })
  .strict();
export type GitHubCheck = z.infer<typeof githubCheckSchema>;
export type GitHubEvidence = z.infer<typeof githubEvidenceSchema>;
export type GitHubCheckKey = GitHubCheck["key"];

export function githubSecurityComplete(evidence: GitHubEvidence) {
  return GITHUB_SECURITY_KEYS.every((key) =>
    evidence.checks.some(
      (check) => check.key === key && check.state === "observed",
    ),
  );
}
