import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  type Project,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";

const WORKSPACE_ID = "inventory-test";
const INVENTORY_URL = "/repositories?workspace=" + WORKSPACE_ID;
const FLEET_SIZE = 64;
const ARCHIVED_COUNT = 4;
const repositories: Repository[] = [];
async function command<T>(
  request: APIRequestContext,
  name: string,
  data: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE_ID, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
function rows(page: Page) {
  return page
    .getByRole("table", { name: "Repository inventory" })
    .locator("tbody tr");
}
function requests(page: Page) {
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      commands.push(new URL(request.url()).pathname.split("/").at(-1)!);
  });
  return commands;
}

test.beforeAll(async ({ request }) => {
  const snapshot = await command<Snapshot>(request, "workspace_snapshot", {});
  const project =
    snapshot.projects.find((item) => item.name === "Demo services") ??
    (await command<Project>(request, "project_create", {
      name: "Demo services",
      description: "Synthetic inventory project",
    }));
  const otherProject =
    snapshot.projects.find((item) => item.name === "Other services") ??
    (await command<Project>(request, "project_create", {
      name: "Other services",
      description: "Synthetic secondary inventory project",
    }));
  for (let index = 0; index < FLEET_SIZE; index++) {
    const fields = {
      fullName: "example/inventory-" + String(index).padStart(2, "0"),
      description: "Synthetic detailed description " + index,
      projectId: index % 2 ? otherProject.id : project.id,
      classification: index % 3 ? "maintained" : "watchlist",
      lifecycle: index >= FLEET_SIZE - ARCHIVED_COUNT ? "archived" : "active",
      expectations: {
        ...DEFAULT_EXPECTATIONS,
        reviewDate: index % 10 ? null : "2020-01-01",
      },
    } as const;
    const existing = snapshot.repositories.find(
      (item) => item.fullName === fields.fullName,
    );
    repositories.push(
      await command<Repository>(
        request,
        existing ? "repository_update" : "repository_create",
        {
          ...(existing
            ? { repositoryId: existing.id, revision: existing.revision }
            : {}),
          repository: fields,
        },
      ),
    );
  }
});

test("dense inventory counts, filters, sorting, paging and detail return use the same view without read amplification", async ({
  page,
}) => {
  const calls = requests(page);
  await page.goto(INVENTORY_URL);
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await expect(rows(page)).toHaveCount(25);
  await expect(page.locator(".repository-inventory-summary")).toContainText(
    "1-25 of 60 repositories active",
  );
  await expect(
    page.getByRole("button", { name: "Archived", exact: true }),
  ).toHaveAccessibleDescription("4");
  await page.getByRole("button", { name: "Next repository page" }).click();
  await expect(rows(page).first()).toContainText("example/inventory-25");
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.locator(".repository-inventory-summary [role=status]"),
  ).toBeFocused();
  await page
    .getByRole("link", { name: "example/inventory-25", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic detailed description 25", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Repository sections" })
    .getByRole("link", { name: "Hooks", exact: true })
    .click();
  await expect(page).toHaveURL(/section=hooks/);
  await page.locator(".back-link").click();
  await expect(rows(page).first()).toContainText("example/inventory-25");
  await expect(page).toHaveURL(/page=2/);
  await page.waitForLoadState("networkidle");
  const reads = [...calls];
  await page.getByRole("button", { name: "Next repository page" }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(
    page.getByRole("button", { name: "Next repository page" }),
  ).toBeDisabled();
  await select(page, "Sort repositories", "Name Z to A");
  await expect(rows(page).first()).toContainText("example/inventory-59");
  await expect(page.locator(".repository-inventory-summary")).toContainText(
    "1-25",
  );
  await select(page, "Repository tracking", "Watchlist");
  await expect(rows(page)).toHaveCount(20);
  await page
    .getByRole("textbox", { name: "Search repositories" })
    .fill("Demo services");
  await expect(rows(page)).toHaveCount(10);
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("example/inventory-60");
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Sort repositories" }),
  ).toContainText("Name Z to A");
  await page
    .getByRole("textbox", { name: "Search repositories" })
    .fill("detailed description 17");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("example/inventory-17");
  await page
    .getByRole("textbox", { name: "Search repositories" })
    .fill("missing phrase");
  await expect(
    page.getByRole("heading", { name: "No repositories match" }),
  ).toBeVisible();
  await expect(page.locator(".repository-inventory-summary")).toContainText(
    "0 repositories matching filters",
  );
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await select(page, "Per page", "50");
  await expect(rows(page)).toHaveCount(50);
  await select(page, "Per page", "100");
  await expect(rows(page)).toHaveCount(60);
  expect(calls).toEqual(reads);
  await page.reload();
  await expect(rows(page)).toHaveCount(60);
  await expect(
    page.getByRole("combobox", { name: "Sort repositories" }),
  ).toContainText("Name Z to A");
});

test("incoming records preserve inventory page, controls and an unsaved enrollment draft", async ({
  page,
  request,
}) => {
  const calls = requests(page);
  const repo = repositories[31];
  await page.goto(INVENTORY_URL + "&q=inventory&sort=name&page=2");
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  const row = page
    .locator(".repository-inventory tbody tr")
    .filter({ hasText: repo.fullName });
  await expect(
    row.getByRole("cell", { name: "Maintained", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enroll repository", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Repository name", { exact: true })
    .fill("example/preserved-inventory-draft");
  const {
    id,
    workspaceId: _workspace,
    revision,
    updatedAt: _updated,
    ...fields
  } = repo;
  await command(request, "repository_update", {
    repositoryId: id,
    revision,
    repository: { ...fields, classification: "reference" },
  });
  await expect(row.locator('[data-label="Tracking"]')).toHaveText("Reference");
  await expect(
    dialog.getByLabel("Repository name", { exact: true }),
  ).toHaveValue("example/preserved-inventory-draft");
  await expect(page).toHaveURL(/q=inventory&sort=name&page=2/);
  expect(calls).toEqual(["workspace_view"]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enroll repository", exact: true }),
  ).toBeFocused();
  await expect(page.locator(".repository-pagination")).toContainText(
    "Page 2 of 3",
  );
});

test("desktop density preserves readable names and mobile retains all column facts, keyboard controls and both themes", async ({
  page,
}) => {
  await page.goto(INVENTORY_URL);
  for (const viewport of [
    { width: 1720, height: 932 },
    { width: 1100, height: 932 },
    { width: 390, height: 900 },
    { width: 320, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await page.reload();
      await expect(rows(page)).toHaveCount(25);
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
      await expect(rows(page).first().locator("h2")).toHaveCSS(
        "font-size",
        "16px",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const first = rows(page).first();
      for (const fact of [
        "Demo services",
        "Watchlist",
        "Unverified",
        "Review overdue",
        "Awaiting evidence",
      ])
        await expect(first.getByText(fact, { exact: true })).toBeVisible();
      if (viewport.width === 1720) {
        const visible = await rows(page).evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.top >= 0 && bounds.bottom <= innerHeight;
            }).length,
        );
        expect(visible).toBeGreaterThanOrEqual(8);
      }
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const sort = page.getByRole("combobox", { name: "Sort repositories" });
      await sort.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sort).toBeFocused();
      const link = first.getByRole("link", {
        name: "example/inventory-00",
        exact: true,
      });
      await link.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", {
          name: "example/inventory-00",
          exact: true,
        }),
      ).toBeVisible();
      await page.goBack();
      await expect(rows(page)).toHaveCount(25);
      await first
        .getByRole("link", { name: "Demo services", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Demo services", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(rows(page)).toHaveCount(25);
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  await expect(rows(page).first().locator("h2")).toHaveCSS("font-size", "20px");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("long identifiers, invalid pages, and a live final-page removal stay usable", async ({
  page,
}) => {
  const longName = "long-organization-name/" + "long-repository-name".repeat(5);
  let records = repositories.slice(0, 26).map((repo, index) => ({
    ...repo,
    fullName: index === 25 ? longName : repo.fullName,
  }));
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: records,
  }));
  await page.goto(INVENTORY_URL + "&page=999&pageSize=100000");
  await expect(rows(page)).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: longName, exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  records = records.slice(0, 25);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(rows(page)).toHaveCount(25);
  await expect(page.locator(".repository-pagination")).toContainText(
    "Page 1 of 1",
  );
  await expect(
    page.getByRole("button", { name: "Previous repository page" }),
  ).toBeDisabled();
});

test("fresh evidence expires on the display clock without new requests", async ({
  page,
}) => {
  const now = Date.now();
  const repo = { ...repositories[1], expectations: DEFAULT_EXPECTATIONS };
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: [repo],
    observations: [
      {
        sourceId: "synthetic-github",
        resourceType: "repository",
        resourceId: repo.id,
        name: repo.fullName,
        provider: "github",
        health: "healthy",
        summary: "Synthetic passing checks",
        details: { ci: "passing", openFindings: 0 },
        observedAt: new Date(now).toISOString(),
        receivedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      },
    ],
  }));
  const calls = requests(page);
  await page.goto(INVENTORY_URL);
  await expect(
    rows(page).first().getByText("Healthy", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  const reads = [...calls];
  await page.clock.setSystemTime(now + 120000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    rows(page).first().getByText("Unverified", { exact: true }),
  ).toBeVisible();
  await expect(
    rows(page).first().getByText("Refresh needed", { exact: true }),
  ).toBeVisible();
  expect(calls).toEqual(reads);
});
