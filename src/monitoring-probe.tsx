import { useRef, useState } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, Play } from "lucide-react";
import { MONITOR_LIMITS, monitorProbeInput, monitorProbeResponseSchema, type MonitorProbeResponse } from "../shared/monitoring";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { MonitorTime } from "./monitoring-components";

type ProbeInput = ReturnType<typeof monitorProbeInput.parse>;
type Attempt = { input: ProbeInput; response: MonitorProbeResponse | null };
function loadAttempt(key: string): Attempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const input = monitorProbeInput.safeParse(value?.input);
    const response = monitorProbeResponseSchema.nullable().safeParse(value?.response);
    return input.success && response.success ? { input: input.data, response: response.data } : null;
  } catch { return null; }
}
function remember(key: string, attempt: Attempt) {
  try { sessionStorage.setItem(key, JSON.stringify(attempt)); } catch { /* The live request can still complete without browser storage */ }
}
const FAILURE_MESSAGES: Record<string, string> = {
  monitoring_provider_forbidden: "Probe permission is missing. Ask the connection owner to enable it.",
  monitoring_provider_conflict: "Configuration changed. Refresh the targets before probing again.",
  monitoring_provider_not_found: "Target not found. Refresh the targets.",
  monitoring_provider_unauthorized: "The provider credential expired. Ask the connection owner to restore access.",
  monitoring_provider_unconfigured: "The provider connection needs repair.",
  revision_conflict: "Access or connection changed. Refresh before probing again.",
};

export function MonitoringProbe({ workspaceId, actor, connectionId, connectionRevision, configurationRevision, targetId, allowed, canOperate }: {
  workspaceId: string; actor: string; connectionId: string; connectionRevision: number;
  configurationRevision: number; targetId: string; allowed: boolean; canOperate: boolean;
}) {
  const storageKey = "hq.monitoring.diagnostic.v1:" + JSON.stringify([actor, workspaceId, connectionId, targetId]);
  const [attempt, setAttempt] = useState<Attempt | null>(() => loadAttempt(storageKey));
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const response = attempt?.response;
  const diagnostic = response?.diagnostic;
  const recoverable = Boolean(attempt && (!response || response.status === "running" || response.status === "indeterminate"));
  const mustRecover = Boolean(attempt && (!response || response.status === "running"));
  const changed = Boolean(diagnostic && (!diagnostic.configurationMatches || response!.configurationRevision !== configurationRevision || response!.connectionRevision !== connectionRevision));
  async function run(recover: boolean) {
    if (lock.current || !canOperate || (!recover && !allowed)) return;
    const next: Attempt = recover && attempt ? attempt : {
      input: { workspaceId, connectionId, connectionRevision, configurationRevision, targetId, requestId: crypto.randomUUID() },
      response: null,
    };
    lock.current = true;
    setBusy(true);
    setError("");
    setAttempt(next);
    remember(storageKey, next);
    try {
      const result = monitorProbeResponseSchema.parse(await command<MonitorProbeResponse>(
        "monitoring_probe", next.input, AbortSignal.timeout(MONITOR_LIMITS.PROBE_REQUEST_TIMEOUT_MS),
      ));
      const completed = { ...next, response: result };
      setAttempt(completed);
      remember(storageKey, completed);
    } catch (failure) {
      if (failure instanceof RequestError && failure.status >= 400 && failure.status < 500
        && ![401, 403, 408, 429].includes(failure.status)) {
        setAttempt(null);
        try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage is optional */ }
      }
      setError(failure instanceof RequestError && failure.status > 0 ? failure.message : "Response unavailable. Recover this request before probing again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (!canOperate) return null;
  return (
    <div className="monitor-diagnostic">
      <div className="monitor-probe-actions">
        <Button variant="outline" disabled={busy || mustRecover || !allowed} onClick={() => void run(false)}>
          {busy ? <LoaderCircle size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          {busy ? "Probing..." : attempt && !mustRecover ? "Probe again" : "Probe now"}
        </Button>
        {recoverable && !busy ? (
          <Button variant="outline" onClick={() => void run(true)}>Recover result</Button>
        ) : null}
      </div>
      {busy ? <p className="hook-muted" role="status">Running diagnostic...</p> : null}
      {!busy && diagnostic ? (
        <div className="monitor-diagnostic-result" role="status">
          <div className="monitor-diagnostic-outcome">
            {diagnostic.outcome === "success" ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
            <strong>Diagnostic {diagnostic.outcome === "success" ? "passed" : "failed"}</strong>
            <span>{diagnostic.httpStatus ? "HTTP " + diagnostic.httpStatus : "No HTTP response"}</span>
            <span>{diagnostic.durationMilliseconds} ms</span>
            <MonitorTime value={diagnostic.completedAt} />
          </div>
          {diagnostic.errorCode ? <p>{diagnostic.errorCode.replaceAll("-", " ")}</p> : null}
          {changed ? <p className="monitor-diagnostic-warning">Configuration changed since this diagnostic.</p> : null}
          <span className="hook-muted">Diagnostic only. Scheduled health and incidents are unchanged.</span>
        </div>
      ) : null}
      {!busy && response?.status === "failed" ? (
        <p role="alert">{FAILURE_MESSAGES[response.errorCode ?? ""] ?? "Diagnostic rejected. Refresh the connection and try again."}</p>
      ) : null}
      {!busy && response?.status === "indeterminate" ? <p role="status">Result unavailable. This request will not be repeated.</p> : null}
      {!busy && response?.status === "running" ? <p role="status">Diagnostic still running. Recover its result before probing again.</p> : null}
      {!busy && error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
