import { useEffect, useState } from "react";
import { Clock3, Database, Radio, RefreshCw } from "lucide-react";
import { DOCUMENTATION_ORIGIN } from "../shared/documentation";
import { Button } from "./components/ui/button";
import { Disclosure } from "./components/ui/disclosure";
import { StatusIcon, type StatusTone } from "./components/ui/status";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import {
  PUSH_DIAGNOSTIC_LIMITS,
  PUSH_REASON_LABEL,
  PUSH_STATUS_LABEL,
  type PushDiagnostics,
  type PushStatus,
} from "./lib/push-diagnostics";
import { useDateTime } from "./date-time";
import "./connection-details.css";

const RECOVERY: Record<PushStatus, string> = {
  connecting:
    "Waiting for the live connection. Your view can still load over HTTP.",
  live: "Changes arrive automatically. No action needed.",
  renewing:
    "HQ is renewing a bounded connection automatically. Your view and unsaved choices stay in place.",
  reconnecting:
    "HQ is reconnecting automatically. Check current view if you need a fresh read while live delivery recovers.",
  fallback:
    "Live delivery is unavailable. While this tab is visible and online, HQ checks for changes once a minute and keeps trying to reconnect.",
  offline:
    "Reconnect to the network. HQ will catch up automatically and keep your unsaved choices.",
  paused:
    "Return to this tab to resume live updates. Hidden tabs do not keep a live connection or fallback refresh running.",
};

const CONNECTION_TONES: Record<PushStatus, StatusTone> = {
  connecting: "info",
  live: "success",
  renewing: "info",
  reconnecting: "warning",
  fallback: "warning",
  offline: "danger",
  paused: "neutral",
};

type Props = {
  status: PushStatus;
  label: string;
  read: () => PushDiagnostics | null;
  viewLabel: string;
  acceptedAt: string | undefined;
  refreshing: boolean;
  refreshFailed: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
};

function Details({
  status,
  read,
  acceptedAt,
  refreshing,
  refreshFailed,
  canRefresh,
  onRefresh,
}: Props) {
  const dates = useDateTime();
  const [diagnostics, setDiagnostics] = useState<PushDiagnostics | null>(null);
  useEffect(() => {
    const update = () => setDiagnostics(read());
    update();
    const timer = window.setInterval(
      update,
      PUSH_DIAGNOSTIC_LIMITS.DISPLAY_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [read, status]);
  const time = (value: number | null | undefined) => {
    if (value == null) return <span>Not recorded</span>;
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return <span>Not recorded</span>;
    const iso = instant.toISOString();
    return (
      <time dateTime={iso} title={dates.tooltip(iso)}>
        {dates.dateTime(iso, true)}
      </time>
    );
  };
  const interruption = diagnostics?.events.find(
    (event) => !["connected", "hidden", "offline"].includes(event.reason),
  );
  return (
    <>
      <div className="connection-detail-body">
        <section
          className="connection-section connection-summary"
          aria-label="Live transport"
          data-tone={CONNECTION_TONES[status]}
        >
          <h3>
            <StatusIcon tone={CONNECTION_TONES[status]} size={20} />
            {PUSH_STATUS_LABEL[status]}
          </h3>
          <p>{RECOVERY[status]}</p>
          {interruption ? (
            <p className="connection-last-reason">
              <strong>Last reconnect reason: </strong>
              {PUSH_REASON_LABEL[interruption.reason]} ({time(interruption.at)})
            </p>
          ) : null}
        </section>
        <section className="connection-section" aria-label="Current view data">
          <h3>
            <Database size={18} aria-hidden="true" />
            Current view data
          </h3>
          <p role="status">
            {refreshing
              ? "Checking the current view..."
              : refreshFailed
                ? "The view refresh was interrupted. Check the current view to retry."
                : acceptedAt
                  ? "Showing the last accepted HQ data, with live changes applied when received."
                  : "Waiting for the first view to load."}
          </p>
          <dl className="connection-facts">
            <div>
              <dt>Last accepted view data</dt>
              <dd>
                {acceptedAt ? (
                  <time dateTime={acceptedAt} title={dates.tooltip(acceptedAt)}>
                    {dates.dateTime(acceptedAt, true)}
                  </time>
                ) : (
                  "Not received"
                )}
              </dd>
            </div>
          </dl>
          <p className="connection-storage-note">
            A heartbeat does not prove provider health. Check each resource's
            evidence for freshness.
          </p>
        </section>
        <Disclosure
          title="Connection timings"
          icon={Clock3}
          description="Transport responses and reconnect schedule"
        >
          <dl className="connection-facts">
            <div>
              <dt>Last connected</dt>
              <dd>{time(diagnostics?.lastConnectedAt)}</dd>
            </div>
            <div>
              <dt>Last transport response</dt>
              <dd>{time(diagnostics?.lastMessageAt)}</dd>
            </div>
            {diagnostics?.expiresAt ? (
              <div>
                <dt>Connection renews by</dt>
                <dd>{time(diagnostics.expiresAt)}</dd>
              </div>
            ) : null}
            {diagnostics?.nextRetryAt ? (
              <div>
                <dt>Next reconnect attempt</dt>
                <dd>{time(diagnostics.nextRetryAt)}</dd>
              </div>
            ) : null}
            {diagnostics?.nextRefreshAt ? (
              <div>
                <dt>Next fallback check</dt>
                <dd>{time(diagnostics.nextRefreshAt)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="connection-storage-note">
            Times use {dates.zoneLabel}. Connection events stay in this tab and
            clear on reload. No private message contents are recorded.
          </p>
        </Disclosure>
        {diagnostics?.events.length ? (
          <details className="connection-events">
            <summary>Recent connection events</summary>
            <ol>
              {diagnostics.events.map((event, index) => (
                <li key={event.at + ":" + index}>
                  <span>
                    {PUSH_REASON_LABEL[event.reason]}
                    {event.code ? <small> (code {event.code})</small> : null}
                  </span>
                  {time(event.at)}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      <div className="connection-actions">
        <a
          href={DOCUMENTATION_ORIGIN + "/push/#connection-details"}
          target="_blank"
          rel="noopener noreferrer"
        >
          Live updates guide
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <Button
          variant="outline"
          disabled={!canRefresh || refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Check current view
        </Button>
      </div>
    </>
  );
}

export function ConnectionDetails(props: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="connection-trigger"
          aria-label="Connection details"
          title="Connection details"
        >
          <StatusIcon
            tone={
              props.refreshFailed ? "warning" : CONNECTION_TONES[props.status]
            }
            size={15}
          />
          <span>{props.label}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-heading">
            <Radio size={20} aria-hidden="true" />
            Connection details
          </DialogTitle>
          <DialogDescription>
            Live delivery for {props.viewLabel}. Refreshing checks HQ data, not
            providers.
          </DialogDescription>
        </DialogHeader>
        <Details {...props} />
      </DialogContent>
    </Dialog>
  );
}
