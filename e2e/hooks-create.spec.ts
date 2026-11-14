import { test, expect, type Page, type APIRequestContext } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_EXPECTATIONS, type Repository } from "../shared/domain";
import { mockHookPolicies, POLICY_AUTHORITY_ID } from "./hooks-policy-fixture";
import { HOOK_CONNECTION } from "./hooks-fixture";
import type { HookSetupReview } from "../shared/hook-setup";

async function fixture(page: Page, request: APIRequestContext, denied = false) {
  const repos: Repository[] = [];
  for (const prefix of ["first", "second"]) {
    const response = await request.post("/api/commands/repository_create", { headers: { "X-HQ-Client": "cli" }, data: {
      workspaceId: "development", repository: { fullName: `${prefix}/${crypto.randomUUID()}`, description: "Hook entrypoint test", projectId: "development-default", classification: "maintained", lifecycle: "active", expectations: DEFAULT_EXPECTATIONS },
    } });
    expect(response.ok()).toBeTruthy(); repos.push(await response.json());
  }
  await mockHookPolicies(page);
  const pending: (() => void)[] = [];
  const state = { reads: [] as { repositoryId: string; page: number }[], plans: 0, applies: 0, review: null as HookSetupReview | null, denied, failPage: null as number | null, holdFirst: false, release: () => { for (const release of pending.splice(0)) release(); } };
  await page.route("**/api/commands/hooks_github_inventory", async route => {
    const input = route.request().postDataJSON(); state.reads.push(input);
    if (state.holdFirst && input.repositoryId === repos[0].id) await new Promise<void>(resolve => { pending.push(resolve); });
    if (state.failPage === input.page) return route.fulfill({ status: 503, json: { error: { code: "hooks_provider_unavailable", message: "GitHub inventory read temporarily unavailable." } } });
    if (state.denied) return route.fulfill({ status: 403, json: { error: { code: "hooks_provider_github_denied", message: "GitHub access to this repository was denied. Check the App installation and the configured credential's repository scope." } } });
    const repo = repos.find(repo => repo.id === input.repositoryId)!;
    await route.fulfill({ json: { repository: repo.fullName, repositoryId: input.repositoryId === repos[0].id ? 101 : 102, items: input.repositoryId === repos[0].id && input.page === 1 ? Array.from({ length: 25 }, (_, i) => ({ id: i + 1, active: true, events: ["push"] })) : [], page: input.page, nextPage: input.repositoryId === repos[0].id && input.page === 1 ? 2 : null, limited: false, observedAt: new Date().toISOString() } });
  });
  await page.route("**/api/commands/hooks_setup_*", async route => {
    const command = route.request().url().split("/").at(-1)!; const input = route.request().postDataJSON(); const now = new Date().toISOString();
    if (command.endsWith("configuration")) return route.fulfill({ json: { status: "supported", configuration: { authorityId: POLICY_AUTHORITY_ID, revision: 1, mode: "active", canCreate: true, reason: "ready", observedAt: now } } });
    if (command.endsWith("status")) return route.fulfill({ json: { resourceId: state.review!.provider!.resourceId, name: state.review!.provider!.name, routingConfigured: true, webhook: "installed", deliveredAt: null, observedAt: now } });
    if (command.endsWith("plan")) {
      state.plans++; const repo = repos.find(repo => repo.id === input.repositoryId)!;
      state.review = { id: input.reviewId, fingerprint: "a".repeat(64), connectionId: HOOK_CONNECTION.id, connectionName: HOOK_CONNECTION.name, repositoryId: repo.id, repositoryName: repo.fullName, actorMatches: true, createdAt: now, expiresAt: new Date(Date.now() + 300000).toISOString(), linked: false, operation: null, provider: { planId: input.reviewId, resourceId: "00000000-0000-4000-8000-000000000075", name: input.name, repository: repo.fullName, events: input.events, sinks: input.sinks, action: "create", status: "ready", errorCode: null, createdAt: now, expiresAt: new Date(Date.now() + 300000).toISOString(), updatedAt: now, routingConfigured: false, webhookInstalled: false, webhookId: null } };
    }
    if (command.endsWith("apply")) {
      state.applies++; state.review!.provider = { ...state.review!.provider!, status: "installed", routingConfigured: true, webhookInstalled: true, webhookId: 42 };
      state.review!.linked = true; state.review!.operation = { id: "00000000-0000-4000-8000-000000000076", status: "succeeded", summary: "GitHub webhook installed", updatedAt: now };
    }
    await route.fulfill({ json: state.review });
  });
  await page.goto(`/hooks?workspace=development&connection=${HOOK_CONNECTION.id}`);
  await page.getByRole("button", { name: "New GitHub hook", exact: true }).click();
  return { repos, state, dialog: page.getByRole("dialog") };
}

test("the main new-hook action discovers GitHub hooks automatically and reviews App installation", async ({ page, request }) => {
  const { repos, state, dialog } = await fixture(page, request);
  await expect(dialog.getByLabel("Repository", { exact: true })).toBeVisible();
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[0].id);
  await expect(dialog.getByRole("region", { name: "Existing GitHub webhooks" })).toContainText("Webhook #1");
  expect(state.reads.some(input => input.repositoryId === repos[0].id && input.page === 1)).toBe(true);
  await expect(dialog.getByRole("button", { name: "Find existing hooks" })).toHaveCount(0);
  await expect(dialog).not.toContainText("hand its credentials");
  await dialog.getByRole("button", { name: "Next GitHub hooks" }).click();
  await expect(dialog).toContainText("No GitHub webhooks found on this page.");
  await dialog.getByRole("checkbox", { name: /Test phone/ }).check();
  await dialog.getByRole("button", { name: "Review setup", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("install a signed GitHub webhook");
  expect(state.plans).toBe(1); expect(state.applies).toBe(0);
  await page.getByRole("button", { name: "Apply setup", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("GitHub webhook installed");
  expect(state.applies).toBe(1);
  await expect(page.getByRole("button", { name: "Check verification", exact: true })).toBeEnabled();
  await page.getByRole("dialog").evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
});

test("denied discovery is actionable and is never presented as no hooks or manual setup", async ({ page, request }) => {
  const { repos, state, dialog } = await fixture(page, request, true);
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[0].id);
  await expect(dialog).toContainText("GitHub access to this repository was denied");
  await expect(dialog).not.toContainText("No GitHub webhooks found");
  await expect(dialog.getByRole("button", { name: "Review setup" })).toBeDisabled();
  state.denied = false;
  await dialog.getByRole("button", { name: "Retry GitHub hooks" }).click();
  await expect(dialog).toContainText("Webhook #1");
});

test("repository changes discard stale discovery results and reset the setup draft", async ({ page, request }) => {
  const { repos, state, dialog } = await fixture(page, request);
  state.holdFirst = true;
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[0].id);
  await expect.poll(() => state.reads.filter(input => input.repositoryId === repos[0].id).length).toBeGreaterThan(0);
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[1].id);
  await expect(dialog).toContainText("No GitHub webhooks found on this page.");
  state.release();
  await expect(dialog).not.toContainText("Webhook #1");
  await expect(dialog.getByLabel("Subscription name")).toHaveValue(repos[1].fullName.replaceAll("/", "-"));
});


test("switching repositories confirms draft discard and resets name and destinations", async ({ page, request }) => {
  const { repos, dialog } = await fixture(page, request);
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[0].id);
  await expect(dialog).toContainText("Webhook #1");
  await dialog.getByLabel("Subscription name").fill("unsaved-first-repository");
  await dialog.getByRole("checkbox", { name: /Test phone/ }).check();
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[1].id);
  const discard = page.getByRole("alertdialog");
  await expect(discard).toContainText("Discard unsaved changes?");
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog.getByLabel("Subscription name")).toHaveValue(repos[1].fullName.replaceAll("/", "-"));
  await expect(dialog.getByRole("checkbox", { name: /Test phone/ })).not.toBeChecked();
});


test("a failed later inventory page keeps backward navigation available", async ({ page, request }) => {
  const { repos, state, dialog } = await fixture(page, request);
  await dialog.getByLabel("Repository", { exact: true }).selectOption(repos[0].id);
  await expect(dialog).toContainText("Webhook #1");
  state.failPage = 2;
  await dialog.getByRole("button", { name: "Next GitHub hooks" }).click();
  await expect(dialog).toContainText("GitHub inventory read temporarily unavailable.");
  await dialog.getByRole("button", { name: "Previous GitHub hooks" }).click();
  await expect(dialog).toContainText("Webhook #1");
});
