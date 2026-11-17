import { CAPABILITY } from "../shared/domain";
import { MONITOR_LIMITS, monitorProbeInput, monitorProbeResponseSchema, type MonitorProbeResponse } from "../shared/monitoring";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { callMonitorProvider, MonitorProviderError, monitorActor, monitorProvider } from "./monitoring-client";
import { MonitoringService } from "./monitoring";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

const KIND = "endpoint-monitor.diagnostic";
type ProbeInput = ReturnType<typeof monitorProbeInput.parse>;
type Stored = {
  request: ProbeInput;
  tokenId: string | null;
  memberRevision: number;
  providerIdentity: string;
  response: MonitorProbeResponse;
};
type Operation = { actor_subject: string; result_json: string };

export class MonitoringProbe {
  constructor(readonly context: WorkspaceService) {}
  get db() { return this.context.db; }
  async previous(input: ProbeInput): Promise<MonitorProbeResponse | null> {
    const guard = hookActorGuard(this.context, input.workspaceId, CAPABILITY.OPERATE);
    const row = await this.db.prepare(`SELECT actor_subject,result_json FROM operations WHERE id=? AND workspace_id=? AND kind=? AND ${guard.sql}`)
      .bind(input.requestId, input.workspaceId, KIND, ...guard.values).first<Operation>();
    if (!row) return null;
    const stored = JSON.parse(row.result_json) as Stored;
    if (row.actor_subject !== this.context.principal.subject || stored.tokenId !== (this.context.principal.tokenId ?? null))
      throw new DomainError("not_found", "Diagnostic request not found.", 404);
    if (JSON.stringify(stored.request) !== JSON.stringify(input))
      throw new DomainError("revision_conflict", "This request ID belongs to another diagnostic. Recover its original inputs.", 409);
    if (stored.response.status === "running" && this.context.now() - Date.parse(stored.response.requestedAt) > MONITOR_LIMITS.PROBE_REQUEST_TIMEOUT_MS) {
      const response = { ...stored.response, status: "indeterminate" as const, errorCode: "monitoring_probe_interrupted", completedAt: new Date(this.context.now()).toISOString() };
      await this.db.prepare("UPDATE operations SET status='indeterminate',result_json=?,updated_at=? WHERE id=? AND workspace_id=? AND kind=? AND status='running'")
        .bind(JSON.stringify({ ...stored, response }), response.completedAt, input.requestId, input.workspaceId, KIND).run();
      return this.previous(input);
    }
    return monitorProbeResponseSchema.parse(stored.response);
  }
  async run(raw: unknown): Promise<MonitorProbeResponse> {
    const input = monitorProbeInput.parse(raw);
    const { workspaceId, connectionId, requestId } = input;
    const memberRevision = await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const previous = await this.previous(input);
    if (previous) return previous;
    const monitoring = new MonitoringService(this.context);
    const { row, provider } = await monitoring.active(workspaceId, connectionId);
    if (row.revision !== input.connectionRevision)
      throw new DomainError("revision_conflict", "Connection changed. Refresh before probing.", 409);
    const started = performance.now();
    const now = new Date(this.context.now()).toISOString();
    const response: MonitorProbeResponse = {
      requestId, targetId: input.targetId,
      connectionRevision: input.connectionRevision, configurationRevision: input.configurationRevision,
      status: "running", requestedAt: now, completedAt: null, diagnostic: null, errorCode: null,
    };
    const stored: Stored = { request: input, tokenId: this.context.principal.tokenId ?? null, memberRevision, providerIdentity: provider.identity, response };
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE, memberRevision);
    const claim = await this.db.prepare(`INSERT OR IGNORE INTO operations
      (id,workspace_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
      SELECT ?,?,?,?,'running','Diagnostic probe requested',?,?,? WHERE ${guard.sql}
      AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND credential_ref=?)
      AND NOT EXISTS(SELECT 1 FROM operations WHERE workspace_id=? AND kind=?
        AND json_extract(result_json,'$.request.connectionId')=?
        AND (created_at>? OR (status='running' AND created_at>?)))`)
      .bind(requestId, workspaceId, this.context.principal.subject, KIND, JSON.stringify(stored), now, now, ...guard.values,
        workspaceId, connectionId, row.revision, row.credential_ref,
        workspaceId, KIND, connectionId,
        new Date(this.context.now() - MONITOR_LIMITS.PROBE_COOLDOWN_MS).toISOString(),
        new Date(this.context.now() - MONITOR_LIMITS.PROBE_REQUEST_TIMEOUT_MS).toISOString()).run();
    if (!claim.meta.changes) {
      await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
      const existing = await this.previous(input);
      if (existing) return existing;
      throw new DomainError("monitoring_probe_busy", "A diagnostic is running or was just requested. Wait a few seconds and try again.", 409);
    }
    let submitted = false;
    try {
      const current = await monitoring.active(workspaceId, connectionId);
      const actorId = await monitorActor(this.context.principal.subject);
      const revision = await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
      if (revision !== memberRevision || current.row.revision !== row.revision || current.provider.identity !== provider.identity)
        throw new DomainError("revision_conflict", "Access or connection changed. Refresh before starting another diagnostic.", 409);
      submitted = true;
      const result = await callMonitorProvider(provider, "probe", workspaceId, {
        actorId, targetId: input.targetId, expectedRevision: input.configurationRevision, requestId,
      });
      if (!result.capabilities.includes("probe") || result.result.requestId !== requestId || result.result.targetId !== input.targetId
        || result.result.configurationRevision !== input.configurationRevision)
        throw new MonitorProviderError("metadata_invalid");
      response.diagnostic = result.result;
      response.status = "succeeded";
      const active = await monitoring.connection(workspaceId, connectionId);
      const activeProvider = await monitorProvider(this.context.env, workspaceId, active.credential_ref);
      if (!active.enabled || active.revision !== row.revision || activeProvider.identity !== provider.identity)
        response.diagnostic.configurationMatches = false;
    } catch (error) {
      const rejected = !submitted || (error instanceof MonitorProviderError && ["forbidden", "unauthorized", "not_found", "conflict", "validation", "unconfigured"].includes(error.providerCode));
      response.status = rejected ? "failed" : "indeterminate";
      response.diagnostic = null;
      response.errorCode = error instanceof DomainError ? error.code : "monitoring_provider_unavailable";
    }
    response.completedAt = new Date(this.context.now()).toISOString();
    const summary = response.status === "succeeded" ? "Diagnostic completed: " + (response.diagnostic!.outcome === "success" ? "passed" : "failed")
      : response.status === "failed" ? "Diagnostic request rejected" : "Diagnostic outcome unavailable";
    await this.db.prepare("UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE id=? AND workspace_id=? AND kind=?")
      .bind(response.status, summary, JSON.stringify(stored), response.completedAt, requestId, workspaceId, KIND).run();
    emitDiagnostic({ event: "hq.monitoring.probe", reference: requestId, workspaceId,
      state: response.status, outcome: response.diagnostic?.outcome ?? null, code: response.errorCode,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    return monitorProbeResponseSchema.parse(response);
  }
}
