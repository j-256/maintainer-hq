import { z } from "zod";
import {
  GITHUB_SECURITY_KEYS,
  type GitHubCheck,
  type GitHubCheckKey,
  type GitHubEvidence,
} from "./github-evidence";

export const GITHUB_REQUIREMENT_LABELS = Object.freeze({
  required: "Required",
  not_required: "Not required",
});
const scannerRequirement = z.enum(["required", "not_required"]);
export const githubSecurityRequirementsSchema = z
  .object({
    dependabot: scannerRequirement,
    codeScanning: scannerRequirement,
    secretScanning: scannerRequirement,
  })
  .strict();
export type GitHubSecurityRequirements = z.infer<
  typeof githubSecurityRequirementsSchema
>;
export const DEFAULT_GITHUB_SECURITY: GitHubSecurityRequirements =
  Object.freeze({
    dependabot: "required",
    codeScanning: "required",
    secretScanning: "required",
  });

export function githubCheckRequired(
  key: GitHubCheckKey,
  requirements: GitHubSecurityRequirements = DEFAULT_GITHUB_SECURITY,
) {
  return !GITHUB_SECURITY_KEYS.some(
    (security) => security === key && requirements[security] === "not_required",
  );
}

export function requiredGitHubSecurityRead(
  checks: readonly Pick<GitHubCheck, "key" | "state">[],
  requirements?: GitHubSecurityRequirements,
) {
  return GITHUB_SECURITY_KEYS.filter((key) =>
    githubCheckRequired(key, requirements),
  ).every((key) =>
    checks.some((check) => check.key === key && check.state === "observed"),
  );
}

export function requiredGitHubFindings(
  evidence: GitHubEvidence,
  requirements?: GitHubSecurityRequirements,
): number | undefined {
  let total = 0;
  for (const key of GITHUB_SECURITY_KEYS) {
    if (!githubCheckRequired(key, requirements)) continue;
    const check = evidence.checks.find((item) => item.key === key);
    if (check?.state !== "observed" || check.count === undefined)
      return undefined;
    total += check.count;
  }
  return total;
}
