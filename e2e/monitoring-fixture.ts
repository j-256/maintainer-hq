import type { Page } from "@playwright/test";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Repository,
} from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";
import {
  MONITOR_DEFAULTS,
  type MonitorChange,
  type MonitorConfiguration,
  type MonitorConnection,
  type MonitorIncident,
  type MonitorReview,
  type MonitorTarget,
  type MonitorObservedTarget,
  type MonitorResult,
} from "../shared/monitoring";
import type { ResourceLinks } from "../shared/resource-links";
import { HOOK_CONNECTION, HOOK_DELIVERY } from "./hooks-fixture";

export const MONITOR_TIME = "2026-09-06T10:00:00.000Z";
export const MONITOR_CONNECTION: MonitorConnection = {
  id: "monitor-test",
  name: "Synthetic monitoring",
  revision: 1,
  enabled: true,
  providerRef: "primary",
  providerName: "Synthetic provider",
  available: true,
  projectId: null,
};
export const MONITOR_TARGET: MonitorTarget = {
  id: "synthetic-health",
  url: "https://example.com/health",
  method: "GET",
  failureThreshold: 2,
  recoveryThreshold: 2,
  timeoutMilliseconds: 10000,
  expectedStatuses: [200],
  expect: {
    contentType: "application/json",
    jsonSubset: { ready: true, build: { channel: "stable" } },
  },
};
export const MONITOR_REPOSITORIES: Repository[] = ["hq", "shared"].map(
  (id) => ({
    id: "monitor-repo-" + id,
    workspaceId: "development",
    fullName: "example/" + id,
    description: "Synthetic repository fixture",
    projectId: "development-default",
    classification: "maintained",
    lifecycle: "active",
    revision: 1,
    updatedAt: MONITOR_TIME,
    expectations: { ...DEFAULT_EXPECTATIONS },
  }),
);
export const MONITOR_INCIDENT: MonitorIncident = {
  id: "synthetic-incident",
  targetId: MONITOR_TARGET.id,
  targetUrl: MONITOR_TARGET.url,
  revision: 1,
  status: "open",
  acknowledgedAt: null,
  configFingerprint: "sha256:" + "a".repeat(64),
  errorCode: null,
  failureKind: "http",
  failureThreshold: 2,
  firstObservedAt: MONITOR_TIME,
  firstStatus: 520,
  lastFailureAt: MONITOR_TIME,
  latestSignal: "probe",
  latestStatus: 520,
  openedAt: MONITOR_TIME,
  recoveryThreshold: 2,
  requestCount: null,
  resolutionReason: null,
  resolvedAt: null,
  snoozedUntil: null,
};
export async function mockMonitoring(
  page: Page,
  options: { empty?: boolean; viewer?: boolean } = {},
) {
  const state = {
    connections: options.empty
      ? ([] as MonitorConnection[])
      : [{ ...MONITOR_CONNECTION }],
    configuration: {
      defaults: { ...MONITOR_DEFAULTS },
      schemaVersion: 2,
      targets: [structuredClone(MONITOR_TARGET)],
    } as MonitorConfiguration,
    revision: 1,
    incident: structuredClone(MONITOR_INCIDENT),
    links: new Map<string, ResourceLinks>(),
    review: null as MonitorReview | null,
    calls: [] as { name: string; input: Record<string, unknown> }[],
    conflict: false,
    linkConflict: false,
    rejectRead: false,
    loseApplyResponse: false,
    applies: 0,
    check: {
      state: "unobserved",
      observedAt: null,
      lastSuccessAt: null,
      freshUntil: null,
      scheduledAt: null,
      configurationRevision: null,
      configurationMatches: null,
      status: null,
      errorCode: null,
    } as MonitorObservedTarget["evidence"]["check"],
    execution: {
      state: "unobserved",
      freshUntil: null,
      expectedIntervalSeconds: 60,
      retainedRunLimit: 120,
      lastRun: null,
    } as MonitorResult<"snapshot">["execution"],
    failEvidenceRead: false,
  };
  const links = (kind: "monitor" | "hook", key: string) => {
    const id = kind + "/" + key;
    if (!state.links.has(id))
      state.links.set(id, {
        workspaceId: "development",
        kind,
        connectionId:
          kind === "monitor" ? MONITOR_CONNECTION.id : HOOK_CONNECTION.id,
        resourceKey: key,
        revision: 1,
        connectionRevision: 1,
        updatedAt: MONITOR_TIME,
        repositoryIds: MONITOR_REPOSITORIES.map((repository) => repository.id),
      });
    return state.links.get(id)!;
  };
  links("monitor", MONITOR_TARGET.id);
  links("hook", HOOK_DELIVERY.subscription);
  const metadata = () => ({
    configFingerprint: "sha256:" + "a".repeat(64),
    revision: state.revision,
    targetCount: state.configuration.targets.length,
    updatedAt: MONITOR_TIME,
    updatedBy: "synthetic-operator",
    updatedWorkspace: "development",
  });
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: MONITOR_REPOSITORIES,
    projects: [],
    ...(options.viewer
      ? {
          capabilities: [CAPABILITY.READ],
          workspace: { ...snapshot.workspace, role: "viewer" },
        }
      : {}),
  }));
  await page.route(
    /\/api\/commands\/(monitoring_.*|resource_repositories(?:_save)?|repository_resources|activity_feed)$/,
    async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
      const input = route.request().postDataJSON() as Record<string, unknown>;
      state.calls.push({ name, input });
      const fail = (message: string, status = 409) =>
        route.fulfill({
          status,
          json: { error: { code: "revision_conflict", message } },
        });
      const envelope = (result: unknown) => ({
        result,
        capabilities: options.viewer
          ? ["read"]
          : ["read", "configure", "triage"],
      });
      const targets = (items: MonitorTarget[], nextCursor: string | null) => ({
        ...envelope({
          readAt: MONITOR_TIME,
          configuration: metadata(),
          nextCursor,
          items: items.map((target) => ({
            ...target,
            evidence: {
              state: "unobserved",
              observedAt: null,
              incidentId: null,
              configurationMatches: null,
              status: null,
              errorCode: null,
              check: state.check,
            },
          })),
        }),
        repositoryLinks: items.map((target) => links("monitor", target.id)),
      });
      let result: unknown;
      switch (name) {
        case "monitoring_connections":
          result = state.connections;
          break;
        case "monitoring_providers":
          result = [
            { id: "primary", name: "Synthetic provider", available: true },
          ];
          break;
        case "monitoring_connection_save":
          if (state.conflict)
            return fail(
              "Settings changed. Load saved settings; keep your draft.",
            );
          state.connections = [
            {
              ...MONITOR_CONNECTION,
              ...(input.connection as object),
              id: String(input.connectionId),
              revision: Number(input.revision) + 1,
            },
          ];
          result = state.connections[0];
          break;
        case "monitoring_snapshot":
          if (state.failEvidenceRead)
            return fail("Synthetic evidence read failure", 503);
          result = envelope({
            readAt: MONITOR_TIME,
            configuration: metadata(),
            runtimeConfigured: true,
            enabled: true,
            deliveryEnabled: true,
            analyticsEnabled: false,
            openIncidents: { count: 1, truncated: false },
            pendingDeliveries: { count: 50, truncated: true },
            execution: state.execution,
          });
          break;
        case "monitoring_configuration":
          if (state.rejectRead)
            return fail(
              "Synthetic read failure. Your draft is preserved.",
              503,
            );
          result = envelope({
            readAt: MONITOR_TIME,
            configuration: {
              ...metadata(),
              configuration: state.configuration,
            },
          });
          break;
        case "monitoring_targets":
          if (state.failEvidenceRead)
            return fail("Synthetic evidence read failure", 503);
          result = input.cursor
            ? targets([{ ...MONITOR_TARGET, id: "second-page" }], null)
            : targets(state.configuration.targets, "synthetic-next-page");
          break;
        case "monitoring_target":
          result = targets(
            state.configuration.targets.filter(
              (value) => value.id === input.targetId,
            ),
            null,
          );
          break;
        case "monitoring_incidents":
          result = envelope({
            readAt: MONITOR_TIME,
            items:
              input.status === "resolved" ||
              (input.targetId && input.targetId !== MONITOR_TARGET.id)
                ? []
                : [state.incident],
            nextCursor: input.cursor ? null : "synthetic-history-page",
          });
          break;
        case "monitoring_incident":
          result = envelope({
            readAt: MONITOR_TIME,
            incident: state.incident,
            actions: [],
            nextCursor: input.cursor ? null : "synthetic-action-page",
          });
          break;
        case "monitoring_configuration_plan":
        case "monitoring_triage_plan": {
          if (state.conflict)
            return fail(
              "Configuration changed. Load saved configuration; keep your draft.",
            );
          const change =
            name === "monitoring_configuration_plan"
              ? (input.change as MonitorChange)
              : null;
          state.review = {
            id: String(input.reviewId),
            fingerprint: "b".repeat(64),
            connectionId: MONITOR_CONNECTION.id,
            connectionName: MONITOR_CONNECTION.name,
            actorMatches: true,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            change,
            before:
              change?.kind === "defaults"
                ? structuredClone(state.configuration.defaults)
                : change?.kind === "target"
                  ? structuredClone(
                      state.configuration.targets.find(
                        (target) => target.id === change.targetId,
                      ) ?? null,
                    )
                  : null,
            operation: null,
            provider: {
              id: String(input.reviewId),
              kind: change ? "configuration" : "triage",
              status: "reviewed",
              result: null,
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              appliedAt: null,
              preview: change
                ? {
                    addedIds:
                      change.kind === "target" && change.action === "create"
                        ? [change.targetId]
                        : [],
                    changedIds:
                      change.kind === "target" && change.action === "update"
                        ? [change.targetId]
                        : [],
                    removedIds:
                      change.kind === "target" && change.action === "remove"
                        ? [change.targetId]
                        : [],
                    defaultsChanged: change.kind === "defaults",
                    expectedFingerprint: "sha256:" + "b".repeat(64),
                    expectedRevision: state.revision,
                    remoteFingerprint: metadata().configFingerprint,
                    remoteTargetCount: state.configuration.targets.length,
                    targetCount: state.configuration.targets.length,
                    unchanged: false,
                    resultingRevision: state.revision + 1,
                  }
                : {
                    action: input.action as "acknowledged",
                    note: input.note as string | null,
                    until: input.until as string | null,
                    incidentId: state.incident.id,
                    targetId: state.incident.targetId,
                    incidentRevision: state.incident.revision,
                    configurationRevision: state.revision,
                    effect: "Synthetic reviewed triage",
                  },
            },
          };
          result = state.review;
          break;
        }
        case "monitoring_review":
          result = state.review;
          break;
        case "monitoring_apply": {
          state.applies += 1;
          const change = state.review!.change;
          if (change?.kind === "defaults")
            state.configuration.defaults = change.defaults;
          if (change?.kind === "target") {
            state.configuration.targets = state.configuration.targets.filter(
              (value) => value.id !== change.targetId,
            );
            if (change.target) state.configuration.targets.push(change.target);
          }
          if (change) state.revision += 1;
          state.review!.operation = {
            id: "synthetic-operation",
            status: state.loseApplyResponse ? "indeterminate" : "succeeded",
            summary: state.loseApplyResponse
              ? "Acceptance is uncertain. Reconcile before preparing another change."
              : "Endpoint Monitor accepted the reviewed change. This is not a health confirmation.",
            updatedAt: MONITOR_TIME,
          };
          if (state.loseApplyResponse)
            return fail(
              "Synthetic connection loss. Read the saved receipt.",
              503,
            );
          result = state.review;
          break;
        }
        case "monitoring_reconcile":
          state.review!.operation = {
            ...state.review!.operation!,
            status: "succeeded",
            summary:
              "The provider receipt confirms acceptance, not endpoint health.",
          };
          result = state.review;
          break;
        case "monitoring_history":
          result = state.review?.operation
            ? [{ ...state.review.operation, planId: state.review.id }]
            : [];
          break;
        case "resource_repositories":
          if (state.rejectRead)
            return fail(
              "Synthetic read failure. Your draft is preserved.",
              503,
            );
          result = links(
            input.kind as "monitor" | "hook",
            String(input.resourceKey),
          );
          break;
        case "resource_repositories_save": {
          if (state.linkConflict)
            return fail(
              "Repository links changed. Load saved links; keep your draft.",
            );
          const value = links(
            input.kind as "monitor" | "hook",
            String(input.resourceKey),
          );
          value.repositoryIds = input.repositoryIds as string[];
          value.revision += 1;
          result = value;
          break;
        }
        case "repository_resources":
          result = {
            items: [...state.links.values()]
              .filter(
                (value) =>
                  value.repositoryIds.includes(String(input.repositoryId)) &&
                  (!input.kind || value.kind === input.kind),
              )
              .map((value) => ({
                kind: value.kind,
                connectionId: value.connectionId,
                connectionName:
                  value.kind === "monitor"
                    ? MONITOR_CONNECTION.name
                    : HOOK_CONNECTION.name,
                connectionEnabled: true,
                connectionRevision: 1,
                resourceKey: value.resourceKey,
                revision: value.revision,
                updatedAt: MONITOR_TIME,
                repositoryCount: value.repositoryIds.length,
              })),
            nextCursor: null,
          };
          break;
        case "activity_feed":
          result = {
            groups: [
              {
                kind: "event",
                event: {
                  id: "synthetic-repo-note",
                  type: "update.note",
                  title: "Repository-specific work",
                  summary:
                    "Synthetic activity associated with this repository.",
                  actor: "Synthetic operator",
                  resourceId: input.repositoryId,
                  goalId: null,
                  createdAt: MONITOR_TIME,
                },
              },
            ],
            nextCursor: null,
            viewCursor: "synthetic-view",
          };
          break;
        default:
          throw new Error("Unhandled synthetic Monitoring command: " + name);
      }
      await route.fulfill({ json: result });
    },
  );
  return state;
}
