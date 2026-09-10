import { test, expect } from "./test-fixture";
import { DOCUMENTATION_ORIGIN } from "../shared/documentation";

test("contextual help opens separately without leaking workspace context or losing preference drafts", async ({ page, context }) => {
  await context.route(DOCUMENTATION_ORIGIN + "/**", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html lang='en'><title>Synthetic documentation</title><body><main><h1>Preferences guide</h1></main></body></html>",
  }));
  await page.goto("/settings/preferences?workspace=development");
  const clock = page.getByRole("combobox", { name: "Clock", exact: true });
  const startingClock = await clock.textContent();
  const selected = startingClock?.includes("12-hour") ? "24-hour clock" : "12-hour clock (AM/PM)";
  await clock.click();
  await page.getByRole("option", { name: selected, exact: true }).click();
  await expect(page.getByRole("button", { name: "Save preferences", exact: true })).toBeEnabled();
  const guide = page.getByRole("link", { name: "Date and time preferences guide (opens in a new tab)", exact: true });
  await expect(guide).toHaveAttribute("href", DOCUMENTATION_ORIGIN + "/preferences/");
  await expect(guide).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = context.waitForEvent("page");
  await guide.focus();
  await page.keyboard.press("Enter");
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup).toHaveURL(DOCUMENTATION_ORIGIN + "/preferences/");
  expect(await popup.evaluate(() => ({ referrer: document.referrer, opener: window.opener }))).toEqual({ referrer: "", opener: null });
  await expect(page).toHaveURL(/\/settings\/preferences\?workspace=development$/);
  await expect(clock).toHaveText(selected);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await popup.close();
});

for (const width of [1440, 390, 320]) {
  test("help and connection controls fit at " + width + "px in both themes", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.goto("/repositories?workspace=development");
      await page.evaluate((value) => localStorage.setItem("hq.theme.v1", value), theme);
      await page.reload();
      const guide = page.getByRole("link", { name: "Repositories guide (opens in a new tab)", exact: true });
      await expect(guide).toBeVisible();
      await guide.focus();
      await expect(guide).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const box = await guide.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(40);
      expect(box!.height).toBeGreaterThanOrEqual(40);
      await expect(page.getByRole("button", { name: "Refresh view", exact: true })).toBeVisible();
    }
  });
}
