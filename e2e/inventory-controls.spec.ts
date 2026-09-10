import { test, expect } from "./test-fixture";

for (const collection of ["projects", "repositories"]) {
  for (const theme of ["light", "dark"]) {
    test(`${collection} filters keep their default labels readable on narrow screens in ${theme}`, async ({
      page,
    }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto("/" + collection + "?workspace=development");
      const controls = page.locator(".repository-inventory-controls");
      await expect(controls.getByRole("combobox")).toHaveCount(3);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(async () => {
          document.documentElement.style.fontSize = "125%";
          await document.fonts.ready;
          await new Promise(requestAnimationFrame);
        });
        for (const select of await controls.getByRole("combobox").all()) {
          await expect(select).toBeVisible();
          const value = select.locator('[data-slot="select-value"]');
          expect(
            await value.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          expect((await select.boundingBox())?.height).toBeGreaterThanOrEqual(
            44,
          );
          await select.focus();
          await expect(select).toBeFocused();
          await page.keyboard.press("Enter");
          await expect(page.getByRole("listbox")).toBeVisible();
          await expect(
            page.getByRole("option", { selected: true }),
          ).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("listbox")).toHaveCount(0);
          await expect(select).toBeFocused();
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    });
  }
}
