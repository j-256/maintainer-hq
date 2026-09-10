import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Repository,
} from "../shared/domain";
import type { GitHubSource } from "../shared/github";
import {
  WORK_LIMITS,
  type WorkResult,
  type PullWork,
} from "../shared/repository-work";
import { mockWorkspaceView } from "./workspace-fixture";
import { verifyFlatContrast } from "./flat-contrast";

const WORKSPACE = "development";
const HEAD = "a".repeat(40);
const AGO = 45 * WORK_LIMITS.DAY_MS;
async function populated(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: WORKSPACE,
      repository: {
        fullName: "example/work-" + crypto.randomUUID(),
        description: "Synthetic work browser fixture",
        projectId: "development-default",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const repository: Repository = await response.json();
  const source: GitHubSource = {
    id: "work-fixture",
    name: "Read-only work source",
    provider: "github",
    revision: 1,
    enabled: true,
    freshnessMinutes: 15,
    repositoryIds: [repository.id],
    credentialConfigured: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    github: {
      credentialRef: "synthetic",
      configurationValid: true,
      refreshIntervalMinutes: 15,
      nextRefreshAt: null,
      retryAt: null,
      activeRefreshId: null,
      lastRefreshId: null,
      lastRefreshStatus: null,
    },
  };
  const now = new Date().toISOString();
  const pulls: PullWork[] = Array.from(
    { length: WORK_LIMITS.PULLS },
    (_, index) => ({
      number: index + 1,
      title:
        index === 0
          ? "Make the first-use workflow understandable with a deliberately long title that must wrap without shrinking text or widening the viewport"
          : "Review workflow improvement " + (index + 1),
      createdAt: new Date(Date.now() - AGO).toISOString(),
      updatedAt: now,
      draft: index === 3,
      headSha: HEAD,
      author:
        index === 2
          ? { login: "dependabot", bot: true }
          : { login: "contributor", bot: false },
      dependencyBot: index === 2 ? "dependabot" : null,
      review: {
        state: "observed",
        reason: "complete",
        decision: index === 1 ? null : "REVIEW_REQUIRED",
        requested: index === 1 ? null : 0,
      },
      checks: {
        state: "observed",
        reason: "complete",
        status: index === 0 ? "FAILURE" : index === 1 ? null : "SUCCESS",
      },
    }),
  );
  const result: WorkResult = {
    repository: {
      id: repository.id,
      fullName: repository.fullName,
      revision: repository.revision,
    },
    source: { id: source.id, name: source.name, revision: source.revision },
    state: "ready",
    nextReadAt: new Date(Date.now() + WORK_LIMITS.CACHE_MS).toISOString(),
    evidence: {
      observedAt: now,
      requests: 2,
      retryAt: null,
      pulls: {
        state: "observed",
        reason: "complete",
        total: 51,
        hasMore: true,
        records: pulls,
      },
      issues: {
        state: "observed",
        reason: "complete",
        enabled: true,
        total: 17,
        hasMore: true,
        records: Array.from({ length: WORK_LIMITS.ISSUES }, (_, i) => ({
          number: i + 101,
          title: "Clarify the operator workflow " + (i + 1),
          createdAt: new Date(Date.now() - AGO).toISOString(),
          updatedAt: now,
        })),
      },
    },
  };
  const state = {
    result,
    sources: [source],
    rejectStatus: 0,
    calls: [] as { name: string; input: Record<string, unknown> }[],
  };
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      state.calls.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    capabilities: [CAPABILITY.READ],
    connections: state.sources,
  }));
  await page.route("**/api/commands/repository_work", (route) =>
    state.rejectStatus
      ? route.fulfill({
          status: state.rejectStatus,
          json: {
            error: {
              code: "read_unavailable",
              message: "Synthetic work read unavailable",
            },
          },
        })
      : route.fulfill({ json: state.result }),
  );
  return { state, repository };
}
const href = (repo: Repository, suffix = "") =>
  `/repositories/${repo.id}?workspace=${WORKSPACE}&section=work${suffix}`;
for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`work context is readable and scoped at ${width} ${theme}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const { state, repository } = await populated(page, request);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(href(repository));
      await expect(
        page.getByRole("heading", { name: "Open pull requests 51" }),
      ).toBeVisible();
      await expect(page.getByText(/Showing 20 of 51 open PRs/)).toBeVisible();
      await expect(
        page.getByText(/Showing the 10 oldest of 17 open issues/),
      ).toBeVisible();
      await expect(
        page.getByText("No review decision reported", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: "No check rollup reported",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Checks failing", exact: true }),
      ).toHaveAttribute(
        "href",
        `https://github.com/${repository.fullName}/pull/1/checks`,
      );
      await expect(
        page.getByRole("button", { name: "Refresh work", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Edit expectations" }),
      ).toBeDisabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .include(".repository-work")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(audit.violations).toEqual([]);
      await verifyFlatContrast(page, audit.incomplete);
      await page.screenshot({
        path: info.outputPath(`work-${width}-${theme}.png`),
        fullPage: true,
      });
      expect(errors).toEqual([]);
      const reads = state.calls.filter((c) => c.name === "repository_work");
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every(
          (c) =>
            c.input.repositoryId === repository.id &&
            c.input.sourceId === "work-fixture",
        ),
      ).toBe(true);
      expect(
        state.calls.some(
          (c) =>
            c.name === "workspace_view" && c.input.view === "repository-work",
        ),
      ).toBe(true);
      expect(
        state.calls.filter(
          (c) => !["workspace_view", "repository_work"].includes(c.name),
        ),
      ).toEqual([]);
    });
  }
test("keyboard filters and sample pagination persist without reading other tabs", async ({
  page,
  request,
}) => {
  const { state, repository } = await populated(page, request);
  await page.goto(href(repository, "&workPage=2&from=inventory"));
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "#11 Review workflow improvement 11",
      exact: true,
    }),
  ).toBeVisible();
  const filter = page.getByRole("combobox", {
    name: "Filter sampled pull requests",
  });
  await filter.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "All sampled PRs", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Pending review", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Failing checks", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(filter).toBeFocused();
  await expect(page).toHaveURL(/workFilter=failing/);
  await expect(page).toHaveURL(/from=inventory/);
  await expect(
    page
      .getByRole("list", { name: "Sampled pull requests" })
      .locator(":scope > li"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Checks failing", exact: true }),
  ).toBeVisible();
  state.result.nextReadAt = new Date(Date.now() - 1000).toISOString();
  await page.reload();
  await expect(filter).toHaveText("Failing checks");
  state.result.evidence!.pulls.records[0].title = "Updated sampled PR title";
  await page.getByRole("button", { name: "Refresh work", exact: true }).click();
  await expect(
    page.getByRole("link", {
      name: "#1 Updated sampled PR title",
      exact: true,
    }),
  ).toBeVisible();
  await expect(filter).toHaveText("Failing checks");
  await expect(page).toHaveURL(/from=inventory/);
  expect(
    state.calls.some((c) =>
      [
        "repository_releases",
        "activity_feed",
        "workspace_snapshot",
        "repository_resources",
      ].includes(c.name),
    ),
  ).toBe(false);
});
test("keeps old evidence dated on temporary failure and hides it after access changes", async ({
  page,
  request,
}) => {
  const { state, repository } = await populated(page, request);
  state.result.nextReadAt = new Date(Date.now() - 1000).toISOString();
  state.result.evidence!.observedAt = new Date(
    Date.now() - WORK_LIMITS.CACHE_MS - 1000,
  ).toISOString();
  await page.goto(href(repository));
  await expect(
    page.getByText("Evidence needs refresh", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.work-signals [data-tone="success"]')).toHaveCount(0);
  state.rejectStatus = 503;
  await page.getByRole("button", { name: "Refresh work", exact: true }).click();
  await expect(
    page.getByText("Any evidence below belongs to the previous read."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Open pull requests 51" }),
  ).toBeVisible();
  state.rejectStatus = 403;
  await page
    .getByRole("button", { name: "Retry work read", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Open pull requests 51" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Synthetic work read unavailable", { exact: true }),
  ).toBeVisible();
});
test("explains independent read gaps and disabled issues without inventing a clean inventory", async ({
  page,
  request,
}) => {
  const { state, repository } = await populated(page, request);
  state.result.evidence!.pulls = {
    state: "unavailable",
    reason: "permission",
    total: null,
    hasMore: false,
    records: [],
  };
  state.result.evidence!.issues = {
    state: "observed",
    reason: "complete",
    total: 0,
    hasMore: false,
    enabled: false,
    records: [],
  };
  await page.goto(href(repository));
  await expect(
    page.getByText(
      /Review repository access and Pull requests read permission/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("GitHub Issues is disabled for this repository."),
  ).toBeVisible();
  await expect(
    page.getByText("No open pull requests were reported at this read."),
  ).toHaveCount(0);
  await expect(
    page.getByText("No open issues were reported at this read."),
  ).toHaveCount(0);
});
test("shows a missing source without making a provider-context request", async ({
  page,
  request,
}) => {
  const { state, repository } = await populated(page, request);
  state.sources = [];
  await page.goto(href(repository));
  await expect(
    page.getByRole("heading", { name: "No GitHub source for this repository" }),
  ).toBeVisible();
  expect(state.calls.some((c) => c.name === "repository_work")).toBe(false);
});
