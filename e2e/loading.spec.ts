import { test, expect, type Page } from "./test-fixture";

const OVERVIEW = "/overview?workspace=development";
const PLACEHOLDER = ".workspace-loading-placeholder";
const TEST_TIME = new Date("2026-09-13T12:00:00.000Z");

async function pauseClock(page: Page) {
  await page.clock.install({ time: TEST_TIME });
  await page.clock.pauseAt(TEST_TIME);
}

async function holdResponse(page: Page, pattern: string) {
  let release!: () => void;
  let received = false;
  let fulfilled = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    received = true;
    await gate;
    await route.fulfill({ response });
    fulfilled = true;
  });
  return {
    release,
    received: () => received,
    fulfilled: () => fulfilled,
  };
}

async function settle(page: Page, condition: () => boolean | Promise<boolean>) {
  await expect.poll(async () => {
    await page.clock.runFor(1);
    return condition();
  }).toBe(true);
}

test("reload keeps one placeholder through data and lazy view loading", async ({ page }) => {
  await pauseClock(page);
  const data = await holdResponse(page, "**/api/commands/workspace_view");
  const module = await holdResponse(page, "**/src/overview.tsx");
  try {
    await page.goto(OVERVIEW);
    await settle(page, data.received);
    await expect(page.locator(".loading-state")).toContainText("Opening your workspace...");
    await expect(page.locator(PLACEHOLDER)).toBeHidden();
    await page.clock.runFor(200);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    const placeholder = await page.locator(PLACEHOLDER).elementHandle();
    const before = await page.locator(PLACEHOLDER).boundingBox();
    data.release();
    await settle(page, module.received);
    await page.clock.runFor(400);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    expect(await page.locator(PLACEHOLDER).boundingBox()).toEqual(before);
    expect(await placeholder!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByText("Opening view...", { exact: true })).toHaveCount(0);
    module.release();
    await settle(page, module.fulfilled);
    await page.clock.resume();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
  } finally {
    data.release();
    module.release();
  }
});

test("fast uncached navigation skips the decorative loader and refresh keeps content", async ({ page }) => {
  await page.goto(OVERVIEW);
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await pauseClock(page);
  const data = await holdResponse(page, "**/api/commands/workspace_view");
  try {
    await page.getByRole("combobox", { name: "Workspace", exact: true }).click();
    await page.getByRole("option", { name: "Synthetic expectations workspace", exact: true }).click();
    await settle(page, data.received);
    await expect(page.locator(PLACEHOLDER)).toBeHidden();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toHaveCount(0);
    await page.clock.runFor(50);
    data.release();
    await settle(page, data.fulfilled);
    await settle(page, () => page.getByRole("heading", { name: "Overview", exact: true }).isVisible());
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
    await page.clock.runFor(500);
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);

    const refresh = await holdResponse(page, "**/api/commands/workspace_view");
    try {
      await page.getByRole("button", { name: "Refresh view", exact: true }).click();
      await settle(page, refresh.received);
      await page.clock.runFor(500);
      await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
      await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
    } finally {
      refresh.release();
    }
  } finally {
    data.release();
  }
});

test("a shown loader stays briefly while ready content remains out of keyboard focus", async ({ page }) => {
  await page.goto(OVERVIEW);
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await pauseClock(page);
  const data = await holdResponse(page, "**/api/commands/workspace_view");
  try {
    await page.getByRole("combobox", { name: "Workspace", exact: true }).click();
    await page.getByRole("option", { name: "Synthetic expectations workspace", exact: true }).click();
    await settle(page, data.received);
    await page.clock.runFor(200);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    data.release();
    await settle(page, data.fulfilled);
    await settle(page, () => page.locator("h1").count().then((count) => count > 0));
    await page.clock.runFor(100);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh view", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Source code (opens in a new tab)" })).toBeFocused();
    await page.clock.runFor(300);
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
  } finally {
    data.release();
  }
});

test("default workspace selection preserves an already visible session loader", async ({ page }) => {
  await pauseClock(page);
  const session = await holdResponse(page, "**/api/session");
  const data = await holdResponse(page, "**/api/commands/workspace_view");
  try {
    await page.goto("/overview");
    await settle(page, session.received);
    await page.clock.runFor(200);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    const placeholder = await page.locator(PLACEHOLDER).elementHandle();
    session.release();
    await settle(page, data.received);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    expect(await placeholder!.evaluate((element) => element.isConnected)).toBe(true);
    data.release();
    await page.clock.resume();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
  } finally {
    session.release();
    data.release();
  }
});

test("leaving a pending view cancels its loader without disturbing cached content", async ({ page }) => {
  await page.goto(OVERVIEW);
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await pauseClock(page);
  const data = await holdResponse(page, "**/api/commands/workspace_view");
  try {
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    await navigation.getByRole("link", { name: "Projects", exact: true }).click();
    await settle(page, data.received);
    await expect(page.locator(PLACEHOLDER)).toBeHidden();
    await navigation.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await page.clock.runFor(500);
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
    data.release();
    await page.clock.resume();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page).toHaveURL(OVERVIEW);
  } finally {
    data.release();
  }
});

test("load failures replace the placeholder immediately and retry can recover", async ({ page }) => {
  await pauseClock(page);
  let fail!: () => void;
  const failure = new Promise<void>((resolve) => { fail = resolve; });
  await page.route("**/api/commands/workspace_view", async (route) => {
    await failure;
    await route.fulfill({ status: 503, json: { error: "Synthetic loading failure", code: "unavailable" } });
  });
  try {
    await page.goto(OVERVIEW);
    await settle(page, () => page.locator(".loading-state").count().then((count) => count > 0));
    await page.clock.runFor(200);
    await expect(page.locator(PLACEHOLDER)).toBeVisible();
    fail();
    await settle(page, () => page.getByRole("alert").count().then((count) => count > 0));
    await expect(page.getByRole("alert")).toContainText("Workspace update interrupted");
    await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
    await page.unroute("**/api/commands/workspace_view");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.clock.resume();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  } finally {
    fail();
  }
});

for (const theme of ["light", "dark"])
  for (const width of [390, 1440])
    test(`slow loading is stable at ${width}px in ${theme} with reduced motion`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((theme) => localStorage.setItem("hq.theme.v1", theme), theme);
      const data = await holdResponse(page, "**/api/commands/workspace_view");
      try {
        await page.goto(OVERVIEW);
        await expect(page.locator(PLACEHOLDER)).toBeVisible();
        expect(await page.locator(PLACEHOLDER).evaluate((element) => ({
          animations: element.getAnimations({ subtree: true }).map((animation) => animation.playState),
          fits: element.getBoundingClientRect().right <= window.innerWidth,
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        }))).toEqual({ animations: [], fits: true, theme });
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#main-content")).toBeFocused();
      } finally {
        data.release();
      }
    });
