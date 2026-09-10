import { test, expect, type Locator, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { navigateSection } from "./navigation-fixture";

const WORKSPACE_ID = "development";
const NOTE_TITLE = "Readable Activity descriptions " + crypto.randomUUID();
const NOTE_SUMMARY =
  "Keep the full description comfortable to read on a narrow screen.\nLong identifiers must wrap: " +
  "repository-identifier-".repeat(8);
const GOAL = {
  workspaceId: WORKSPACE_ID,
  goalId: crypto.randomUUID(),
  sourceId: "typography-browser-test",
  objective:
    "  Verbatim typography /goal\nPreserve spaces, punctuation, and the full objective while making the journal easier to read.  ",
  status: "active",
  startedAt: new Date().toISOString(),
  reportedAt: new Date().toISOString(),
};
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 800, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
];

test.beforeAll(async ({ request }) => {
  for (const [command, data] of [
    ["goal_sync", GOAL],
    [
      "activity_add",
      {
        workspaceId: WORKSPACE_ID,
        eventId: crypto.randomUUID(),
        kind: "note",
        title: NOTE_TITLE,
        summary: NOTE_SUMMARY,
        resourceId: null,
      },
    ],
  ] as const) {
    const response = await request.post("/api/commands/" + command, {
      headers: { "X-HQ-Client": "cli" },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
});

test.afterAll(async ({ request }) => {
  const response = await request.post("/api/commands/goal_sync", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      ...GOAL,
      status: "complete",
      reportedAt: new Date().toISOString(),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
});

async function expectSize(locator: Locator, size: number) {
  await expect(locator).toHaveCSS("font-size", size + "px");
}

async function expectNoOverflow(page: Page, container?: Locator) {
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  if (container)
    await expect
      .poll(() =>
        container.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
}

for (const viewport of VIEWPORTS) {
  test(`Activity typography stays readable at ${viewport.width}px in both themes`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"]) {
      await page.goto("/activity");
      await page.evaluate(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.reload();
      const event = page
        .locator(".activity-event")
        .filter({ hasText: NOTE_TITLE });
      const summary = event.locator(".event-summary");
      const objective = page
        .locator(".goal-objective")
        .filter({ hasText: "Verbatim typography /goal" });
      await expect(
        event.getByRole("heading", { name: NOTE_TITLE }),
      ).toBeVisible();
      await expectSize(page.locator("body"), 16);
      await expectSize(summary, 15);
      await expectSize(event.locator("h3"), 16);
      await expectSize(event.locator(".event-meta"), 12);
      await expectSize(
        page.getByRole("textbox", { name: "Search activity" }),
        15,
      );
      expect(await summary.textContent()).toBe(NOTE_SUMMARY);
      expect(await objective.textContent()).toBe(GOAL.objective);
      await expectNoOverflow(page, summary);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      await page.getByRole("button", { name: "Notes", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(summary).toBeVisible();
      await expect(objective).toBeVisible();
      const addNote = page.getByRole("button", {
        name: "Add note",
        exact: true,
      });
      await addNote.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
      await expectSize(dialog.locator("[data-slot=dialog-description]"), 15);
      await expectSize(
        dialog.getByLabel("Title", { exact: true }),
        viewport.width < 768 ? 16 : 15,
      );
      await expectNoOverflow(page, dialog);
      await page.keyboard.press("Escape");
      await expect(addNote).toBeFocused();
    }
  });
}

test("supporting text and forms honor a larger root font without shrinking on mobile", async ({
  page,
}) => {
  for (const viewport of [VIEWPORTS[0]!, VIEWPORTS[2]!]) {
    await page.setViewportSize(viewport);
    await page.goto("/activity");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await expectSize(page.locator(".event-summary").first(), 18.75);
    await expectNoOverflow(page);
    await navigateSection(page, "Repositories");
    await page
      .getByRole("button", { name: "Enroll repository", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expectSize(dialog.locator(".field-help").first(), 17.5);
    await dialog
      .locator("summary")
      .filter({ hasText: "About expectations" })
      .click();
    await expectSize(dialog.locator(".expectation-help dd").first(), 17.5);
    await expectSize(
      dialog.getByRole("combobox", { name: "Continuous integration" }),
      17.5,
    );
    await expectNoOverflow(page, dialog);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await navigateSection(page, "Settings");
    for (const paragraph of await page.locator(".settings-card p").all())
      await expectSize(paragraph, 17.5);
    await expectNoOverflow(page);
    await page.getByRole("link", { name: /^Automation access Manage/ }).click();
    await expectSize(page.locator(".access-card p").first(), 18.75);
    await page
      .getByRole("button", {
        name: "Create automation credential",
        exact: true,
      })
      .click();
    await expectSize(dialog.locator(".field-help").first(), 17.5);
    await expectNoOverflow(page, dialog);
    await page.keyboard.press("Escape");
  }
});
