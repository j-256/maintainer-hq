import {
  ATTENTION_LIMITS,
  attentionHref,
  type AttentionItem,
} from "./attention";
import type { HookResult } from "./hooks";
import type { MonitorResult } from "./monitoring";
import {
  monitorCheckState,
  monitorExecutionState,
} from "./monitoring-freshness";

type Connection = { id: string; name: string };
type ItemDraft = Pick<AttentionItem, "id" | "title" | "reason" | "category"> &
  Partial<AttentionItem>;
export function operationalItem(
  workspaceId: string,
  connection: Connection,
  kind: "hook" | "monitor",
  now: number,
  item: ItemDraft,
): AttentionItem {
  return {
    severity: item.category === "problem" ? "warning" : "info",
    action: kind === "hook" ? "Open Hooks" : "Open Monitoring",
    href: attentionHref(
      kind === "hook" ? "/hooks" : "/monitoring",
      workspaceId,
      { connection: connection.id },
    ),
    source: connection.name,
    connectionId: connection.id,
    resourceKey: null,
    repositoryIds: [],
    projectIds: [],
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ATTENTION_LIMITS.READ_FRESH_MS).toISOString(),
    ...item,
    id: connection.id + ":" + item.id,
  };
}

export function hookAttention(
  workspaceId: string,
  connection: Connection,
  snapshot: HookResult<"snapshot">,
  deliveries: HookResult<"deliveries">,
  now: number,
) {
  const base = (item: ItemDraft) =>
    operationalItem(workspaceId, connection, "hook", now, item);
  const items = deliveries.items.map((delivery) =>
    base({
      id:
        "delivery:" +
        encodeURIComponent(delivery.eventId) +
        ":" +
        encodeURIComponent(delivery.sinkName),
      category: "problem",
      title: "Hook delivery exhausted retries",
      resourceKey: delivery.subscription,
      reason:
        delivery.sinkName +
        ": " +
        delivery.attempts +
        " attempts. Inspect the delivery before reviewing a retry.",
      observedAt: delivery.updatedAt,
      expiresAt: new Date(
        Math.min(now, Date.parse(deliveries.observedAt)) +
          ATTENTION_LIMITS.READ_FRESH_MS,
      ).toISOString(),
      action: "Inspect delivery",
      href: attentionHref("/hooks", workspaceId, {
        connection: connection.id,
        view: "deliveries",
        subscription: delivery.subscription,
        event: delivery.eventId,
        sink: delivery.sinkName,
        status: "exhausted",
      }),
    }),
  );
  const signals = new Map<
    string,
    { records: number; critical: boolean; lastSeenAt: string }
  >();
  for (const signal of snapshot.signals.items) {
    if (
      signal.resolvedAt ||
      !["warning", "error", "critical"].includes(signal.severity)
    )
      continue;
    const existing = signals.get(signal.code);
    signals.set(signal.code, {
      records: (existing?.records ?? 0) + 1,
      critical: signal.severity === "critical" || Boolean(existing?.critical),
      lastSeenAt:
        existing &&
        Date.parse(existing.lastSeenAt) > Date.parse(signal.lastSeenAt)
          ? existing.lastSeenAt
          : signal.lastSeenAt,
    });
  }
  for (const [code, signal] of signals) {
    items.push(
      base({
        id: "signal:" + code,
        category: "problem",
        severity: signal.critical ? "critical" : "warning",
        title: "Hookrelay: " + code.replaceAll("-", " "),
        reason:
          signal.records +
          " unresolved retained signal records in this sample. Connection-wide; no individual repository is identified.",
        observedAt: signal.lastSeenAt,
        expiresAt: new Date(
          Math.min(now, Date.parse(snapshot.observedAt)) +
            ATTENTION_LIMITS.READ_FRESH_MS,
        ).toISOString(),
      }),
    );
  }
  const limited = Boolean(
    deliveries.nextCursor ||
    snapshot.deliveries.truncated ||
    snapshot.signals.truncated,
  );
  if (limited)
    items.push(
      base({
        id: "preview",
        category: "coverage",
        title: "Hook preview is limited",
        reason:
          "Older deliveries or signals are outside this bounded preview. Inspect the provider's paginated views; an empty preview is not an all-clear.",
      }),
    );
  return { items, limited };
}

export function monitorAttention(
  workspaceId: string,
  connection: Connection,
  snapshot: MonitorResult<"snapshot">,
  targets: MonitorResult<"targets">,
  incidents: MonitorResult<"incidents">,
  now: number,
) {
  const base = (item: ItemDraft) =>
    operationalItem(workspaceId, connection, "monitor", now, item);
  const readDeadline = new Date(
    Math.min(now, Date.parse(snapshot.readAt)) + ATTENTION_LIMITS.READ_FRESH_MS,
  ).toISOString();
  const items: AttentionItem[] = [];
  const execution = monitorExecutionState(snapshot.execution, now);
  if (
    !snapshot.runtimeConfigured ||
    !snapshot.configuration ||
    !snapshot.enabled
  )
    items.push(
      base({
        id: "configuration",
        category: "coverage",
        title: "Monitoring is not actively configured",
        reason:
          "Inspect the provider's runtime configuration and probe intent. Disabled or absent monitoring is not healthy evidence.",
        expiresAt: readDeadline,
      }),
    );
  if (execution !== "fresh")
    items.push(
      base({
        id: "scheduler",
        category: "coverage",
        title:
          execution === "stale"
            ? "Monitoring scheduler evidence is overdue"
            : "Monitoring scheduler has not been observed",
        reason:
          "Inspect the last completed run and its deadline. No incidents cannot prove that the scheduled Worker is running.",
        observedAt: snapshot.execution.lastRun?.completedAt ?? null,
        expiresAt: readDeadline,
      }),
    );
  const run = snapshot.execution.lastRun;
  if (execution === "fresh" && run && (run.phaseErrors || run.deliveriesFailed))
    items.push(
      base({
        id: "run-errors",
        category: "problem",
        title: "Monitoring run reported errors",
        reason:
          run.phaseErrors +
          " phase errors and " +
          run.deliveriesFailed +
          " notification failures in the completed run. Target probe outcomes are separate.",
        observedAt: run.completedAt,
        expiresAt: snapshot.execution.freshUntil,
      }),
    );
  const incidentTargets = new Set(
    incidents.items.map((incident) => incident.targetId),
  );
  for (const incident of incidents.items)
    items.push(
      base({
        id: "incident:" + incident.id,
        category: "problem",
        title: "Open monitoring incident",
        resourceKey: incident.targetId,
        reason:
          "Last recorded failure" +
          (incident.latestStatus
            ? ": HTTP " + incident.latestStatus
            : ": " + (incident.errorCode ?? "network error")) +
          ". An open incident is retained state, not proof that the target is failing now.",
        observedAt: incident.lastFailureAt,
        expiresAt: new Date(
          Math.min(now, Date.parse(incidents.readAt)) +
            ATTENTION_LIMITS.READ_FRESH_MS,
        ).toISOString(),
        action: "Inspect incident",
        href: attentionHref("/monitoring", workspaceId, {
          connection: connection.id,
          view: "incidents",
          target: incident.targetId,
          incident: incident.id,
          status: "open",
        }),
      }),
    );
  for (const target of targets.items) {
    const state = monitorCheckState(target.evidence, now);
    const href = attentionHref("/monitoring", workspaceId, {
      connection: connection.id,
      view: "targets",
      target: target.id,
    });
    if (state === "failed" && !incidentTargets.has(target.id))
      items.push(
        base({
          id: "target-failed:" + target.id,
          category: "problem",
          title: "Monitoring check failed",
          resourceKey: target.id,
          reason:
            "A configuration-matching check failed. This may precede the incident threshold.",
          observedAt: target.evidence.check.observedAt,
          expiresAt: target.evidence.check.freshUntil,
          action: "Inspect target",
          href,
        }),
      );
    else if (state !== "passed" && state !== "failed")
      items.push(
        base({
          id: "target-coverage:" + target.id,
          category: "coverage",
          title: "Monitoring check " + state.replaceAll("_", " "),
          resourceKey: target.id,
          reason:
            "Inspect the last check, successful-check deadline and saved configuration before drawing a health conclusion.",
          observedAt:
            target.evidence.check.observedAt ?? target.evidence.observedAt,
          action: "Inspect target",
          href,
          expiresAt: readDeadline,
        }),
      );
  }
  const limited = Boolean(
    targets.nextCursor ||
    incidents.nextCursor ||
    snapshot.openIncidents.truncated ||
    snapshot.pendingDeliveries.truncated,
  );
  if (limited)
    items.push(
      base({
        id: "preview",
        category: "coverage",
        title: "Monitoring preview is limited",
        reason:
          "More targets, incidents or notifications exist outside this preview. Open Monitoring for paginated details.",
        expiresAt: readDeadline,
      }),
    );
  return { items, limited };
}
