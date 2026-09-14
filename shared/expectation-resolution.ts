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
    groups.every((value) => Date.parse(value.observation.expiresAt) > now);
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
  resolve?: "hooks",
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
