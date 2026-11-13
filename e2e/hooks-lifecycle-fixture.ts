import type { Page } from "@playwright/test";
import type { LifecycleReview } from "../shared/hook-lifecycle";
import { mockHookPolicies, POLICY_RESOURCE_ID, POLICY_AUTHORITY_ID } from "./hooks-policy-fixture";
import { HOOK_CONNECTION } from "./hooks-fixture";
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
export async function mockHookLifecycle(page: Page, options: { viewer?: boolean; grants?: boolean; retired?: boolean; referenced?: boolean; configure?: boolean; provision?: boolean } = {}) {
  const policy = await mockHookPolicies(page, options);
  const state = { reviews: new Map<string, LifecycleReview>(), applies: 0, privateInputs: 0, lost: false };
  await page.route("**/api/commands/hooks_*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON();
    if (name === "hooks_history") return route.fulfill({ json: [...state.reviews.values()].filter(item => item.operation).map(item => ({ ...item.operation, planId: item.id, kind: "hookrelay.resource.lifecycle", createdAt: item.createdAt })) });
    if (!name.startsWith("hooks_lifecycle_")) return route.fallback();
    let result: unknown;
    if (name === "hooks_lifecycle_configuration") result = { authorityId: POLICY_AUTHORITY_ID, revision: 1, mode: "active", canConfigure: options.configure ?? options.grants !== false, canProvision: options.provision ?? options.grants !== false, canSupplyPrivate: options.grants !== false, canManageHooks: options.grants !== false, reason: options.grants === false ? "grant_required" : "ready", observedAt: time() };
    if (name === "hooks_lifecycle_plan") {
      const change = input.change;
      const summary = { resourceId: "resourceId" in change ? change.resourceId : POLICY_RESOURCE_ID, name: "name" in change ? change.name : "Synthetic destination", type: "type" in change ? change.type : "ntfy", retired: false };
      const receipt: LifecycleReview = { id: input.planId, authorityId: POLICY_AUTHORITY_ID, revision: 1, fingerprint: "b".repeat(64), state: "ready", change, before: change.kind === "destination-create" ? null : summary, after: { ...summary, retired: change.kind.endsWith("retire") }, affectedSubscriptions: options.referenced ? [{ resourceId: POLICY_RESOURCE_ID, name: "Synthetic enabled subscription" }] : [], privateInputRequired: change.kind === "destination-create" || change.replaceCredentials === true, privateInputReceived: false, expiresAt: time(300000), outcome: null, observedAt: time(), workspaceId: "development", connectionId: HOOK_CONNECTION.id, connectionName: HOOK_CONNECTION.name, actorMatches: !options.viewer, canSupplyPrivate: options.grants !== false, createdAt: time(), operation: null };
      state.reviews.set(receipt.id, receipt); result = receipt;
    } else if (name === "hooks_lifecycle_apply") {
      const review = state.reviews.get(input.planId)!;
      if (!review.operation) { state.applies++; review.state = state.lost ? "indeterminate" : "applied"; review.operation = { id: crypto.randomUUID(), status: state.lost ? "indeterminate" : "succeeded", summary: state.lost ? "Lifecycle outcome needs reconciliation. Read the original receipt before another change." : "Lifecycle change accepted. Delivery and authenticated signing evidence remain separate outcomes.", updatedAt: time() }; review.outcome = { configuration: "applied", upstream: "not_requested" }; }
      result = review;
    } else if (name === "hooks_lifecycle_reconcile") {
      const review = state.reviews.get(input.planId)!;
      if (review.operation) { review.state = "applied"; review.operation.status = "succeeded"; review.operation.summary = "Original provider receipt confirms lifecycle acceptance."; }
      result = review;
    } else if (name === "hooks_lifecycle_get") result = state.reviews.get(input.planId);
    return result ? route.fulfill({ json: result }) : route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Synthetic lifecycle review missing" } } });
  });
  await page.route("**/api/hooks/lifecycle-input/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const review = state.reviews.get(id)!;
    state.privateInputs++; review.privateInputReceived = true; review.canSupplyPrivate = false;
    return route.fulfill({ headers: { "cache-control": "no-store" }, json: { planId: id, state: "ready", privateInputReceived: true, submitted: true } });
  });
  return Object.assign(state, { policy });
}
