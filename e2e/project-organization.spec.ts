import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { verifyFlatContrast } from "./flat-contrast";
import {
  newOrganizationProject,
  type ProjectOrganizationReview,
} from "../shared/project-organization";
import {
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  projectFields,
  repositoryFields,
  type Project,
  type Repository,
} from "../shared/domain";

const WORKSPACE = "organization-test";
const BASE = "/projects?workspace=" + WORKSPACE;
const DEFAULT_PROJECT = "organization-default";
const REPOSITORIES = 52;
async function command<T>(
  request: APIRequestContext,
  name: string,
  data: object = {},
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function open(page: Page) {
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Organize repositories", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function selectTwo(page: Page) {
  for (const suffix of ["00", "01"])
    await page
      .getByRole("checkbox", {
        name: new RegExp("^example/organize-" + suffix + " "),
      })
      .check();
  await page
    .getByRole("button", { name: "Choose projects", exact: true })
    .click();
}
async function newShared(page: Page) {
  await selectTwo(page);
  await choose(page, "Group all selected repositories", "Create a new project");
  const name = "Shared project " + crypto.randomUUID().slice(0, 8);
  await page
    .getByRole("textbox", { name: "New project name", exact: true })
    .fill(name);
  return name;
}
async function review(page: Page) {
  await page
    .getByRole("button", { name: "Review organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Review project organization",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Apply organization", exact: true }),
  ).toBeEnabled();
}
async function audit(page: Page, dialog = true) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState !== "idle" &&
                animation.playState !== "finished" &&
                animation.effect?.getComputedTiming().endTime !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  const builder = new AxeBuilder({ page });
  const result = await (
    dialog ? builder.include(".organization-dialog") : builder
  ).analyze();
  expect(result.violations).toEqual([]);
  await verifyFlatContrast(page, result.incomplete);
}
test.beforeAll(async ({ request }) => {
  const projects = await command<Project[]>(request, "projects_list");
  if (!projects.some((project) => project.name === "Existing target"))
    await command(request, "project_create", {
      name: "Existing target",
      description: "Preserve project description",
      importance: "critical",
      importanceNote: "Keep importance context",
      portfolio: {
        ...DEFAULT_PORTFOLIO,
        status: "listed",
        url: "https://example.com/portfolio",
      },
    });
  const repos = await command<Repository[]>(request, "repositories_list");
  for (let i = 0; i < REPOSITORIES; i++) {
    const fullName = "example/organize-" + String(i).padStart(2, "0");
    if (!repos.some((repo) => repo.fullName === fullName))
      await command(request, "repository_create", {
        repository: {
          fullName,
          description: "Keep repository description",
          projectId: DEFAULT_PROJECT,
          classification: i % 2 ? "watchlist" : "maintained",
          lifecycle: i >= 50 ? "archived" : "active",
          expectations: {
            ...DEFAULT_EXPECTATIONS,
            note: "Keep repository expectations",
          },
        },
      });
  }
});
test.beforeEach(async ({ request }) => {
  const repos = await command<Repository[]>(request, "repositories_list");
  for (const repo of repos.filter((row) =>
    /organize-0[01]$/.test(row.fullName),
  ))
    await command(request, "repository_update", {
      repositoryId: repo.id,
      revision: repo.revision,
      repository: {
        ...repositoryFields.strip().parse(repo),
        projectId: DEFAULT_PROJECT,
      },
    });
  const project = (await command<Project[]>(request, "projects_list")).find(
    (project) => project.name === "Existing target",
  )!;
  await command(request, "project_update", {
    projectId: project.id,
    revision: project.revision,
    project: {
      ...projectFields.strip().parse(project),
      importance: "critical",
      importanceNote: "Keep importance context",
      portfolio: {
        ...DEFAULT_PORTFOLIO,
        status: "listed",
        url: "https://example.com/portfolio",
      },
    },
  });
});

test("suggestions are unselected, bounded and preserved across selection filters and pages", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("button", { name: "Choose projects", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Select this page", exact: true })
    .click();
  await expect(
    page.getByText("25 of 50 selected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Organization selection pages" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select this page", exact: true })
    .click();
  await expect(
    page.getByText("50 of 50 selected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Include archived repositories",
      exact: true,
    })
    .check();
  const pages = page.getByRole("navigation", {
    name: "Organization selection pages",
  });
  await pages.getByRole("button", { name: "Next", exact: true }).click();
  await pages.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select this page", exact: true }),
  ).toBeDisabled();
  for (const box of await page
    .getByRole("list", { name: "Repositories to organize" })
    .getByRole("checkbox")
    .all())
    await expect(box).toBeDisabled();
  await page
    .getByRole("textbox", {
      name: "Find repositories to organize",
      exact: true,
    })
    .fill("no-match");
  await expect(
    page.getByText("50 of 50 selected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No repositories match these filters.", { exact: true }),
  ).toBeVisible();
});

test("shared project creation owns one set of priorities and preserves unrelated repository metadata", async ({
  page,
  request,
}) => {
  const before = await command<Repository[]>(request, "repositories_list");
  await open(page);
  const name = await newShared(page);
  await expect(
    page.getByRole("textbox", { name: "New project name", exact: true }),
  ).toHaveCount(1);
  await page.locator(".organization-row summary").click();
  await choose(page, "Importance", "High");
  await choose(page, "Portfolio inclusion", "Excluded");
  await expect(
    page.getByRole("button", { name: "Review organization", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Portfolio reason (required)", exact: true })
    .fill("Internal tools");
  await review(page);
  await expect(page.getByRole("dialog")).toContainText("Internal tools");
  const url = page.url();
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  const project = (await command<Project[]>(request, "projects_list")).find(
    (project) => project.name === name,
  )!;
  expect(project).toMatchObject({
    importance: "high",
    portfolio: { status: "excluded", reason: "Internal tools" },
    description: "",
  });
  const after = await command<Repository[]>(request, "repositories_list");
  for (const original of before.filter((repo) =>
    /organize-0[01]$/.test(repo.fullName),
  )) {
    const saved = after.find((repo) => repo.id === original.id)!;
    expect(saved.projectId).toBe(project.id);
    expect(saved.expectations).toEqual(original.expectations);
    expect(saved.description).toBe(original.description);
    expect(saved.classification).toBe(original.classification);
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(url);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Organize repositories", exact: true }),
  ).toBeFocused();
});

test("linking an existing project does not reset its Importance or Portfolio", async ({
  page,
  request,
}) => {
  const before = (await command<Project[]>(request, "projects_list")).find(
    (project) => project.name === "Existing target",
  )!;
  await open(page);
  await selectTwo(page);
  await choose(page, "Group all selected repositories", "Existing target");
  await expect(
    page.getByRole("textbox", { name: "New project name", exact: true }),
  ).toHaveCount(0);
  await review(page);
  await expect(page.getByRole("dialog")).toContainText(
    "Keep existing project decisions. No metadata change.",
  );
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  expect(
    (await command<Project[]>(request, "projects_list")).find(
      (project) => project.id === before.id,
    ),
  ).toEqual(before);
});

test("assignment pages retain the complete selected review", async ({
  page,
  request,
}) => {
  const before = await command<Repository[]>(request, "repositories_list");
  await open(page);
  await page
    .getByRole("button", { name: "Select this page", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose projects", exact: true })
    .click();
  await expect(page.locator(".organization-assignment")).toHaveCount(10);
  const assignmentPages = page.getByRole("navigation", {
    name: "Assignment pages",
    exact: true,
  });
  await assignmentPages
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(assignmentPages).toContainText("11 to 20 of 25");
  await expect(
    page.getByRole("heading", { name: "Repository assignments", exact: true }),
  ).toBeFocused();
  await choose(page, "Group all selected repositories", "Create a new project");
  const name = "Paged decision " + crypto.randomUUID().slice(0, 8);
  await page
    .getByRole("textbox", { name: "New project name", exact: true })
    .fill(name);
  await review(page);
  await expect(assignmentPages).toContainText("1 to 10 of 25");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const planId = new URL(page.url()).searchParams.get("organizationReview")!;
  const saved = await command<ProjectOrganizationReview>(
    request,
    "projects_organize_review",
    { planId },
  );
  expect(saved.repositories).toHaveLength(25);
  expect(saved.projects).toHaveLength(1);
  expect(saved.projects.some((project) => project.after.name === name)).toBe(
    true,
  );
  expect(await command<Repository[]>(request, "repositories_list")).toEqual(
    before,
  );
});

test("a CLI-created review with custom target keys reopens as editable project choices", async ({
  page,
  request,
}) => {
  const repos = (
    await command<Repository[]>(request, "repositories_list")
  ).filter((repo) => /organize-0[01]$/.test(repo.fullName));
  const existing = (await command<Project[]>(request, "projects_list")).find(
    (project) => project.name === "Existing target",
  )!;
  const name = "CLI draft " + crypto.randomUUID().slice(0, 8);
  const initial = await command<ProjectOrganizationReview>(
    request,
    "projects_organize_plan",
    {
      repositories: repos.map((repo, index) => ({
        repositoryId: repo.id,
        revision: repo.revision,
        targetKey: index ? "client-new" : "client-existing",
      })),
      targets: [
        {
          key: "client-existing",
          kind: "existing",
          projectId: existing.id,
          revision: existing.revision,
          patch: {},
        },
        {
          key: "client-new",
          kind: "new",
          project: newOrganizationProject(name),
        },
      ],
    },
  );
  await page.goto(BASE + "&organizationReview=" + initial.planId);
  await page
    .getByRole("button", { name: "Back to choices", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", {
      name: "Project for " + repos[0]!.fullName,
      exact: true,
    }),
  ).toContainText(existing.name);
  await expect(
    page.getByRole("combobox", {
      name: "Project for " + repos[1]!.fullName,
      exact: true,
    }),
  ).toContainText(name);
  await choose(page, "Group all selected repositories", existing.name);
  await review(page);
  await expect(page.getByRole("dialog")).toContainText(
    "Keep existing project decisions. No metadata change.",
  );
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  expect(
    (await command<Project[]>(request, "projects_list")).find(
      (project) => project.id === existing.id,
    ),
  ).toEqual(existing);
  expect(
    (await command<Project[]>(request, "projects_list")).some(
      (project) => project.name === name,
    ),
  ).toBe(false);
});

test("an unconfirmed Apply survives reload and retries only the original review", async ({
  page,
  request,
}) => {
  await open(page);
  const name = await newShared(page);
  await review(page);
  const url = page.url();
  await page.route("**/api/commands/projects_organize_apply", (route) =>
    route.abort(),
  );
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Back to choices", exact: true }),
  ).toBeDisabled();
  await expect(page).toHaveURL(url);
  await page.unroute("**/api/commands/projects_organize_apply");
  await page
    .getByRole("button", { name: "Retry same review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  expect(
    (await command<Project[]>(request, "projects_list")).filter(
      (project) => project.name === name,
    ),
  ).toHaveLength(1);
});

for (const state of ["stale", "expired"] as const)
  test(`an unconfirmed Apply retains its recovery identity after a ${state} review read`, async ({
    page,
  }) => {
    await open(page);
    await newShared(page);
    await review(page);
    const url = page.url();
    await page.route("**/api/commands/projects_organize_apply", (route) =>
      route.abort(),
    );
    await page
      .getByRole("button", { name: "Apply organization", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry same review", exact: true }),
    ).toBeEnabled();
    await page.route(
      "**/api/commands/projects_organize_review",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: {
            ...(await response.json()),
            state,
            expiresAt:
              state === "expired"
                ? new Date(Date.now() - 1000).toISOString()
                : new Date(Date.now() + 60000).toISOString(),
          },
        });
      },
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Retry same review", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Back to choices", exact: true }),
    ).toBeDisabled();
    expect(page.url()).toBe(url);
    await page.unroute("**/api/commands/projects_organize_review");
    await page.unroute("**/api/commands/projects_organize_apply");
    await page
      .getByRole("button", { name: "Retry same review", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Projects organized", exact: true }),
    ).toBeVisible();
    expect(page.url()).toBe(url);
  });

test("lost committed responses recover the original receipt with a close warning and no duplicate project", async ({
  page,
  request,
}) => {
  await open(page);
  const name = await newShared(page);
  await review(page);
  const url = page.url();
  await page.route("**/api/commands/projects_organize_apply", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const warning = page.getByRole("alertdialog");
  await expect(warning).toContainText("Closing does not cancel Apply");
  await expect(
    warning.getByRole("textbox", { name: "Saved review URL", exact: true }),
  ).toHaveValue(url);
  await warning
    .getByRole("button", { name: "Keep review open", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check saved receipt", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects organized", exact: true }),
  ).toBeVisible();
  expect(
    (await command<Project[]>(request, "projects_list")).filter(
      (project) => project.name === name,
    ),
  ).toHaveLength(1);
});

test("a concurrent project edit rejects Apply and rebaselines only unselected metadata", async ({
  page,
  request,
}) => {
  await open(page);
  await selectTwo(page);
  await choose(page, "Group all selected repositories", "Existing target");
  await page.locator(".organization-row summary").click();
  await choose(page, "Importance", "High");
  await review(page);
  const before = (await command<Project[]>(request, "projects_list")).find(
    (project) => project.name === "Existing target",
  )!;
  await command(request, "project_update", {
    projectId: before.id,
    revision: before.revision,
    project: {
      ...projectFields.strip().parse(before),
      importanceNote: "Concurrent saved note",
    },
  });
  await page
    .getByRole("button", { name: "Apply organization", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "No organization changes were applied",
  );
  await page
    .getByRole("button", { name: "Back to choices", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Use latest repository and project versions",
      exact: true,
    })
    .click();
  await page.locator(".organization-row summary").click();
  await expect(
    page.getByRole("combobox", { name: "Importance", exact: true }),
  ).toContainText("High");
  await expect(
    page.getByRole("textbox", {
      name: "Why this importance? (optional)",
      exact: true,
    }),
  ).toHaveValue("Concurrent saved note");
  await review(page);
});

for (const theme of ["light", "dark"])
  for (const width of [1440, 390, 320])
    test(`project organization supports keyboard review in ${theme} at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await open(page);
      const checkbox = page.getByRole("checkbox", {
        name: /^example\/organize-00 /,
      });
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await audit(page);
      await page
        .getByRole("button", { name: "Choose projects", exact: true })
        .click();
      await choose(
        page,
        "Group all selected repositories",
        "Create a new project",
      );
      await page
        .getByRole("textbox", { name: "New project name", exact: true })
        .fill(
          "Visual " + theme + width + " " + crypto.randomUUID().slice(0, 8),
        );
      await audit(page);
      for (const selector of [".organization-dialog", ".organization-scroll"])
        expect(
          await page
            .locator(selector)
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("organization-choices.png"),
      });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await review(page);
      await audit(page);
      await page
        .getByRole("button", { name: "Apply organization", exact: true })
        .focus();
      for (let index = 0; index < 10; index++) {
        await page.keyboard.press("Tab");
        expect(
          await page
            .getByRole("dialog")
            .evaluate((element) => element.contains(document.activeElement)),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath("organization-review.png"),
      });
      await page
        .getByRole("button", { name: "Apply organization", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Projects organized", exact: true }),
      ).toBeVisible();
      await audit(page);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        page.getByRole("button", {
          name: "Organize repositories",
          exact: true,
        }),
      ).toBeFocused();
      await audit(page, false);
    });
