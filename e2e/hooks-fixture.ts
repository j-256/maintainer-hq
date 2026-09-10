import type { Page } from "@playwright/test";
import { CAPABILITY, DEFAULT_PORTFOLIO, projectSchema } from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";
import {
  HOOK_DELIVERY_STATES,
  type HookAssociation,
  type HookConnection,
  type HookDelivery,
  type HookReview,
  type HookSnapshot,
} from "../shared/hooks";

export const HOOK_TIME = "2026-09-06T10:00:00.000Z";
export const HOOK_CONNECTION: HookConnection = {
  id: "hooks-test",
  name: "Synthetic hooks",
  revision: 1,
  enabled: true,
  providerRef: "primary",
  providerName: "Synthetic provider",
  available: true,
  projectId: null,
};
export const HOOK_DELIVERY: HookDelivery = {
  eventId: "synthetic:event-1",
  sinkName: "Test phone",
  generation: 4,
  status: "exhausted",
  attempts: 8,
  decisionReason: null,
  updatedAt: HOOK_TIME,
  receivedAt: HOOK_TIME,
  deliveredAt: null,
  subscription: "Synthetic subscription",
  source: "github",
};
export const HOOK_SNAPSHOT: HookSnapshot = {
  observedAt: HOOK_TIME,
  deliveries: {
    totals: Object.fromEntries(
      HOOK_DELIVERY_STATES.map((state) => [
        state,
        state === "exhausted" ? 1000 : 0,
      ]),
    ) as HookSnapshot["deliveries"]["totals"],
    sampled: 1000,
    limit: 1000,
    truncated: true,
  },
  signals: {
    items: [
      {
        code: "delivery-exhausted",
        severity: "error",
        firstSeenAt: HOOK_TIME,
        lastSeenAt: HOOK_TIME,
        occurrences: 2,
        resolvedAt: null,
      },
    ],
    truncated: true,
  },
  lastRetentionAt: HOOK_TIME,
};

export async function mockHooks(
  page: Page,
  options: { empty?: boolean; viewer?: boolean } = {},
) {
  const state = {
    snapshot: structuredClone(HOOK_SNAPSHOT),
    connections: options.empty
      ? ([] as HookConnection[])
      : [{ ...HOOK_CONNECTION }],
    association: {
      subscription: HOOK_DELIVERY.subscription,
      projectId: null,
      revision: 0,
    } as HookAssociation,
    review: null as HookReview | null,
    calls: [] as { name: string; input: Record<string, unknown> }[],
    conflict: false,
    associationConflict: false,
    rejectRead: false,
    loseApplyResponse: false,
    applies: 0,
  };
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    projects: [
      {
        id: "standalone",
        name: "Standalone service",
        description: "No repository",
        workspaceId: snapshot.workspace.id,
        lifecycle: "active",
        importance: "standard",
        importanceNote: "",
        portfolio: DEFAULT_PORTFOLIO,
        revision: 1,
        updatedAt: HOOK_TIME,
      },
    ],
    ...(options.viewer
      ? {
          capabilities: [CAPABILITY.READ],
          workspace: { ...snapshot.workspace, role: "viewer" },
        }
      : {}),
  }));
  await page.route("**/api/commands/resource_project*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON();
    state.calls.push({ name, input });
    if (
      state.rejectRead ||
      (name === "resource_project_save" && state.associationConflict)
    )
      return route.fulfill({
        status: state.rejectRead ? 503 : 409,
        json: {
          error: {
            code: "revision_conflict",
            message:
              "Association changed. Load saved association; keep your draft.",
          },
        },
      });
    if (name === "resource_project_save")
      state.association = {
        ...state.association,
        projectId: input.projectId,
        revision: input.revision + 1,
      };
    return route.fulfill({
      json: {
        workspaceId: input.workspaceId,
        kind: "hook",
        connectionId: input.connectionId,
        resourceKey: state.association.subscription,
        projectId: state.association.projectId,
        revision: state.association.revision,
        connectionRevision: state.connections[0].revision,
        updatedAt: HOOK_TIME,
      },
    });
  });
  await page.route("**/api/commands/project_get", (route) =>
    route.fulfill({
      json: projectSchema.parse({
        id: "standalone",
        workspaceId: route.request().postDataJSON().workspaceId,
        name: "Standalone service",
        description: "No repository",
        revision: 1,
        updatedAt: HOOK_TIME,
      }),
    }),
  );
  await page.route("**/api/commands/hooks_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.calls.push({ name, input });
    const fail = (message: string, status = 409) =>
      route.fulfill({
        status,
        json: { error: { code: "revision_conflict", message } },
      });
    const envelope = (result: unknown) => ({
      capabilities: options.viewer ? ["read"] : ["read", "retry"],
      result,
    });
    let result: unknown;
    switch (name) {
      case "hooks_connections":
        if (state.rejectRead)
          return fail("Synthetic read failure. Your draft is preserved.", 503);
        result = state.connections;
        break;
      case "hooks_providers":
        result = [
          { id: "primary", name: "Synthetic provider", available: true },
        ];
        break;
      case "hooks_connection_save":
        if (state.conflict)
          return fail(
            "Settings changed. Load saved settings; keep your draft.",
          );
        state.connections = [
          {
            ...HOOK_CONNECTION,
            ...(input.connection as object),
            id: String(input.connectionId),
            revision: Number(input.revision) + 1,
          },
        ];
        result = state.connections[0];
        break;
      case "hooks_snapshot":
        result = envelope(state.snapshot);
        break;
      case "hooks_configuration":
        result = { status: "unsupported", configuration: null };
        break;
      case "hooks_subscriptions":
        result = {
          ...envelope({
            items: [
              {
                name: HOOK_DELIVERY.subscription,
                source: "github",
                enabled: true,
                sinks: [HOOK_DELIVERY.sinkName],
              },
            ],
            nextCursor: null,
            disappeared: 1,
            observedAt: HOOK_TIME,
          }),
          associations: [state.association],
          repositoryLinks: [],
        };
        break;
      case "hooks_association_get":
        if (state.rejectRead)
          return fail("Synthetic read failure. Your draft is preserved.", 503);
        result = state.association;
        break;
      case "hooks_association_save":
        if (state.associationConflict)
          return fail(
            "Association changed. Load saved association; keep your draft.",
          );
        state.association = {
          ...state.association,
          projectId: input.projectId as string | null,
          revision: Number(input.revision) + 1,
        };
        result = state.association;
        break;
      case "hooks_deliveries": {
        const next =
          input.cursor === null
            ? {
                updatedAt: HOOK_TIME,
                eventId: HOOK_DELIVERY.eventId,
                sinkName: HOOK_DELIVERY.sinkName,
              }
            : null;
        result = envelope({
          items:
            input.subscription && next
              ? []
              : [
                  {
                    ...HOOK_DELIVERY,
                    eventId: next ? HOOK_DELIVERY.eventId : "synthetic:older",
                  },
                ],
          nextCursor: next,
          scanned: 25,
          observedAt: HOOK_TIME,
          pagination: "live-updated-desc",
        });
        break;
      }
      case "hooks_delivery":
        result = envelope(HOOK_DELIVERY);
        break;
      case "hooks_retry_plan":
        state.review = {
          id: String(input.reviewId),
          fingerprint: "a".repeat(64),
          connectionId: HOOK_CONNECTION.id,
          connectionName: HOOK_CONNECTION.name,
          actorMatches: true,
          eventId: HOOK_DELIVERY.eventId,
          sinkName: HOOK_DELIVERY.sinkName,
          generation: 4,
          updatedAt: HOOK_TIME,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          operation: null,
          provider: {
            planId: String(input.reviewId),
            eventId: HOOK_DELIVERY.eventId,
            sinkName: HOOK_DELIVERY.sinkName,
            generation: 4,
            updatedAt: HOOK_TIME,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            state: "review",
            acceptedAt: null,
            acceptedGeneration: null,
          },
        };
        result = state.review;
        break;
      case "hooks_retry_get":
        result = state.review;
        break;
      case "hooks_retry_apply":
        state.applies += 1;
        state.review!.operation = {
          id: "synthetic-operation",
          status: state.loseApplyResponse ? "indeterminate" : "succeeded",
          summary: state.loseApplyResponse
            ? "Hookrelay acceptance is uncertain. Reconcile before any new retry."
            : "Hookrelay accepted this retry. Queue delivery is a separate outcome.",
          updatedAt: HOOK_TIME,
        };
        if (state.loseApplyResponse)
          return fail(
            "Synthetic connection loss. Read the saved receipt.",
            503,
          );
        result = state.review;
        break;
      case "hooks_retry_reconcile":
        state.review!.operation = {
          ...state.review!.operation!,
          status: "succeeded",
          summary:
            "Hookrelay's durable receipt confirms acceptance. Queue delivery is a separate outcome.",
        };
        result = state.review;
        break;
      case "hooks_history":
        result = state.review?.operation
          ? [
              {
                ...state.review.operation,
                planId: state.review.id,
                createdAt: HOOK_TIME,
              },
            ]
          : [];
        break;
      default:
        throw new Error("Unhandled synthetic Hooks command: " + name);
    }
    await route.fulfill({ json: result });
  });
  return state;
}
