import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockHookPolicies } from "./hooks-policy-fixture";
import { HOOK_CONNECTION } from "./hooks-fixture";
import type { HandoffReview } from "../shared/hook-handoff";
const authorityId = "a".repeat(32);
const resourceId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "00000000-0000-4000-8000-000000000002";
const secret = "synthetic-private-browser-hmac";
test("creates a reviewed handoff and clears private reveal on close, navigation and reload", async ({ page }) => {
  await mockHookPolicies(page);
  let review: HandoffReview; let applies = 0;
  await page.route("**/api/commands/hooks_handoff_*", async route => {
    const name = route.request().url().split("/").at(-1)!; const input = route.request().postDataJSON(); const now = new Date().toISOString();
    let result: unknown;
    if (name.endsWith("configuration")) result = { status: "supported", configuration: { authorityId, revision: 1, mode: "active", canCreate: true, canReveal: true, reason: "ready", observedAt: now } };
    else if (name.endsWith("repository")) result = { repository: input.repository, repositoryId: applies ? repositoryId : null, resources: applies ? [{ resourceId, profile: "activity", authMode: "environment" }] : [], adoptionRequired: false, observedAt: now };
    else if (name.endsWith("plan")) {
      review = { id: input.reviewId, fingerprint: "a".repeat(64), connectionId: HOOK_CONNECTION.id, connectionName: HOOK_CONNECTION.name, projectId: input.projectId, repository: input.repository, actorMatches: true, createdAt: now, expiresAt: new Date(Date.now() + 300000).toISOString(), linked: false, operation: null,
        provider: { planId: input.reviewId, repositoryId, resourceId, repository: input.repository, name: "github:" + input.repository + (input.profile === "activity" ? "" : ":" + input.profile), profile: input.profile, profiles: [input.profile], sinks: input.sinks, action: "create", status: "ready", routingConfigured: false, createdAt: now, expiresAt: new Date(Date.now() + 300000).toISOString(), updatedAt: now } }; result = review;
    } else if (name.endsWith("apply")) { applies++; review!.provider!.status = "configured"; review!.provider!.routingConfigured = true; review!.linked = true; review!.operation = { id: resourceId, status: "succeeded", summary: "Manual hook routing configured", updatedAt: now }; result = review!; }
    else if (name.endsWith("get")) result = review!;
    else if (name.endsWith("status")) result = { resourceId, repository: review!.repository, profile: "activity", routingConfigured: true, credentialAvailable: true, pingAt: null, deliveredAt: null, sample: { events: 0, limit: 100, truncated: false }, observedAt: now };
    else throw new Error("Unexpected handoff command");
    expect(JSON.stringify(result)).not.toContain(secret);
    await route.fulfill({ json: result });
  });
  await page.route("**/api/hooks/handoff/private", async route => {
    const input = route.request().postDataJSON(); expect(input.action).toBe("reveal");
    await route.fulfill({ headers: { "cache-control": "no-store" }, json: { resourceId, repository: review!.repository, profile: review!.provider!.profile, url: "https://hooks.example/hook/github/synthetic-private-browser-route", secret, events: review!.provider!.profile === "stars" ? ["star"] : ["push", "workflow_run", "pull_request"], contentType: "application/json", sslVerification: true, settingsUrl: `https://github.com/${review!.repository}/settings/hooks/new` } });
  });
  await page.goto(`/hooks?workspace=development&connection=${HOOK_CONNECTION.id}&view=subscriptions`);
  await page.getByRole("button", { name: "New GitHub hook", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(dialog.getByRole("checkbox", { name: /Test phone/ })).toBeEnabled();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByLabel("GitHub repository").fill("https://github.com/trusted/external");
  await dialog.getByRole("checkbox", { name: /Test phone/ }).check();
  await dialog.getByRole("button", { name: "Review hook", exact: true }).click();
  await expect(dialog).toContainText("Review GitHub hook");
  await dialog.getByRole("button", { name: "Back to editing" }).click();
  await expect(dialog.getByLabel("GitHub repository")).toHaveValue("https://github.com/trusted/external");
  await dialog.getByRole("button", { name: "Review hook", exact: true }).click();
  await dialog.getByRole("button", { name: "Create hook", exact: true }).click();
  await expect(dialog).toContainText("Authenticated ping not observed");
  await dialog.getByRole("button", { name: "Reveal URL and secret" }).click();
  await expect(dialog.getByLabel("Signing secret")).toHaveValue(secret);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
  await dialog.getByRole("button", { name: "Copy secret", exact: true }).click();
  await expect(dialog).toContainText("Clipboard access was denied");
  await dialog.getByRole("button", { name: "Hide credentials" }).click();
  await expect(dialog.getByLabel("Signing secret")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Reveal URL and secret" }).click();
  await expect(dialog.getByLabel("Signing secret")).toHaveValue(secret);
  expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage, history: history.state, url: location.href }))).not.toContain(secret);
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText("Reveal URL and secret");
  await expect(page.getByLabel("Signing secret")).toHaveCount(0);
  expect(applies).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: "New GitHub hook", exact: true }).click();
  await dialog.getByLabel("GitHub repository").fill("trusted/external");
  await dialog.getByLabel("Profile", { exact: true }).selectOption("stars");
  await expect(dialog).toContainText("GitHub events: star");
  await dialog.getByRole("checkbox", { name: /Test phone/ }).check();
  await dialog.getByRole("button", { name: "Review hook", exact: true }).click();
  await expect(dialog).toContainText("Stars");
  await dialog.getByRole("button", { name: "Create hook", exact: true }).click();
  await dialog.getByRole("button", { name: "Reveal URL and secret" }).click();
  await expect(dialog.getByLabel("Signing secret")).toHaveValue(secret);
  await page.goto("/activity?workspace=development");
  await expect(page.getByLabel("Signing secret")).toHaveCount(0);
  expect(applies).toBe(2);
});

test("viewers cannot start manual handoff", async ({ page }) => {
  await mockHookPolicies(page, { viewer: true });
  await page.goto(`/hooks?workspace=development&connection=${HOOK_CONNECTION.id}&view=subscriptions`);
  await expect(page.getByRole("button", { name: "New GitHub hook", exact: true })).toBeDisabled();
});

test("restores opener focus after closing manual handoff", async ({ page }) => {
  await mockHookPolicies(page);
  await page.route("**/api/commands/hooks_handoff_configuration", route => route.fulfill({ json: {
    status: "supported", configuration: { authorityId, revision: 1, mode: "active", canCreate: true, canReveal: true, reason: "ready", observedAt: new Date().toISOString() },
  } }));
  await page.goto(`/hooks?workspace=development&connection=${HOOK_CONNECTION.id}&view=subscriptions`);
  const opener = page.getByRole("button", { name: "New GitHub hook", exact: true });
  const dialog = page.getByRole("dialog");
  for (const action of ["escape", "close"]) {
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    if (action === "escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  }
});
