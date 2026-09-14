import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  CAPABILITY,
  type Repository,
} from "../shared/domain";
import {
  mockMonitoring,
  MONITOR_REPOSITORIES,
  MONITOR_TARGET,
} from "./monitoring-fixture";
import { coverageFixture } from "./github-coverage-fixture";
import { mockWorkspaceView } from "./workspace-fixture";
const repositoryUrl = (id: string, kind?: string) =>
  "/repositories/" +
  id +
  "?workspace=development&dialog=expectations" +
  (kind ? "&resolve=" + kind : "");
async function monitoring(page: Page, viewer = false) {
  const state = await mockMonitoring(page, { viewer });
  state.links.get("monitor/" + MONITOR_TARGET.id)!.repositoryIds = [];
  await page.route(/\/api\/commands\/repository_coverage(?:_get)?$/, (route) =>
    route.fulfill({
      json: {
        repositoryId: MONITOR_REPOSITORIES[0]!.id,
        phase: "ready",
        nextReadAt: null,
        generatedAt: new Date().toISOString(),
        links: {
          hooks: 0,
          monitoring: [...state.links.values()].filter(
            (item) =>
              item.kind === "monitor" &&
              item.repositoryIds.includes(MONITOR_REPOSITORIES[0]!.id),
          ).length,
        },
        evidence: [],
      },
    }),
  );
  return state;
}
async function github(page: Page, viewer = false) {
  const fixture = coverageFixture();
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    connections: fixture.sources,
    repositories: fixture.repositories,
    observations: fixture.observations,
    ...(viewer
      ? {
          capabilities: [CAPABILITY.READ],
          workspace: { ...snapshot.workspace, role: "viewer" as const },
        }
      : {}),
  }));
  await page.route("**/api/commands/github_coverage", (route) =>
    route.fulfill({ json: fixture.response(route.request().postDataJSON()) }),
  );
  await page.route("**/api/commands/github_credentials_list", (route) =>
    route.fulfill({
      json: [{ id: "synthetic-read-only", name: "Synthetic read access" }],
    }),
  );
  return fixture;
}
async function createRepository(request: APIRequestContext) {
  const response = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: "development",
      repository: {
        fullName: "synthetic/" + crypto.randomUUID(),
        description: "Original description",
        projectId: "development-default",
        classification: "maintained",
        lifecycle: "active",
        expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2026-01-01" },
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as Repository;
}
test("links monitoring from an expectation draft and retains it through browser Back", async ({
  page,
}) => {
  const state = await monitoring(page);
  await page.goto(repositoryUrl(MONITOR_REPOSITORIES[0]!.id));
  await page
    .getByLabel("Description", { exact: true })
    .fill("Kept monitoring draft");
  await page
    .getByRole("button", {
      name: "Set up monitoring for Endpoint monitoring",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Link monitor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Linked to repository", exact: true }),
  ).toBeDisabled();
  expect(
    state.links.get("monitor/" + MONITOR_TARGET.id)!.repositoryIds,
  ).toEqual([MONITOR_REPOSITORIES[0]!.id]);
  await page.goBack();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Kept monitoring draft",
  );
});
test("creates a monitor with an addressable review and separates acceptance from coverage", async ({
  page,
}) => {
  const state = await monitoring(page);
  await page.goto(repositoryUrl(MONITOR_REPOSITORIES[0]!.id, "monitoring"));
  await page
    .getByRole("button", { name: "Create monitor", exact: true })
    .click();
  await page.getByLabel("Target ID", { exact: true }).fill("new-target");
  await page
    .getByLabel("Endpoint URL", { exact: true })
    .fill("https://example.com/status");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm change", exact: true }),
  ).toBeEnabled();
  expect(new URL(page.url()).searchParams.get("monitorReview")).toBe(
    state.review!.id,
  );
  const saved = page.url();
  state.rejectRead = true;
  await page.reload();
  expect(page.url()).toBe(saved);
  await page
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "not a health confirmation",
  );
  expect(state.applies).toBe(1);
  state.rejectRead = false;
  await page
    .getByRole("button", { name: "Close receipt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "After creating a target",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "No retained probe evidence",
  );
  await expect(page.getByRole("dialog")).not.toContainText(
    "Monitoring verified",
  );
});
test("keeps a monitor edit when navigation is cancelled and preserves uncertain receipt recovery", async ({
  page,
}) => {
  const state = await monitoring(page);
  state.loseApplyResponse = true;
  await page.goto(repositoryUrl(MONITOR_REPOSITORIES[0]!.id, "monitoring"));
  await page.getByRole("button", { name: "Edit monitor", exact: true }).click();
  await page
    .getByLabel("Endpoint URL", { exact: true })
    .fill("https://example.com/changed");
  await page.goBack();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Endpoint URL", { exact: true })).toHaveValue(
    "https://example.com/changed",
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reconcile with provider", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Reconcile with provider", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "not endpoint health",
  );
  expect(state.applies).toBe(1);
});
test("uses the GitHub connection and provider actions without losing the expectation draft", async ({
  page,
}) => {
  const fixture = await github(page);
  const repo = fixture.repositories[0]!;
  await page.goto(repositoryUrl(repo.id));
  await page
    .getByLabel("Description", { exact: true })
    .fill("GitHub draft retained");
  await page
    .getByRole("button", { name: /for Continuous integration$/ })
    .click();
  await expect(
    page.getByRole("link", { name: "Set up a workflow", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/" + repo.fullName + "/actions/new",
  );
  await expect(
    page.getByRole("link", { name: "Set up a workflow", exact: true }),
  ).toHaveAttribute("target", "_blank");
  await page
    .getByRole("button", { name: "Edit GitHub connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("GitHub");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "GitHub draft retained",
  );
});
test("starts GitHub enrollment in repository context and preserves an existing connection scope", async ({
  page,
}) => {
  const fixture = await github(page);
  const repo = fixture.repositories[5]!;
  const original = [...fixture.sources[0]!.repositoryIds];
  let saved: string[] = [];
  await page.route("**/api/commands/github_source_update", (route) => {
    const fields = route.request().postDataJSON();
    saved = fields.source.repositoryIds;
    fixture.sources[0] = {
      ...fixture.sources[0]!,
      ...fields.source,
      revision: fixture.sources[0]!.revision + 1,
    };
    return route.fulfill({ json: fixture.sources[0] });
  });
  await page.goto(repositoryUrl(repo.id, "ci"));
  await page
    .getByRole("combobox", { name: "GitHub connection", exact: true })
    .click();
  await page
    .getByRole("option", { name: /GitHub - selected service repositories/ })
    .click();
  await page
    .getByRole("button", { name: "Add repository to connection", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect(saved).toEqual([...original, repo.id]);
  await expect(
    page.getByRole("button", { name: "Edit GitHub connection", exact: true }),
  ).toBeVisible();
});
test("records a review and reconciles its date into an unsaved expectation draft", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  await page.goto(repositoryUrl(repo.id));
  await page
    .getByLabel("Description", { exact: true })
    .fill("Unrelated draft kept");
  await page
    .locator("summary")
    .filter({ hasText: "Review and maintainer context" })
    .click();
  await page
    .getByRole("button", {
      name: "Complete review for Repository review",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Review outcome", { exact: true })
    .fill("Checked requirements and recorded follow-up work");
  await page
    .getByLabel("Next review date (optional)", { exact: true })
    .fill("2099-01-01");
  await page
    .getByRole("button", { name: "Complete review", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Review completed");
  expect(new URL(page.url()).searchParams.get("completedReview")).toBeTruthy();
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Unrelated draft kept",
  );
  await expect(
    page.getByLabel("Review by (UTC date)", { exact: true }),
  ).toHaveValue("2099-01-01");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const result = await request.post("/api/commands/repository_get", {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: "development", repositoryId: repo.id },
  });
  expect(await result.json()).toMatchObject({
    description: "Unrelated draft kept",
    expectations: { reviewDate: "2099-01-01" },
  });
});
test("recovers completed review after a lost response and reload", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  let writes = 0;
  await page.route(
    "**/api/commands/expectation_review_complete",
    async (route) => {
      writes++;
      await route.fetch();
      await route.abort("failed");
    },
  );
  await page.goto(repositoryUrl(repo.id, "review"));
  await page
    .getByLabel("Review outcome", { exact: true })
    .fill("Outcome persisted before interrupted response");
  await page
    .getByRole("button", { name: "Complete review", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Review completed");
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText(
    "Outcome persisted before interrupted response",
  );
  expect(writes).toBe(1);
});
test("creates a GitHub connection and keeps its new identity in the resolution URL", async ({
  page,
}) => {
  const fixture = await github(page);
  const repo = fixture.repositories[5]!;
  let sourceId = "";
  await page.route("**/api/commands/github_source_enroll", (route) => {
    const fields = route.request().postDataJSON();
    sourceId = fields.sourceId;
    const source = {
      ...fixture.sources[0]!,
      ...fields.source,
      id: sourceId,
      revision: 1,
      github: {
        ...fixture.sources[0]!.github,
        credentialRef: fields.source.credentialRef,
      },
    };
    expect(source.repositoryIds).toEqual([repo.id]);
    fixture.sources.push(source);
    return route.fulfill({ json: source });
  });
  await page.goto(repositoryUrl(repo.id, "ci"));
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("New repository connection");
  await page
    .getByRole("combobox", { name: "Server-side credential", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Synthetic read access", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit GitHub connection", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("githubSource")).toBe(sourceId);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "GitHub connection", exact: true }),
  ).toContainText("New repository connection");
});

test("resolves multiple expectations from a bulk draft and applies against a completed review", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  await page.goto(
    "/projects/development-default?workspace=development&section=repositories",
  );
  await page
    .getByRole("button", { name: "Set expectations", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Find repositories to change" })
    .fill(repo.fullName);
  await page
    .getByRole("checkbox", { name: repo.fullName + " Maintained", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Choose changes", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Change Continuous integration",
      exact: true,
    })
    .check();
  await page
    .getByRole("combobox", { name: "Continuous integration", exact: true })
    .click();
  await page.getByRole("option", { name: "Optional", exact: true }).click();
  await page
    .getByRole("button", { name: "Resolve expectations", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.get("resolveRepository")).toBe(
    repo.id,
  );
  await page
    .getByRole("button", { name: /for Continuous integration$/ })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Expected: Optional");
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Continuous integration", exact: true }),
  ).toContainText("Optional");
  await page
    .getByRole("button", { name: "Resolve expectations", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Complete review for Repository review",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Review outcome", { exact: true })
    .fill("Reviewed CI requirement during bulk editing");
  await page
    .getByLabel("Next review date (optional)", { exact: true })
    .fill("2099-01-01");
  await page
    .getByRole("button", { name: "Complete review", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Review completed");
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply to 1 repository", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Changes saved.");
  const response = await request.post("/api/commands/repository_get", {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: "development", repositoryId: repo.id },
  });
  expect(await response.json()).toMatchObject({
    expectations: { ci: "optional", reviewDate: "2099-01-01" },
  });
});

test("receives a late review completion through push after an unavailable receipt", async ({
  page,
  request,
}) => {
  const repo = await createRepository(request);
  let fields: Record<string, unknown> | null = null;
  let writes = 0;
  await page.route(
    "**/api/commands/expectation_review_complete",
    async (route) => {
      fields = route.request().postDataJSON();
      writes++;
      await route.abort("failed");
    },
  );
  await page.goto(repositoryUrl(repo.id, "review"));
  await page
    .getByLabel("Review outcome", { exact: true })
    .fill("Delayed completion receipt");
  await page
    .getByRole("button", { name: "Complete review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Completion not confirmed",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete review", exact: true }),
  ).toBeDisabled();
  const response = await request.post(
    "/api/commands/expectation_review_complete",
    {
      headers: { "X-HQ-Client": "cli" },
      data: fields,
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Review completed", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test("a direct monitor editor link explains failed connection reads and recovers", async ({
  page,
}) => {
  const state = await monitoring(page);
  let fail = true;
  await page.route("**/api/commands/monitoring_connections", (route) =>
    route.fulfill(
      fail
        ? {
            status: 503,
            json: {
              error: {
                code: "unavailable",
                message: "Synthetic connection read failure",
              },
            },
          }
        : { json: state.connections },
    ),
  );
  await page.goto(
    repositoryUrl(MONITOR_REPOSITORIES[0]!.id, "monitoring") +
      "&connection=" +
      state.connections[0]!.id +
      "&monitorTarget=%3Acreate",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Synthetic connection read failure",
  );
  fail = false;
  await page
    .getByRole("button", { name: "Retry connection read", exact: true })
    .click();
  await expect(page.getByLabel("Endpoint URL", { exact: true })).toBeVisible();
});

for (const theme of ["light", "dark"])
  for (const width of [390, 1440])
    test(`expectation resolution is accessible and usable in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const fixture = await github(page, true);
      for (const kind of ["ci", "security", "visibility", "review"]) {
        await page.goto(repositoryUrl(fixture.repositories[0]!.id, kind));
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.evaluate(async (element) => {
          await Promise.all(
            element
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        expect(
          (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
            .violations,
        ).toEqual([]);
        expect(
          await dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await page.keyboard.press("Tab");
        expect(
          await dialog.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(true);
        if (kind === "review")
          await expect(
            page.getByRole("button", { name: "Complete review", exact: true }),
          ).toBeDisabled();
        else
          await expect(
            page.getByRole("button", {
              name: "Refresh GitHub evidence",
              exact: true,
            }),
          ).toBeDisabled();
      }
      await monitoring(page, true);
      await page.goto(repositoryUrl(MONITOR_REPOSITORIES[0]!.id, "monitoring"));
      const monitor = page.getByRole("dialog");
      await expect(
        page.getByRole("button", { name: "Link monitor", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Create monitor", exact: true }),
      ).toBeDisabled();
      await monitor.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      expect(
        await monitor.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.keyboard.press("Tab");
      expect(
        await monitor.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`monitoring-${theme}-${width}.png`),
      });
    });
