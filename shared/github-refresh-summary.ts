import { z } from "zod";
import type { GitHubRefreshItem } from "./github";
import { GITHUB_STOP_LABELS } from "./github-diagnostics";

export const GITHUB_CHANGE_LABELS = Object.freeze({
  first: "First observation",
  visibility: "Visibility",
  head: "Default branch / commit",
  ci: "CI results",
  security: "Security findings",
  coverage: "Evidence coverage",
  assessment: "Assessment",
});
export const githubChangesSchema = z
  .array(
    z.enum([
      "first",
      "visibility",
      "head",
      "ci",
      "security",
      "coverage",
      "assessment",
    ]),
  )
  .max(Object.keys(GITHUB_CHANGE_LABELS).length);
export type GitHubEvidenceChange = z.infer<typeof githubChangesSchema>[number];
const SUMMARY_REPOSITORIES = 3;
const SUMMARY_REASONS = 3;

export function githubCollectionOutcome(
  item: Pick<GitHubRefreshItem, "status" | "evidence" | "diagnostics">,
) {
  if (item.status === "queued" || item.status === "running") return "pending";
  if (item.status === "cancelled") return "cancelled";
  if (item.status === "succeeded") return "collected";
  const gaps =
    item.evidence?.checks.filter(
      (check) => check.state !== "observed" && check.state !== "unobserved",
    ) ?? [];
  if (
    gaps.length &&
    gaps.every(
      (check) =>
        check.state === "unavailable" &&
        item.diagnostics?.endpoints.some(
          (endpoint) =>
            endpoint.key === check.key && endpoint.reason === "permission",
        ),
    )
  )
    return "coverage_gap";
  return "failure";
}

export const GITHUB_OUTCOME_LABELS = Object.freeze({
  pending: "Collecting",
  cancelled: "Cancelled",
  collected: "Collected",
  coverage_gap: "Access / feature gap",
  failure: "Collection needs attention",
});

function repositories(count: number) {
  return count + (count === 1 ? " repository" : " repositories");
}

export function githubRefreshSummary(items: GitHubRefreshItem[]) {
  const outcomes = items.map(githubCollectionOutcome);
  const count = (outcome: ReturnType<typeof githubCollectionOutcome>) =>
    outcomes.filter((value) => value === outcome).length;
  const parts: string[] = [];
  if (count("collected")) parts.push(count("collected") + " fully collected");
  if (count("coverage_gap"))
    parts.push(count("coverage_gap") + " with access or feature gaps");
  if (count("failure"))
    parts.push(count("failure") + " needing collection attention");
  if (count("cancelled")) parts.push(count("cancelled") + " cancelled");
  if (count("pending")) parts.push(count("pending") + " still pending");
  const reasons = [
    ...new Set(
      items
        .filter((item) => githubCollectionOutcome(item) === "failure")
        .flatMap((item) => item.diagnostics?.endpoints ?? [])
        .filter(
          (endpoint) =>
            !["complete", "not_attempted", "permission"].includes(
              endpoint.reason,
            ),
        )
        .map((endpoint) => GITHUB_STOP_LABELS[endpoint.reason]),
    ),
  ];
  const outcome =
    (parts.length
      ? repositories(items.length) + ": " + parts.join(", ")
      : "No repository results were collected") +
    "." +
    (reasons.length
      ? " Check: " +
        reasons.slice(0, SUMMARY_REASONS).join(", ") +
        (reasons.length > SUMMARY_REASONS ? ", and other failures" : "") +
        "."
      : "");
  const changed = items.filter((item) => item.changes?.length);
  const untracked = items.some((item) => item.changes == null);
  const changes = changed.length
    ? "Evidence changed for " +
      repositories(changed.length) +
      ": " +
      changed
        .slice(0, SUMMARY_REPOSITORIES)
        .map(
          (item) =>
            item.fullName +
            " (" +
            item
              .changes!.map((change) =>
                GITHUB_CHANGE_LABELS[change].toLowerCase(),
              )
              .join(", ") +
            ")",
        )
        .join("; ") +
      (changed.length > SUMMARY_REPOSITORIES
        ? "; plus " + repositories(changed.length - SUMMARY_REPOSITORIES)
        : "") +
      "."
    : untracked
      ? "Evidence changes were not recorded for every repository."
      : "No evidence changes since the previous observations.";
  return { outcome, changes, summary: changes + " " + outcome };
}

export function githubReceiptHref(
  workspaceId: string,
  sourceId: string,
  refreshId: string,
) {
  return (
    "/settings/github?" +
    new URLSearchParams({
      workspace: workspaceId,
      source: sourceId,
      refresh: refreshId,
    })
  );
}
