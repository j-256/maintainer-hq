import type { MonitorObservedTarget, MonitorResult } from "./monitoring";

function withinEvidenceWindow(
  observedAt: string | null,
  freshUntil: string | null,
  now: number,
) {
  return (
    observedAt !== null &&
    freshUntil !== null &&
    Number.isFinite(now) &&
    now >= Date.parse(observedAt) &&
    now < Date.parse(freshUntil)
  );
}

export function monitorExecutionState(
  execution: MonitorResult<"snapshot">["execution"],
  now: number,
) {
  if (!execution.lastRun) return "unobserved";
  if (
    execution.state !== "fresh" ||
    !withinEvidenceWindow(
      execution.lastRun.completedAt,
      execution.freshUntil,
      now,
    )
  )
    return "stale";
  return "fresh";
}

export function monitorCheckState(
  evidence: MonitorObservedTarget["evidence"],
  now: number,
) {
  const check = evidence.check;
  if (
    check.configurationMatches === false ||
    check.state === "configuration_changed"
  )
    return "configuration_changed";
  if (
    evidence.configurationMatches &&
    evidence.observedAt &&
    (!check.observedAt ||
      Date.parse(evidence.observedAt) > Date.parse(check.observedAt))
  )
    return evidence.state;
  if (!check.observedAt || check.state === "unobserved") return evidence.state;
  if (
    check.state === "stale" ||
    !withinEvidenceWindow(check.observedAt, check.freshUntil, now)
  )
    return "stale";
  if (check.configurationMatches !== true) return "unobserved";
  return check.state;
}
