import {
  GITHUB_CHECK_LABELS,
  type GitHubCheck,
  type GitHubEvidence,
} from "../shared/github-evidence";
import { StatusBadge, type StatusTone } from "./components/ui/status";

const CHECK_TONES: Record<GitHubCheck["state"], StatusTone> = {
  observed: "info",
  unobserved: "neutral",
  unavailable: "neutral",
  error: "danger",
  limited: "warning",
  rate_limited: "warning",
};

export function GitHubEvidenceList({ evidence }: { evidence: GitHubEvidence }) {
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
    </div>
  );
}
