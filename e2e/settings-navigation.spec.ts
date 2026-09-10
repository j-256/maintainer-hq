import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { SETTINGS_SECTIONS } from "../shared/settings-navigation";
import { DOCUMENTATION_ORIGIN } from "../shared/documentation";
import type { WorkspaceView } from "../shared/workspace-sync";

for (const width of [1440, 390, 320])
  for (const theme of ["light", "dark"]) {
    test(`Settings is a task index with scoped pages at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      const commands: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/commands/"))
          commands.push(request.url().split("/").at(-1)!);
      });
      const bootstrap = page.waitForResponse((response) =>
        response.url().endsWith("/api/commands/workspace_view"),
      );
      await page.goto("/settings?workspace=development");
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: "Date and time preferences",
          exact: true,
        }),
      ).toBeVisible();
      await page.waitForLoadState("networkidle");
      const view = (await (await bootstrap).json()) as WorkspaceView;
      expect(view.scope.view).toBe("workspace");
      expect(view.records).toEqual({});
      expect(
        commands.every(
          (command) =>
            command === "workspace_view" || command === "workspace_changes",
        ),
      ).toBe(true);
      for (const section of SETTINGS_SECTIONS) {
        await expect(
          page
            .locator("main")
            .getByRole("link")
            .filter({ hasText: section.label }),
        ).toBeVisible();
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "125%";
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBe(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      for (const section of SETTINGS_SECTIONS.filter(
        (section) => section.id !== "preferences",
      )) {
        const link = page
          .locator("main")
          .getByRole("link")
          .filter({ hasText: section.label });
        await link.focus();
        await page.keyboard.press("Enter");
        const heading = page.getByRole("heading", {
          name: section.title,
          level: 1,
          exact: true,
        });
        await expect(heading).toBeVisible();
        await expect(heading).toBeFocused();
        await page.waitForLoadState("networkidle");
        await expect(page).toHaveTitle(
          section.title + " | Development | Maintainer HQ",
        );
        await expect(
          page.getByRole("link", {
            name: section.label + " guide (opens in a new tab)",
            exact: true,
          }),
        ).toHaveAttribute(
          "href",
          DOCUMENTATION_ORIGIN + "/" + section.guide + "/",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - innerWidth,
          ),
        ).toBe(0);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        await page
          .getByRole("link", { name: "All settings", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "Settings",
            level: 1,
            exact: true,
          }),
        ).toBeVisible();
      }
    });
  }
