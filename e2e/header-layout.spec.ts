import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { PUSH_STATUS_LABEL } from "../src/lib/workspace-push";

for (const theme of ["light", "dark"]) {
  test(`mobile header accommodates every connection label with enlarged text in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.addInitScript(
      (theme) => localStorage.setItem("hq.theme.v1", theme),
      theme,
    );
    await page.goto("/settings?workspace=development");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    for (const label of [
      ...Object.values(PUSH_STATUS_LABEL),
      "Refresh interrupted",
      "Offline",
    ]) {
      await page
        .locator(".connection-trigger > span:last-child")
        .evaluate((element, text) => {
          element.textContent = text;
        }, label);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBe(0);
      await expect(
        page.getByRole("button", { name: "Refresh view" }),
      ).toBeInViewport();
    }
    await page
      .locator(".breadcrumb > span")
      .first()
      .evaluate((element) => {
        element.textContent =
          "A-long-unbroken-workspace-name-for-layout-verification";
      });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBe(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
