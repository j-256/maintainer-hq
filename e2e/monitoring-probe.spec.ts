import { test, expect } from "./test-fixture";
import { mockMonitoring, MONITOR_TARGET } from "./monitoring-fixture";

const URL = "/monitoring?workspace=development";
test("target rows probe once, show diagnostic results separately, and edit directly", async ({ page }) => {
  const state = await mockMonitoring(page);
  await page.goto(URL);
  const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: MONITOR_TARGET.id, exact: true }) });
  let release!: () => void;
  state.probeGate = new Promise<void>((resolve) => { release = resolve; });
  await row.getByRole("button", { name: "Probe now", exact: true }).click();
  await expect(row.getByRole("button", { name: "Probing...", exact: true })).toBeDisabled();
  release();
  await expect(row.getByRole("status")).toContainText("Diagnostic passed");
  await expect(row.getByRole("status")).toContainText("HTTP 200");
  await expect(row.getByRole("status")).toContainText("128 ms");
  await expect(row).toContainText("No retained probe evidence");
  expect(state.calls.filter((call) => call.name === "monitoring_probe")).toHaveLength(1);
  expect(state.applies).toBe(0);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Target ID", { exact: true })).toBeDisabled();
});

test("lost diagnostic responses recover the same request after navigation and preserve stale-result labels", async ({ page }) => {
  const state = await mockMonitoring(page);
  state.loseProbeResponse = true;
  state.probeConfigurationMatches = false;
  await page.goto(URL);
  await page.getByRole("button", { name: "Probe now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover result", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Recover result", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Diagnostic passed" })).toContainText("Configuration changed");
  const calls = state.calls.filter((call) => call.name === "monitoring_probe");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.input.requestId).toBe(calls[1]!.input.requestId);
  expect(state.probeResults.size).toBe(1);
});

test("diagnostic failures are visible and a new deliberate probe uses a new request ID", async ({ page }) => {
  const state = await mockMonitoring(page);
  state.probeOutcome = "failure";
  await page.goto(URL);
  await page.getByRole("button", { name: "Probe now", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Diagnostic failed" })).toContainText("HTTP 503");
  state.probeOutcome = "success";
  await page.getByRole("button", { name: "Probe again", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Diagnostic passed" })).toBeVisible();
  const calls = state.calls.filter((call) => call.name === "monitoring_probe");
  expect(calls[0]!.input.requestId).not.toBe(calls[1]!.input.requestId);
});

test("missing probe permission is explained and viewers cannot probe", async ({ page }) => {
  const state = await mockMonitoring(page);
  state.probeAllowed = false;
  await page.goto(URL);
  await expect(page.getByRole("button", { name: "Probe now", exact: true })).toBeDisabled();
  await expect(page.getByText("Probe permission is not enabled for this connection.", { exact: true })).toBeVisible();
  expect(state.calls.filter((call) => call.name === "monitoring_probe")).toHaveLength(0);
});

test("a pre-journal busy rejection leaves a fresh diagnostic available", async ({ page }) => {
  await mockMonitoring(page);
  let rejected = false;
  await page.route("**/api/commands/monitoring_probe", async (route) => {
    if (rejected) return route.fallback();
    rejected = true;
    await route.fulfill({ status: 409, json: { error: { code: "monitoring_probe_busy", message: "A diagnostic is running. Wait a few seconds and try again." } } });
  });
  await page.goto(URL);
  await page.getByRole("button", { name: "Probe now", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Wait a few seconds");
  await expect(page.getByRole("button", { name: "Probe now", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Probe now", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Diagnostic passed" })).toBeVisible();
});

test("long target identifiers keep diagnostics and direct editing usable in both themes", async ({ page }) => {
  const state = await mockMonitoring(page);
  const id = "health-" + "a".repeat(57);
  state.configuration.targets[0]!.id = id;
  state.configuration.targets[0]!.url = "https://example.com/" + "long-path/".repeat(45);
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem("hq.theme.v1", value), theme);
      await page.goto(URL);
      const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: id, exact: true }) });
      const probe = row.getByRole("button", { name: /Probe (now|again)/ });
      await probe.click();
      await expect(row.getByRole("status")).toContainText("Diagnostic passed");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await probe.focus();
      await page.keyboard.press("Tab");
      await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").getByLabel("Target ID", { exact: true })).toHaveValue(id);
      await page.keyboard.press("Escape");
      await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
    }
  }
});

test("viewers can read evidence but cannot run diagnostics", async ({ page }) => {
  await mockMonitoring(page, { viewer: true });
  await page.goto(URL);
  await expect(page.getByText("Your role can view monitoring but cannot run diagnostics.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Probe now", exact: true })).toHaveCount(0);
});
