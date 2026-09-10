import { test, expect, type APIRequestContext } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { ACTIVITY_LIMITS, type ActivityFeed } from "../shared/activity";
import { DEFAULT_EXPECTATIONS, type Snapshot } from "../shared/domain";

const WORKSPACE_ID = "activity-test";
const ACTIVITY_URL = "/activity?workspace=" + WORKSPACE_ID;
const HISTORY_GOALS = ACTIVITY_LIMITS.PAGE_SIZE + 3;
const LONG_GOAL_ID = "journal-goal-" + (HISTORY_GOALS - 1);
const LONG_OBJECTIVE =
  "  Finished /goal\nKeep the complete objective and this identifier: " +
  "repository-context-".repeat(7) +
  "  ";
const ACTIVE_GOAL = {
  goalId: "journal-active",
  sourceId: "journal-browser",
  objective:
    "  The active /goal remains verbatim\nwhile browsing earlier work.  ",
  status: "active",
  startedAt: "2026-01-01T00:00:00Z",
  reportedAt: "2026-01-01T00:00:01Z",
};

async function api<T>(
  request: APIRequestContext,
  name: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE_ID, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function addNote(
  request: APIRequestContext,
  title: string,
  goalId: string | null = null,
) {
  return api(request, "activity_add", {
    eventId: "journal-note-" + createHash("sha256").update(title).digest("hex"),
    kind: "note",
    title,
    summary: "A synthetic journal update for browser verification",
    resourceId: null,
    goalId,
  });
}

test.beforeAll(async ({ request }) => {
  for (let index = 0; index < 105; index++)
    await addNote(
      request,
      index === 0
        ? "Find this beyond the recent-history limit"
        : "Standalone journal update " + index,
    );
  for (let index = 0; index < HISTORY_GOALS; index++)
    await api(request, "goal_sync", {
      ...ACTIVE_GOAL,
      goalId: "journal-goal-" + index,
      objective:
        index === HISTORY_GOALS - 1
          ? LONG_OBJECTIVE
          : "Finished journal goal " + index,
      status: "complete",
    });
  for (let index = 0; index < ACTIVITY_LIMITS.PAGE_SIZE + 5; index++)
    await addNote(request, "Linked journal update " + index, LONG_GOAL_ID);
  await api(request, "goal_sync", ACTIVE_GOAL);
});

test("Activity counts reported goals without a source inventory dependency", async ({
  page,
  request,
}) => {
  const repository = await api<{ id: string }>(request, "repository_create", {
    repository: {
      fullName: "example/activity-source-" + crypto.randomUUID(),
      description: "Synthetic source-count fixture",
      projectId: "activity-default",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  for (const enabled of [true, false]) {
    await api(request, "github_source_enroll", {
      sourceId: "activity-source-" + crypto.randomUUID(),
      source: {
        name: "Synthetic enrolled source",
        enabled,
        credentialRef: null,
        repositoryIds: [repository.id],
        freshnessMinutes: 30,
        refreshIntervalMinutes: 15,
      },
    });
  }
  const snapshot = await api<Snapshot>(request, "workspace_snapshot");
  expect(
    snapshot.connections.filter((source) => !source.lastSuccessAt).length,
  ).toBeGreaterThanOrEqual(2);
  await page.goto(ACTIVITY_URL);
  await expect(
    page
      .locator(".context-stat")
      .filter({ hasText: "Reported goals" })
      .locator("strong"),
  ).toHaveText(String(snapshot.goals.length), { timeout: 2000 });
});

test("goal sections and journal pages preserve choices, exact text, and stable history", async ({
  page,
  request,
}) => {
  await page.goto(ACTIVITY_URL);
  const group = page
    .locator(".goal-group")
    .filter({ hasText: "Finished /goal" });
  const trigger = group.locator(".goal-group-trigger");
  const active = page.locator(".goal-objective");
  await expect(active).toBeVisible();
  expect(await active.textContent()).toBe(ACTIVE_GOAL.objective);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(await group.locator(".goal-group-objective").textContent()).toBe(
    LONG_OBJECTIVE,
  );
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(group.locator(".activity-event")).toHaveCount(
    ACTIVITY_LIMITS.PAGE_SIZE,
  );
  await group
    .getByRole("button", { name: "Older updates", exact: true })
    .click();
  await expect(
    group.getByRole("heading", { name: "Updates / page 2", exact: true }),
  ).toBeFocused();
  const entries = await group
    .locator(".activity-event")
    .evaluateAll((elements) => elements.map((element) => element.id));
  await addNote(request, "Arrived while reading goal history", LONG_GOAL_ID);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(
    group.getByText("27 matching events", { exact: true }),
  ).toBeVisible();
  expect(
    await group
      .locator(".activity-event")
      .evaluateAll((elements) => elements.map((element) => element.id)),
  ).toEqual(entries);
  await expect(
    group.getByRole("button", { name: "Older updates", exact: true }),
  ).toBeDisabled();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const pager = page.getByRole("navigation", {
    name: "Activity pages",
    exact: true,
  });
  await pager.getByRole("button", { name: "Older activity" }).click();
  await expect(
    page.getByRole("heading", { name: "Activity / page 2", exact: true }),
  ).toBeFocused();
  const history = await page.locator(".activity-feed-list").innerText();
  await addNote(request, "Arrived after entering journal history");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator(".activity-feed-list")).toHaveText(history, {
    useInnerText: true,
  });
  await pager.getByRole("button", { name: "Newer activity" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("button", { name: "Return to live activity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Arrived after entering journal history",
      exact: true,
    }),
  ).toBeVisible();
  expect(await active.textContent()).toBe(ACTIVE_GOAL.objective);
});

test("search reaches the full journal, resets pages, and recovers a failed page without losing filters", async ({
  page,
}) => {
  await page.goto(ACTIVITY_URL);
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("navigation", { name: "Activity pages", exact: true })
    .getByRole("button", { name: "Older activity" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Activity / page 2", exact: true }),
  ).toBeVisible();
  const search = page.getByRole("textbox", { name: "Search activity" });
  await search.fill("beyond the recent-history limit");
  await expect(
    page.getByRole("heading", {
      name: "Find this beyond the recent-history limit",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Activity / page 1", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".goal-objective")).toBeVisible();
  await page.route("**/api/commands/activity_feed", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "unavailable",
          message: "Synthetic journal interruption",
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic journal interruption",
  );
  await expect(search).toHaveValue("beyond the recent-history limit");
  await page.unroute("**/api/commands/activity_feed");
  await page
    .getByRole("button", { name: "Retry activity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Find this beyond the recent-history limit",
      exact: true,
    }),
  ).toBeVisible();
  await search.fill("no matching journal entry");
  await expect(
    page.getByRole("heading", { name: "No matching activity", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect(page.locator(".activity-feed-list > li")).toHaveCount(
    ACTIVITY_LIMITS.PAGE_SIZE,
  );
});

test("linked notes survive reload and goal controls stay accessible in both themes on narrow screens", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(ACTIVITY_URL);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const title = "A deliberately linked note " + crypto.randomUUID();
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog
    .getByLabel("Details", { exact: true })
    .fill("A note attached through the structured goal picker");
  await dialog
    .getByRole("combobox", { name: "Goal (optional)", exact: true })
    .click();
  await page
    .getByRole("option", { name: /The active \/goal remains verbatim/ })
    .click();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(0);
  await dialog.getByRole("button", { name: "Post note", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  const feed = await api<ActivityFeed>(request, "activity_feed", {
    search: title,
  });
  expect(feed.groups).toHaveLength(1);
  expect(feed.groups[0]).toMatchObject({
    kind: "goal",
    goal: { id: ACTIVE_GOAL.goalId },
  });
  for (const theme of ["light", "dark"] as const) {
    const target = page.getByRole("button", {
      name: `Switch to ${theme} theme`,
    });
    if (await target.isVisible()) await target.click();
    const search = page.getByRole("textbox", { name: "Search activity" });
    await search.fill("Finished /goal");
    const group = page.locator(".goal-group");
    await expect(group.locator(".activity-event")).toHaveCount(
      ACTIVITY_LIMITS.PAGE_SIZE,
    );
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished),
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      )
      .toBeLessThanOrEqual(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await group.locator(".goal-group-trigger").focus();
    await page.keyboard.press("Space");
    await expect(group.locator(".goal-group-trigger")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await search.fill("");
    await expect(page.locator(".goal-group")).not.toHaveCount(1);
  }
});
