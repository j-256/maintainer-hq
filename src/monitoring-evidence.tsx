import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  MonitorObservedTarget,
  MonitorResult,
} from "../shared/monitoring";
import {
  monitorCheckState,
  monitorExecutionState,
} from "../shared/monitoring-freshness";
import { StatusBadge, type StatusTone } from "./components/ui/status";
import { HookTime as MonitorTime } from "./hook-components";

const CLOCK_TICK_MS = 1000;
const EvidenceClock = createContext(0);
export function MonitoringEvidenceClock({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function updateVisibility() {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
      }
    }
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  return (
    <EvidenceClock.Provider value={now}>{children}</EvidenceClock.Provider>
  );
}

const CHECK_LABELS = {
  unobserved: "No retained probe evidence",
  exceptional: "Exceptional-state evidence",
  incident: "Incident recorded",
  configuration_changed: "Awaiting check of changed configuration",
  stale: "Check overdue",
  passed: "Check passed",
  failed: "Check failed",
} as const;
const CHECK_TONES: Record<keyof typeof CHECK_LABELS, StatusTone> = {
  unobserved: "neutral",
  exceptional: "warning",
  incident: "danger",
  configuration_changed: "warning",
  stale: "warning",
  passed: "success",
  failed: "danger",
};
export function MonitorEvidence({
  evidence,
}: {
  evidence: MonitorObservedTarget["evidence"];
}) {
  const now = useContext(EvidenceClock);
  const state = monitorCheckState(evidence, now);
  return (
    <div className="monitor-evidence-badges">
      <StatusBadge tone={CHECK_TONES[state]}>{CHECK_LABELS[state]}</StatusBadge>
      {evidence.incidentId && state !== "incident" ? (
        <StatusBadge tone="danger">Incident recorded</StatusBadge>
      ) : null}
    </div>
  );
}
export function MonitorCheckTimes({
  evidence,
}: {
  evidence: MonitorObservedTarget["evidence"];
}) {
  const { check } = evidence;
  return (
    <div className="monitor-check-times hook-muted">
      <p>
        Last check: <MonitorTime value={check.observedAt} />
        {check.status ? " / HTTP " + check.status : ""}
        {check.errorCode ? " / " + check.errorCode : ""}
      </p>
      <p>
        Last retained pass: <MonitorTime value={check.lastSuccessAt} />
      </p>
      {check.configurationMatches === false ? (
        <p>
          The recorded check used an older configuration. Waiting for a check of
          the saved revision.
        </p>
      ) : null}
      {check.freshUntil && check.configurationMatches ? (
        <p>
          Check due by <MonitorTime value={check.freshUntil} />.
        </p>
      ) : null}
    </div>
  );
}
export function MonitorExecution({
  data,
}: {
  data: MonitorResult<"snapshot">;
}) {
  const now = useContext(EvidenceClock);
  const execution = data.execution;
  const state = monitorExecutionState(execution, now);
  const run = execution.lastRun;
  return (
    <section className="monitor-run-status" aria-label="Scheduler status">
      <div className="hook-section-heading">
        <h2>Scheduler</h2>
        <StatusBadge
          tone={
            state === "fresh"
              ? "success"
              : state === "stale"
                ? "warning"
                : "neutral"
          }
        >
          {state === "fresh"
            ? "Fresh completion"
            : state === "stale"
              ? "Scheduler overdue"
              : "No completed run recorded"}
        </StatusBadge>
      </div>
      <p>
        Last completed run: <MonitorTime value={run?.completedAt ?? null} />
      </p>
      {run ? (
        <p className="hook-muted">
          Scheduled for <MonitorTime value={run.scheduledAt} />.{" "}
          {run.enabled
            ? `Checks passed: ${run.succeededProbes}; failed: ${run.failedProbes}; phase errors: ${run.phaseErrors}; notification failures: ${run.deliveriesFailed}.`
            : "Probing was disabled for this run."}
        </p>
      ) : null}
      {state === "stale" ? (
        <p className="hook-notice">
          No fresh scheduler completion is available. Check Worker invocation
          logs and the cron trigger. A successful dashboard refresh does not
          clear this condition.
        </p>
      ) : null}
      {state === "unobserved" ? (
        <p className="hook-muted">
          Waiting for a completed scheduled run to publish evidence.
        </p>
      ) : null}
      {run?.enabled &&
      data.configuration &&
      run.configurationRevision !== data.configuration.revision ? (
        <p className="hook-notice">
          The last run used configuration revision {run.configurationRevision}.
          Waiting for the scheduler to adopt revision{" "}
          {data.configuration.revision}.
        </p>
      ) : null}
      <p className="hook-muted">
        Expected every minute, with two minutes of grace. Target checks follow
        their own configured interval.
      </p>
    </section>
  );
}
