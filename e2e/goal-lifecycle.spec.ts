import { test, expect, type APIRequestContext } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import type { Goal } from "../shared/domain";

const WORKSPACE_ID = "development";
const MINUTE_MS = 60 * 1000;

async function sync(request: APIRequestContext, input: unknown): Promise<Goal> {
  const response = await request.post("/api/commands/goal_sync", {
    headers: { "X-HQ-Client": "cli" },
    data: input,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<Goal>;
}

test("paused and cleared goals stay truthful, preserve history and update through push", async ({
  page,
  request,
}) => {
  const start = Date.now() - 30 * MINUTE_MS;
  const oldGoal = {
    workspaceId: WORKSPACE_ID,
    goalId: crypto.randomUUID(),
    sourceId: "lifecycle-browser-source",
    objective:
      "  Unfinished source /goal\nKeep the original objective in history.  ",
    status: "blocked",
    startedAt: new Date(start).toISOString(),
    reportedAt: new Date(start + MINUTE_MS).toISOString(),
  };
  await sync(request, oldGoal);
  await page.goto("/activity");
  const panel = page.getByRole("region", { name: "Agent goals" });
  const oldCard = panel
    .locator("article")
    .filter({ hasText: "Unfinished source /goal" });
  await expect(
    oldCard.getByText("LAST REPORTED BLOCKED /GOAL", { exact: true }),
  ).toBeVisible();
  await expect(oldCard.getByText("Awaiting goal sync")).toBeVisible();

  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/commands/")) requests.push(path);
  });
  await sync(request, {
    ...oldGoal,
    status: "cleared",
    reportedAt: new Date().toISOString(),
  });
  await expect(oldCard).toHaveCount(0);
  const history = page
    .locator(".goal-group")
    .filter({ hasText: "Unfinished source /goal" });
  await expect(history.getByText("Cleared", { exact: true })).toBeVisible();
  await expect(
    history.getByText("Removed from the source, not marked complete"),
  ).toBeVisible();
  await expect(history.locator(".goal-group-trigger")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(await history.locator(".goal-group-objective").textContent()).toBe(
    oldGoal.objective,
  );

  const replacement = {
    ...oldGoal,
    goalId: crypto.randomUUID(),
    objective:
      "  Replacement inventory /goal\nDo not confuse a pause with a blocker.  ",
    status: "paused",
    startedAt: new Date(start + 2 * MINUTE_MS).toISOString(),
    reportedAt: new Date(start + 3 * MINUTE_MS).toISOString(),
  };
  await sync(request, replacement);
  const paused = panel
    .locator("article")
    .filter({ hasText: "Replacement inventory /goal" });
  await expect(paused.getByText("PAUSED /GOAL", { exact: true })).toBeVisible();
  await expect(paused.getByText("Paused", { exact: true })).toBeVisible();
  await expect(paused.getByText("Awaiting goal sync")).toHaveCount(0);
  await expect(paused.getByText("Blocked", { exact: true })).toHaveCount(0);
  expect(await paused.locator(".goal-objective").textContent()).toBe(
    replacement.objective,
  );
  await expect(
    paused.getByText(/HQ does not resume source goals/),
  ).toBeVisible();
  expect(requests).not.toContain("/api/commands/workspace_snapshot");
  expect(requests).not.toContain("/api/commands/workspace_view");

  await history.locator(".goal-group-trigger").focus();
  await page.keyboard.press("Enter");
  await expect(history.locator(".goal-group-trigger")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(history.locator(".activity-event")).toHaveCount(2);
  await expect(
    history.locator(".activity-event").filter({ hasText: "Goal completed" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search activity" })
    .fill("nothing matches this lifecycle search");
  await expect(paused).toBeVisible();
  await page.getByRole("textbox", { name: "Search activity" }).fill("");

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(theme);
      }, theme);
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
      await expect(paused).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .include(".goals-panel")
        .analyze();
      expect(audit.violations).toEqual([]);
    }
  }

  await sync(request, {
    ...replacement,
    status: "active",
    reportedAt: new Date().toISOString(),
  });
  await expect(paused.getByText("ACTIVE /GOAL", { exact: true })).toBeVisible();
  await expect(paused.getByText("In progress", { exact: true })).toBeVisible();
  await expect(paused.getByText(/HQ does not resume source goals/)).toHaveCount(
    0,
  );
  await sync(request, {
    ...replacement,
    status: "cleared",
    reportedAt: new Date().toISOString(),
  });
  await expect(paused).toHaveCount(0);
});

test("the pinned source report ages without new reports or network-driven rerenders", async ({
  page,
  request,
}) => {
  const now = Date.now();
  const goal = {
    workspaceId: WORKSPACE_ID,
    goalId: crypto.randomUUID(),
    sourceId: "aging-browser-source",
    objective: "Age this /goal without a dashboard request",
    status: "active",
    startedAt: new Date(now).toISOString(),
    reportedAt: new Date(now).toISOString(),
  };
  await sync(request, goal);
  await page.goto("/activity");
  const card = page
    .getByRole("region", { name: "Agent goals" })
    .locator("article")
    .filter({ hasText: goal.objective });
  await expect(card.getByText("ACTIVE /GOAL", { exact: true })).toBeVisible();
  await expect(card.getByText("Awaiting goal sync")).toHaveCount(0);
  await page.clock.setSystemTime(now + 6 * MINUTE_MS);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    card.getByText("LAST REPORTED ACTIVE /GOAL", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Awaiting goal sync")).toBeVisible();
  await sync(request, {
    ...goal,
    status: "cleared",
    reportedAt: new Date().toISOString(),
  });
});
