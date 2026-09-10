import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  History,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  MONITOR_LIMITS,
  type MonitorConnection,
  type MonitorResult,
  type MonitorReview,
} from "../shared/monitoring";
import type { ResourceLinks } from "../shared/resource-links";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  RelatedRepositoryLinks,
  RepositoryContext,
  ResourceRepositoriesEditor,
  RESOURCE_REQUEST_TIMEOUT_MS,
} from "./resource-repositories";
import {
  MonitorError,
  MonitorTime,
  MonitorTargetFacts,
} from "./monitoring-components";
import {
  MonitorEvidence,
  MonitorCheckTimes,
  MonitorExecution,
  MonitoringEvidenceClock,
} from "./monitoring-evidence";
import { MonitoringConfigurationEditor } from "./monitoring-editor";
import { MonitoringConnectionEditor } from "./monitoring-connection";
import { MonitoringReview } from "./monitoring-review";
import {
  MonitoringIncidentDetail,
  MonitoringIncidents,
  MonitorPagination,
  type MonitorResponse,
} from "./monitoring-incidents";
import { useDateTime } from "./date-time";
import { ResourceProjectEditor } from "./resource-project";
import "./sources.css";
import "./hooks.css";
import "./monitoring.css";

const VIEWS = ["targets", "incidents", "history"] as const;
type TargetsResponse = MonitorResponse<MonitorResult<"targets">> & {
  repositoryLinks: ResourceLinks[];
};
function MonitoringSummary({
  data,
  onIncidents,
}: {
  data: MonitorResult<"snapshot">;
  onIncidents: () => void;
}) {
  return (
    <section className="hook-summary" aria-label="Endpoint Monitor evidence">
      <MonitorExecution data={data} />
      <dl className="hook-metrics">
        <div>
          <dt>Configured targets</dt>
          <dd>{data.configuration?.targetCount ?? "Not configured"}</dd>
        </div>
        <div>
          <dt>Open incidents</dt>
          <dd>
            <Button variant="ghost" onClick={onIncidents}>
              {data.openIncidents.count}
              {data.openIncidents.truncated ? "+" : ""}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </dd>
        </div>
        <div>
          <dt>Pending notifications</dt>
          <dd>
            {data.pendingDeliveries.count}
            {data.pendingDeliveries.truncated ? "+" : ""}
          </dd>
        </div>
        <div>
          <dt>Probe intent</dt>
          <dd className="monitor-metric-label">
            {!data.runtimeConfigured
              ? "Not configured"
              : data.enabled
                ? "Enabled"
                : "Disabled"}
          </dd>
        </div>
      </dl>
      <p className="hook-muted">
        Read <MonitorTime value={data.readAt} />.{" "}
        {data.configuration
          ? "Configuration revision " + data.configuration.revision + "."
          : "No executing target configuration is saved."}{" "}
        {data.openIncidents.truncated || data.pendingDeliveries.truncated
          ? "A plus sign marks a bounded count; additional records are not included."
          : "Counts cover retained records at read time."}
      </p>
      <details className="hook-signals">
        <summary>What this status can tell you</summary>
        <p>
          Completed runs publish a bounded snapshot with check outcomes and the
          configuration they used. Scheduler completion and each target's last
          check have separate deadlines. A pass proves the recorded check met
          its expectations; it is not continuous uptime or incident resolution.
          Cached evidence continues to age even when a refresh fails.
        </p>
        <p>
          Notification intent:{" "}
          {data.deliveryEnabled === null
            ? "not configured"
            : data.deliveryEnabled
              ? "enabled"
              : "disabled"}
          . Analytics signal intent:{" "}
          {data.analyticsEnabled === null
            ? "not configured"
            : data.analyticsEnabled
              ? "enabled"
              : "disabled"}
          . These are configuration settings, not delivery or execution
          evidence.
        </p>
      </details>
    </section>
  );
}
function MonitoringTargets({
  snapshot,
  connection,
  canConfigure,
  onInspect,
  onAdd,
  onDefaults,
}: {
  snapshot: Snapshot;
  connection: MonitorConnection;
  canConfigure: boolean;
  onInspect: (id: string) => void;
  onAdd: () => void;
  onDefaults: () => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const key = [
    "monitoring",
    workspaceId,
    "targets",
    connection.id,
    connection.revision,
  ];
  const query = useQuery({
    queryKey: [...key, cursor],
    queryFn: ({ signal }) =>
      command<TargetsResponse>(
        "monitoring_targets",
        { workspaceId, connectionId: connection.id, cursor },
        signal,
      ),
    staleTime: MONITOR_LIMITS.REFRESH_MS,
    refetchInterval: cursor ? false : MONITOR_LIMITS.REFRESH_MS,
  });
  const data = query.data?.result;
  function refresh() {
    if (!cursor) void query.refetch();
    else {
      void client.invalidateQueries({ queryKey: [...key, null] });
      setCursors([null]);
    }
  }
  return (
    <section className="hook-section" aria-labelledby="monitor-targets-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="monitor-targets-title">Monitor targets</h2>
          <p>Endpoint intent, retained evidence, and related repositories.</p>
        </div>
        <div className="hook-actions">
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={refresh}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh targets
          </Button>
          {canConfigure ? (
            <>
              <Button variant="outline" onClick={onDefaults}>
                <Settings2 size={16} aria-hidden="true" /> Schedule and defaults
              </Button>
              <Button onClick={onAdd}>
                <Plus size={16} aria-hidden="true" /> Add target
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {query.error ? <MonitorError error={query.error} /> : null}
      {query.isPending ? <p role="status">Loading monitor targets...</p> : null}
      {data ? (
        <>
          <div className="monitor-card-list">
            {data.items.map((target) => (
              <article className="monitor-card" key={target.id}>
                <div className="hook-section-heading">
                  <h3>{target.id}</h3>
                  <MonitorEvidence evidence={target.evidence} />
                </div>
                <p className="monitor-private-url">{target.url}</p>
                <MonitorCheckTimes evidence={target.evidence} />
                <p className="hook-muted">
                  {target.method} /{" "}
                  {target.expectedStatuses?.join(", ") ?? "Reachability"} /{" "}
                  {target.timeoutMilliseconds / 1000}s timeout
                </p>
                <RelatedRepositoryLinks
                  snapshot={snapshot}
                  ids={
                    query.data!.repositoryLinks.find(
                      (value) => value.resourceKey === target.id,
                    )?.repositoryIds ?? []
                  }
                />
                <Button variant="outline" onClick={() => onInspect(target.id)}>
                  Inspect target
                </Button>
              </article>
            ))}
          </div>
          {!data.items.length ? (
            <div className="hook-empty">
              <Activity size={28} aria-hidden="true" />
              <h3>No targets configured</h3>
              <p>
                {canConfigure
                  ? "Add a target to define its endpoint and response checks. You will review the change before it is saved to the provider."
                  : "A maintainer with provider configuration access can add targets. This is an empty configuration, not a health result."}
              </p>
            </div>
          ) : null}
          <p className="hook-muted">
            Read <MonitorTime value={data.readAt} />.
          </p>
          <MonitorPagination
            label="Targets"
            page={cursors.length}
            previous={
              cursors.length > 1 ? () => setCursors(cursors.slice(0, -1)) : null
            }
            next={
              data.nextCursor
                ? () => setCursors([...cursors, data.nextCursor])
                : null
            }
            pending={query.isFetching}
          />
        </>
      ) : null}
    </section>
  );
}
function MonitoringTargetDetail({
  snapshot,
  connection,
  targetId,
  onClose,
  onEdit,
  onIncidents,
  onReceipt,
  returnFocus,
}: {
  snapshot: Snapshot;
  connection: MonitorConnection;
  targetId: string;
  onClose: () => void;
  onEdit: () => void;
  onIncidents: () => void;
  onReceipt: (id: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const [params] = useSearchParams();
  const [linking, setLinking] = useState(false);
  const [projectLinking, setProjectLinking] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const linkButton = useRef<HTMLButtonElement>(null);
  const attempt = useRef<{ revision: number; id: string } | null>(null);
  const workspaceId = snapshot.workspace.id;
  const query = useQuery({
    queryKey: [
      "monitoring",
      workspaceId,
      "target",
      connection.id,
      connection.revision,
      targetId,
    ],
    queryFn: ({ signal }) =>
      command<TargetsResponse>(
        "monitoring_target",
        { workspaceId, connectionId: connection.id, targetId },
        signal,
      ),
    retry: false,
  });
  const data = query.data?.result;
  const target = data?.items[0];
  const canConfigure =
    snapshot.capabilities.includes(CAPABILITY.OPERATE) &&
    query.data?.capabilities.includes("configure");
  async function remove() {
    if (busy || !data?.configuration || !target) return;
    const revision = data.configuration.revision;
    if (attempt.current?.revision !== revision)
      attempt.current = { revision, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const prepared = await command<MonitorReview>(
        "monitoring_configuration_plan",
        {
          workspaceId,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          configurationRevision: revision,
          reviewId: attempt.current.id,
          change: { kind: "target", action: "remove", targetId, target: null },
        },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      onReceipt(prepared.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent
          className="monitor-editor-dialog"
          showCloseButton={!busy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{targetId}</DialogTitle>
            <DialogDescription>
              Saved endpoint intent and retained evidence. Repository links are
              HQ metadata and do not change probes or notifications.
            </DialogDescription>
          </DialogHeader>
          {query.isPending ? <p role="status">Loading target...</p> : null}
          {query.error || error ? (
            <MonitorError error={error ?? query.error} />
          ) : null}
          {notice ? (
            <p className="save-notice" role="status">
              {notice}
            </p>
          ) : null}
          {target ? (
            <>
              <MonitorEvidence evidence={target.evidence} />
              <MonitorCheckTimes evidence={target.evidence} />
              <MonitorTargetFacts target={target} />
              <p className="hook-muted">
                Evidence recorded{" "}
                <MonitorTime value={target.evidence.observedAt} />.{" "}
                {target.evidence.configurationMatches === false
                  ? "This evidence belongs to a different configuration."
                  : "Exceptional-state evidence is separate from completed-run check results."}
                {target.evidence.status
                  ? " HTTP " + target.evidence.status + "."
                  : ""}
                {target.evidence.errorCode
                  ? " " + target.evidence.errorCode + "."
                  : ""}
              </p>
              <RelatedRepositoryLinks
                snapshot={snapshot}
                ids={
                  query.data!.repositoryLinks.find(
                    (value) => value.resourceKey === targetId,
                  )?.repositoryIds ?? []
                }
              />
            </>
          ) : data ? (
            <p className="hook-notice">
              This target is no longer in the executing configuration. Its
              repository links and historical activity remain available.
            </p>
          ) : null}
          <div className="hook-actions">
            <Button
              ref={linkButton}
              variant="outline"
              disabled={busy}
              onClick={() => setLinking(true)}
            >
              Related repositories
            </Button>
            <Button
              ref={projectButton}
              variant="outline"
              disabled={busy}
              onClick={() => setProjectLinking(true)}
            >
              Project association
            </Button>
            <Button variant="outline" disabled={busy} onClick={onIncidents}>
              View incidents
            </Button>
            <Button
              variant="ghost"
              disabled={busy || query.isFetching}
              onClick={() => void query.refetch()}
            >
              Reload target
            </Button>
            {target && canConfigure ? (
              <>
                <Button disabled={busy || query.isError} onClick={onEdit}>
                  Edit target
                </Button>
                <Button
                  variant="outline"
                  className="monitor-remove"
                  disabled={busy || query.isError}
                  onClick={() => void remove()}
                >
                  {busy ? "Preparing review..." : "Review removal"}
                </Button>
              </>
            ) : null}
          </div>
          {target && !canConfigure ? (
            <p className="permission-notice">
              {!snapshot.capabilities.includes(CAPABILITY.OPERATE)
                ? "Your role can inspect targets but cannot change provider configuration."
                : "This provider credential allows reads but not configuration changes."}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      {projectLinking ? (
        <ResourceProjectEditor
          snapshot={snapshot}
          reference={{
            workspaceId,
            kind: "monitor",
            connectionId: connection.id,
            resourceKey: targetId,
          }}
          suggestedProjectId={params.get("project") ?? undefined}
          returnFocus={projectButton.current}
          onClose={() => setProjectLinking(false)}
          onSaved={() =>
            setNotice(
              "Project association saved. Endpoint Monitor configuration is unchanged.",
            )
          }
        />
      ) : null}
      {linking ? (
        <ResourceRepositoriesEditor
          snapshot={snapshot}
          reference={{
            workspaceId,
            kind: "monitor",
            connectionId: connection.id,
            resourceKey: targetId,
          }}
          suggestedRepositoryId={
            snapshot.repositories.find(
              (value) => value.id === params.get("repository"),
            )?.id
          }
          returnFocus={linkButton.current}
          onClose={() => setLinking(false)}
          onSaved={() =>
            setNotice(
              "Repository links saved. Endpoint Monitor configuration is unchanged.",
            )
          }
        />
      ) : null}
    </>
  );
}
function MonitoringHistory({
  snapshot,
  onReceipt,
}: {
  snapshot: Snapshot;
  onReceipt: (id: string) => void;
}) {
  const query = useQuery({
    queryKey: ["monitoring", snapshot.workspace.id, "history"],
    queryFn: ({ signal }) =>
      command<
        {
          id: string;
          planId: string;
          status: string;
          summary: string;
          updatedAt: string;
        }[]
      >("monitoring_history", { workspaceId: snapshot.workspace.id }, signal),
  });
  return (
    <section className="hook-section" aria-labelledby="monitor-history-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="monitor-history-title">Workspace monitoring operations</h2>
          <p>
            The latest {MONITOR_LIMITS.HISTORY} operations requested through HQ,
            across its monitoring connections. Provider incident history also
            includes decisions made outside HQ.
          </p>
        </div>
        <History size={22} aria-hidden="true" />
      </div>
      {query.error ? <MonitorError error={query.error} /> : null}
      {query.isPending ? (
        <p role="status">Loading operation receipts...</p>
      ) : null}
      {query.data ? (
        query.data.length ? (
          <div className="hook-history">
            {query.data.map((item) => (
              <article key={item.id}>
                <div>
                  <Badge variant="outline">
                    {item.status === "succeeded"
                      ? "Accepted"
                      : item.status === "failed"
                        ? "Not accepted"
                        : "Needs reconciliation"}
                  </Badge>
                  <p>{item.summary}</p>
                  <MonitorTime value={item.updatedAt} />
                </div>
                <Button
                  variant="outline"
                  onClick={() => onReceipt(item.planId)}
                >
                  Open receipt
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <div className="hook-empty">
            <History size={28} aria-hidden="true" />
            <h3>No monitoring operations requested through HQ</h3>
            <p>
              Confirmed changes and their recovery receipts will appear here.
              Reading or preparing a review does not execute it.
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}
export function MonitoringView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <MonitoringEvidenceClock>
      <MonitoringWorkspace snapshot={snapshot} />
    </MonitoringEvidenceClock>
  );
}
function MonitoringWorkspace({ snapshot }: { snapshot: Snapshot }) {
  const [params, setParams] = useSearchParams();
  const [editingConnection, setEditingConnection] = useState<string | null>(
    null,
  );
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  const workspaceId = snapshot.workspace.id;
  const date = useDateTime();
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const connections = useQuery({
    queryKey: ["monitoring", workspaceId, "connections"],
    queryFn: ({ signal }) =>
      command<MonitorConnection[]>(
        "monitoring_connections",
        { workspaceId },
        signal,
      ),
  });
  const connectionId = params.get("connection") ?? connections.data?.[0]?.id;
  const selected = connections.data?.find((value) => value.id === connectionId);
  const active = Boolean(selected?.enabled && selected.available);
  const view = VIEWS.find((value) => value === params.get("view")) ?? "targets";
  const targetId = params.get("target");
  const incidentId = params.get("incident");
  const planId = params.get("review");
  const status =
    params.get("status") === "resolved"
      ? "resolved"
      : params.get("status") === "all"
        ? "all"
        : "open";
  const summary = useQuery({
    queryKey: [
      "monitoring",
      workspaceId,
      "snapshot",
      connectionId,
      selected?.revision,
    ],
    queryFn: ({ signal }) =>
      command<MonitorResponse<MonitorResult<"snapshot">>>(
        "monitoring_snapshot",
        { workspaceId, connectionId },
        signal,
      ),
    enabled: active && view !== "history",
    staleTime: MONITOR_LIMITS.REFRESH_MS,
    refetchInterval: MONITOR_LIMITS.REFRESH_MS,
  });
  const canConfigure =
    snapshot.capabilities.includes(CAPABILITY.OPERATE) &&
    Boolean(summary.data?.capabilities.includes("configure")) &&
    !summary.isError;
  function navigate(fields: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.set("workspace", workspaceId);
    if (connectionId) next.set("connection", connectionId);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  }
  function rememberFocus() {
    focus.current = document.activeElement as HTMLElement | null;
  }
  function receipt(id: string) {
    navigate({ review: id, target: null, incident: null });
  }
  return (
    <div className="hooks-workspace monitoring-workspace">
      <RepositoryContext snapshot={snapshot} section="monitoring" />
      <div className="page-heading">
        <div>
          <div className="eyebrow">ENDPOINT OPERATIONS</div>
          <h1 tabIndex={-1}>Monitoring</h1>
          <p>
            Endpoint intent, failure evidence, and deliberate triage. Times use{" "}
            {date.zoneLabel}.
          </p>
        </div>
        {canAdmin ? (
          <Button
            onClick={() => {
              rememberFocus();
              setEditingConnection(":new");
            }}
          >
            <Plus size={16} aria-hidden="true" /> Connect Endpoint Monitor
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p className="save-notice" role="status">
          {notice}
        </p>
      ) : null}
      {connections.error ? (
        <>
          <MonitorError error={connections.error} />
          <Button
            variant="outline"
            disabled={connections.isFetching}
            onClick={() => void connections.refetch()}
          >
            Retry loading connections
          </Button>
        </>
      ) : null}
      {connections.isPending ? (
        <p role="status">Loading monitoring connections...</p>
      ) : null}
      {connections.data?.length === 0 ? (
        <div className="hook-empty">
          <Activity size={32} aria-hidden="true" />
          <h2>Bring endpoint monitoring into view</h2>
          <p>
            Connect Endpoint Monitor to manage targets and inspect health
            checks, scheduler runs, and incidents.
          </p>
          {!canAdmin ? <p>Ask a workspace owner to add a connection.</p> : null}
        </div>
      ) : null}
      {connections.data?.length ? (
        <div className="hook-connection-bar">
          <div className="hook-field">
            <label htmlFor="monitor-connection">Connection</label>
            <Select
              value={selected?.id ?? ""}
              onValueChange={(id) =>
                navigate({
                  connection: id,
                  target: null,
                  incident: null,
                  review: null,
                })
              }
            >
              <SelectTrigger
                id="monitor-connection"
                aria-label="Endpoint Monitor connection"
              >
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.data.map((value) => (
                  <SelectItem key={value.id} value={value.id}>
                    {value.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected ? (
            <>
              <Badge variant="outline">
                {!selected.enabled
                  ? "Disabled in HQ"
                  : selected.available
                    ? "Configured"
                    : "Provider unavailable"}
              </Badge>
              <span className="hook-muted">
                {selected.providerName ?? "Saved provider reference"}
              </span>
              {canAdmin ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    rememberFocus();
                    setEditingConnection(selected.id);
                  }}
                >
                  <Settings2 size={16} aria-hidden="true" /> Connection settings
                </Button>
              ) : null}
            </>
          ) : (
            <p className="hook-notice">
              The selected connection is not available in this workspace.
            </p>
          )}
        </div>
      ) : null}
      <nav className="hook-views" aria-label="Monitoring views">
        {VIEWS.map((value) => (
          <Button
            key={value}
            variant={value === view ? "secondary" : "ghost"}
            aria-current={value === view ? "page" : undefined}
            onClick={() =>
              navigate({ view: value, target: null, incident: null })
            }
          >
            {value === "history"
              ? "Operations"
              : value === "targets"
                ? "Targets"
                : "Incidents"}
          </Button>
        ))}
      </nav>
      {view === "history" ? (
        <MonitoringHistory
          snapshot={snapshot}
          onReceipt={(id) => {
            rememberFocus();
            receipt(id);
          }}
        />
      ) : selected ? (
        active ? (
          <>
            {summary.error ? (
              <>
                <MonitorError error={summary.error} />
                <Button
                  variant="outline"
                  disabled={summary.isFetching}
                  onClick={() => void summary.refetch()}
                >
                  Retry provider summary
                </Button>
              </>
            ) : null}
            {summary.isPending ? (
              <p role="status">Reading provider evidence...</p>
            ) : summary.data ? (
              <MonitoringSummary
                data={summary.data.result}
                onIncidents={() =>
                  navigate({ view: "incidents", status: "open", target: null })
                }
              />
            ) : null}
            {view === "targets" ? (
              <MonitoringTargets
                key={selected.id + "/" + selected.revision}
                snapshot={snapshot}
                connection={selected}
                canConfigure={canConfigure}
                onInspect={(id) => {
                  rememberFocus();
                  navigate({ target: id });
                }}
                onAdd={() => {
                  rememberFocus();
                  setEditingTarget(":new");
                }}
                onDefaults={() => {
                  rememberFocus();
                  setEditingTarget(":defaults");
                }}
              />
            ) : (
              <MonitoringIncidents
                key={JSON.stringify([
                  selected.id,
                  selected.revision,
                  status,
                  targetId,
                ])}
                snapshot={snapshot}
                connection={selected}
                status={status}
                targetId={targetId}
                onFilter={(status, target) =>
                  navigate({ status, target, incident: null })
                }
                onInspect={(id) => {
                  rememberFocus();
                  navigate({ incident: id });
                }}
              />
            )}
          </>
        ) : (
          <div className="hook-empty">
            <h2>
              {selected.enabled
                ? "Provider connection unavailable"
                : "This HQ connection is disabled"}
            </h2>
            <p>
              No new reads or changes will be sent through this connection.
              Endpoint Monitor's own probes and notifications are not stopped by
              this setting. Previously submitted operation receipts remain under
              Operations.
            </p>
          </div>
        )
      ) : null}
      {editingConnection ? (
        <MonitoringConnectionEditor
          key={editingConnection}
          initial={connections.data?.find(
            (value) => value.id === editingConnection,
          )}
          snapshot={snapshot}
          returnFocus={focus.current}
          onClose={() => setEditingConnection(null)}
          onSaved={(value) => {
            setNotice(
              "Connection saved. Provider target and runtime configuration is unchanged.",
            );
            navigate({ connection: value.id });
          }}
        />
      ) : null}
      {active &&
      selected &&
      targetId &&
      view === "targets" &&
      !editingTarget &&
      !planId ? (
        <MonitoringTargetDetail
          key={selected.id + "/" + targetId}
          snapshot={snapshot}
          connection={selected}
          targetId={targetId}
          returnFocus={focus.current}
          onClose={() => navigate({ target: null })}
          onEdit={() => setEditingTarget(targetId)}
          onIncidents={() =>
            navigate({ view: "incidents", status: "all", target: targetId })
          }
          onReceipt={receipt}
        />
      ) : null}
      {active && selected && editingTarget ? (
        <MonitoringConfigurationEditor
          key={selected.id + "/" + editingTarget}
          snapshot={snapshot}
          connection={selected}
          targetId={editingTarget.startsWith(":") ? undefined : editingTarget}
          defaults={editingTarget === ":defaults"}
          returnFocus={focus.current}
          onClose={() => setEditingTarget(null)}
          onReceipt={receipt}
        />
      ) : null}
      {active && selected && incidentId && !planId ? (
        <MonitoringIncidentDetail
          key={selected.id + "/" + incidentId}
          snapshot={snapshot}
          connection={selected}
          incidentId={incidentId}
          returnFocus={focus.current}
          onClose={() => navigate({ incident: null })}
          onReceipt={receipt}
        />
      ) : null}
      {planId ? (
        <MonitoringReview
          key={planId}
          snapshot={snapshot}
          planId={planId}
          returnFocus={focus.current}
          onClose={() => navigate({ review: null })}
        />
      ) : null}
    </div>
  );
}
