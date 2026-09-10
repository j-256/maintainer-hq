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
  type Project,
  type Repository,
} from "../shared/domain";
import type { GitHubSource } from "../shared/github";
import type { ReleaseResult } from "../shared/releases";
import { mockWorkspaceView } from "./workspace-fixture";
import { verifyFlatContrast } from "./flat-contrast";

const WORKSPACE = "development";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
async function api<T>(
  request: APIRequestContext,
  name: string,
  input: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE, ...input },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function populated(page: Page, request: APIRequestContext) {
  const project = await api<Project>(request, "project_create", {
    name: "Release fixtures " + crypto.randomUUID(),
    description: "Synthetic release context",
  });
  const repositories: Repository[] = [];
  for (const name of ["first", "second"])
    repositories.push(
      await api<Repository>(request, "repository_create", {
        repository: {
          fullName: "example/release-" + name + "-" + crypto.randomUUID(),
          description: "Synthetic repository release context",
          projectId: project.id,
          classification: "watchlist",
          lifecycle: "active",
          expectations: DEFAULT_EXPECTATIONS,
        },
      }),
    );
  const now = new Date().toISOString();
  const source: GitHubSource = {
    id: "release-fixture",
    name: "Read-only release source",
    provider: "github",
    revision: 1,
    enabled: true,
    freshnessMinutes: 15,
    repositoryIds: repositories.map((repo) => repo.id),
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
  const result: ReleaseResult = {
    repository: {
      id: repositories[0].id,
      fullName: repositories[0].fullName,
      revision: repositories[0].revision,
    },
    source: { id: source.id, name: source.name, revision: source.revision },
    state: "ready",
    nextReadAt: new Date(Date.now() + 300000).toISOString(),
    evidence: {
      observedAt: now,
      retryAt: null,
      requests: 2,
      head: { branch: "main", sha: HEAD },
      release: {
        state: "observed",
        reason: "complete",
        record: { id: 17, tag: "v1.0.0", publishedAt: now, sha: BASE },
      },
      comparison: {
        state: "observed",
        reason: "complete",
        record: {
          baseSha: BASE,
          headSha: HEAD,
          status: "ahead",
          aheadBy: 3,
          behindBy: 0,
        },
      },
      deployments: {
        state: "observed",
        reason: "complete",
        total: 44,
        hasMore: true,
        records: Array.from({ length: 5 }, (_, i) => ({
          id: 6089727714 + i,
          sha: HEAD,
          environment:
            i === 0
              ? "production"
              : "preview-environment-with-a-long-name-to-verify-wrapping",
          createdAt: now,
          status: i === 0 ? "FAILURE" : "SUCCESS",
          statusAt: now,
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
  await page.route("**/api/commands/repository_releases", (route) => {
    if (state.rejectStatus)
      return route.fulfill({
        status: state.rejectStatus,
        json: {
          error: {
            code: "read_unavailable",
            message: "Synthetic release read unavailable",
          },
        },
      });
    const selected = repositories.find(
      (repo) => repo.id === route.request().postDataJSON().repositoryId,
    )!;
    return route.fulfill({
      json: {
        ...state.result,
        repository: {
          id: selected.id,
          fullName: selected.fullName,
          revision: selected.revision,
        },
      },
    });
  });
  return { state, project, repositories };
}
const href = (repo: Repository, section = "releases") =>
  `/repositories/${repo.id}?workspace=${WORKSPACE}&section=${section}`;
for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`release evidence is readable and bounded at ${width} ${theme}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const { state, repositories } = await populated(page, request);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(href(repositories[0]));
      await expect
        .poll(() =>
          page
            .locator("html")
            .evaluate((element) => element.classList.contains("dark")),
        )
        .toBe(theme === "dark");
      await expect(
        page.getByRole("heading", { name: "Latest published release" }),
      ).toBeVisible();
      await expect(
        page.getByText("3 commits ahead", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Failed", { exact: true })).toBeVisible();
      await expect(page.getByText(/Newest 5 of 44 records/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Edit expectations" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Refresh evidence", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("link", { name: "Review commit comparison" }),
      ).toHaveAttribute(
        "href",
        `https://github.com/${repositories[0].fullName}/compare/${BASE}...${HEAD}`,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .include(".release-workspace")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(audit.violations).toEqual([]);
      await verifyFlatContrast(page, audit.incomplete);
      expect(errors).toEqual([]);
      const reads = state.calls.filter(
        (call) => call.name === "repository_releases",
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.length).toBeLessThanOrEqual(2);
      expect(
        reads.every((call) => call.input.repositoryId === repositories[0].id),
      ).toBe(true);
      expect(
        state.calls.some((call) =>
          /^(activity_feed|hooks_|monitoring_|workspace_snapshot)/.test(
            call.name,
          ),
        ),
      ).toBe(false);
      const views = state.calls.filter(
        (call) => call.name === "workspace_view",
      );
      expect(
        views.some((call) => call.input.view === "repository-releases"),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`releases-${width}-${theme}.png`),
        fullPage: true,
      });
    });
  }
test("project selection loads one repository at a time and supports keyboard navigation", async ({
  page,
  request,
}) => {
  const { state, project, repositories } = await populated(page, request);
  await page.goto(
    `/projects/${project.id}?workspace=${WORKSPACE}&section=releases`,
  );
  await expect(
    page.getByText("3 commits ahead", { exact: true }),
  ).toBeVisible();
  expect([
    ...new Set(
      state.calls
        .filter((call) => call.name === "repository_releases")
        .map((call) => call.input.repositoryId),
    ),
  ]).toEqual([repositories[0].id]);
  const selector = page.getByRole("combobox", {
    name: "Project release repository",
  });
  await selector.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: repositories[1].fullName, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp("releaseRepository=" + repositories[1].id),
  );
  await expect(selector).toBeFocused();
  await expect(
    page.getByText("3 commits ahead", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => [
      ...new Set(
        state.calls
          .filter((call) => call.name === "repository_releases")
          .map((call) => call.input.repositoryId),
      ),
    ])
    .toEqual([repositories[0].id, repositories[1].id]);
  await page
    .getByRole("link", { name: repositories[1].fullName, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: repositories[1].fullName }),
  ).toBeVisible();
  await expect(page).toHaveURL(/section=releases/);
  expect(state.calls.some((call) => call.name === "workspace_snapshot")).toBe(
    false,
  );
});
test("keeps partial and empty evidence distinct, without inventing deployment or release health", async ({
  page,
  request,
}) => {
  const { state, repositories } = await populated(page, request);
  state.result.evidence!.release.record = null;
  state.result.evidence!.comparison = {
    state: "unobserved",
    reason: "not_attempted",
    record: null,
  };
  state.result.evidence!.deployments = {
    state: "unavailable",
    reason: "permission",
    total: null,
    hasMore: false,
    records: [],
  };
  await page.goto(href(repositories[0]));
  await expect(
    page.getByText("No published stable release", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Review repository access and Deployments read permission/),
  ).toBeVisible();
  await expect(
    page.getByText("Comparison unavailable", { exact: true }),
  ).toBeVisible();
  state.result.evidence!.deployments = {
    state: "observed",
    reason: "complete",
    total: 0,
    hasMore: false,
    records: [],
  };
  await page.reload();
  await expect(
    page.getByText("No GitHub deployment records", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Deployments made outside GitHub's deployment integration/),
  ).toBeVisible();
});
test("explains stale evidence, budget waits, missing sources and failed reads", async ({
  page,
  request,
}) => {
  const { state, repositories } = await populated(page, request);
  state.result.evidence!.observedAt = new Date(
    Date.now() - 600000,
  ).toISOString();
  state.result.state = "waiting";
  await page.goto(href(repositories[0]));
  await expect(
    page.getByText("Evidence needs refresh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/bounded read budget or provider cooldown is active/),
  ).toBeVisible();
  state.rejectStatus = 503;
  await page.reload();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Synthetic release read unavailable" }),
  ).toBeVisible();
  state.sources = [];
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No GitHub source for this repository" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review GitHub connection" }),
  ).toBeVisible();
});

test("a failed refresh retains dated evidence but an access rejection hides it", async ({
  page,
  request,
}) => {
  const { state, repositories } = await populated(page, request);
  state.result.nextReadAt = new Date(Date.now() - 1000).toISOString();
  await page.goto(href(repositories[0]));
  await expect(
    page.getByText("3 commits ahead", { exact: true }),
  ).toBeVisible();
  state.rejectStatus = 503;
  await page
    .getByRole("button", { name: "Refresh evidence", exact: true })
    .click();
  await expect(
    page.getByText("Any evidence below belongs to the previous read."),
  ).toBeVisible();
  await expect(
    page.getByText("3 commits ahead", { exact: true }),
  ).toBeVisible();
  state.rejectStatus = 403;
  await page
    .getByRole("button", { name: "Retry release read", exact: true })
    .click();
  await expect(page.getByText("3 commits ahead", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("v1.0.0", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Any evidence below belongs to the previous read."),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Synthetic release read unavailable" }),
  ).toBeVisible();
});
