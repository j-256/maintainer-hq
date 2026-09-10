import type { Page } from "@playwright/test";
import type { HookPolicy, HookPolicyReview, HookResult } from "../shared/hooks";
import { mockHooks, HOOK_CONNECTION, HOOK_DELIVERY } from "./hooks-fixture";

export const POLICY_RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
export const POLICY_AUTHORITY_ID = "a".repeat(32);
const DESTINATION_CURSOR = "00000000-0000-4000-8000-000000000010";
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();

export async function mockHookPolicies(
  page: Page,
  options: {
    viewer?: boolean;
    mode?: "active" | "legacy";
    canConfigure?: boolean;
    supported?: boolean;
  } = {},
) {
  const hooks = await mockHooks(page, options);
  const state = {
    hooks,
    policy: {
      enabled: true,
      sinks: [HOOK_DELIVERY.sinkName],
      filter: null,
      sinkFilters: {},
    } as HookPolicy,
    revision: 1,
    reviews: new Map<string, HookPolicyReview>(),
    applies: 0,
    rejectRead: false,
    rejectPlan: false,
    loseApplyResponse: false,
    losePlanResponse: false,
  };
  const authority = () => ({
    authorityId: POLICY_AUTHORITY_ID,
    revision: state.revision,
    mode: options.mode ?? "active",
  });
  const subscription = () => ({
    resourceId: POLICY_RESOURCE_ID,
    name: HOOK_DELIVERY.subscription,
    source: "github",
    policy: structuredClone(state.policy),
  });
  await page.route("**/api/commands/hooks_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (
      !name.startsWith("hooks_policy_") &&
      name !== "hooks_configuration" &&
      name !== "hooks_history"
    )
      return route.fallback();
    const input = route.request().postDataJSON();
    hooks.calls.push({ name, input });
    const fail = (message: string, status = 409) =>
      route.fulfill({
        status,
        json: { error: { code: "revision_conflict", message } },
      });
    let result: unknown;
    switch (name) {
      case "hooks_configuration":
        result =
          options.supported === false
            ? { status: "unsupported", configuration: null }
            : {
                status: "supported",
                configuration: {
                  ...authority(),
                  canConfigure: options.canConfigure ?? true,
                  supported: { policy: true, create: false, retire: false },
                  observedAt: time(),
                },
              };
        break;
      case "hooks_policy_subscriptions": {
        if (input.revision !== state.revision)
          return fail("Routing changed. Refresh the subscription page.");
        result = {
          result: {
            ...authority(),
            items: [subscription()],
            nextCursor: null,
            observedAt: time(),
          },
          capabilities: ["read", "retry"],
          associations: [],
          repositoryLinks: [],
        };
        break;
      }
      case "hooks_policy_subscription": {
        if (state.rejectRead)
          return fail(
            "Synthetic routing read failed. Your draft is preserved.",
            503,
          );
        result = {
          result: {
            ...authority(),
            ...subscription(),
            observedAt: time(),
          } satisfies HookResult<"configuration_subscription">,
          capabilities: ["read", "retry"],
        };
        break;
      }
      case "hooks_policy_destinations": {
        if (input.revision !== state.revision)
          return fail("Destination inventory changed. Load saved routing.");
        result = {
          result: {
            ...authority(),
            observedAt: time(),
            nextCursor: input.cursor ? null : DESTINATION_CURSOR,
            items: input.cursor
              ? [
                  {
                    resourceId: "00000000-0000-4000-8000-000000000011",
                    name: "Team inbox",
                    type: "email",
                    retired: false,
                  },
                ]
              : [
                  {
                    resourceId: "00000000-0000-4000-8000-000000000010",
                    name: HOOK_DELIVERY.sinkName,
                    type: "ntfy",
                    retired: false,
                  },
                  {
                    resourceId: "00000000-0000-4000-8000-000000000012",
                    name: "Retired destination",
                    type: "ntfy",
                    retired: true,
                  },
                ],
          },
          capabilities: ["read", "retry"],
        };
        break;
      }
      case "hooks_policy_plan": {
        if (state.rejectPlan || input.revision !== state.revision)
          return fail(
            "Saved routing changed. Your draft is preserved; load saved routing before reviewing again.",
          );
        if (!state.reviews.has(input.reviewId))
          state.reviews.set(input.reviewId, {
            id: input.reviewId,
            fingerprint: "b".repeat(64),
            connectionId: HOOK_CONNECTION.id,
            connectionName: HOOK_CONNECTION.name,
            resourceId: POLICY_RESOURCE_ID,
            actorMatches: true,
            createdAt: time(),
            expiresAt: time(300000),
            operation: null,
            provider: {
              planId: input.reviewId,
              authorityId: POLICY_AUTHORITY_ID,
              revision: state.revision,
              resourceId: POLICY_RESOURCE_ID,
              resourceName: HOOK_DELIVERY.subscription!,
              status: "ready",
              before: structuredClone(state.policy),
              after: input.policy,
              createdAt: time(),
              expiresAt: time(300000),
              receipt: null,
              effect: "future-ingress-policy",
            },
          });
        if (state.losePlanResponse) {
          state.losePlanResponse = false;
          return fail(
            "Synthetic review response was lost. Retry the same draft.",
            503,
          );
        }
        result = state.reviews.get(input.reviewId);
        break;
      }
      case "hooks_policy_apply": {
        const review = state.reviews.get(input.planId)!;
        if (!review.operation) {
          state.applies++;
          state.policy = structuredClone(review.provider!.after);
          state.revision++;
          review.operation = {
            id: "synthetic-routing-operation",
            status: state.loseApplyResponse ? "indeterminate" : "succeeded",
            summary: state.loseApplyResponse
              ? "Provider acceptance is uncertain. Reconcile this operation."
              : "Future routing changed. Queued deliveries are unchanged.",
            updatedAt: time(),
          };
          if (!state.loseApplyResponse) {
            review.provider!.status = "accepted";
            review.provider!.receipt = {
              operationId: input.planId,
              revision: state.revision,
              acceptedAt: time(),
            };
          }
        }
        if (state.loseApplyResponse) {
          state.loseApplyResponse = false;
          return fail("Synthetic apply response was lost.", 503);
        }
        result = review;
        break;
      }
      case "hooks_policy_get":
        result = state.reviews.get(input.planId);
        break;
      case "hooks_policy_reconcile": {
        const review = state.reviews.get(input.planId)!;
        review.operation!.status = "succeeded";
        review.operation!.summary =
          "Hookrelay receipt confirms the routing change. Notification delivery is a separate outcome.";
        review.provider!.status = "accepted";
        review.provider!.receipt = {
          operationId: input.planId,
          revision: state.revision,
          acceptedAt: time(),
        };
        result = review;
        break;
      }
      case "hooks_history":
        result = [...state.reviews.values()]
          .filter((review) => review.operation)
          .map((review) => ({
            ...review.operation,
            planId: review.id,
            kind: "hookrelay.subscription.policy",
            createdAt: review.createdAt,
          }));
        break;
    }
    if (!result) return fail("Synthetic review not found.", 404);
    return route.fulfill({ json: result });
  });
  return state;
}
