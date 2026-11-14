import { test, expect } from "./test-fixture";
import { mockHooks, HOOK_DELIVERY, HOOK_TIME } from "./hooks-fixture";
import { mockMonitoring, MONITOR_TARGET, MONITOR_TIME } from "./monitoring-fixture";

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  test(`Hooks puts the first delivery and its action in view at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockHooks(page);
    await page.goto("/hooks?workspace=development");
    const inspect = page.getByRole("button", {
      name: `Inspect delivery ${HOOK_DELIVERY.eventId} to ${HOOK_DELIVERY.sinkName}`,
    });
    await expect(inspect).toBeInViewport({ ratio: 1 });
    const summary = page.getByRole("region", { name: "Hookrelay health sample" });
    await expect(summary).toContainText("Limited sample");
    await expect(summary).toContainText("Unresolved");
    await inspect.click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(inspect).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Monitoring puts the first target and its action in view at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockMonitoring(page);
    await page.goto("/monitoring?workspace=development");
    await expect(page.getByRole("heading", { name: MONITOR_TARGET.id, exact: true })).toBeInViewport();
    const inspect = page.getByRole("button", { name: "Inspect target", exact: true });
    await expect(inspect).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("region", { name: "Scheduler status" })).toContainText("No completed run");
    await expect(page.getByRole("region", { name: "Endpoint Monitor evidence" })).toContainText("50+");
    await inspect.click();
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("secondary Hooks actions open from the keyboard and restore focus after a dialog", async ({ page }) => {
  const state = await mockHooks(page);
  await page.goto("/hooks?workspace=development");
  const actions = page.getByRole("button", { name: "More Hooks actions", exact: true });
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Manage destinations", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Connect Hookrelay", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(actions).toBeFocused();
  expect(state.applies).toBe(0);
});

for (const width of [320, 390]) {
  test(`applied filters keep editable names readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockHooks(page);
    await mockMonitoring(page);
    for (const selection of [
      { path: "/hooks?workspace=development&subscription=Synthetic%20subscription", label: "Subscription name" },
      { path: "/monitoring?workspace=development&view=incidents&target=synthetic-health", label: "Target ID" },
    ]) {
      await page.goto(selection.path);
      const input = page.getByLabel(selection.label, { exact: true });
      await expect(input).toBeVisible();
      expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(128);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(input).toHaveValue("");
    }
  });
}

test("long delivery and target identifiers remain readable without horizontal scrolling", async ({ page }) => {
  const subscription = "Synthetic-subscription-" + "long-name-".repeat(12);
  const destination = "Synthetic-destination-" + "long-name-".repeat(6);
  const hooks = await mockHooks(page);
  hooks.connections[0]!.name = "Synthetic connection " + "long-name-".repeat(6);
  await page.route("**/api/commands/hooks_deliveries", route => route.fulfill({ json: {
    capabilities: ["read", "retry"],
    result: {
      items: [{ ...HOOK_DELIVERY, subscription, sinkName: destination, eventId: "synthetic:" + "a".repeat(100) }],
      nextCursor: null,
      scanned: 1,
      observedAt: HOOK_TIME,
      pagination: "live-updated-desc",
    },
  } }));
  await page.route("**/api/commands/hooks_subscriptions", route => route.fulfill({ json: {
    capabilities: ["read", "retry"],
    associations: [],
    repositoryLinks: [],
    result: {
      items: [{ name: subscription, source: "github", enabled: true, sinks: [destination] }],
      nextCursor: null,
      disappeared: 0,
      observedAt: HOOK_TIME,
    },
  } }));
  const monitoring = await mockMonitoring(page);
  const target = {
    ...MONITOR_TARGET,
    id: "synthetic-health-" + "production-".repeat(4),
    url: "https://example.com/" + "long-endpoint-path-".repeat(12),
  };
  monitoring.configuration.targets = [target];
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/hooks?workspace=development");
    const table = page.getByRole("region", { name: "Deliveries by subscription and destination" });
    await expect(table).toContainText(subscription);
    await expect(table).toContainText(destination);
    expect(await table.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const state = table.getByText("Needs attention", { exact: true });
    expect((await state.boundingBox())!.height).toBeLessThan(48);
    await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
    const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: subscription, exact: true }) });
    await expect(row.getByText(destination, { exact: true })).toBeVisible();
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.goto("/monitoring?workspace=development");
    await expect(page.getByRole("heading", { name: target.id, exact: true })).toBeVisible();
    await expect(page.getByText(target.url, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("compact scheduler status exposes disabled runs and failure totals", async ({ page }) => {
  const at = Date.parse(MONITOR_TIME);
  await page.clock.install({ time: at });
  const state = await mockMonitoring(page);
  state.execution = {
    state: "fresh",
    freshUntil: new Date(at + 180000).toISOString(),
    expectedIntervalSeconds: 60,
    retainedRunLimit: 120,
    lastRun: {
      scheduledAt: MONITOR_TIME,
      startedAt: MONITOR_TIME,
      completedAt: MONITOR_TIME,
      enabled: false,
      configurationRevision: 1,
      configFingerprint: "sha256:" + "a".repeat(64),
      probeIntervalMinutes: 5,
      targetCount: 1,
      dueTargets: 0,
      succeededProbes: 0,
      failedProbes: 0,
      phaseErrors: 0,
      deliveriesFailed: 0,
      subrequests: 0,
    },
  };
  await page.goto("/monitoring?workspace=development");
  const scheduler = page.getByRole("region", { name: "Scheduler status" });
  await expect(scheduler.getByText("Probing was disabled for this run.")).toBeVisible();
  state.execution.lastRun = { ...state.execution.lastRun!, enabled: true, failedProbes: 2, phaseErrors: 1, deliveriesFailed: 3 };
  await page.reload();
  await expect(scheduler.getByText("Last run: 2 failed checks; 1 phase errors; 3 notification failures.")).toBeVisible();
  await page.getByText("Schedule and evidence details", { exact: true }).click();
  await expect(page.getByText("Scheduled for", { exact: false })).toContainText("2026-09-06");
});
