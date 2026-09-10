import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  mockHooks,
  HOOK_CONNECTION,
  HOOK_DELIVERY,
  HOOK_TIME,
} from "./hooks-fixture";

const URL = "/hooks?workspace=development";
test.use({ timezoneId: "America/New_York" });
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function settle(page: Page, role: "dialog" | "alertdialog") {
  await page.getByRole(role).evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await expect(page.getByRole(role)).toHaveCSS("opacity", "1");
}

test("enrolls connection metadata, guards drafts, and reloads saved settings after conflict", async ({
  page,
}) => {
  const controlWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      /Select is changing from (uncontrolled|controlled)/.test(message.text())
    )
      controlWarnings.push(message.text());
  });
  const state = await mockHooks(page, { empty: true });
  await page.goto(URL);
  await expect(
    page.getByRole("heading", { name: "Bring your hooks into view" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect Hookrelay", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name").fill("My test hooks");
  await select(page, "Hookrelay provider", "Synthetic provider");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Discard unsaved changes?",
  );
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Hookrelay connection" }),
  ).toHaveText("My test hooks");
  const settings = page.getByRole("button", { name: "Connection settings" });
  await settings.click();
  await dialog.getByLabel("Connection name").fill("Unsaved draft");
  state.conflict = true;
  state.connections[0]!.name = "Saved elsewhere";
  state.connections[0]!.revision += 1;
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Settings changed");
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Unsaved draft",
  );
  state.rejectRead = true;
  await dialog.getByRole("button", { name: "Load saved settings" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved settings" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Synthetic read failure",
  );
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Unsaved draft",
  );
  state.rejectRead = false;
  await dialog.getByRole("button", { name: "Load saved settings" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved settings" })
    .click();
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Saved elsewhere",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(state.calls.some((call) => call.name.startsWith("hooks_retry"))).toBe(
    false,
  );
  expect(controlWarnings).toEqual([]);
});

test("shows sample coverage, bounded empty pages, addressable filters, and account-formatted times", async ({
  page,
}) => {
  const state = await mockHooks(page);
  await page.goto(URL);
  await expect(
    page.getByText(/Sampled health, not a complete inventory/),
  ).toBeVisible();
  await page
    .getByText("Recent operational signals (1)", { exact: true })
    .click();
  await expect(
    page.getByText("delivery exhausted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Older operational signals are not included/),
  ).toBeVisible();
  const time = page.locator(".hook-table time").first();
  await expect(time).toHaveText("2026-09-06 06:00");
  await expect(time).toHaveAttribute("datetime", HOOK_TIME);
  await expect(time).toHaveAttribute("title", /America\/New_York/);
  await select(page, "Delivery state", "Needs attention");
  await page
    .getByLabel("Subscription name", { exact: true })
    .fill("Rare subscription");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page).toHaveURL(/subscription=Rare\+subscription/);
  await expect(
    page.getByRole("heading", { name: "No matches in this page" }),
  ).toBeVisible();
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.locator(".hook-table")).toContainText("synthetic:older");
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matches in this page" }),
  ).toBeVisible();
  expect(
    state.calls.filter((call) => call.name === "hooks_deliveries").at(-1)!.input
      .cursor,
  ).toBeNull();
  await page.reload();
  await expect(
    page.getByLabel("Subscription name", { exact: true }),
  ).toHaveValue("Rare subscription");
});

test("opens retained failures beyond a zero-failure sample and renders rate-limit signals", async ({
  page,
}) => {
  const state = await mockHooks(page);
  state.snapshot.deliveries.totals.exhausted = 0;
  state.snapshot.deliveries.totals.delivered = state.snapshot.deliveries.sampled;
  state.snapshot.signals.items[0]!.code = "ingress-rate-limited";
  state.snapshot.signals.items[0]!.severity = "warning";
  await page.goto(URL + "&subscription=Rare+subscription");
  const summary = page.getByRole("region", { name: "Hookrelay health sample" });
  await expect(
    summary.getByText("Exhausted in sample", { exact: true }),
  ).toBeVisible();
  const inspect = summary.getByRole("button", {
    name: "Inspect all exhausted deliveries, 0 in sample",
    exact: true,
  });
  await expect(inspect).toHaveText("0");
  await summary
    .getByText("Recent operational signals (1)", { exact: true })
    .click();
  await expect(
    summary.getByText("ingress rate limited", { exact: true }),
  ).toBeVisible();
  await expect(summary.getByText("warning", { exact: true })).toBeVisible();
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/status=exhausted/);
  expect(new globalThis.URL(page.url()).searchParams.has("subscription")).toBe(
    false,
  );
  await expect(page.locator(".hook-table")).toContainText(HOOK_DELIVERY.eventId);
  expect(
    state.calls.filter((call) => call.name === "hooks_deliveries").at(-1)?.input,
  ).toMatchObject({
    status: "exhausted",
    subscription: null,
    cursor: null,
  });
  expect(state.calls.some((call) => call.name.startsWith("hooks_retry"))).toBe(
    false,
  );
  expect(state.applies).toBe(0);
});

test("identifies a complete retained count without calling it a truncated sample", async ({
  page,
}) => {
  const state = await mockHooks(page);
  state.snapshot.deliveries.truncated = false;
  state.snapshot.deliveries.sampled = 1;
  state.snapshot.deliveries.totals.exhausted = 1;
  await page.goto(URL);
  const summary = page.getByRole("region", { name: "Hookrelay health sample" });
  await expect(summary.getByText("Exhausted", { exact: true })).toBeVisible();
  await expect(
    summary.getByRole("button", {
      name: "Inspect all exhausted deliveries, 1 retained",
      exact: true,
    }),
  ).toHaveText("1");
  await expect(summary).toContainText("Counts cover all 1 retained deliveries");
  await expect(summary).not.toContainText("Older failures may be outside");
});

test("associates a subscription with a standalone project and restores keyboard focus", async ({
  page,
}) => {
  const state = await mockHooks(page);
  await page.goto(URL + "&view=subscriptions");
  const edit = page.getByRole("button", {
    name: "Associate project",
    exact: true,
  });
  await edit.click();
  await select(page, "Primary project", "Standalone service");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  state.associationConflict = true;
  state.association.revision = 1;
  await dialog.getByRole("button", { name: "Save association" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Primary project" }),
  ).toHaveText("Standalone service");
  await dialog.getByRole("button", { name: "Load saved association" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved association" })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Primary project" }),
  ).toHaveText("Choose a project");
  await expect(
    dialog.getByRole("button", { name: "Save association" }),
  ).toBeDisabled();
  state.associationConflict = false;
  await select(page, "Primary project", "Standalone service");
  await dialog.getByRole("button", { name: "Save association" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(
    page.getByText("Project: Standalone service", { exact: true }),
  ).toBeVisible();
  expect(state.association.projectId).toBe("standalone");
  expect(state.association.revision).toBe(2);
  expect(
    state.calls.filter((call) => call.name === "resource_project_save").at(-1)
      ?.input,
  ).toMatchObject({
    projectId: "standalone",
    projectRevision: 1,
    connectionRevision: 1,
    revision: 1,
  });
});

test("reviews exact consequences, survives response loss, and reconciles once from a reloadable receipt", async ({
  page,
}) => {
  const state = await mockHooks(page);
  state.loseApplyResponse = true;
  await page.goto(URL);
  await page
    .getByRole("button", {
      name:
        "Inspect delivery " +
        HOOK_DELIVERY.eventId +
        " to " +
        HOOK_DELIVERY.sinkName,
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Generation4");
  await page.getByRole("button", { name: "Review retry", exact: true }).click();
  const review = page.getByRole("alertdialog");
  await expect(
    review.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(review).toContainText("This can send a real notification");
  await expect(review).toContainText(
    "at-least-once delivery can produce duplicates",
  );
  await expect(page).toHaveURL(/review=/);
  await review
    .getByRole("button", { name: "Confirm retry", exact: true })
    .click();
  await expect(
    review.getByRole("button", {
      name: "Reconcile with Hookrelay",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.applies).toBe(1);
  await page.reload();
  await expect(review).toContainText("Needs reconciliation");
  state.connections[0]!.enabled = false;
  state.connections[0]!.revision += 1;
  await page.reload();
  await review
    .getByRole("button", { name: "Reconcile with Hookrelay", exact: true })
    .click();
  await expect(review.getByRole("heading")).toHaveText(
    "Retry accepted by Hookrelay",
  );
  await expect(review).toContainText("not a delivery confirmation");
  expect(state.applies).toBe(1);
  await review
    .getByRole("button", { name: "Close receipt", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Hooks", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Open receipt", exact: true }).click();
  await expect(review).toContainText("Retry accepted by Hookrelay");
});

test("viewers get read-only screens and unavailable providers never appear healthy", async ({
  page,
}) => {
  const state = await mockHooks(page, { viewer: true });
  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Connect Hookrelay", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Inspect delivery/ }).click();
  await expect(
    page.getByRole("button", { name: "Review retry", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText(
    "Your role can inspect deliveries",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  state.connections[0]!.available = false;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Provider connection unavailable" }),
  ).toBeVisible();
  await expect(page.locator(".hook-metrics")).toHaveCount(0);
  expect(state.applies).toBe(0);
});

test("Hooks screens and dialogs fit mobile and desktop in both themes with accessible controls", async ({
  page,
}) => {
  await mockHooks(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"])
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto(URL + "&connection=" + HOOK_CONNECTION.id);
      await expect(page.locator(".connection-state")).toContainText(
        "Live updates",
      );
      await page.waitForLoadState("networkidle");
      await expect(page.locator(".hook-table")).toContainText(
        HOOK_DELIVERY.eventId,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: /^Inspect delivery/ }).click();
      await settle(page, "dialog");
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      await page
        .getByRole("button", { name: "Review retry", exact: true })
        .click();
      await settle(page, "alertdialog");
      expect(
        (
          await new AxeBuilder({ page })
            .include('[role="alertdialog"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", { name: "Connection settings", exact: true })
        .click();
      await settle(page, "dialog");
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  expect(errors).toEqual([]);
});
