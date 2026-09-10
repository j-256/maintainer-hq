import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockHookPolicies } from "./hooks-policy-fixture";
import { HOOK_CONNECTION } from "./hooks-fixture";

const URL =
  "/hooks?workspace=development&connection=" +
  HOOK_CONNECTION.id +
  "&view=subscriptions";
async function editor(page: Page) {
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit routing", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Enabled for future events",
  );
  return page.getByRole("dialog");
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

test("reviews exact routing changes, preserves the draft on Back, and applies once", async ({
  page,
}) => {
  const state = await mockHookPolicies(page);
  const dialog = await editor(page);
  const enabled = dialog.getByRole("checkbox", {
    name: "Enabled for future events",
  });
  await enabled.uncheck();
  await dialog.getByRole("button", { name: "Next destinations" }).click();
  await dialog.getByRole("checkbox", { name: /Team inbox/ }).check();
  const filters = dialog.getByRole("group", {
    name: "Subscription filters",
    exact: true,
  });
  await filters.getByLabel("Include event types").fill("github.*, ");
  await filters
    .getByLabel("Include event types")
    .pressSequentially("custom.event");
  await expect(filters.getByLabel("Include event types")).toHaveValue(
    "github.*, custom.event",
  );
  await filters
    .getByRole("group", { name: "Exclude severities" })
    .getByRole("checkbox", { name: "debug" })
    .check();
  expect(state.policy.enabled).toBe(true);
  expect(state.applies).toBe(0);
  await dialog.getByRole("button", { name: "Review changes" }).click();
  const review = page.getByRole("alertdialog");
  await expect(review).toContainText("Review routing changes");
  await expect(
    review.getByRole("region", { name: "Before", exact: true }),
  ).toContainText("Enabled");
  await expect(
    review.getByRole("region", { name: "After", exact: true }),
  ).toContainText("Disabled");
  await expect(
    review.getByRole("region", { name: "After", exact: true }),
  ).toContainText("Team inbox");
  await review.getByRole("button", { name: "Back to editing" }).click();
  await expect(enabled).not.toBeChecked();
  await expect(filters.getByLabel("Include event types")).toHaveValue(
    "github.*, custom.event",
  );
  await dialog.getByRole("button", { name: "Review changes" }).click();
  expect(state.reviews.size).toBe(1);
  await review
    .getByRole("button", { name: "Apply routing", exact: true })
    .click();
  await expect(review).toContainText("Routing changed in Hookrelay");
  expect(state.applies).toBe(1);
  expect(state.policy).toMatchObject({
    enabled: false,
    sinks: ["Test phone", "Team inbox"],
    filter: {
      eventTypes: { include: ["github.*", "custom.event"] },
      severities: { exclude: ["debug"] },
    },
  });
  await expect(
    review.getByRole("button", { name: "Apply routing" }),
  ).toHaveCount(0);
  await review.getByRole("button", { name: "Close receipt" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Open receipt" }).click();
  await expect(review).toContainText("Routing changed in Hookrelay");
  expect(
    state.hooks.calls.filter((call) => call.name === "hooks_retry_get"),
  ).toHaveLength(0);
});

test("reopens and reconciles a lost apply response without sending another change", async ({
  page,
}) => {
  const state = await mockHookPolicies(page);
  const dialog = await editor(page);
  await dialog
    .getByRole("checkbox", { name: "Enabled for future events" })
    .uncheck();
  await dialog.getByRole("button", { name: "Review changes" }).click();
  state.loseApplyResponse = true;
  await page
    .getByRole("button", { name: "Apply routing", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Needs reconciliation",
  );
  const savedUrl = page.url();
  await page.reload();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Needs reconciliation",
  );
  expect(page.url()).toBe(savedUrl);
  await page.getByRole("button", { name: "Reconcile with Hookrelay" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Routing changed in Hookrelay",
  );
  expect(state.applies).toBe(1);
  expect(
    state.hooks.calls.filter((call) => call.name === "hooks_policy_apply"),
  ).toHaveLength(1);
});

test("keeps drafts on conflict, validation, failed reload and dismissal", async ({
  page,
}) => {
  const state = await mockHookPolicies(page);
  const dialog = await editor(page);
  const filters = dialog.getByRole("group", {
    name: "Subscription filters",
    exact: true,
  });
  await filters.getByLabel("Include event types").fill("INVALID");
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Subscription filters");
  expect(state.reviews.size).toBe(0);
  await filters.getByLabel("Include event types").fill("github.*");
  state.rejectPlan = true;
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Saved routing changed",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Discard unsaved changes?",
  );
  await page.getByRole("button", { name: "Keep editing" }).click();
  state.rejectRead = true;
  await dialog.getByRole("button", { name: "Load saved routing" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved routing" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Synthetic routing read failed",
  );
  await expect(filters.getByLabel("Include event types")).toHaveValue(
    "github.*",
  );
  state.rejectRead = false;
  await dialog.getByRole("button", { name: "Load saved routing" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved routing" })
    .click();
  await expect(filters.getByLabel("Include event types")).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Review changes" }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Edit routing", exact: true }),
  ).toBeFocused();
});

test("retries a lost review response with the same draft identity", async ({
  page,
}) => {
  const state = await mockHookPolicies(page);
  const dialog = await editor(page);
  await dialog
    .getByRole("checkbox", { name: "Enabled for future events" })
    .uncheck();
  state.losePlanResponse = true;
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "review response was lost",
  );
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Review routing changes",
  );
  expect(state.reviews.size).toBe(1);
  expect(state.applies).toBe(0);
});

for (const options of [{ viewer: true }, { canConfigure: false }]) {
  test(
    "explains read-only routing " + JSON.stringify(options),
    async ({ page }) => {
      await mockHookPolicies(page, options);
      await page.goto(URL);
      await expect(
        page.getByRole("button", { name: "Edit routing", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "View routing", exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", { name: "Enabled for future events" }),
      ).toBeDisabled();
      await expect(page.getByRole("dialog")).toContainText(
        options.viewer
          ? "Your workspace role can inspect routing"
          : "provider credential does not allow routing changes",
      );
    },
  );
}
for (const options of [{ mode: "legacy" as const }, { supported: false }]) {
  test(
    "keeps subscription reads usable without an active editor " +
      JSON.stringify(options),
    async ({ page }) => {
      const state = await mockHookPolicies(page, options);
      await page.goto(URL);
      await expect(page.locator(".hook-subscription-grid")).toContainText(
        "Synthetic subscription",
      );
      await expect(
        page.getByRole("button", { name: "Edit routing", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".hook-section")).toContainText(
        options.mode
          ? "read-only until"
          : "does not support the routing editor",
      );
      expect(
        state.hooks.calls.some((call) => call.name.startsWith("hooks_policy_")),
      ).toBe(false);
    },
  );
}

test("routing reads are scoped to subscriptions, not the deliveries tab", async ({
  page,
}) => {
  const state = await mockHookPolicies(page);
  await page.goto("/hooks?workspace=development&view=deliveries");
  await expect(page.locator(".hook-table")).toBeVisible();
  expect(
    state.hooks.calls.some(
      (call) =>
        call.name === "hooks_configuration" ||
        call.name.startsWith("hooks_policy_"),
    ),
  ).toBe(false);
});

test("policy forms and exact reviews fit both themes, mobile and larger text with keyboard access", async ({
  page,
}, testInfo) => {
  const state = await mockHookPolicies(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"])
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto(URL);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      const trigger = page.getByRole("button", {
        name: "Edit routing",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await settle(page, "dialog");
      const dialog = page.getByRole("dialog");
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(width);
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`editor-${theme}-${width}.png`),
      });
      const enabled = dialog.getByRole("checkbox", {
        name: "Enabled for future events",
      });
      await enabled.focus();
      await page.keyboard.press("Space");
      await dialog.getByRole("button", { name: "Review changes" }).focus();
      await page.keyboard.press("Enter");
      await settle(page, "alertdialog");
      const review = page.getByRole("alertdialog");
      expect(
        await review.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .include('[role="alertdialog"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`review-${theme}-${width}.png`),
      });
      await review.getByRole("button", { name: "Close review" }).focus();
      await page.keyboard.press("Enter");
      await expect(trigger).toBeFocused();
    }
  expect(errors).toEqual([]);
  expect(state.applies).toBe(0);
});
