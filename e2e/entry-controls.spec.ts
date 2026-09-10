import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./test-fixture";

async function audit(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const theme of ["light", "dark"]) {
  test(`primary actions stay readable at rest, on hover, and after validation in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("hq.theme.v1", value),
      theme,
    );
    await page.goto("/projects?workspace=development");
    const create = page.getByRole("button", {
      name: "Create project",
      exact: true,
    });
    await expect(create).toBeVisible();
    await page.mouse.move(0, 0);
    await audit(page);
    await create.hover();
    await audit(page);
    await create.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", {
      name: "Create project",
      exact: true,
    });
    await submit.hover();
    await audit(page);
    await submit.click();
    await expect(
      dialog.getByLabel("Project name", { exact: true }),
    ).toBeFocused();
    await audit(page);
  });

  test(`initial session failure has a page heading and recovers to the requested inventory in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (value) => localStorage.setItem("hq.theme.v1", value),
      theme,
    );
    await page.route("**/api/session", (route) =>
      route.fulfill({
        status: 401,
        json: {
          error: {
            code: "unauthorized",
            message: "Sign in again, then retry.",
          },
        },
      }),
    );
    await page.goto("/repositories?workspace=development&q=synthetic");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Unable to load workspace",
    );
    await audit(page);
    await page.unroute("**/api/session");
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Repositories",
    );
    await expect(
      page.getByRole("textbox", { name: "Search repositories" }),
    ).toHaveValue("synthetic");
    await audit(page);
  });
}
