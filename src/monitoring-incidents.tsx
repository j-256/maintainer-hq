import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  MONITOR_LIMITS,
  type MonitorConnection,
  type MonitorIncident,
  type MonitorResult,
  type MonitorReview,
} from "../shared/monitoring";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { StatusBadge } from "./components/ui/status";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
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
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { MonitorError, MonitorTime } from "./monitoring-components";
import { MonitoringReview } from "./monitoring-review";
import { RESOURCE_REQUEST_TIMEOUT_MS } from "./resource-repositories";
import { useDateTime } from "./date-time";

export type MonitorResponse<T> = { result: T; capabilities: string[] };
export function MonitorPagination({
  page,
  previous,
  next,
  pending,
  label,
}: {
  page: number;
  previous: (() => void) | null;
  next: (() => void) | null;
  pending: boolean;
  label: string;
}) {
  return (
    <nav className="hook-pagination" aria-label={label + " pagination"}>
      <span>Page {page}</span>
      <div>
        <Button
          variant="outline"
          disabled={!previous || pending}
          onClick={() => previous?.()}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Previous
        </Button>
        <Button
          variant="outline"
          disabled={!next || pending}
          onClick={() => next?.()}
        >
          Next <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
const INCIDENT_STATUS = ["open", "resolved", "all"] as const;
const TRIAGE_LABELS = {
  acknowledged: "Acknowledge",
  snoozed: "Snooze notifications",
  dismissed: "Dismiss",
} as const;
const HOUR_MS = 60 * 60 * 1000;
function IncidentFacts({ incident }: { incident: MonitorIncident }) {
  return (
    <dl className="monitor-target-facts">
      <div>
        <dt>Target</dt>
        <dd>{incident.targetId}</dd>
      </div>
      <div>
        <dt>Endpoint at detection</dt>
        <dd className="monitor-private-url">{incident.targetUrl}</dd>
      </div>
      <div>
        <dt>Opened</dt>
        <dd>
          <MonitorTime value={incident.openedAt} />
        </dd>
      </div>
      <div>
        <dt>Last failure</dt>
        <dd>
          <MonitorTime value={incident.lastFailureAt} />
        </dd>
      </div>
      <div>
        <dt>Latest signal</dt>
        <dd>
          {incident.latestSignal === "probe"
            ? "Endpoint probe"
            : "Cloudflare analytics"}
          {incident.latestStatus ? " / HTTP " + incident.latestStatus : ""}
          {incident.errorCode ? " / " + incident.errorCode : ""}
        </dd>
      </div>
      <div>
        <dt>Acknowledged</dt>
        <dd>
          <MonitorTime value={incident.acknowledgedAt} />
        </dd>
      </div>
      <div>
        <dt>Snoozed until</dt>
        <dd>
          <MonitorTime value={incident.snoozedUntil} />
        </dd>
      </div>
      {incident.resolvedAt ? (
        <>
          <div>
            <dt>Resolved</dt>
            <dd>
              <MonitorTime value={incident.resolvedAt} />
            </dd>
          </div>
          <div>
            <dt>Resolution reason</dt>
            <dd>
              {incident.resolutionReason?.replaceAll("-", " ") ??
                "Not recorded"}
            </dd>
          </div>
        </>
      ) : null}
    </dl>
  );
}
export function MonitoringIncidents({
  snapshot,
  connection,
  status,
  targetId,
  onFilter,
  onInspect,
}: {
  snapshot: Snapshot;
  connection: MonitorConnection;
  status: (typeof INCIDENT_STATUS)[number];
  targetId: string | null;
  onFilter: (status: string, targetId: string | null) => void;
  onInspect: (id: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [filter, setFilter] = useState(targetId ?? "");
  const cursor = cursors.at(-1) ?? null;
  const key = [
    "monitoring",
    workspaceId,
    "incidents",
    connection.id,
    connection.revision,
    status,
    targetId,
  ];
  const query = useQuery({
    queryKey: [...key, cursor],
    queryFn: ({ signal }) =>
      command<MonitorResponse<MonitorResult<"incidents">>>(
        "monitoring_incidents",
        { workspaceId, connectionId: connection.id, status, targetId, cursor },
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
    <section className="hook-section" aria-labelledby="monitor-incidents-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="monitor-incidents-title">Incidents</h2>
          <p>
            Recorded failures and their resolution, not a continuous uptime
            feed.
          </p>
        </div>
        <Button variant="outline" disabled={query.isFetching} onClick={refresh}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh incidents
        </Button>
      </div>
      <div className="hook-filters">
        <div className="hook-field">
          <label htmlFor="monitor-incident-status">Status</label>
          <Select
            value={status}
            onValueChange={(value) => onFilter(value, targetId)}
          >
            <SelectTrigger id="monitor-incident-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INCIDENT_STATUS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "all"
                    ? "All retained incidents"
                    : value === "open"
                      ? "Open"
                      : "Resolved"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <form
          className="hook-filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            onFilter(status, filter.trim() || null);
          }}
        >
          <label htmlFor="monitor-incident-target">Target ID</label>
          <div>
            <Input
              id="monitor-incident-target"
              value={filter}
              maxLength={64}
              placeholder="All targets"
              onChange={(event) => setFilter(event.target.value)}
            />
            <Button variant="outline" type="submit">
              Apply filter
            </Button>
            {targetId ? (
              <Button
                variant="ghost"
                type="button"
                onClick={() => onFilter(status, null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      {query.error ? <MonitorError error={query.error} /> : null}
      {query.isPending ? <p role="status">Loading incidents...</p> : null}
      {data ? (
        <>
          <div className="monitor-card-list">
            {data.items.map((item) => (
              <article className="monitor-card" key={item.id}>
                <div className="hook-section-heading">
                  <h3>{item.targetId}</h3>
                  <StatusBadge
                    tone={item.status === "open" ? "danger" : "success"}
                  >
                    {item.status === "open" ? "Open" : "Resolved"}
                  </StatusBadge>
                </div>
                <p className="hook-muted">
                  {item.latestStatus
                    ? "HTTP " + item.latestStatus
                    : (item.errorCode ?? item.failureKind)}{" "}
                  / Last failure <MonitorTime value={item.lastFailureAt} />
                </p>
                {item.resolutionReason ? (
                  <p>
                    Resolution: {item.resolutionReason.replaceAll("-", " ")}
                  </p>
                ) : null}
                <Button variant="outline" onClick={() => onInspect(item.id)}>
                  Inspect incident
                </Button>
              </article>
            ))}
          </div>
          {!data.items.length ? (
            <div className="hook-empty">
              <h3>
                No {status === "all" ? "retained" : status} incidents match
              </h3>
              <p>
                Absence of incidents does not prove that the provider is running
                or that an endpoint is healthy.
              </p>
            </div>
          ) : null}
          <p className="hook-muted">
            Read <MonitorTime value={data.readAt} />.
          </p>
          <MonitorPagination
            label="Incidents"
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
function TriageForm({
  snapshot,
  connection,
  incident,
  onClose,
  onReceipt,
  returnFocus,
}: {
  snapshot: Snapshot;
  connection: MonitorConnection;
  incident: MonitorIncident;
  onClose: () => void;
  onReceipt: (id: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const [action, setAction] =
    useState<keyof typeof TRIAGE_LABELS>("acknowledged");
  const [hours, setHours] = useState(4);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const attempt = useRef<{
    key: string;
    id: string;
    until: string | null;
  } | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const guard = useCloseGuard(
    busy || Boolean(note) || action !== "acknowledged" || hours !== 4,
    onClose,
  );
  const date = useDateTime();
  async function review(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const key = JSON.stringify([action, hours, note]);
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        id: crypto.randomUUID(),
        until:
          action === "snoozed"
            ? new Date(Date.now() + hours * HOUR_MS).toISOString()
            : null,
      };
    setBusy(true);
    setError(null);
    try {
      const result = await command<MonitorReview>(
        "monitoring_triage_plan",
        {
          workspaceId: snapshot.workspace.id,
          connectionId: connection.id,
          connectionRevision: connection.revision,
          reviewId: attempt.current.id,
          incidentId: incident.id,
          incidentRevision: incident.revision,
          action,
          note: note.trim() || null,
          until: attempt.current.until,
        },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      setReviewId(result.id);
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
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="hook-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Triage incident</DialogTitle>
            <DialogDescription>
              {incident.targetId}. Triage is an operator decision, not proof of
              endpoint recovery. The incident revision is checked again before
              acceptance.
            </DialogDescription>
          </DialogHeader>
          <form className="hook-form" onSubmit={review}>
            {error ? <MonitorError error={error} /> : null}
            <div className="hook-field">
              <label htmlFor="monitor-triage-action">Action</label>
              <Select
                value={action}
                disabled={busy}
                onValueChange={(value) =>
                  setAction(value as keyof typeof TRIAGE_LABELS)
                }
              >
                <SelectTrigger id="monitor-triage-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TRIAGE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="hook-notice">
              {action === "acknowledged"
                ? "Record that this incident has your attention. Probes and notification delivery continue."
                : action === "snoozed"
                  ? "Delay pending problem notifications while probes continue. Recovery notifications and messages already sent are not retracted."
                  : "Resolve by operator decision and suppress pending problem deliveries. Persistent failures can open another incident."}
            </p>
            {action === "snoozed" ? (
              <div className="hook-field">
                <label htmlFor="monitor-snooze-hours">Snooze for (hours)</label>
                <Input
                  id="monitor-snooze-hours"
                  aria-describedby="monitor-snooze-help"
                  type="number"
                  min={1}
                  max={168}
                  required
                  value={Number.isNaN(hours) ? "" : hours}
                  disabled={busy}
                  onChange={(event) => setHours(event.target.valueAsNumber)}
                />
                <p id="monitor-snooze-help" className="hook-muted">
                  The review shows the exact end time in {date.zoneLabel} using
                  your date and clock preferences.
                </p>
              </div>
            ) : null}
            <div className="hook-field">
              <label htmlFor="monitor-triage-note">
                Operator note (optional)
              </label>
              <Textarea
                id="monitor-triage-note"
                aria-describedby="monitor-note-help"
                maxLength={MONITOR_LIMITS.NOTE_BYTES}
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
              <p id="monitor-note-help" className="hook-muted">
                Retained in the provider's incident history. Do not include
                secrets.
              </p>
            </div>
            <div className="hook-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
              <Button ref={reviewButton} type="submit" disabled={busy}>
                {busy ? "Preparing review..." : "Review triage"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      {reviewId ? (
        <MonitoringReview
          snapshot={snapshot}
          planId={reviewId}
          returnFocus={reviewButton.current}
          onClose={() => {
            setReviewId(null);
            attempt.current = null;
          }}
          onOperation={(id) => {
            guard.saved();
            onReceipt(id);
          }}
        />
      ) : null}
    </>
  );
}
export function MonitoringIncidentDetail({
  snapshot,
  connection,
  incidentId,
  onClose,
  onReceipt,
  returnFocus,
}: {
  snapshot: Snapshot;
  connection: MonitorConnection;
  incidentId: string;
  onClose: () => void;
  onReceipt: (id: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [triage, setTriage] = useState<MonitorIncident | null>(null);
  const triageButton = useRef<HTMLButtonElement>(null);
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: [
      "monitoring",
      snapshot.workspace.id,
      "incident",
      connection.id,
      connection.revision,
      incidentId,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<MonitorResponse<MonitorResult<"incident">>>(
        "monitoring_incident",
        {
          workspaceId: snapshot.workspace.id,
          connectionId: connection.id,
          incidentId,
          cursor,
        },
        signal,
      ),
    retry: false,
  });
  const data = query.data?.result;
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          className="monitor-editor-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Monitor incident</DialogTitle>
            <DialogDescription>
              Failure evidence and operator decisions from Endpoint Monitor. A
              resolved incident may reflect a configuration change or dismissal,
              not observed recovery.
            </DialogDescription>
          </DialogHeader>
          {query.isPending ? <p role="status">Loading incident...</p> : null}
          {query.error ? (
            <>
              <MonitorError error={query.error} />
              <Button
                variant="outline"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Retry loading incident
              </Button>
            </>
          ) : null}
          {data ? (
            <>
              <div className="hook-section-heading">
                <Badge variant="outline">
                  {data.incident.status === "open" ? "Open" : "Resolved"}
                </Badge>
                <Button
                  variant="outline"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  Refresh incident
                </Button>
              </div>
              <IncidentFacts incident={data.incident} />
              {data.incident.status === "open" ? (
                canOperate && query.data?.capabilities.includes("triage") ? (
                  <Button
                    ref={triageButton}
                    disabled={query.isError}
                    onClick={() => setTriage(data.incident)}
                  >
                    Triage incident
                  </Button>
                ) : (
                  <p className="permission-notice">
                    {!canOperate
                      ? "Your role can inspect incidents but cannot triage them."
                      : "This provider credential does not grant triage access."}
                  </p>
                )
              ) : null}
              <section
                className="hook-section"
                aria-label="Incident action history"
              >
                <h3>Operator history</h3>
                {data.actions.length ? (
                  <ol className="monitor-action-list">
                    {data.actions.map((action) => (
                      <li key={action.id}>
                        <strong>{TRIAGE_LABELS[action.action]}</strong>
                        <p className="hook-muted">
                          <MonitorTime value={action.createdAt} />
                        </p>
                        {action.note ? <p>{action.note}</p> : null}
                        {action.snoozedUntil ? (
                          <p>
                            Until <MonitorTime value={action.snoozedUntil} />
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No operator decisions in this history page.</p>
                )}
                <MonitorPagination
                  label="Incident history"
                  page={cursors.length}
                  previous={
                    cursors.length > 1
                      ? () => setCursors(cursors.slice(0, -1))
                      : null
                  }
                  next={
                    data.nextCursor
                      ? () => setCursors([...cursors, data.nextCursor])
                      : null
                  }
                  pending={query.isFetching}
                />
              </section>
              <p className="hook-muted">
                Read <MonitorTime value={data.readAt} />.
              </p>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      {triage ? (
        <TriageForm
          snapshot={snapshot}
          connection={connection}
          incident={triage}
          returnFocus={triageButton.current}
          onClose={() => setTriage(null)}
          onReceipt={onReceipt}
        />
      ) : null}
    </>
  );
}
