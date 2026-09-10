import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./test-fixture";

const FIRST_ACCOUNT = "long.account.name.for.readability@example.test";
const SECOND_ACCOUNT = "replacement@example.test";

async function hostedSession(page: Page, noMembership = false) {
  let signedOut = false;
  let logoutRequests = 0;
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({
      json: {
        ...session,
        development: false,
        principal: {
          subject: signedOut ? "second-account" : "first-account",
          displayName: signedOut ? SECOND_ACCOUNT : FIRST_ACCOUNT,
        },
        ...(noMembership ? { workspaces: [] } : {}),
      },
    });
  });
  await page.route("**/cdn-cgi/access/logout", (route) => {
    logoutRequests++;
    signedOut = true;
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html lang='en'><title>Synthetic sign-out</title><h1>Synthetic sign-out endpoint</h1></html>",
    });
  });
  return () => logoutRequests;
}

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390, 320]) {
    test(`sign-out explains its scope, cancels safely, and navigates only after confirmation at ${width}px in ${theme}`, async ({
      page,
    }) => {
      const requests = await hostedSession(page);
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto("/settings?workspace=development");
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      if (width === 320)
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "125%";
        });
      if (width < 1440)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      const trigger = page.getByRole("button", {
        name: "Sign out",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("alertdialog", {
        name: "Sign out of your account?",
      });
      await expect(dialog).toContainText(FIRST_ACCOUNT);
      await expect(dialog).toContainText(
        "other apps protected by the same Cloudflare Access team",
      );
      await expect(
        dialog.getByRole("button", { name: "Stay signed in" }),
      ).toBeFocused();
      await expect(
        dialog.getByRole("link", { name: "Sign out of Access" }),
      ).toHaveAttribute("href", "/cdn-cgi/access/logout");
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
      expect(
        await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            element.scrollWidth <= element.clientWidth
          );
        }),
      ).toBe(true);
      expect(requests()).toBe(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(requests()).toBe(0);
      await trigger.click();
      await dialog.getByRole("button", { name: "Stay signed in" }).click();
      await expect(trigger).toBeFocused();
      expect(requests()).toBe(0);
      await trigger.click();
      await dialog.getByRole("link", { name: "Sign out of Access" }).click();
      await expect(
        page.getByRole("heading", { name: "Synthetic sign-out endpoint" }),
      ).toBeVisible();
      expect(requests()).toBe(1);
      await page.goto("/settings?workspace=development");
      if (width < 1440)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(page.locator(".profile:visible")).toContainText(
        SECOND_ACCOUNT,
      );
      await expect(page.locator(".profile:visible")).not.toContainText(
        FIRST_ACCOUNT,
      );
    });
  }
}

test("canceling sign-out keeps an unsaved preference draft", async ({
  page,
}) => {
  const requests = await hostedSession(page);
  await page.goto("/settings/preferences?workspace=development");
  const clock = page.getByRole("combobox", { name: "Clock", exact: true });
  await clock.click();
  await page
    .getByRole("option", { name: "12-hour clock (AM/PM)", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Stay signed in" }).click();
  await expect(clock).toHaveText("12-hour clock (AM/PM)");
  await expect(
    page.getByRole("button", { name: "Save preferences", exact: true }),
  ).toBeEnabled();
  expect(requests()).toBe(0);
});

test("an account without workspace membership can still sign out", async ({
  page,
}) => {
  await hostedSession(page, true);
  await page.route("**/api/commands/setup_status", (route) =>
    route.fulfill({ json: { state: "complete" } }),
  );
  await page.route("**/api/commands/invitations_mine", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("/activity");
  await expect(
    page.getByRole("heading", { name: "Find your workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".profile:visible")).toContainText("Signed in");
  await expect(page.locator(".profile:visible")).not.toContainText(
    "Connecting",
  );
});

test("fixed development identities do not advertise an Access logout", async ({
  page,
}) => {
  await page.goto("/settings?workspace=development");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toHaveCount(0);
});
