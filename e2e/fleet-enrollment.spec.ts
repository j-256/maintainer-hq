import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { FLEET_REVIEW_PARAM } from "../shared/fleet-discovery";
import { fleetFixture, FLEET_URL } from "./fleet-enrollment-fixture";
import { verifyFlatContrast } from "./flat-contrast";

async function choose(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function open(page: Page) {
  await page.goto(FLEET_URL + "&q=example&classification=watchlist");
  await page
    .getByRole("button", { name: "Review enrollment", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review enrollment" }),
  ).toBeVisible();
  await choose(page, "Discovery GitHub source", "Read-only fleet source");
}
async function select(page: Page) {
  await page.getByRole("button", { name: "Check GitHub", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select example/renamed", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Select example/discovered-01",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Configure 2 repositories", exact: true })
    .click();
}
async function configure(page: Page) {
  await choose(
    page,
    "Owning project for example/discovered-01",
    "Development",
  );
  await choose(page, "Tracking for example/discovered-01", "Watchlist");
  await page
    .getByRole("checkbox", {
      name: "Collect example/discovered-01 with Read-only fleet source",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Prepare review", exact: true })
    .click();
}
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
}
async function audit(page: Page) {
  await settled(page);
  const dialog = page.getByRole("dialog", { name: "Review enrollment" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const result = await new AxeBuilder({ page })
    .include(".fleet-dialog")
    .analyze();
  expect(result.violations).toEqual([]);
  for (const finding of result.incomplete) {
    expect(finding.id).toBe("color-contrast");
    for (const node of finding.nodes) {
      const selector = node.target[0] as string;
      await page.locator(selector).scrollIntoViewIfNeeded();
      const shown = await new AxeBuilder({ page })
        .include(selector)
        .withRules(["color-contrast"])
        .analyze();
      expect(shown.violations).toEqual([]);
      await verifyFlatContrast(page, shown.incomplete);
    }
  }
}

for (const width of [1440, 390])
  for (const theme of ["dark", "light"]) {
    test(`reviewed enrollment ${width} ${theme}: readable, explicit and scoped`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const state = await fleetFixture(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page);
      expect(
        state.calls.filter((call) => call.name.startsWith("fleet_") && call.name !== "fleet_sources"),
      ).toEqual([]);
      await page
        .getByRole("button", { name: "Check GitHub", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Review enrollment" });
      await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(
        0,
      );
      await expect(
        dialog.getByRole("checkbox", { name: "Select example/discovered-02" }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("checkbox", { name: "Select example/unavailable" }),
      ).toBeDisabled();
      await audit(page);
      await dialog
        .locator(".fleet-scroll")
        .evaluate((element) => element.scrollTo({ top: 0 }));
      await page.screenshot({
        path: info.outputPath(`discovery-${width}-${theme}.png`),
      });
      await dialog
        .getByRole("checkbox", { name: "Select example/renamed", exact: true })
        .check();
      await dialog
        .getByRole("checkbox", {
          name: "Select example/discovered-01",
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "Configure 2 repositories", exact: true })
        .click();
      await expect(
        dialog.getByRole("heading", { name: "Review enrollment", exact: true }),
      ).toBeFocused();
      expect(
        await dialog
          .locator(".fleet-scroll")
          .evaluate((element) => element.scrollTop),
      ).toBe(0);
      await expect(
        dialog.getByRole("button", { name: "Prepare review" }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("checkbox", {
          name: "Collect example/renamed with Read-only fleet source",
          exact: true,
        }),
      ).toBeChecked();
      await expect(
        dialog.getByRole("checkbox", {
          name: "Collect example/discovered-01 with Read-only fleet source",
          exact: true,
        }),
      ).not.toBeChecked();
      await audit(page);
      await configure(page);
      await expect(
        dialog.getByRole("heading", { name: "Ready for your review" }),
      ).toBeVisible();
      expect(state.planInputs[0].selections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            repositoryId: "fleet-existing",
            revision: 1,
            fullName: "example/renamed",
            lifecycle: "archived",
            collect: true,
          }),
          expect.objectContaining({
            repositoryId: null,
            classification: "watchlist",
            projectId: "development-default",
            projectRevision: 1,
            collect: true,
          }),
        ]),
      );
      expect(state.applyInputs).toEqual([]);
      await audit(page);
      await dialog
        .locator(".fleet-scroll")
        .evaluate((element) => element.scrollTo({ top: 0 }));
      await page.screenshot({
        path: info.outputPath(`review-${width}-${theme}.png`),
      });
      await page
        .getByRole("button", { name: "Apply reviewed changes", exact: true })
        .click();
      await expect(
        dialog.getByRole("heading", { name: "Enrollment saved" }),
      ).toBeVisible();
      expect(state.applyInputs).toEqual([
        {
          workspaceId: "development",
          planId: state.review!.planId,
          fingerprint: state.review!.fingerprint,
        },
      ]);
      await audit(page);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Review enrollment", exact: true }),
      ).toBeFocused();
      expect(page.url()).toContain("q=example");
      expect(page.url()).toContain("classification=watchlist");
      expect(errors).toEqual([]);
      expect(state.calls.map((call) => call.name)).not.toEqual(
        expect.arrayContaining([
          "workspace_snapshot",
          "activity_feed",
          "repository_work",
          "repository_releases",
          "github_refresh",
        ]),
      );
    });
  }
test("selection and source authority remain explicit across pages and catalog scopes", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  await open(page);
  await choose(page, "Discovery scope", "Owner or organization catalog");
  await page
    .getByRole("textbox", { name: "GitHub owner or organization" })
    .fill("example");
  await page.getByRole("button", { name: "Check GitHub", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select example/renamed", exact: true })
    .check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByText("Page 2; 1 repository selected across pages"),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Select example/page-two-0", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Select example/renamed", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Configure 2 repositories", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "example/page-two-0", exact: true }),
  ).toBeVisible();
  const calls = state.calls.filter((call) => call.name === "fleet_discover");
  expect(calls).toHaveLength(3);
  expect(calls[0].input).toMatchObject({
    sourceId: state.source.id,
    sourceRevision: 1,
    scope: { kind: "owner", owner: "example", cursor: null },
  });
  expect(calls[1].input.scope).toMatchObject({
    cursor: {
      sourceId: state.source.id,
      sourceRevision: 1,
      owner: "example",
      after: "page-two",
    },
  });
});
test("partial provider visibility is distinct from a failed discovery read", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  state.result.candidates = [
    state.result.candidates[0],
    state.result.candidates[3],
  ];
  state.result.evidence!.read = { state: "error", reason: "provider_error" };
  await open(page);
  await page.getByRole("button", { name: "Check GitHub", exact: true }).click();
  const coverage = page.getByRole("region", { name: "Discovery coverage" });
  await expect(coverage).toContainText("Partially verified");
  await expect(coverage).toContainText("Verified 1 of 2 repositories on this page");
  await expect(coverage).not.toContainText("Read failed");
  await expect(
    page.getByRole("checkbox", { name: "Select example/unavailable" }),
  ).toBeDisabled();
  state.result.candidates = [];
  await page.getByRole("button", { name: "Check GitHub", exact: true }).click();
  await expect(coverage).toContainText("Read failed");
  await expect(coverage).not.toContainText("Partially verified");
});
test("a lost preparation response reuses the same exact review ID after reload", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  state.losePreparation = true;
  await open(page);
  await select(page);
  await configure(page);
  await expect(page.getByRole("alert")).toContainText("could not be reached");
  const id = new URL(page.url()).searchParams.get(FLEET_REVIEW_PARAM);
  expect(id).toBe(state.planInputs[0].reviewId);
  state.missingReview = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("not available");
  await page
    .getByRole("button", { name: "Retry preparation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready for your review" }),
  ).toBeVisible();
  expect(state.planInputs).toHaveLength(2);
  expect(state.planInputs[0]).toEqual(state.planInputs[1]);
  expect(state.applyInputs).toEqual([]);
});
test("lost Apply responses recover the original receipt without resubmitting", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  state.loseApply = true;
  await open(page);
  await select(page);
  await configure(page);
  await page
    .getByRole("button", { name: "Apply reviewed changes", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "do not start a replacement",
  );
  await expect(
    page.getByRole("button", { name: "Edit choices", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Enrollment saved" }),
  ).toBeVisible();
  expect(state.planInputs).toHaveLength(1);
  expect(state.applyInputs).toHaveLength(1);
});
test("an uncertain uncommitted Apply retries only its exact fingerprint and remains guarded", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  state.loseApply = true;
  state.commitOnApply = false;
  await open(page);
  await select(page);
  await configure(page);
  await page
    .getByRole("button", { name: "Apply reviewed changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check saved review", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("No committed receipt");
  await expect(
    page.getByRole("button", { name: "Start discovery again", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Closing does not cancel Apply");
  await confirmation
    .getByRole("button", { name: "Keep review open", exact: true })
    .click();
  state.commitOnApply = true;
  await page
    .getByRole("button", { name: "Retry exact Apply", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Enrollment saved" }),
  ).toBeVisible();
  expect(state.applyInputs).toHaveLength(2);
  expect(state.applyInputs[0]).toEqual(state.applyInputs[1]);
});
test("stale reviews preserve choices and offer a fresh review without granting extra access", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  state.rejectApply = true;
  await open(page);
  await select(page);
  await configure(page);
  await page
    .getByRole("button", { name: "Apply reviewed changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review needs updating" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit choices", exact: true }).click();
  await expect(
    page.getByRole("combobox", {
      name: "Tracking for example/discovered-01",
      exact: true,
    }),
  ).toContainText("Watchlist");
  await expect(
    page.getByRole("combobox", {
      name: "Owning project for example/discovered-01",
      exact: true,
    }),
  ).toContainText("Development");
  await expect(
    page.getByRole("checkbox", {
      name: "Collect example/discovered-01 with Read-only fleet source",
      exact: true,
    }),
  ).toBeChecked();
});
test("the dialog traps keyboard focus and returns it without fetching unrelated data", async ({
  page,
}) => {
  const state = await fleetFixture(page);
  await open(page);
  const dialog = page.getByRole("dialog", { name: "Review enrollment" });
  await dialog
    .getByRole("heading", { name: "Review enrollment", exact: true })
    .focus();
  for (const direction of ["Tab", "Shift+Tab"])
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press(direction);
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review enrollment", exact: true }),
  ).toBeFocused();
  expect(state.calls.filter((call) => call.name.startsWith("fleet_") && call.name !== "fleet_sources")).toEqual(
    [],
  );
});
test("viewers cannot open discovery or use a saved review to bypass the owner gate", async ({
  page,
}) => {
  const state = await fleetFixture(page, "viewer");
  await page.goto(FLEET_URL);
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review enrollment", exact: true }),
  ).toHaveCount(0);
  await page.goto(
    FLEET_URL + "&" + FLEET_REVIEW_PARAM + "=" + crypto.randomUUID(),
  );
  await expect(page.getByRole("dialog")).toContainText(
    "A workspace owner with metadata-write access",
  );
  expect(state.calls.filter((call) => call.name.startsWith("fleet_"))).toEqual(
    [],
  );
});
