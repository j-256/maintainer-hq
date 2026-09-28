import {
  GITHUB_CHECK_KEYS,
  GITHUB_CHECK_LABELS,
  type GitHubCheck,
} from "./github-evidence";
import {
  githubCheckRequired,
  type GitHubSecurityRequirements,
} from "./github-requirements";

const GUIDANCE = Object.freeze({
  repository:
    "Confirm the repository still exists under this name and that the connection's token or GitHub App installation includes it. If it was removed, archive its HQ record and remove it from the connection's collection scope.",
  head: "Check that the repository has a default branch and that the connection can read its contents.",
  checks:
    "Check that the connection's credential can read check runs for the default branch. Repository access alone does not grant every check permission.",
  statuses:
    "Check that the connection's credential can read commit statuses for the default branch.",
  dependabot:
    "In repository security settings, check that Dependabot alerts are enabled. The connection's fine-grained token or GitHub App also needs Dependabot alerts read permission.",
  codeScanning:
    "In repository security settings, check that code scanning is configured and has analyzed the default branch. The connection's fine-grained token or GitHub App also needs Code scanning alerts read permission.",
  secretScanning:
    "In repository security settings, check that secret scanning is enabled and available for this repository. The connection's fine-grained token or GitHub App also needs Secret scanning alerts read permission.",
});

export type GitHubRemediation = {
  key: GitHubCheck["key"];
  label: string;
  guidance: string;
};

export function githubRemediation(
  checks: readonly Pick<GitHubCheck, "key" | "state">[],
  requirements?: GitHubSecurityRequirements,
): GitHubRemediation[] {
  return GITHUB_CHECK_KEYS.filter(
    (key) =>
      githubCheckRequired(key, requirements) &&
      checks.some(
        (check) => check.key === key && check.state === "unavailable",
      ),
  ).map((key) => ({
    key,
    label: GITHUB_CHECK_LABELS[key],
    guidance: GUIDANCE[key],
  }));
}
