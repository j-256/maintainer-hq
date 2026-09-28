import {
  GITHUB_CHECK_LABELS,
  type GitHubCheck,
  type GitHubEvidence,
} from "../shared/github-evidence";
import { StatusBadge, type StatusTone } from "./components/ui/status";
import { githubManagementLinks } from "../shared/github-settings";
import { GitHubGapActions } from "./github-gap-actions";
import { githubRemediation } from "../shared/github-remediation";
import {
  githubCheckRequired,
  type GitHubSecurityRequirements,
} from "../shared/github-requirements";

const CHECK_TONES: Record<GitHubCheck["state"], StatusTone> = {
  observed: "info",
  unobserved: "neutral",
  unavailable: "neutral",
  error: "danger",
  limited: "warning",
  rate_limited: "warning",
};

export function GitHubEvidenceList({
  evidence,
  fullName,
  requirements,
}: {
  evidence: GitHubEvidence;
  fullName: string;
  requirements?: GitHubSecurityRequirements;
}) {
  return (
    <div className="github-evidence">
      {evidence.headSha ? (
        <p className="field-help">
          Default branch: <strong>{evidence.defaultBranch}</strong> at{" "}
          <code title={evidence.headSha}>{evidence.headSha.slice(0, 12)}</code>
        </p>
      ) : null}
      <dl className="github-checks">
        {evidence.checks.map((check) => (
          <div key={check.key}>
            <dt>
              {GITHUB_CHECK_LABELS[check.key]}{" "}
              {!githubCheckRequired(check.key, requirements) ? (
                <span>Not required - </span>
              ) : null}
              <StatusBadge tone={CHECK_TONES[check.state]}>
                {check.state.replaceAll("_", " ")}
              </StatusBadge>
            </dt>
            <dd>
              {check.summary}
              {check.count !== undefined ? (
                <span className="github-count">
                  {check.count}
                  {check.state === "limited" ? "+" : ""} found
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <GitHubGapActions
        links={githubManagementLinks(
          fullName,
          evidence.checks.filter((check) =>
            githubCheckRequired(check.key, requirements),
          ),
        )}
        remediation={githubRemediation(evidence.checks, requirements)}
      />
    </div>
  );
}
