import {
  DEPENDABOT_LIMITS as LIMITS,
  type DependabotEdit,
  type DependabotEntry,
  type DependabotInventoryRow,
} from "../../shared/dependabot";
export type DependabotDraft = {
  head: string;
  digest: string;
  edits: DependabotEdit[];
};
export const entryKey = (row: DependabotInventoryRow, entry: DependabotEntry) =>
  row.repository.id + ":" + entry.id;
export function withinDependabotSchedules(
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
) {
  return current.pathname === next.pathname &&
    new URLSearchParams(current.search).get("workspace") ===
      new URLSearchParams(next.search).get("workspace") &&
    new URLSearchParams(next.search).get("view") === "schedules";
}
export function stale(row: DependabotInventoryRow, now: number) {
  const observed = row.result?.evidence?.observedAt;
  return (
    !observed ||
    Date.parse(observed) > now ||
    now - Date.parse(observed) >= LIMITS.CACHE_MS
  );
}
export function draftMatches(
  row: DependabotInventoryRow,
  draft: DependabotDraft | undefined,
) {
  return Boolean(
    draft &&
    row.result?.evidence?.headSha === draft.head &&
    row.result?.evidence?.file?.digest === draft.digest,
  );
}
export function rowState(row: DependabotInventoryRow, now: number) {
  if (!row.source) return "No GitHub source";
  const result = row.result,
    e = result?.evidence;
  if (!e)
    return result?.state === "disabled"
      ? "Source disabled"
      : result?.state === "not_configured"
        ? "Read access unavailable"
        : "Not inspected";
  if (e.read.state !== "observed")
    return "Read unavailable: " + e.read.reason.replaceAll("_", " ");
  if (e.configuration !== "present")
    return {
      missing: "No Dependabot file",
      ambiguous: "Both YAML filenames exist",
      malformed: "Malformed YAML",
      unsupported: "Unsupported configuration",
      limited: "Inspection limit reached",
      unknown: "Configuration unknown",
    }[e.configuration];
  return stale(row, now) ? "Stale observation" : "Observed";
}
