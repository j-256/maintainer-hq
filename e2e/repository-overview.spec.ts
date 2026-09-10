import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  type Connection,
  type Observation,
  type Project,
  type Repository,
} from "../shared/domain";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import {
  REPOSITORY_CONTEXT_LIMITS,
  type RepositoryContext,
} from "../shared/repository-context";
import type { ActivityFeed } from "../shared/activity";
import type { RepositoryCoverage } from "../shared/repository-coverage";
import { mockWorkspaceView } from "./workspace-fixture";
import { PUSH_LIMITS, type PushTopic } from "../shared/workspace-push";

const WORKSPACE = "development";
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
function calls(page: Page) {
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      requests.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  return requests;
}
async function createRepository(
  request: APIRequestContext,
  projectId = "development-default",
) {
  return api<Repository>(request, "repository_create", {
    repository: {
      fullName: "example/overview-" + crypto.randomUUID(),
      description: "A repository with an explicit operational context",
      projectId,
      classification: "watchlist",
      lifecycle: "active",
      expectations: {
        ...DEFAULT_EXPECTATIONS,
        note: "A deliberate exception, retained with the expectation review.",
      },
    },
  });
}
const detailHref = (repo: Repository, section = "overview") =>
  `/repositories/${repo.id}?workspace=${WORKSPACE}&section=${section}&q=overview&classification=watchlist&sort=updated&page=2`;

async function populated(page: Page, request: APIRequestContext) {
  const project = await api<Project>(request, "project_create", {
    name: "Demonstration services " + crypto.randomUUID().slice(0, 8),
    description: "Explicit project, not inferred",
  });
  const repo = await createRepository(request, project.id);
  const now = new Date().toISOString();
  const source: Connection = {
    id: "overview-github",
    name: "GitHub read-only source",
    provider: "github",
    repositoryIds: [repo.id],
    revision: 1,
    enabled: true,
    freshnessMinutes: 30,
    credentialConfigured: true,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastError: null,
  };
  const observation: Observation = {
    sourceId: source.id,
    resourceType: "repository",
    resourceId: repo.id,
    name: "Default branch evidence",
    provider: "github",
    health: "unknown",
    summary: "CI passing, security coverage incomplete",
    observedAt: now,
    receivedAt: now,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    details: {
      ci: "passing",
      openFindings: 0,
      github: {
        headSha: "a".repeat(40),
        defaultBranch: "main",
        checks: GITHUB_CHECK_KEYS.map((key) => ({
          key,
          state: key === "secretScanning" ? "unavailable" : "observed",
          count: 0,
          summary:
            key === "secretScanning"
              ? "Feature or permission unavailable"
              : "Observed",
        })),
      },
    },
  };
  const context: RepositoryContext = {
    repositoryId: repo.id,
    generatedAt: now,
    hooks: {
      total: 7,
      items: [
        {
          kind: "hook",
          connectionId: "hook-connection",
          connectionName: "Shared delivery connection",
          connectionEnabled: false,
          connectionRevision: 1,
          resourceKey:
            "subscription-with-a-long-name-to-check-wrapping-and-navigation",
          revision: 1,
          updatedAt: now,
          repositoryCount: 2,
        },
      ],
    },
    monitoring: {
      total: 1,
      items: [
        {
          kind: "monitor",
          connectionId: "monitor-connection",
          connectionName: "Service monitoring",
          connectionEnabled: true,
          connectionRevision: 1,
          resourceKey: "service-health",
          revision: 1,
          updatedAt: now,
          repositoryCount: 1,
        },
      ],
    },
    secrets: {
      total: 2,
      items: [
        {
          connectionId: "cloudflare",
          connectionName: "Cloudflare connection",
          connectionEnabled: true,
          resourceId: "worker",
          label: "Service Worker",
          providerKind: "cloudflare-workers",
          repositoryCount: 1,
          identityMatches: false,
        },
        {
          connectionId: "github-secrets",
          connectionName: "GitHub connection",
          connectionEnabled: false,
          resourceId: "actions",
          label: "Actions settings",
          providerKind: "github-actions",
          repositoryCount: 1,
          identityMatches: true,
        },
      ],
    },
  };
  const activity: ActivityFeed = {
    viewCursor: "synthetic-view",
    nextCursor: "older",
    groups: [
      {
        kind: "event",
        event: {
          id: "refresh-event",
          actor: "GitHub collector",
          type: "github.refresh.completed",
          title: "GitHub refresh completed: GitHub read-only source",
          summary: "CI changed. Secret scanning remains unavailable.",
          resourceId: null,
          goalId: null,
          createdAt: now,
          githubSourceId: source.id,
          githubRefreshId: "receipt",
          githubSourceName: source.name,
        },
      },
      {
        kind: "goal",
        goal: {
          id: "overview-goal",
          sourceId: "agent",
          actor: "Agent",
          objective:
            "A verbatim goal with enough context to preserve its entire objective while keeping the repository preview readable. ".repeat(
              5,
            ),
          status: "active",
          startedAt: now,
          reportedAt: now,
          receivedAt: now,
        },
        eventCount: 8,
        latestAt: now,
        eventsCursor: "goal-page",
      },
      {
        kind: "event",
        event: {
          id: "note",
          actor: "Maintainer",
          type: "update.note",
          title: "Reviewed repository expectations",
          summary: "The exception remains deliberate.",
          resourceId: repo.id,
          goalId: null,
          createdAt: now,
        },
      },
    ],
  };
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: [repo],
    projects: [project],
    connections: [source],
    observations: [observation],
  }));
  await page.route("**/api/commands/repository_context", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      workspaceId: WORKSPACE,
      repositoryId: repo.id,
    });
    return route.fulfill({ json: context });
  });
  const coverage: RepositoryCoverage = {
    repositoryId: repo.id,
    phase: "ready",
    nextReadAt: new Date(Date.parse(now) + 60_000).toISOString(),
    generatedAt: now,
    links: { hooks: 7, monitoring: 1 },
    evidence: [
      {
        connectionId: "monitor-connection",
        connectionName: "Service monitoring",
        kind: "monitor",
        observation: {
          sourceId: "monitor-connection",
          resourceId: repo.id,
          resourceType: "repository",
          name: repo.fullName,
          provider: "endpoint-monitor",
          health: "healthy",
          summary: "Linked monitoring check passed",
          observedAt: now,
          receivedAt: now,
          expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
          details: {
            coverage: {
              version: 1,
              connectionRevision: 1,
              readAt: now,
              freshUntil: new Date(Date.parse(now) + 60_000).toISOString(),
              complete: true,
              total: 1,
              resources: [
                {
                  resourceKey: "service-health",
                  state: "passing",
                  observedAt: now,
                  freshUntil: new Date(Date.parse(now) + 30_000).toISOString(),
                },
              ],
            },
          },
        },
      },
    ],
  };
  await page.route("**/api/commands/repository_coverage", (route) =>
    route.fulfill({ json: coverage }),
  );
  await page.route("**/api/commands/repository_coverage_get", (route) =>
    route.fulfill({ json: coverage }),
  );
  await page.route("**/api/commands/activity_feed", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      workspaceId: WORKSPACE,
      repositoryId: repo.id,
    });
    return route.fulfill({ json: activity });
  });
  return { repo, project, context, source, observation, activity, coverage };
}

for (const theme of ["light", "dark"])
  for (const width of [1280, 390]) {
    test(`compact repository overview is readable and keyboard accessible in ${theme} at ${width}`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      const fixture = await populated(page, request);
      const requests = calls(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(detailHref(fixture.repo));
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /dark/ : /^(?!.*dark)/,
      );
      await expect(
        page.getByRole("region", { name: "Observed evidence" }),
      ).toContainText("Passing");
      await expect(
        page.getByRole("region", { name: "Observed evidence" }),
      ).toContainText("Coverage incomplete");
      await page.locator(".repository-linked-details > summary").focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("region", { name: "Hooks preview" }),
      ).toContainText("Connection disabled");
      await expect(
        page.getByRole("region", { name: "Hooks preview" }),
      ).toContainText("7 linked");
      await expect(
        page.getByRole("region", { name: "Secrets preview" }),
      ).toContainText("Repository identity changed");
      await expect(
        page.getByRole("region", { name: "Secrets preview" }),
      ).toContainText("GitHub Actions");
      await expect(
        page.getByRole("region", { name: "Secrets preview" }),
      ).toContainText("Cloudflare Workers");
      await expect(
        page.getByRole("link", { name: "Open on GitHub" }),
      ).toHaveAttribute("href", "https://github.com/" + fixture.repo.fullName);
      await expect(
        page.getByRole("link", { name: fixture.project.name, exact: true }),
      ).toHaveAttribute("href", new RegExp("/projects/" + fixture.project.id));
      const preview = page.getByRole("region", {
        name: "Recent repository activity",
      });
      await expect(preview.locator("ol > li")).toHaveCount(
        REPOSITORY_CONTEXT_LIMITS.ACTIVITY_PREVIEW,
      );
      await expect(
        preview.getByRole("link", { name: "View refresh receipt" }),
      ).toHaveAttribute("href", /source=overview-github&refresh=receipt/);
      expect(
        await preview
          .locator(".repository-preview-description")
          .nth(1)
          .textContent(),
      ).toBe(
        fixture.activity.groups[1].kind === "goal"
          ? fixture.activity.groups[1].goal.objective
          : "",
      );
      await page
        .locator("summary")
        .filter({ hasText: "GitHub evidence details" })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByText("Feature or permission unavailable"),
      ).toBeVisible();
      await page
        .locator("summary")
        .filter({ hasText: "Maintainer context" })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByText(fixture.repo.expectations.note, { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.waitForLoadState("networkidle");
      const journalReads = requests.filter(
        (call) => call.name === "activity_feed",
      );
      expect(journalReads.length).toBeGreaterThan(0);
      expect(journalReads.length).toBeLessThanOrEqual(2);
      for (const read of journalReads)
        expect(read).toEqual({
          name: "activity_feed",
          input: expect.objectContaining({
            repositoryId: fixture.repo.id,
            limit: REPOSITORY_CONTEXT_LIMITS.ACTIVITY_PREVIEW,
          }),
        });
      const metadataReads = requests.filter(
        (call) => call.name === "repository_context",
      );
      expect(metadataReads.length).toBeGreaterThan(0);
      expect(metadataReads.length).toBeLessThanOrEqual(2);
      expect(requests.map((call) => call.name)).not.toEqual(
        expect.arrayContaining(["workspace_snapshot"]),
      );
      expect(
        requests.filter((call) =>
          /^(hooks_|monitoring_|secrets_)/.test(call.name),
        ),
      ).toEqual([]);
      expect(errors).toEqual([]);
      await page.locator(".repository-full-evidence > summary").click();
      await page.locator(".repository-linked-details > summary").click();
      await page.getByRole("heading", { level: 1 }).focus();
      await page.screenshot({
        path: testInfo.outputPath("overview.png"),
        fullPage: true,
      });
    });
  }

test("linked operational checks age locally, recover from read errors and open the exact management resource", async ({
  page,
  request,
}) => {
  await page.clock.install();
  const fixture = await populated(page, request);
  const requests = calls(page);
  await page.goto(detailHref(fixture.repo));
  const monitoring = page.getByRole("article", {
    name: "Endpoint monitoring coverage",
  });
  await expect(monitoring).toContainText("Coverage verified");
  const resource = monitoring.getByRole("link", {
    name: "service-health",
    exact: true,
  });
  await expect(resource).toHaveAttribute(
    "href",
    new RegExp("/monitoring\\?.*target=service-health"),
  );
  const refresh = page.getByRole("button", {
    name: "Check linked resources",
    exact: true,
  });
  await expect(refresh).toBeDisabled();
  await page.clock.fastForward(31_000);
  await expect(monitoring).toContainText("Coverage unverified");
  await expect(monitoring).toContainText("Last known: Check evidence expired");
  const before = requests.filter(
    (call) => call.name === "repository_coverage",
  ).length;
  await page.clock.fastForward(30_000);
  await expect(refresh).toBeEnabled();
  expect(
    requests.filter((call) => call.name === "repository_coverage"),
  ).toHaveLength(before);
  await page.route("**/api/commands/repository_coverage", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "unavailable", message: "Synthetic provider failure" },
      },
    }),
  );
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Operational evidence could not be refreshed" }),
  ).toBeVisible();
  await expect(monitoring).toContainText("Coverage unverified");
  expect(requests.map((call) => call.name)).not.toContain("workspace_snapshot");
});

test("missing operational coverage offers setup, not a setting that silently creates resources", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  const requests = calls(page);
  await page.goto(detailHref(repo));
  await expect(
    page.getByRole("article", { name: "Endpoint monitoring coverage" }),
  ).toContainText("No linked resources");
  await page
    .getByRole("link", { name: "Set up monitoring", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp("/monitoring\\?.*repository=" + repo.id),
  );
  expect(
    requests.some((call) => /(?:_save|_apply|_plan)$/.test(call.name)),
  ).toBe(false);
});

test("accepted operational push converges through a cache-only retry without another provider check or a lost draft", async ({
  page,
  request,
}) => {
  const fixture = await populated(page, request);
  const accepted = structuredClone(fixture.coverage);
  accepted.generatedAt = new Date(
    Date.parse(accepted.generatedAt) + 1000,
  ).toISOString();
  fixture.coverage.phase = "pending";
  fixture.coverage.evidence = [];
  let savedResult = fixture.coverage;
  let failedRead = false;
  await page.route("**/api/commands/repository_coverage_get", (route) =>
    route.fulfill(
      failedRead
        ? {
            status: 503,
            json: {
              error: {
                code: "unavailable",
                message: "Synthetic retained read failure",
              },
            },
          }
        : { json: savedResult },
    ),
  );
  let sendUpdate: (
    observations: Observation[],
    topics?: PushTopic[],
  ) => void = () => {
    throw new Error("Synthetic socket is not ready");
  };
  await page.routeWebSocket("**/api/events?*", (socket) => {
    const parameters = new URL(socket.url()).searchParams;
    let cursor = Number(parameters.get("cursor"));
    let revision = 1;
    const scope = {
      view: parameters.get("view"),
      repositoryId: parameters.get("repositoryId"),
    };
    const frame = (
      type: "ready" | "update",
      observations: Observation[],
      topics: PushTopic[],
    ) => ({
      version: 2,
      workspaceId: WORKSPACE,
      type,
      revision: revision++,
      scope,
      topics,
      ...(type === "ready"
        ? { expiresAt: Date.now() + PUSH_LIMITS.CONNECTION_MS }
        : {}),
      update: {
        type: "delta",
        from: cursor,
        cursor: type === "ready" ? cursor : ++cursor,
        generatedAt: new Date().toISOString(),
        upserts: observations.length ? { observations } : {},
        removals: [],
      },
    });
    socket.send(JSON.stringify(frame("ready", [], [])));
    socket.onMessage((message) => {
      if (message === PUSH_LIMITS.PING) socket.send(PUSH_LIMITS.PONG);
    });
    sendUpdate = (observations, topics = ["sources"]) =>
      socket.send(JSON.stringify(frame("update", observations, topics)));
  });
  const requests = calls(page);
  await page.goto(detailHref(fixture.repo));
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await expect(
    page.getByText("Another check is in progress.", { exact: false }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  const providerReads = () =>
    requests.filter((call) => call.name === "repository_coverage").length;
  const retainedReads = () =>
    requests.filter((call) => call.name === "repository_coverage_get").length;
  const initialProviderReads = providerReads();
  const initialRetainedReads = retainedReads();
  await page
    .getByRole("button", { name: "Edit expectations", exact: true })
    .click();
  const draft = page
    .getByRole("dialog")
    .getByLabel("Description", { exact: true });
  await draft.fill("Keep the unsaved assessment context");
  savedResult = accepted;
  failedRead = true;
  sendUpdate([accepted.evidence[0]!.observation]);
  await expect(page.locator(".repository-operational-checks")).toContainText(
    "HQ's saved result could not be read",
  );
  await expect(draft).toHaveValue("Keep the unsaved assessment context");
  expect(providerReads()).toBe(initialProviderReads);
  expect(retainedReads()).toBe(initialRetainedReads + 1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit expectations", exact: true }),
  ).toBeFocused();
  failedRead = false;
  const retry = page.getByRole("button", {
    name: "Retry saved result",
    exact: true,
  });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("article", { name: "Endpoint monitoring coverage" }),
  ).toContainText("Coverage verified");
  await expect(
    page.getByText("Another check is in progress.", { exact: false }),
  ).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Operational checks", exact: true }),
  ).toBeFocused();
  expect(providerReads()).toBe(initialProviderReads);
  expect(retainedReads()).toBe(initialRetainedReads + 2);
  savedResult = structuredClone(accepted);
  savedResult.generatedAt = new Date(
    Date.parse(accepted.generatedAt) + 1000,
  ).toISOString();
  const changed = savedResult.evidence[0]!.observation;
  changed.receivedAt = savedResult.generatedAt;
  changed.health = "warning";
  changed.details.coverage.resources[0]!.state = "failing";
  sendUpdate([changed]);
  await expect(
    page.getByRole("article", { name: "Endpoint monitoring coverage" }),
  ).toContainText("Needs attention");
  expect(providerReads()).toBe(initialProviderReads);
  expect(retainedReads()).toBe(initialRetainedReads + 3);
  failedRead = true;
  changed.expiresAt = new Date(0).toISOString();
  sendUpdate([changed]);
  await expect(page.locator(".repository-operational-checks")).toContainText(
    "HQ's saved result could not be read",
  );
  await expect(
    page.getByRole("article", { name: "Endpoint monitoring coverage" }),
  ).toContainText("Coverage unverified");
  await expect(
    page.getByRole("article", { name: "Endpoint monitoring coverage" }),
  ).toContainText("Last known:");
  await expect(
    page.getByText("Another check is in progress.", { exact: false }),
  ).toHaveCount(0);
  expect(providerReads()).toBe(initialProviderReads);
  expect(retainedReads()).toBe(initialRetainedReads + 4);
  const settled = requests.length;
  sendUpdate([{ ...fixture.observation, receivedAt: accepted.generatedAt }]);
  sendUpdate([], ["activity"]);
  await expect
    .poll(() => requests.slice(settled).map((call) => call.name))
    .toEqual(["activity_feed"]);
  await page.waitForLoadState("networkidle");
  expect(requests.slice(settled).map((call) => call.name)).toEqual([
    "activity_feed",
  ]);
  expect(requests.map((call) => call.name)).not.toContain("workspace_snapshot");
});

test("overview loads only while visible, keeps inventory return context, and does not fetch provider inventory", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  const requests = calls(page);
  await page.goto(detailHref(repo, "hooks"));
  await expect(
    page.getByRole("heading", { name: "Hooks", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(
    requests.some((call) =>
      [
        "repository_context",
        "repository_coverage",
        "repository_coverage_get",
        "activity_feed",
      ].includes(call.name),
    ),
  ).toBe(false);
  await page
    .getByRole("navigation", { name: "Repository sections" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await page.locator(".repository-linked-details > summary").click();
  await expect(
    page.getByRole("region", { name: "Hooks preview" }),
  ).toContainText("No resources linked");
  await expect(page.getByRole("link", { name: "Open on GitHub" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Observed evidence" }),
  ).toContainText("Not configured");
  await page.waitForLoadState("networkidle");
  const contexts = requests.filter(
    (call) => call.name === "repository_context",
  ).length;
  await page
    .getByRole("link", { name: "View all repository monitoring" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Monitoring", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/q=overview/);
  await page.waitForLoadState("networkidle");
  expect(
    requests.filter((call) => call.name === "repository_context"),
  ).toHaveLength(contexts);
  await page.locator(".back-link").click();
  await expect(
    page.getByRole("textbox", { name: "Search repositories" }),
  ).toHaveValue("overview");
  await expect(page).toHaveURL(/classification=watchlist/);
  await page.goBack();
  await expect(page).toHaveURL(/section=monitoring/);
  expect(requests.map((call) => call.name)).not.toContain("workspace_snapshot");
});

test("failed metadata and journal reads have independent explicit recovery", async ({
  page,
  request,
}) => {
  const fixture = await populated(page, request);
  const requests = calls(page);
  let fail = true;
  await page.route("**/api/commands/repository_context", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: {
            error: { code: "unavailable", message: "Synthetic read failure" },
          },
        })
      : route.fulfill({ json: fixture.context }),
  );
  await page.goto(detailHref(fixture.repo));
  await expect(
    page.getByRole("button", { name: "Retry resource links" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Recent repository activity" }),
  ).toContainText("Reviewed repository expectations");
  await page.waitForLoadState("networkidle");
  expect(
    requests.filter((call) => call.name === "repository_context").length,
  ).toBeLessThanOrEqual(2);
  const journalCalls = requests.filter(
    (call) => call.name === "activity_feed",
  ).length;
  fail = false;
  await page.getByRole("button", { name: "Retry resource links" }).click();
  await page.locator(".repository-linked-details > summary").click();
  await expect(
    page.getByRole("region", { name: "Hooks preview" }),
  ).toContainText("7 linked");
  expect(requests.filter((call) => call.name === "activity_feed")).toHaveLength(
    journalCalls,
  );
  await page.route("**/api/commands/activity_feed", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "unavailable", message: "Synthetic journal failure" },
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry activity", exact: true }),
  ).toBeVisible();
  await page.locator(".repository-linked-details > summary").click();
  await expect(
    page.getByRole("region", { name: "Monitoring preview" }),
  ).toContainText("service-health");
});

test("real push updates the bounded journal without re-reading metadata or losing an expectation draft", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  const requests = calls(page);
  await page.goto(detailHref(repo));
  await expect(
    page.getByRole("region", { name: "Recent repository activity" }),
  ).toBeVisible();
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  const initial = requests.length;
  const edit = page.getByRole("button", {
    name: "Edit expectations",
    exact: true,
  });
  await edit.click();
  const description = page
    .getByRole("dialog")
    .getByLabel("Description", { exact: true });
  await description.fill(
    "Preserve this draft while evidence and Activity arrive",
  );
  const title = "Relevant repository progress " + crypto.randomUUID();
  await api(request, "activity_add", {
    eventId: crypto.randomUUID(),
    kind: "progress",
    title,
    summary: "An explicitly repository-scoped update",
    resourceId: repo.id,
  });
  await expect(page.locator(".repository-recent-activity")).toContainText(
    title,
  );
  await expect(description).toHaveValue(
    "Preserve this draft while evidence and Activity arrive",
  );
  expect(requests.slice(initial).map((call) => call.name)).toEqual([
    "activity_feed",
  ]);
  const {
    id: _id,
    workspaceId: _workspace,
    updatedAt: _time,
    revision: _revision,
    ...fields
  } = repo;
  await api(request, "repository_update", {
    repositoryId: repo.id,
    revision: repo.revision,
    repository: { ...fields, description: "Concurrent saved change" },
  });
  await expect(page.locator(".repository-heading")).toContainText(
    "Concurrent saved change",
  );
  await expect(description).toHaveValue(
    "Preserve this draft while evidence and Activity arrive",
  );
  expect(requests.map((call) => call.name)).not.toContain("workspace_snapshot");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(edit).toBeFocused();
});
