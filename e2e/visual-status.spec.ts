import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { coverageFixture } from "./github-coverage-fixture";
import { mockWorkspaceView } from "./workspace-fixture";
import type { Observation } from "../shared/domain";
import { verifyFlatContrast } from "./flat-contrast";

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`status labels distinguish success, failure, warning and unknown in ${theme} at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const fixture = coverageFixture();
      const repositories = fixture.repositories.slice(0, 4);
      const now = Date.now();
      const observations: Observation[] = repositories
        .slice(0, 3)
        .map((repository, index) => ({
          ...fixture.observations[0],
          resourceId: repository.id,
          health:
            index === 0 ? "healthy" : index === 1 ? "critical" : "warning",
          expiresAt: new Date(now + 30000).toISOString(),
          details: {
            ...fixture.observations[0].details,
            ci: index === 0 ? "passing" : "failing",
            openFindings: 0,
          },
        }));
      await page.clock.install({ time: now });
      await mockWorkspaceView(page, (snapshot) => ({
        ...snapshot,
        repositories,
        observations,
        connections: fixture.sources,
      }));
      await page.goto("/repositories?workspace=development");
      const tones = ["success", "danger", "warning", "neutral"];
      for (const [index, repository] of repositories.entries()) {
        const badge = page
          .getByRole("row")
          .filter({ hasText: repository.fullName })
          .locator(".health-badge");
        await expect(badge).toHaveAttribute("data-tone", tones[index]);
        await expect(badge.locator('svg[aria-hidden="true"]')).toHaveCount(1);
        await expect(badge).toContainText(
          index === 0
            ? "Healthy"
            : index === 1
              ? "Critical"
              : index === 3
                ? "Unverified"
                : "Needs attention",
        );
      }
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath("statuses.png") });
      await page.clock.runFor(60000);
      await expect(
        page.locator('.health-badge[data-tone="success"]'),
      ).toHaveCount(0);
      await expect(
        page.locator('.health-badge[data-tone="neutral"]'),
      ).toHaveCount(repositories.length);
    });

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`project sections preserve drafts and reveal invalid fields in ${theme} at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.goto("/projects?workspace=development");
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Create project",
        exact: true,
      });
      await dialog
        .getByLabel("Project name", { exact: true })
        .fill("Synthetic visual draft");
      const portfolio = dialog
        .locator("details")
        .filter({ hasText: "Portfolio inclusion" });
      const summary = portfolio.locator("summary");
      await expect(portfolio).not.toHaveAttribute("open");
      await summary.focus();
      await page.keyboard.press("Enter");
      await dialog
        .getByRole("combobox", { name: "Inclusion decision" })
        .click();
      await page.getByRole("option", { name: "Excluded", exact: true }).click();
      await summary.click();
      await dialog
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      const reason = dialog.getByLabel("Reason (required)", { exact: true });
      await expect(reason).toBeFocused();
      await expect(portfolio).toHaveAttribute("open", "");
      await reason.fill("Keep this optional context while collapsed");
      await summary.click();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(reason).toHaveValue(
        "Keep this optional context while collapsed",
      );
      await summary.click();
      await dialog.locator(".project-form-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      const save = dialog.getByRole("button", {
        name: "Create project",
        exact: true,
      });
      const bounds = await save.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .include(".project-dialog")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(audit.violations).toEqual([]);
      for (const finding of audit.incomplete)
        for (const node of finding.nodes) {
          await page.locator(node.target[0] as string).scrollIntoViewIfNeeded();
          await verifyFlatContrast(page, [{ ...finding, nodes: [node] }]);
        }
      await dialog.locator(".project-form-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath("project-dialog.png") });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await expect(
        dialog.getByLabel("Project name", { exact: true }),
      ).toHaveValue("Synthetic visual draft");
    });
