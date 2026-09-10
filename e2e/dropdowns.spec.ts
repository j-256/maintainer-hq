import { test, expect, type Locator, type Page } from "./test-fixture";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";

type DropdownFrame = {
  background: string;
  foreground: string;
  opacity: string;
  animation: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
declare global {
  interface Window {
    dropdownFrames: DropdownFrame[];
  }
}

const THEMES = {
  light: { background: "rgb(255, 255, 255)", foreground: "rgb(32, 37, 41)" },
  dark: { background: "rgb(29, 35, 38)", foreground: "rgb(236, 239, 240)" },
};
const FRAME_COUNT = 12;
const LONG_LIST_SIZE = 80;

async function expectStableOpening(
  page: Page,
  trigger: Locator,
  theme: keyof typeof THEMES,
  keyboard = false,
) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await page.evaluate((frameCount) => {
    window.dropdownFrames = [];
    let attempts = 0;
    function sample() {
      const popup = document.querySelector('[data-slot="select-content"]');
      if (popup) {
        const style = getComputedStyle(popup);
        const rect = popup.getBoundingClientRect();
        if (rect.width && rect.bottom > 0 && rect.top < innerHeight) {
          window.dropdownFrames.push({
            background: style.backgroundColor,
            foreground: style.color,
            opacity: style.opacity,
            animation: style.animationName,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          });
        }
      }
      if (++attempts < 180 && window.dropdownFrames.length < frameCount)
        requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, FRAME_COUNT);
  if (keyboard) await page.keyboard.press("ArrowDown");
  else await trigger.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.dropdownFrames.length))
    .toBe(FRAME_COUNT);
  const frames = await page.evaluate(() => window.dropdownFrames);
  for (const frame of frames) {
    expect(frame).toMatchObject({
      ...THEMES[theme],
      opacity: "1",
      animation: "none",
    });
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(frame[key] - frames[0][key]),
        key + " changes during opening",
      ).toBeLessThanOrEqual(1);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  }
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

for (const theme of ["light", "dark"] as const) {
  test(`long mobile repository lists open without a positioning transition in reduced motion (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(
      (value) => localStorage.setItem("hq.theme.v1", value),
      theme,
    );
    await mockWorkspaceView(page, (snapshot) => ({
      ...snapshot,
      repositories: Array.from({ length: LONG_LIST_SIZE }, (_, index) => ({
        id: "long-list-" + index,
        workspaceId: snapshot.workspace.id,
        fullName: "example/long-list-repository-" + index,
        description: "Synthetic repository",
        projectId: snapshot.projects[0]!.id,
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
        revision: 1,
        updatedAt: new Date().toISOString(),
      })),
    }));
    await page.goto("/activity");
    await expectStableOpening(
      page,
      page.getByRole("combobox", { name: "Filter by repository" }),
      theme,
    );
  });
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`dropdowns open themed and stationary at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto("/activity");
      await expect(
        page.getByRole("heading", { name: "Activity", exact: true }),
      ).toBeVisible();
      if (width <= 720)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expectStableOpening(
        page,
        page.getByRole("combobox", { name: "Workspace", exact: true }),
        theme,
        true,
      );
      if (width <= 720) await page.keyboard.press("Escape");
      await expectStableOpening(
        page,
        page.getByRole("combobox", { name: "Filter by repository" }),
        theme,
      );
      await page.getByRole("button", { name: "Add note", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("dialog").evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await expectStableOpening(
        page,
        page.getByRole("combobox", { name: "Related to" }),
        theme,
      );
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    });
  }
}
