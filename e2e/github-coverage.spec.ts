import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Repository,
} from "../shared/domain";
import { GITHUB_COVERAGE_LIMITS } from "../shared/github-coverage";
import type { GitHubSource } from "../shared/github";
import type { WorkspaceView } from "../shared/workspace-sync";
import { coverageFixture } from "./github-coverage-fixture";
import { mockWorkspaceView } from "./workspace-fixture";

const BASE = "/settings/github?workspace=development";
function requests(page: Page) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  return calls;
}
async function populated(page: Page, viewer = false) {
  const fixture = coverageFixture();
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: fixture.repositories,
    connections: fixture.sources,
    observations: fixture.observations,
    ...(viewer
      ? {
          capabilities: [CAPABILITY.READ],
          workspace: { ...snapshot.workspace, role: "viewer" },
        }
      : {}),
  }));
  await page.route("**/api/commands/github_coverage", (route) =>
    route.fulfill({ json: fixture.response(route.request().postDataJSON()) }),
  );
  await page.route("**/api/commands/github_refreshes_list", (route) =>
    route.fulfill({
      json: [fixture.receipt(route.request().postDataJSON().sourceId)],
    }),
  );
  await page.route("**/api/commands/github_refresh_get", (route) => {
    const input = route.request().postDataJSON();
    const receipt = fixture.receipt(input.sourceId);
    expect(input.refreshId).toBe(receipt.id);
    return route.fulfill({ json: receipt });
  });
  return fixture;
}
const row = (page: Page, name: string) =>
  page.locator(".coverage-table tbody > tr").filter({
    has: page.getByRole("link", { name, exact: true, includeHidden: true }),
  });

for (const theme of ["light", "dark"])
  for (const width of [1440, 1280, 390])
    test(`coverage distinguishes gaps and remains accessible in ${theme} at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await populated(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(BASE);
      await expect(row(page, "example/service-01")).toContainText(
        "Coverage current",
      );
      await expect(row(page, "example/service-01")).toContainText("Collected");
      await expect(row(page, "example/service-02")).toContainText(
        "Access or feature gaps",
      );
      await expect(row(page, "example/service-03")).toContainText(
        "Evidence stale",
      );
      await expect(row(page, "example/service-04")).toContainText(
        "Connection not configured",
      );
      await expect(row(page, "example/service-05")).toContainText(
        "Collection disabled",
      );
      await expect(row(page, "example/service-06")).toContainText(
        "Not collected",
      );
      await expect(row(page, "example/service-07")).toContainText(
        "Not yet attempted",
      );
      await expect(row(page, "example/service-08")).toContainText(
        "Collection error",
      );
      await expect(row(page, "example/service-09")).toContainText(
        "Read limit reached",
      );
      await expect(row(page, "example/service-10")).toContainText(
        "Provider rate limited",
      );
      await expect(row(page, "example/service-11")).toContainText(
        "Evidence incomplete",
      );
      await expect(row(page, "example/service-13")).toContainText(
        "Previous repository name",
      );
      await expect(row(page, "example/service-14")).toContainText(
        "Previous settings",
      );
      await expect(row(page, "example/service-15")).toContainText(
        "Cancelled before attempt",
      );
      await expect(row(page, "example/service-16")).toContainText(
        "Previous repository name",
      );
      const inspect = page.getByRole("button", {
        name: "Inspect coverage for example/service-02",
        exact: true,
      });
      await inspect.focus();
      await page.keyboard.press("Enter");
      const details = page.getByRole("region", {
        name: "GitHub - selected service repositories coverage",
        exact: true,
      });
      await expect(details).toContainText(
        "A denied read does not identify which is missing",
      );
      await expect(details).toContainText("Evidence accepted by HQ");
      await expect(
        details.getByRole("list", { name: "Accepted check coverage" }),
      ).toContainText("Unavailable");
      await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await page
          .locator('.coverage-table [data-slot="badge"]')
          .evaluateAll((badges) =>
            badges
              .filter(
                (badge) =>
                  badge.scrollHeight >
                  Math.ceil(badge.getBoundingClientRect().height),
              )
              .map((badge) => badge.textContent),
          ),
      ).toEqual([]);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("coverage.png"),
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });

test("coverage bounds visible reads, preserves URL filters and routes exact receipts without eager history", async ({
  page,
}) => {
  await populated(page);
  const calls = requests(page);
  await page.goto(BASE);
  await expect(
    page.getByRole("status").filter({ hasText: "1-25 of 30" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const call of calls.filter((call) => call.name === "github_coverage"))
    expect((call.input.repositoryIds as string[]).length).toBe(
      GITHUB_COVERAGE_LIMITS.REPOSITORIES,
    );
  expect(
    calls.some((call) =>
      /github_refresh|activity_feed|workspace_snapshot/.test(call.name),
    ),
  ).toBe(false);
  await page
    .getByRole("navigation", { name: "Evidence coverage pagination" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(page).toHaveURL(/coveragePage=2/);
  await expect(
    page.getByRole("status").filter({ hasText: "26-30 of 30" }),
  ).toBeFocused();
  await expect(row(page, "example/service-31")).toContainText("Collected");
  expect(
    (
      calls.filter((call) => call.name === "github_coverage").at(-1)!.input
        .repositoryIds as string[]
    ).length,
  ).toBe(5);
  await page
    .getByRole("combobox", { name: "Coverage status", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Access or feature gaps", exact: true })
    .click();
  await expect(page).toHaveURL(/coverage=unavailable/);
  await expect(page).not.toHaveURL(/coveragePage=/);
  await expect(
    page.getByRole("status").filter({ hasText: "1-2 of 2" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search evidence coverage" })
    .fill("service-02");
  await page
    .getByRole("button", {
      name: "Inspect coverage for example/service-02",
      exact: true,
    })
    .click();
  const receipt = page.getByRole("button", {
    name: "Open refresh receipt",
    exact: true,
  });
  await receipt.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Synthetic completed refresh with explicit access gaps",
  );
  await expect(page).toHaveURL(
    /source=coverage-primary&refresh=receipt-coverage-primary/,
  );
  await expect(page).toHaveURL(/coverage=unavailable/);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(receipt).toBeFocused();
  await expect(page).not.toHaveURL(/source=/);
  await expect(
    page.getByRole("textbox", { name: "Search evidence coverage" }),
  ).toHaveValue("service-02");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const coverageReads = calls.filter(
    (call) => call.name === "github_coverage",
  ).length;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.waitForLoadState("networkidle");
  expect(calls.filter((call) => call.name === "github_coverage")).toHaveLength(
    coverageReads,
  );
  expect(calls.map((call) => call.name)).not.toContain("workspace_snapshot");
});

test("each connection exposes its own result and viewers retain read access without edit authority", async ({
  page,
}) => {
  await populated(page, true);
  await page.goto(BASE + "&repository=coverage-12");
  await page
    .getByRole("button", {
      name: "Inspect coverage for example/service-12",
      exact: true,
    })
    .click();
  const primary = page.getByRole("region", {
    name: "GitHub - selected service repositories coverage",
    exact: true,
  });
  const secondary = page.getByRole("region", {
    name: "Additional read-only connection coverage",
    exact: true,
  });
  await expect(primary).toContainText("Coverage current");
  await expect(secondary).toContainText("Access or feature gaps");
  await expect(primary.locator(".coverage-latest-result")).toContainText(
    "Collected",
  );
  await expect(secondary.locator(".coverage-latest-result")).toContainText(
    "Collected with gaps",
  );
  await expect(
    secondary.getByRole("button", { name: "Edit connection", exact: true }),
  ).toBeDisabled();
  await secondary
    .getByRole("button", { name: "Open refresh receipt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Additional read-only connection",
  );
  await expect(page).toHaveURL(/refresh=receipt-coverage-secondary/);
});

test("coverage failure keeps accepted evidence visible and recovers explicitly", async ({
  page,
}) => {
  const fixture = await populated(page);
  await page.route("**/api/commands/github_coverage", async (route) =>
    !(await page.evaluate(
      () => document.documentElement.dataset.coverageRetry === "requested",
    ))
      ? route.fulfill({
          status: 409,
          json: {
            error: {
              code: "capacity",
              message: "Narrow the selected coverage read",
            },
          },
        })
      : route.fulfill({
          json: fixture.response(route.request().postDataJSON()),
        }),
  );
  await page.goto(BASE + "&repository=coverage-2");
  await expect(page.getByRole("alert")).toContainText("Choose one connection");
  await expect(row(page, "example/service-02")).toContainText(
    "Access or feature gaps",
  );
  await expect(row(page, "example/service-02")).toContainText(
    "Receipt unavailable",
  );
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button")?.textContent ===
            "Retry coverage details"
        )
          document.documentElement.dataset.coverageRetry = "requested";
      },
      { capture: true },
    );
  });
  await page
    .getByRole("button", { name: "Retry coverage details", exact: true })
    .click();
  await expect(row(page, "example/service-02")).toContainText(
    "Collected with gaps",
  );
  await expect(
    page.getByRole("button", { name: "Retry coverage details", exact: true }),
  ).toHaveCount(0);
});

test("real push leaves off-tab activity idle and preserves coverage filters and a connection draft", async ({
  page,
  request,
}) => {
  const workspaceId = "polling-test";
  async function api<T>(name: string, input: object): Promise<T> {
    const response = await request.post("/api/commands/" + name, {
      headers: { "X-HQ-Client": "cli" },
      data: { workspaceId, ...input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const repo = await api<Repository>("repository_create", {
    repository: {
      fullName: "example/coverage-push-" + crypto.randomUUID(),
      description: "Synthetic push verification",
      projectId: "polling-default",
      classification: "watchlist",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  const source = await api<GitHubSource>("github_source_enroll", {
    sourceId: crypto.randomUUID(),
    source: {
      name: "Coverage push " + crypto.randomUUID(),
      enabled: true,
      freshnessMinutes: 30,
      repositoryIds: [repo.id],
      credentialRef: null,
      refreshIntervalMinutes: 15,
    },
  });
  const calls = requests(page);
  const views: WorkspaceView[] = [];
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/api/commands/workspace_view") &&
      response.ok()
    )
      views.push(await response.json());
  });
  await page.goto(
    "/settings/github?workspace=" +
      workspaceId +
      "&repository=" +
      repo.id +
      "&coverage=not_configured",
  );
  await expect(row(page, repo.fullName)).toContainText("No latest receipt");
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page
    .getByRole("button", {
      name: "Inspect coverage for " + repo.fullName,
      exact: true,
    })
    .click();
  await page.waitForLoadState("networkidle");
  const beforeActivity = calls.length;
  await api("activity_add", {
    eventId: crypto.randomUUID(),
    kind: "note",
    title: "Off-tab coverage activity",
    summary: "Synthetic push check",
    resourceId: repo.id,
    goalId: null,
  });
  await page.waitForLoadState("networkidle");
  expect(calls).toHaveLength(beforeActivity);
  expect(Object.keys(views[0].records).sort()).toEqual([
    "connections",
    "observations",
    "repositories",
  ]);
  await page
    .getByRole("button", { name: "Edit connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name").fill("Unsaved coverage draft");
  await api("github_source_update", {
    sourceId: source.id,
    revision: source.revision,
    source: {
      name: source.name + " updated",
      enabled: true,
      freshnessMinutes: 60,
      repositoryIds: [repo.id],
      credentialRef: null,
      refreshIntervalMinutes: 15,
    },
  });
  await expect(row(page, repo.fullName)).toContainText(
    source.name + " updated",
  );
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Unsaved coverage draft",
  );
  const draftUrl = page.url();
  const draftScroll = await dialog.evaluate((node) => node.scrollTop);
  for (const value of ["hidden", "visible"]) {
    await page.evaluate((visibility) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: visibility,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, value);
  }
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Unsaved coverage draft",
  );
  expect(page.url()).toBe(draftUrl);
  expect(await dialog.evaluate((node) => node.scrollTop)).toBe(draftScroll);
  await expect(page).toHaveURL(/coverage=not_configured/);
  await expect(
    page.getByRole("button", {
      name: "Close coverage for " + repo.fullName,
      exact: true,
      includeHidden: true,
    }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(calls.map((call) => call.name)).not.toContain("workspace_snapshot");
  expect(views).toHaveLength(1);
});
