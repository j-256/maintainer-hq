import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_PREFERENCES,
  type PreferenceRecord,
  type UserPreferences,
} from "../shared/preferences";

const PREFERENCES_URL = "/settings/preferences?workspace=development";
test.use({ timezoneId: "America/New_York" });

async function api<T>(request: APIRequestContext, command: string, input = {}) {
  const response = await request.post("/api/commands/" + command, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: "development", ...input },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function savePreferences(
  request: APIRequestContext,
  preferences: Readonly<UserPreferences>,
) {
  const { revision } = await api<PreferenceRecord>(request, "preferences_get");
  return api<PreferenceRecord>(request, "preferences_update", {
    revision,
    preferences,
  });
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await savePreferences(request, DEFAULT_PREFERENCES);
});
test.afterEach(async ({ request }) => {
  await savePreferences(request, DEFAULT_PREFERENCES);
});

test("saves account preferences, applies them across routes and workspaces, and retains exact UTC diagnostics", async ({
  page,
  request,
}) => {
  const eventId = "preferences-" + crypto.randomUUID();
  const note = await api<{ createdAt: string }>(request, "activity_add", {
    eventId,
    kind: "note",
    title: eventId,
    summary: "Synthetic timestamp display verification",
    resourceId: null,
  });
  await page.goto("/settings?workspace=development");
  await page
    .getByRole("link", { name: "Date and time preferences", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Time zone", exact: true }),
  ).toHaveText("Local time (America/New_York)");
  await select(page, "Time zone", "UTC");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Preferences saved. Display changes apply across HQ.",
  );
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  const time = page
    .locator(".activity-event")
    .filter({ hasText: eventId })
    .locator("time");
  await expect(time).toHaveText(note.createdAt.slice(0, 16).replace("T", " "));
  await expect(time).toHaveAttribute(
    "title",
    new RegExp("UTC \\(UTC\\) \\| " + note.createdAt.replaceAll(".", "\\.")),
  );
  await page.goto(PREFERENCES_URL);
  await select(page, "Date format", "dd/MM/yyyy");
  await select(page, "Clock", "12-hour clock (AM/PM)");
  await select(page, "Time zone", "Local time (America/New_York)");
  await expect(
    page.getByRole("group", { name: "Date and time preview" }).locator("time"),
  ).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} [AP]M$/);
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Clock", exact: true }),
  ).toHaveText("12-hour clock (AM/PM)");
  await page.goto("/activity?workspace=development");
  await expect(time).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} [AP]M$/);
  await expect(time).toHaveAttribute("title", /America\/New_York/);
  await expect(time).toHaveAttribute("dateTime", note.createdAt);
  await page.goto("/settings/preferences?workspace=activity-test");
  await expect(
    page.getByRole("combobox", { name: "Date format", exact: true }),
  ).toHaveText("dd/MM/yyyy");
  expect(
    (await api<PreferenceRecord>(request, "preferences_get")).preferences,
  ).toEqual({
    dateFormat: "dd/MM/yyyy",
    clockFormat: "12h",
    timeZone: "local",
  });
});

test("guards drafts on navigation and preserves them after a failed or conflicting save", async ({
  page,
  request,
}) => {
  await page.goto(PREFERENCES_URL);
  await select(page, "Clock", "12-hour clock (AM/PM)");
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Discard unsaved changes?",
  );
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Clock", exact: true }),
  ).toHaveText("12-hour clock (AM/PM)");
  await page.route("**/api/commands/preferences_update", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "unavailable", message: "Synthetic save unavailable" },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Clock", exact: true }),
  ).toHaveText("12-hour clock (AM/PM)");
  await page.unroute("**/api/commands/preferences_update");
  await savePreferences(request, { ...DEFAULT_PREFERENCES, timeZone: "UTC" });
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your preferences changed elsewhere",
  );
  await expect(
    page.getByRole("combobox", { name: "Clock", exact: true }),
  ).toHaveText("12-hour clock (AM/PM)");
  await page
    .getByRole("button", { name: "Load saved preferences", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved preferences", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Time zone", exact: true }),
  ).toHaveText("UTC");
  await expect(
    page.getByRole("combobox", { name: "Clock", exact: true }),
  ).toHaveText("24-hour clock");
  await select(page, "Clock", "12-hour clock (AM/PM)");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\?workspace=development$/);
  expect(
    (await api<PreferenceRecord>(request, "preferences_get")).preferences
      .clockFormat,
  ).toBe("24h");
});

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`preferences are accessible and keyboard-operable at ${width}px in ${theme}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto(PREFERENCES_URL);
      const zone = page.getByRole("combobox", {
        name: "Time zone",
        exact: true,
      });
      await zone.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listbox")).toBeVisible();
      await expect(
        page.getByRole("option", {
          name: "Local time (America/New_York)",
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.type("UTC");
      await expect(
        page.getByRole("option", { name: "UTC", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(zone).toHaveText("UTC");
      await zone.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listbox")).toBeVisible();
      const popup = await page.getByRole("listbox").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          background: getComputedStyle(element).backgroundColor,
        };
      });
      expect(popup.left).toBeGreaterThanOrEqual(0);
      expect(popup.right).toBeLessThanOrEqual(width);
      // Verify the JavaScript focus trap and scrolling directly while the popup hides the page
      await page.keyboard.press("Tab");
      expect(
        await page
          .getByRole("listbox")
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(
        await page
          .getByRole("listbox")
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
      await page.keyboard.press("End");
      await expect(page.getByRole("option").last()).toBeFocused();
      await expect(page.getByRole("option").last()).toBeInViewport();
      await page.keyboard.press("Home");
      await expect(page.getByRole("option").first()).toBeFocused();
      await expect(page.getByRole("option").first()).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(zone).toBeFocused();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
