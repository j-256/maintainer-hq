import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  projectFields,
  projectSchema,
  type Project,
  type Repository,
} from "../shared/domain";
import type { WorkspaceView } from "../shared/workspace-sync";
import { mockWorkspaceView } from "./workspace-fixture";

const WORKSPACE_ID = "projects-test";
const URL = "/projects?workspace=" + WORKSPACE_ID;
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
function projectURL(project: Project, section = "overview") {
  return (
    "/projects/" +
    project.id +
    "?workspace=" +
    WORKSPACE_ID +
    "&section=" +
    section
  );
}
function section(page: Page, name: string) {
  return page
    .getByRole("navigation", { name: "Project sections" })
    .getByRole("link", { name, exact: true });
}
async function createProject(request: APIRequestContext, name: string) {
  return command<Project>(request, "project_create", {
    name: name + " " + crypto.randomUUID(),
    description: "Synthetic project verification",
  });
}
function repositoryFields(fullName: string, projectId: string | null) {
  return {
    fullName,
    projectId,
    description: "Synthetic project repository",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
}

test("creates a project and its first repository in one structured flow, then records a project note", async ({
  page,
  request,
}) => {
  const name = "Project create " + crypto.randomUUID();
  const repositoryName = "example/" + crypto.randomUUID();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Project name", { exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Project name", { exact: true }).fill(name);
  await select(page, "Importance", "High");
  const portfolioSection = dialog
    .locator("details")
    .filter({ hasText: "Portfolio inclusion" });
  await portfolioSection.locator("summary").click();
  await select(page, "Inclusion decision", "Excluded");
  await portfolioSection.locator("summary").click();
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Reason (required)", { exact: true }),
  ).toBeFocused();
  await expect(portfolioSection).toHaveAttribute("open", "");
  await dialog
    .getByLabel("Reason (required)", { exact: true })
    .fill("Private operator tooling");
  await dialog
    .getByRole("checkbox", { name: "Enroll a repository with this project" })
    .check();
  await dialog
    .getByLabel("GitHub repository", { exact: true })
    .fill("not a repository");
  await dialog
    .getByRole("button", { name: "Create project and repository" })
    .click();
  await expect(
    dialog.getByLabel("GitHub repository", { exact: true }),
  ).toBeFocused();
  await dialog
    .getByLabel("GitHub repository", { exact: true })
    .fill(repositoryName);
  await dialog
    .getByRole("button", { name: "Create project and repository" })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const projectId = new globalThis.URL(page.url()).pathname.split("/").at(-1)!;
  const project = await command<Project>(request, "project_get", { projectId });
  expect(project.importance).toBe("high");
  expect(project.portfolio.status).toBe("excluded");
  const view = await command<WorkspaceView>(request, "workspace_view", {
    view: "projects",
  });
  expect(
    view.records.repositories?.find((repo) => repo.fullName === repositoryName)
      ?.projectId,
  ).toBe(projectId);
  await section(page, "Repositories").click();
  await expect(
    page.getByRole("heading", { name: repositoryName, exact: true }),
  ).toBeVisible();
  await section(page, "Activity").click();
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(dialog.getByRole("combobox", { name: "Related to" })).toHaveText(
    "Project: " + name,
  );
  await expect(
    dialog.getByRole("combobox", { name: "Related to" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("A project-specific decision");
  await dialog.getByRole("button", { name: "Post note" }).click();
  await expect(
    page.getByRole("heading", { name: "A project-specific decision" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("keeps drafts during record push and recovers a project revision conflict explicitly", async ({
  page,
  request,
}) => {
  const project = await createProject(request, "Draft");
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push(request.url().split("/").at(-1)!);
  });
  await page.goto(projectURL(project));
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  const edit = page.getByRole("button", { name: "Edit project", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Keep this local draft");
  await command(request, "project_update", {
    projectId: project.id,
    revision: project.revision,
    project: {
      ...projectFields.strip().parse(project),
      description: "Another operator saved this",
    },
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "changed while you were editing",
  );
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "Keep this local draft",
  );
  await expect(
    dialog.getByRole("button", { name: "Save project", exact: true }),
  ).toBeDisabled();
  expect(calls).not.toContain("activity_feed");
  expect(calls).not.toContain("workspace_snapshot");
  await dialog
    .getByRole("button", { name: "Discard draft and load saved project" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Load saved project" })
    .click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "Another operator saved this",
  );
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("A reviewed follow-up");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Keep editing" })
    .click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "A reviewed follow-up",
  );
  await dialog
    .getByRole("button", { name: "Save project", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(
    page.getByText("A reviewed follow-up", { exact: true }),
  ).toBeVisible();
});

test("links an existing repository explicitly, preserves historical project activity, and removes regrouped rows by push", async ({
  page,
  request,
}) => {
  const original = await createProject(request, "Original");
  const destination = await createProject(request, "Destination");
  const fields = repositoryFields(
    "example/" + crypto.randomUUID(),
    original.id,
  );
  const repository = await command<Repository>(request, "repository_create", {
    repository: fields,
  });
  const title = "Before regrouping " + crypto.randomUUID();
  await command(request, "activity_add", {
    eventId: crypto.randomUUID(),
    kind: "note",
    title,
    summary: "Recorded in the original project",
    resourceId: repository.id,
    goalId: null,
  });
  const overview = await page.context().newPage();
  await overview.goto(projectURL(destination));
  const linked = overview.getByRole("region", {
    name: "Repositories",
    exact: true,
  });
  await expect(linked).toContainText(
    "No repositories are linked to this project.",
  );
  await expect(overview.locator(".connection-state")).toContainText(
    "Live updates",
  );
  await page.goto(projectURL(destination, "repositories"));
  await page.getByRole("button", { name: "Link existing repository" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Find an existing repository" })
    .fill(repository.fullName);
  await dialog
    .getByRole("button", { name: repository.fullName + " " + original.name })
    .click();
  await expect(dialog.getByRole("combobox", { name: "Project" })).toHaveText(
    destination.name,
  );
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: repository.fullName, exact: true }),
  ).toBeVisible();
  await expect(
    linked.getByRole("link", { name: repository.fullName, exact: true }),
  ).toBeVisible();
  await page.goto(projectURL(original, "activity"));
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.goto(projectURL(destination, "repositories"));
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  const current = await command<WorkspaceView>(request, "workspace_view", {
    view: "projects",
  });
  const saved = current.records.repositories!.find(
    (value) => value.id === repository.id,
  )!;
  await command(request, "repository_update", {
    repositoryId: saved.id,
    revision: saved.revision,
    repository: { ...fields, projectId: original.id },
  });
  await expect(
    page.getByRole("heading", { name: repository.fullName, exact: true }),
  ).toHaveCount(0);
  await expect(
    linked.getByRole("link", { name: repository.fullName, exact: true }),
  ).toHaveCount(0);
  await expect(linked).toContainText(
    "No repositories are linked to this project.",
  );
  await overview.close();
  await page.goto(projectURL(original, "repositories"));
  await expect(
    page.getByRole("heading", { name: repository.fullName, exact: true }),
  ).toBeVisible();
});

test("preserves independent project and nested repository filters on detail return", async ({
  page,
  request,
}) => {
  const name = "Return " + crypto.randomUUID();
  const project = await command<Project>(request, "project_create", {
    name,
    description: "Navigation context",
    firstRepository: {
      ...repositoryFields("example/" + crypto.randomUUID(), null),
      projectId: undefined,
    },
  });
  await page.goto(URL + "&q=" + encodeURIComponent(name));
  await page.getByRole("link", { name, exact: true }).click();
  await page
    .getByRole("region", { name: "Repositories", exact: true })
    .getByRole("link", { name: "example/" })
    .click();
  await page
    .getByRole("link", { name: "Project repositories", exact: true })
    .click();
  expect(new globalThis.URL(page.url()).searchParams.get("projectList")).toBe(
    new URLSearchParams({ q: name }).toString(),
  );
  await page
    .getByRole("textbox", { name: "Search repositories" })
    .fill("example/");
  const repo = page
    .getByRole("table", { name: "Repository inventory" })
    .locator("tbody tr")
    .first()
    .getByRole("rowheader")
    .getByRole("link");
  await repo.click();
  await page
    .getByRole("link", { name: "Project repositories", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search repositories" }),
  ).toHaveValue("example/");
  await page.locator(".back-link").filter({ hasText: "Projects" }).click();
  await expect(
    page.getByRole("textbox", { name: "Search projects" }),
  ).toHaveValue(name);
  await expect(
    page.getByRole("link", { name: project.name, exact: true }),
  ).toBeVisible();
});

test("project inventory is dense, bounded, keyboard-accessible and readable in both themes on desktop and mobile", async ({
  page,
}) => {
  const projects = Array.from({ length: 31 }, (_, index) =>
    projectSchema.parse({
      id: "synthetic-" + index,
      workspaceId: WORKSPACE_ID,
      name: "Synthetic project " + (index + 1),
      description: "No repository",
      revision: 1,
      updatedAt: "2026-09-07T00:00:00.000Z",
    }),
  );
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    projects,
    repositories: [],
    observations: [],
  }));
  await page.goto(URL);
  const rows = page
    .getByRole("table", { name: "Project inventory" })
    .locator("tbody tr");
  await expect(rows).toHaveCount(25);
  await select(page, "Sort projects", "Name A to Z");
  await page.getByRole("button", { name: "Next project page" }).focus();
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(6);
  await expect(page.locator(".repository-inventory-summary > p")).toBeFocused();
  await page
    .getByRole("textbox", { name: "Search projects" })
    .fill("Synthetic project 31");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters" }).click();
  for (const dark of [true, false]) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle("dark", value),
      dark,
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .include("#main-content")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    }
  }
});

test("read-only project overviews list active and archived repositories with accessible navigation", async ({
  page,
  request,
}) => {
  const project = await createProject(request, "Read only");
  const other = await createProject(request, "Separate project");
  const active = await command<Repository>(request, "repository_create", {
    repository: repositoryFields(
      "example/active-" + crypto.randomUUID(),
      project.id,
    ),
  });
  const archived = await command<Repository>(request, "repository_create", {
    repository: {
      ...repositoryFields(
        "example/archived-repository-with-a-long-name-" + crypto.randomUUID(),
        project.id,
      ),
      lifecycle: "archived",
    },
  });
  const unrelated = await command<Repository>(request, "repository_create", {
    repository: repositoryFields(
      "example/unrelated-" + crypto.randomUUID(),
      other.id,
    ),
  });
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role: "viewer" },
    capabilities: [CAPABILITY.READ],
  }));
  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Create project", exact: true }),
  ).toBeDisabled();
  await page.goto(projectURL(project));
  await expect(
    page.getByRole("button", { name: "Edit project", exact: true }),
  ).toBeDisabled();
  const repositories = page.getByRole("region", {
    name: "Repositories",
    exact: true,
  });
  await expect(repositories.locator("li")).toHaveCount(2);
  await expect(repositories.locator("li").first()).toContainText(
    active.fullName,
  );
  await expect(repositories.locator("li").last()).toContainText("Archived");
  await expect(
    repositories.getByRole("link", { name: unrelated.fullName, exact: true }),
  ).toHaveCount(0);
  for (const dark of [true, false]) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle("dark", value),
      dark,
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .include(".project-overview-repositories")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    }
  }
  await repositories
    .getByRole("link", { name: active.fullName, exact: true })
    .focus();
  await page.keyboard.press("Tab");
  await expect(
    repositories.getByRole("link", { name: archived.fullName, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: archived.fullName, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Project repositories", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: archived.fullName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Link existing repository" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Enroll repository" }),
  ).toBeDisabled();
});
