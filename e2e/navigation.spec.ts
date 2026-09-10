import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspaceView } from "./workspace-fixture";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";

const DEVELOPMENT_PROJECT_ID = "development-default";

test("malformed resource links load no invalid resource query and return to the collection", async ({
  page,
}) => {
  const calls: { name: string; input: unknown }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push({
        name: new URL(request.url()).pathname.split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  for (const [collection, kind] of [
    ["repositories", "repository"],
    ["projects", "project"],
  ]) {
    for (const id of ["%", "%25", "bad%20id", "%E0%A4%A", "a".repeat(101)]) {
      calls.length = 0;
      await page.goto(
        "/" + collection + "/" + id + "?workspace=development&section=activity",
      );
      await expect(
        page.getByRole("heading", {
          name: "Invalid " + kind + " link",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        calls.filter((call) => call.name === "departed_resource_context"),
      ).toEqual([]);
      const views = calls.filter((call) => call.name === "workspace_view");
      expect(views).toHaveLength(1);
      expect(views[0].input).toEqual({
        workspaceId: "development",
        view: "workspace",
      });
      await page
        .getByRole("link", { name: "Back to " + collection, exact: true })
        .click();
      await expect(page).toHaveURL("/" + collection + "?workspace=development");
      await expect(
        page.getByRole("heading", {
          name: collection === "projects" ? "Projects" : "Repositories",
          exact: true,
        }),
      ).toBeVisible();
    }
  }
});

test("route aliases render the same repository data, titles, and scoped subscriptions", async ({
  page,
}) => {
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: [
      {
        id: "CaseSensitive-ID",
        workspaceId: "development",
        fullName: "example/route-alias",
        description: "Synthetic route alias regression",
        projectId: DEVELOPMENT_PROJECT_ID,
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  }));
  for (const pathname of [
    "/repositories",
    "/repositories/",
    "/Repositories",
    "/Repositories///",
  ]) {
    const bootstrap = page.waitForResponse((response) =>
      response.url().endsWith("/api/commands/workspace_view"),
    );
    await page.goto(pathname + "?workspace=development&q=route-alias");
    expect((await (await bootstrap).json()).scope).toEqual({
      view: "repositories",
    });
    await expect(
      page.getByRole("link", { name: "example/route-alias", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle(
      "Repositories | Development | Maintainer HQ",
    );
    await expect(
      page.getByRole("link", {
        name: "Repositories guide (opens in a new tab)",
        exact: true,
      }),
    ).toHaveAttribute("href", "https://docs.hq.lasers.app/repositories/");
    await expect(
      page.getByRole("textbox", { name: "Search repositories" }),
    ).toHaveValue("route-alias");
  }
  const bootstrap = page.waitForResponse((response) =>
    response.url().endsWith("/api/commands/workspace_view"),
  );
  await page.goto("/Repositories/CaseSensitive-ID/?workspace=development");
  expect((await (await bootstrap).json()).scope).toEqual({
    view: "repository",
    repositoryId: "CaseSensitive-ID",
  });
  await expect(
    page.getByRole("heading", { name: "example/route-alias", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(
    "example/route-alias | Overview | Development | Maintainer HQ",
  );
  await page.goto("/Settings/GitHub/?workspace=development");
  await expect(
    page.getByRole("heading", { name: "GitHub evidence", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(
    "GitHub evidence | Development | Maintainer HQ",
  );
});

for (const theme of ["light", "dark"])
  for (const width of [390, 320]) {
    test(`mobile navigation exposes every section and workspace at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await page.goto("/secrets?workspace=development&view=providers");
      await expect(page).toHaveTitle(
        "Provider access | Development | Maintainer HQ",
      );
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await menu.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Workspace menu" });
      await expect(dialog).toBeVisible();
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      await expect(
        dialog.getByRole("combobox", { name: "Workspace", exact: true }),
      ).toBeFocused();
      const navigation = dialog.getByRole("navigation", {
        name: "Main navigation",
        exact: true,
      });
      for (const name of [
        "Overview",
        "Activity",
        "Projects",
        "Repositories",
        "Hooks",
        "Monitoring",
        "Secrets",
        "Settings",
      ]) {
        const link = navigation.getByRole("link", { name, exact: true });
        await expect(link).toBeVisible();
        expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(
        navigation.getByRole("link", { name: "Secrets", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();
      await menu.click();
      const settings = navigation.getByRole("link", {
        name: "Settings",
        exact: true,
      });
      await settings.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("#main-content")).toBeFocused();
      await expect(page).toHaveTitle("Settings | Development | Maintainer HQ");
      await page.keyboard.press("Tab");
      expect(
        await page
          .locator("main")
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "125%";
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBe(0);
      await menu.click();
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBe(0);
      await dialog
        .getByRole("combobox", { name: "Workspace", exact: true })
        .click();
      await page
        .getByRole("option", {
          name: "Synthetic projects workspace",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?workspace=projects-test$/);
      await expect(page).toHaveTitle(
        "Settings | Synthetic projects workspace | Maintainer HQ",
      );
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("#main-content")).toBeFocused();
    });
  }

test("workspace switching clears foreign detail context and supports browser return navigation", async ({
  page,
}) => {
  await page.goto(
    "/projects/missing-project?workspace=development&section=hooks&connection=foreign",
  );
  await page.getByRole("combobox", { name: "Workspace", exact: true }).click();
  await page
    .getByRole("option", { name: "Synthetic projects workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\?workspace=projects-test$/);
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(
    /\/projects\/missing-project\?workspace=development&section=hooks&connection=foreign$/,
  );
});

test("bad page and workspace links offer recovery instead of a redirect or endless loading", async ({
  page,
}) => {
  const views: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/workspace_view"))
      views.push(request.postDataJSON());
  });
  await page.goto("/not-a-page?workspace=development");
  await expect(
    page.getByRole("heading", { name: "Page not found", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/not-a-page\?workspace=development$/);
  await page
    .getByRole("link", { name: "Browse projects", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\?workspace=development$/);
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  views.length = 0;
  await page.goto("/repositories/foreign-repo?workspace=unavailable");
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Opening your workspace...", { exact: true }),
  ).toHaveCount(0);
  expect(views).toEqual([]);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Development", exact: true })
    .click();
  await expect(page).toHaveURL(/\/repositories\?workspace=development$/);
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
});
