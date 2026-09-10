import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import { LIMITS } from "../shared/domain";
import { ACTIVITY_LIMITS } from "../shared/activity";

const WORKSPACE_ID = "polling-test";
const ACTIVITY_URL = "/activity?workspace=" + WORKSPACE_ID;
const POLLING_WINDOW_MS = LIMITS.REFRESH_MS * 2 + 250;
const RETURN_TIMEOUT_MS = LIMITS.REFRESH_MS / 2;
const CLOCK_LEAD_MS = 1000;

async function note(request: APIRequestContext, title: string) {
  const response = await request.post("/api/commands/activity_add", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: WORKSPACE_ID,
      eventId: crypto.randomUUID(),
      kind: "note",
      title,
      summary: "Synthetic live-update verification",
      resourceId: null,
      goalId: null,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function requests(page: Page) {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return counts;
}

async function visibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value,
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);
}

async function pauseClock(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.clock.pauseAt(
    await page.evaluate((lead) => Date.now() + lead, CLOCK_LEAD_MS),
  );
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test.beforeAll(async ({ request }) => {
  for (let index = 0; index <= ACTIVITY_LIMITS.PAGE_SIZE; index++)
    await note(request, "Polling history " + index);
});

test("push Activity stays idle until a change and catches up after returning to the tab", async ({
  page,
  request,
}) => {
  const counts = requests(page);
  await page.goto(ACTIVITY_URL);
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await pauseClock(page);
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  const visible = counts.get("/api/commands/workspace_view") ?? 0;
  await page.clock.runFor(POLLING_WINDOW_MS);
  expect(counts.get("/api/commands/workspace_view")).toBe(visible);
  await note(request, "Pushed to the visible dashboard");
  await page.clock.resume();
  await expect(
    page.getByRole("heading", {
      name: "Pushed to the visible dashboard",
      exact: true,
    }),
  ).toBeVisible({ timeout: RETURN_TIMEOUT_MS });
  await pauseClock(page);
  await page.waitForLoadState("networkidle");
  await visibility(page, "hidden");
  const hidden = new Map(counts);
  await note(request, "Arrived while Activity was hidden");
  await page.clock.runFor(POLLING_WINDOW_MS);
  expect(counts).toEqual(hidden);
  await page.clock.resume();
  await visibility(page, "visible");
  await expect(
    page.getByRole("heading", {
      name: "Arrived while Activity was hidden",
      exact: true,
    }),
  ).toBeVisible({ timeout: RETURN_TIMEOUT_MS });
  expect(counts.get("/api/commands/workspace_view")).toBe(visible);
  expect(counts.get("/api/commands/workspace_snapshot") ?? 0).toBe(0);
});

test("fixed history stays idle with live goals and explicit refresh", async ({
  page,
  request,
}) => {
  const goal = {
    workspaceId: WORKSPACE_ID,
    goalId: "polling-goal",
    sourceId: "polling-browser",
    objective: "  /goal remains verbatim\nwhile reading fixed history  ",
    startedAt: "2026-01-01T00:00:00Z",
  };
  async function syncGoal(status: "active" | "complete", reportedAt: string) {
    const response = await request.post("/api/commands/goal_sync", {
      headers: { "X-HQ-Client": "cli" },
      data: { ...goal, status, reportedAt },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await syncGoal("active", "2026-01-01T00:00:01Z");
  for (let index = 0; index < ACTIVITY_LIMITS.PAGE_SIZE; index++)
    await note(request, "Newer than the polling goal " + index);
  const counts = requests(page);
  await page.goto(ACTIVITY_URL);
  await expect(page.locator(".goal-objective")).toBeVisible();
  expect(await page.locator(".goal-objective").textContent()).toBe(
    goal.objective,
  );
  await page
    .getByRole("navigation", { name: "Activity pages", exact: true })
    .getByRole("button", { name: "Older activity" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Activity / page 2", exact: true }),
  ).toBeVisible();
  await pauseClock(page);
  const historicalGoal = page
    .locator(".goal-group")
    .filter({ hasText: "/goal remains verbatim" });
  await expect(
    historicalGoal.getByText("In progress", { exact: true }),
  ).toBeVisible();
  const historyEntries = page.locator(".activity-feed-list > .activity-event");
  const history = await historyEntries.evaluateAll((items) =>
    items.map((item) => item.id),
  );
  const feedReads = counts.get("/api/commands/activity_feed");
  const workspaceReads = counts.get("/api/commands/workspace_view")!;
  await note(request, "Arrived while reading fixed history");
  await syncGoal("complete", "2026-01-01T00:00:02Z");
  await page.clock.runFor(POLLING_WINDOW_MS);
  expect(counts.get("/api/commands/activity_feed")).toBe(feedReads);
  expect(counts.get("/api/commands/workspace_view")).toBe(workspaceReads);
  expect(counts.get("/api/commands/workspace_snapshot") ?? 0).toBe(0);
  await page.clock.resume();
  await expect(
    historicalGoal.getByText("Complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent goals", exact: true }),
  ).toContainText("No open goal has been reported");
  expect(counts.get("/api/commands/activity_feed")).toBe(feedReads);
  const historyUrl = page.url();
  await visibility(page, "hidden");
  await visibility(page, "visible");
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  expect(counts.get("/api/commands/activity_feed")).toBe(feedReads);
  expect(page.url()).toBe(historyUrl);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect
    .poll(() => counts.get("/api/commands/activity_feed"))
    .toBeGreaterThan(feedReads!);
  expect(
    await historyEntries.evaluateAll((items) => items.map((item) => item.id)),
  ).toEqual(history);
  await page
    .getByRole("button", { name: "Return to live activity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Arrived while reading fixed history",
      exact: true,
    }),
  ).toBeVisible({ timeout: RETURN_TIMEOUT_MS });
});

test("offline status preserves loaded content and note drafts until reconnect", async ({
  page,
  context,
  request,
}) => {
  const counts = requests(page);
  await page.goto(ACTIVITY_URL);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Keep this unsaved draft");
  await pauseClock(page);
  await context.setOffline(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".connection-state")).toContainText("Offline");
  await expect(page.getByRole("status")).toContainText(
    "Showing the last successful snapshot",
  );
  await expect(
    page.getByRole("button", { name: "Refresh view", exact: true }),
  ).toBeDisabled();
  const offline = new Map(counts);
  await page.clock.runFor(POLLING_WINDOW_MS);
  expect(counts).toEqual(offline);
  await note(request, "Arrived while the browser was offline");
  await page.clock.resume();
  await context.setOffline(false);
  await expect(
    page.getByRole("heading", {
      name: "Arrived while the browser was offline",
      exact: true,
    }),
  ).toBeVisible({ timeout: RETURN_TIMEOUT_MS });
  await expect(page.locator(".connection-state")).not.toContainText("Offline");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Keep this unsaved draft");
});

test("Settings push shares visibility handling and catches up on return", async ({
  page,
}) => {
  const counts = requests(page);
  await page.goto("/settings/members?workspace=" + WORKSPACE_ID);
  await expect(
    page.getByRole("heading", { name: "Workspace members", exact: true }),
  ).toBeVisible();
  await pauseClock(page);
  await visibility(page, "hidden");
  const hidden = new Map(counts);
  await page.clock.runFor(POLLING_WINDOW_MS);
  expect(counts).toEqual(hidden);
  await page.clock.resume();
  await visibility(page, "visible");
  expect(counts.get("/api/commands/workspace_view")).toBe(
    hidden.get("/api/commands/workspace_view"),
  );
  expect(counts.get("/api/commands/workspace_snapshot") ?? 0).toBe(0);
  await expect
    .poll(() => counts.get("/api/commands/members_list"))
    .toBeGreaterThan(hidden.get("/api/commands/members_list")!);
});
