import { test, expect } from "./test-fixture";

const SOURCE_REPOSITORY_URL = "https://github.com/j-256/maintainer-hq";

for (const theme of ["light", "dark"])
  for (const width of [390, 1280])
    test(`footer exposes public source at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await page.goto("/overview?workspace=development");
      const source = page.getByRole("link", {
        name: "Source code (opens in a new tab)",
        exact: true,
      });
      await expect(source).toBeVisible();
      await expect(source).toHaveAttribute("href", SOURCE_REPOSITORY_URL);
      await expect(source).toHaveAttribute("rel", "noreferrer");
      await expect(source).toHaveAttribute("target", "_blank");
      await source.focus();
      await expect(source).toBeFocused();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBe(0);
    });
