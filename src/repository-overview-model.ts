import type { Observation, Repository, Snapshot } from "../shared/domain";
import type { StatusTone } from "./components/ui/status";
import {
  GITHUB_LIMITS,
  githubSecurityComplete,
} from "../shared/github-evidence";

export function repositoryGitHubContext(
  repository: Repository,
  snapshot: Pick<Snapshot, "observations" | "connections">,
) {
  const observations = snapshot.observations
    .filter(
      (item) =>
        item.resourceType === "repository" &&
        item.resourceId === repository.id &&
        item.provider === "github",
    )
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const sources = snapshot.connections.filter(
    (item) =>
      item.provider === "github" && item.repositoryIds.includes(repository.id),
  );
  const observation = observations[0];
  const source =
    snapshot.connections.find((item) => item.id === observation?.sourceId) ??
    sources[0];
  return {
    observations,
    observation,
    source,
    upstream:
      sources.length || observations.length
        ? GITHUB_LIMITS.WEB_ORIGIN +
          "/" +
          repository.fullName.split("/").map(encodeURIComponent).join("/")
        : null,
  };
}

export function repositoryEvidenceSummary(
  kind: "ci" | "security",
  observation: Observation | undefined,
  source: Snapshot["connections"][number] | undefined,
  now: number,
): { label: string; detail: string; tone: StatusTone } {
  const evidence = observation?.details;
  const complete = evidence?.github
    ? githubSecurityComplete(evidence.github)
    : false;
  const label =
    kind === "ci"
      ? evidence?.ci === "passing"
        ? "Passing"
        : evidence?.ci === "failing"
          ? "Failing"
          : "Not verified"
      : evidence?.openFindings
        ? `${evidence.openFindings} open findings`
        : evidence?.openFindings === 0 && complete
          ? "No open findings"
          : "Coverage incomplete";
  const details =
    kind === "ci"
      ? "Default branch checks and commit statuses."
      : complete
        ? "Dependabot, code scanning and secret scanning were collected."
        : "Unavailable security checks are not passing checks.";
  if (source?.enabled === false)
    return {
      label: "Collection disabled",
      detail: observation
        ? "Last result: " + label + "."
        : "No evidence received.",
      tone: "neutral",
    };
  if (!observation)
    return {
      label: source ? "Awaiting evidence" : "Not configured",
      detail: source
        ? "No accepted GitHub observation yet."
        : "No GitHub source covers this repository.",
      tone: "neutral",
    };
  if (Date.parse(observation.expiresAt) <= now)
    return {
      label: "Stale evidence",
      detail: "Last result: " + label + ".",
      tone: "warning",
    };
  const failing =
    kind === "ci"
      ? evidence?.ci === "failing"
      : Boolean(evidence?.openFindings);
  const passing =
    kind === "ci"
      ? evidence?.ci === "passing"
      : evidence?.openFindings === 0 && complete;
  return {
    label,
    detail: details,
    tone: failing ? "danger" : passing ? "success" : "neutral",
  };
}
