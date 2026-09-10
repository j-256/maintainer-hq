import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  mockMonitoring,
  MONITOR_CONNECTION,
  MONITOR_REPOSITORIES,
  MONITOR_TARGET,
  MONITOR_TIME,
} from "./monitoring-fixture";
import { mockHooks, HOOK_DELIVERY } from "./hooks-fixture";

const URL = "/monitoring?workspace=development";
test.use({ timezoneId: "America/New_York" });
test("scheduler and target evidence age when provider reads fail and recover only from new evidence", async ({
  page,
}) => {
  const at = Date.parse(MONITOR_TIME);
  await page.clock.install({ time: at });
  const state = await mockMonitoring(page);
  state.execution = {
    state: "fresh",
    expectedIntervalSeconds: 60,
    retainedRunLimit: 120,
    freshUntil: new Date(at + 180000).toISOString(),
    lastRun: {
      scheduledAt: MONITOR_TIME,
      startedAt: MONITOR_TIME,
      completedAt: MONITOR_TIME,
      enabled: true,
      configurationRevision: 1,
      configFingerprint: "sha256:" + "a".repeat(64),
      probeIntervalMinutes: 5,
      targetCount: 1,
      dueTargets: 1,
      succeededProbes: 1,
      failedProbes: 0,
      phaseErrors: 0,
      deliveriesFailed: 0,
      subrequests: 1,
    },
  };
  state.check = {
    state: "passed",
    observedAt: MONITOR_TIME,
    lastSuccessAt: MONITOR_TIME,
    freshUntil: new Date(at + 420000).toISOString(),
    scheduledAt: MONITOR_TIME,
    configurationRevision: 1,
    configurationMatches: true,
    status: 200,
    errorCode: null,
  };
  await page.goto(URL);
  await expect(
    page.getByText("Fresh completion", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Check passed", { exact: true })).toBeVisible();
  await expect(page.getByText("Last retained pass:")).toContainText(
    "2026-09-06",
  );
  state.failEvidenceRead = true;
  await page.clock.runFor(181000);
  await expect(
    page.getByText("Scheduler overdue", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Check passed", { exact: true })).toBeVisible();
  await page.clock.runFor(240000);
  await expect(page.getByText("Check overdue", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").first()).toContainText(
    "Synthetic evidence read failure",
  );
  state.failEvidenceRead = false;
  await page
    .getByRole("button", { name: "Refresh targets", exact: true })
    .click();
  await expect(page.getByText("Check overdue", { exact: true })).toBeVisible();
  state.check = {
    ...state.check,
    state: "configuration_changed",
    configurationMatches: false,
    lastSuccessAt: null,
  };
  await page
    .getByRole("button", { name: "Refresh targets", exact: true })
    .click();
  await expect(
    page.getByText("Awaiting check of changed configuration", { exact: true }),
  ).toBeVisible();
  const next = new Date(at + 422000).toISOString();
  await page.clock.runFor(1000);
  state.check = {
    ...state.check,
    state: "passed",
    configurationMatches: true,
    observedAt: next,
    lastSuccessAt: next,
    freshUntil: new Date(at + 842000).toISOString(),
  };
  await page
    .getByRole("button", { name: "Refresh targets", exact: true })
    .click();
  await expect(page.getByText("Check passed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Scheduler overdue", { exact: true }),
  ).toBeVisible();
  expect(state.applies).toBe(0);
});
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function settle(page: Page, role: "dialog" | "alertdialog") {
  const dialog = page.getByRole(role).last();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await expect(dialog).toHaveCSS("opacity", "1");
}
test("repository hub gathers shared hooks, monitoring, and scoped activity with context-preserving links", async ({
  page,
}) => {
  await mockHooks(page);
  const state = await mockMonitoring(page);
  await page.goto("/repositories?workspace=development");
  await page.getByRole("link", { name: /example\/hq/ }).click();
  const sections = page.getByRole("navigation", {
    name: "Repository sections",
  });
  await sections.getByRole("link", { name: "Hooks", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: HOOK_DELIVERY.subscription }),
  ).toBeVisible();
  await expect(
    page.getByText("Shared with 1 other repo", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "View deliveries", exact: true })
    .click();
  await expect(page).toHaveURL(/subscription=Synthetic\+subscription/);
  await expect(page.locator(".repository-context")).toContainText("example/hq");
  await page.locator(".repository-context").getByRole("link").click();
  await sections.getByRole("link", { name: "Monitoring", exact: true }).click();
  await page
    .getByRole("link", { name: "Inspect monitor", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(MONITOR_TARGET.url);
  await expect(page.getByRole("dialog")).toContainText(
    "No retained probe evidence",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("group", { name: "Related repositories" }),
  ).toContainText("example/hq");
  await page.keyboard.press("Escape");
  await page.locator(".repository-context").getByRole("link").click();
  await sections.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Repository-specific work" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Filter by repository" }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((call) => call.name === "activity_feed").at(-1)!.input
      .repositoryId,
  ).toBe(MONITOR_REPOSITORIES[0]!.id);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Title", { exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Related to", exact: true }),
  ).toBeDisabled();
  expect(state.applies).toBe(0);
});
test("repository link drafts survive conflicts and failed reloads without changing the provider", async ({
  page,
}) => {
  const state = await mockMonitoring(page);
  await page.goto(URL + "&target=" + MONITOR_TARGET.id);
  await page
    .getByRole("button", { name: "Related repositories", exact: true })
    .click();
  const editor = page.getByRole("dialog").filter({
    has: page.getByRole("heading", {
      name: "Related repositories",
      exact: true,
    }),
  });
  await editor.getByRole("checkbox", { name: /example\/shared/ }).uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  state.linkConflict = true;
  await editor.getByRole("button", { name: "Save links", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Repository links changed",
  );
  state.rejectRead = true;
  await editor
    .getByRole("button", { name: "Load saved links", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved links", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "Synthetic read failure",
  );
  await expect(
    editor.getByRole("checkbox", { name: /example\/shared/ }),
  ).not.toBeChecked();
  state.linkConflict = false;
  state.rejectRead = false;
  await editor.getByRole("button", { name: "Save links", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Related repositories", exact: true }),
  ).toBeFocused();
  expect(
    state.links.get("monitor/" + MONITOR_TARGET.id)!.repositoryIds,
  ).toEqual([MONITOR_REPOSITORIES[0]!.id]);
  expect(state.applies).toBe(0);
});
test("structured target editing preserves nested assertions and recovers lost responses without resubmission", async ({
  page,
}) => {
  const state = await mockMonitoring(page);
  state.loseApplyResponse = true;
  await page.goto(URL + "&target=" + MONITOR_TARGET.id);
  await page.getByRole("button", { name: "Edit target", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByLabel("Target ID", { exact: true })).toBeDisabled();
  await editor
    .getByLabel("Endpoint URL", { exact: true })
    .fill("https://example.com/ready");
  await select(page, "Expected value for ready", "False");
  await editor
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const review = page.getByRole("alertdialog");
  await expect(
    review.getByRole("button", { name: "Back to form", exact: true }),
  ).toBeFocused();
  await expect(review).toContainText("Before");
  await expect(review).toContainText("https://example.com/ready");
  expect(state.applies).toBe(0);
  await review
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await expect(review).toContainText("Needs reconciliation");
  await expect(
    review.getByRole("status", { name: "Monitoring operation result" }),
  ).toBeFocused();
  await expect(page).toHaveURL(/review=/);
  expect(state.applies).toBe(1);
  expect(state.configuration.targets[0]!.expect!.jsonSubset).toEqual({
    ready: false,
    build: { channel: "stable" },
  });
  state.connections[0]!.enabled = false;
  state.connections[0]!.revision += 1;
  await page.reload();
  await review
    .getByRole("button", { name: "Reconcile with provider", exact: true })
    .click();
  await expect(review).toContainText(
    "The provider receipt confirms acceptance, not endpoint health.",
  );
  expect(state.applies).toBe(1);
  await review
    .getByRole("button", { name: "Close receipt", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Monitoring", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Open receipt", exact: true }).click();
  await expect(review).toContainText("Accepted");
});

for (const theme of ["light", "dark"]) {
  test(`long monitoring reviews keep actions and recovered outcomes in view on mobile in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (value) => localStorage.setItem("hq.theme.v1", value),
      theme,
    );
    const state = await mockMonitoring(page);
    state.loseApplyResponse = true;
    await page.goto(URL + "&target=" + MONITOR_TARGET.id);
    await page
      .getByRole("button", { name: "Edit target", exact: true })
      .click();
    await page
      .getByLabel("Endpoint URL", { exact: true })
      .fill("https://example.com/ready");
    await page
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    const review = page.getByRole("alertdialog");
    const confirm = review.getByRole("button", {
      name: "Confirm change",
      exact: true,
    });
    await expect(confirm).toBeInViewport();
    const details = review.getByRole("region", {
      name: "Monitoring review details",
      exact: true,
    });
    await details.focus();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => details.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(confirm).toBeInViewport();
    await expect(
      review.getByRole("button", { name: "Back to form", exact: true }),
    ).toBeInViewport();
    await confirm.click();
    const result = review.getByRole("status", {
      name: "Monitoring operation result",
    });
    await expect(result).toBeFocused();
    await expect(result).toBeInViewport({ ratio: 1 });
    await expect(result).toContainText("Needs reconciliation");
    const reconcile = review.getByRole("button", {
      name: "Reconcile with provider",
      exact: true,
    });
    await expect(reconcile).toBeInViewport();
    await reconcile.click();
    await expect(result).toContainText("Accepted");
    await expect(result).toBeInViewport({ ratio: 1 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(state.applies).toBe(1);
  });
}
test("configuration drafts survive stale revisions and keep edits when saved state cannot be read", async ({
  page,
}) => {
  const state = await mockMonitoring(page);
  await page.goto(URL + "&target=" + MONITOR_TARGET.id);
  await page.getByRole("button", { name: "Edit target", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor
    .getByLabel("Endpoint URL", { exact: true })
    .fill("https://example.com/draft");
  state.conflict = true;
  await editor
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "Configuration changed",
  );
  state.rejectRead = true;
  await editor
    .getByRole("button", { name: "Load saved configuration", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved configuration", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "Synthetic read failure",
  );
  await expect(editor.getByLabel("Endpoint URL", { exact: true })).toHaveValue(
    "https://example.com/draft",
  );
  state.rejectRead = false;
  state.configuration.targets[0]!.url = "https://example.com/elsewhere";
  state.revision += 1;
  await editor
    .getByRole("button", { name: "Load saved configuration", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved configuration", exact: true })
    .click();
  await expect(editor.getByLabel("Endpoint URL", { exact: true })).toHaveValue(
    "https://example.com/elsewhere",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.applies).toBe(0);
});
test("incident triage has a reviewed local-clock end time and bounded target and history pages", async ({
  page,
}) => {
  const state = await mockMonitoring(page);
  await page.goto(URL);
  await page
    .getByRole("navigation", { name: "Targets pagination" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "second-page", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh targets", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: MONITOR_TARGET.id, exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter((call) => call.name === "monitoring_targets").at(-1)!
      .input.cursor,
  ).toBeNull();
  await page.getByRole("button", { name: "Incidents", exact: true }).click();
  const time = page.locator(".monitor-card time").first();
  await expect(time).toHaveText("2026-09-06 06:00");
  await expect(time).toHaveAttribute("datetime", MONITOR_TIME);
  await page
    .getByRole("button", { name: "Inspect incident", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Incident history pagination" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Incident history pagination" }),
  ).toContainText("Page 2");
  await page
    .getByRole("button", { name: "Triage incident", exact: true })
    .click();
  await select(page, "Action", "Snooze notifications");
  await page.getByLabel("Snooze for (hours)", { exact: true }).fill("4");
  await page
    .getByLabel("Operator note (optional)")
    .fill("Synthetic maintenance window");
  await page
    .getByRole("button", { name: "Review triage", exact: true })
    .click();
  const review = page.getByRole("alertdialog");
  await expect(review).toContainText("Synthetic maintenance window");
  await expect(review.locator("time").last()).toHaveAttribute(
    "title",
    /America\/New_York/,
  );
  await review
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await expect(review).toContainText("Accepted");
  expect(state.applies).toBe(1);
});
test("viewers cannot mutate and unavailable providers do not show cached health", async ({
  page,
}) => {
  const state = await mockMonitoring(page, { viewer: true });
  await page.goto(URL + "&target=" + MONITOR_TARGET.id);
  await expect(page.getByRole("dialog")).toContainText(
    "Your role can inspect targets but cannot change",
  );
  await expect(
    page.getByRole("button", { name: "Edit target", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect Endpoint Monitor", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  state.connections[0]!.available = false;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Provider connection unavailable" }),
  ).toBeVisible();
  await expect(page.locator(".hook-metrics")).toHaveCount(0);
  expect(state.applies).toBe(0);
  await page.waitForLoadState("networkidle");
});
test("monitoring and repository screens fit both themes and mobile with accessible keyboard controls", async ({
  page,
}) => {
  await mockMonitoring(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"])
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto(URL + "&connection=" + MONITOR_CONNECTION.id);
      await expect(page.locator(".connection-state")).toContainText(
        "Live updates",
      );
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("heading", { name: MONITOR_TARGET.id, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const inspect = page.getByRole("button", {
        name: "Inspect target",
        exact: true,
      });
      await inspect.focus();
      await page.keyboard.press("Enter");
      await settle(page, "dialog");
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      await page
        .getByRole("button", { name: "Edit target", exact: true })
        .click();
      await settle(page, "dialog");
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.goto(
        "/repositories/" +
          MONITOR_REPOSITORIES[0]!.id +
          "?workspace=development&section=monitoring",
      );
      await expect(page.locator(".connection-state")).toContainText(
        "Live updates",
      );
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("heading", { name: MONITOR_TARGET.id, exact: true }),
      ).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  expect(errors).toEqual([]);
});
