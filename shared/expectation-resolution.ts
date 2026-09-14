import { reviewIsDue, type Repository, type Snapshot } from "./domain";
import { githubCoverageRepositories } from "./github-coverage";
import { GITHUB_SECURITY_KEYS, type GitHubCheckKey } from "./github-evidence";
import type { RepositoryCoverage } from "./repository-coverage";
import { coverageAssessment, coverageState } from "./coverage-evidence";

export function hookExpectationResolution(
  coverage: RepositoryCoverage | undefined,
  now: number,
) {
  if (!coverage)
    return {
      label: "Coverage not checked",
      action: "Set up coverage",
      tone: "neutral" as const,
    };
  if (!coverage.links.hooks)
    return {
      label: "No linked subscription",
      action: "Set up coverage",
      tone: "warning" as const,
    };
  const groups = coverage.evidence.filter((value) => value.kind === "hook");
  const fresh =
    groups.length > 0 &&
    groups.every(
      (value) =>
        Date.parse(value.observation.observedAt) <= now &&
        Date.parse(value.observation.expiresAt) > now,
    );
  const complete =
    groups.reduce(
      (sum, value) => sum + value.observation.details.coverage.total,
      0,
    ) === coverage.links.hooks;
  if (
    fresh &&
    complete &&
    groups.every(
      (value) =>
        coverageAssessment(value.observation.details.coverage, now).satisfied,
    )
  ) {
    return {
      label: "Routing configured",
      action: "View coverage",
      tone: "success" as const,
    };
  }
  const states = fresh
    ? groups.flatMap((value) =>
        value.observation.details.coverage.resources.map((resource) =>
          coverageState(resource, now),
        ),
      )
    : [];
  if (states.includes("disabled"))
    return {
      label: "Routing needs attention",
      action: "Configure routing",
      tone: "warning" as const,
    };
  if (states.includes("missing"))
    return {
      label: "Subscription missing",
      action: "Resolve coverage",
      tone: "danger" as const,
    };
  return {
    label: "Coverage unverified",
    action: "Check coverage",
    tone: "warning" as const,
  };
}

export function expectationHref(
  workspaceId: string,
  repositoryId: string,
  resolve?: ExpectationResolutionKind,
) {
  const query = new URLSearchParams({
    workspace: workspaceId,
    dialog: "expectations",
  });
  if (resolve) query.set("resolve", resolve);
  return "/repositories/" + encodeURIComponent(repositoryId) + "?" + query;
}

export function sameExpectationFlow(
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
) {
  const from = new URLSearchParams(current.search);
  const to = new URLSearchParams(next.search);
  return (
    current.pathname === next.pathname &&
    from.get("workspace") === to.get("workspace") &&
    from.get("dialog") === "expectations" &&
    to.get("dialog") === "expectations"
  );
}

export const EXPECTATION_RESOLUTIONS = [
  "hooks",
  "monitoring",
  "ci",
  "security",
  "visibility",
  "review",
] as const;
export type ExpectationResolutionKind =
  (typeof EXPECTATION_RESOLUTIONS)[number];
export const EXPECTATION_RESOLUTION_LABELS = Object.freeze({
  hooks: "Hook coverage",
  monitoring: "Endpoint monitoring",
  ci: "Continuous integration",
  security: "Security checks",
  visibility: "Expected visibility",
  review: "Repository review",
});
export const EXPECTATION_RESOLUTION_PARAMS = [
  "resolve",
  "resolveRepository",
  "connection",
  "policy",
  "policyReview",
  "setup",
  "setupReview",
  "resume",
  "verify",
  "monitorTarget",
  "monitorReview",
  "githubSource",
  "githubEdit",
  "githubRefresh",
  "completedReview",
] as const;
export function clearExpectationResolution(params: URLSearchParams) {
  for (const key of EXPECTATION_RESOLUTION_PARAMS) params.delete(key);
}
export function expectationResolutionKind(
  value: string | null,
): ExpectationResolutionKind | "all" | null {
  return value === "all" ||
    EXPECTATION_RESOLUTIONS.includes(value as ExpectationResolutionKind)
    ? (value as ExpectationResolutionKind | "all")
    : null;
}
export const GITHUB_EXPECTATION_CHECKS: Record<
  "ci" | "security" | "visibility",
  readonly GitHubCheckKey[]
> = {
  ci: ["head", "checks", "statuses"],
  security: GITHUB_SECURITY_KEYS,
  visibility: ["repository"],
};
export function githubExpectationResolution(
  repository: Repository,
  snapshot: Snapshot,
  kind: "ci" | "security" | "visibility",
  now: number,
) {
  const coverage = githubCoverageRepositories(
    [repository],
    snapshot.connections,
    snapshot.observations,
    now,
  )[0]!;
  if (!coverage.sources.length)
    return {
      label: "GitHub not connected",
      action: "Connect GitHub",
      tone: "neutral" as const,
    };
  const observations = coverage.sources.map((source) => {
    if (
      !source.enabled ||
      !source.credentialConfigured ||
      !source.configurationValid ||
      !source.evidence?.identityMatches
    )
      return null;
    return (
      snapshot.observations
        .filter(
          (item) =>
            item.provider === "github" &&
            item.sourceId === source.id &&
            item.resourceType === "repository" &&
            item.resourceId === repository.id,
        )
        .sort(
          (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
        )[0] ?? null
    );
  });
  const fresh = observations.filter(
    (item) =>
      item &&
      Date.parse(item.observedAt) <= now &&
      Date.parse(item.expiresAt) > now,
  );
  if (kind === "ci" && fresh.some((item) => item?.details.ci === "failing"))
    return {
      label: "CI failing",
      action: "Inspect failing checks",
      tone: "danger" as const,
    };
  if (
    kind === "security" &&
    fresh.some((item) => (item?.details.openFindings ?? 0) > 0)
  )
    return {
      label: "Open security findings",
      action: "Resolve findings",
      tone: "danger" as const,
    };
  if (
    kind === "visibility" &&
    repository.expectations.visibility !== "any" &&
    fresh.some(
      (item) =>
        item?.details.visibility &&
        item.details.visibility !== repository.expectations.visibility,
    )
  )
    return {
      label: "Visibility mismatch",
      action: "Review visibility",
      tone: "warning" as const,
    };
  const complete =
    fresh.length === observations.length &&
    fresh.every((item) =>
      GITHUB_EXPECTATION_CHECKS[kind].every((key) =>
        item?.details.github?.checks.some(
          (check) => check.key === key && check.state === "observed",
        ),
      ),
    );
  const satisfied =
    complete &&
    fresh.every((item) =>
      kind === "ci"
        ? item?.details.ci === "passing"
        : kind === "security"
          ? item?.details.openFindings === 0
          : Boolean(item?.details.visibility) &&
            (repository.expectations.visibility === "any" ||
              item?.details.visibility === repository.expectations.visibility),
    );
  if (satisfied)
    return {
      label:
        kind === "ci"
          ? "CI passing"
          : kind === "security"
            ? "No findings in checked coverage"
            : "Visibility matches",
      action: "View evidence",
      tone: "success" as const,
    };
  return {
    label: "Evidence unverified",
    action: "Check evidence",
    tone: "warning" as const,
  };
}
export function monitoringExpectationResolution(
  coverage: RepositoryCoverage | undefined,
  now: number,
) {
  if (!coverage?.links.monitoring)
    return {
      label: coverage ? "No linked monitor" : "Coverage not checked",
      action: "Set up monitoring",
      tone: "neutral" as const,
    };
  const groups = coverage.evidence.filter((value) => value.kind === "monitor");
  const complete =
    groups.length > 0 &&
    groups.reduce(
      (sum, value) => sum + value.observation.details.coverage.total,
      0,
    ) === coverage.links.monitoring;
  const fresh = groups.every(
    (value) =>
      Date.parse(value.observation.observedAt) <= now &&
      Date.parse(value.observation.expiresAt) > now,
  );
  if (
    complete &&
    fresh &&
    groups.every(
      (value) =>
        coverageAssessment(value.observation.details.coverage, now).satisfied,
    )
  )
    return {
      label: "Monitoring verified",
      action: "View monitoring",
      tone: "success" as const,
    };
  return {
    label: "Monitoring needs verification",
    action: "Resolve monitoring",
    tone: "warning" as const,
  };
}
export function reviewExpectationResolution(
  repository: Repository,
  now: number,
) {
  return {
    label: reviewIsDue(repository, now)
      ? "Review due"
      : repository.expectations.reviewDate
        ? "Review scheduled"
        : "No review scheduled",
    action: "Complete review",
    tone: reviewIsDue(repository, now)
      ? ("warning" as const)
      : ("neutral" as const),
  };
}
