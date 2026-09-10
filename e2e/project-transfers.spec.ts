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
  type Project,
  type Connection,
} from "../shared/domain";
import type { WorkspaceView } from "../shared/workspace-sync";
import type { TransferReview } from "../shared/project-transfers";
import { mockWorkspaceView } from "./workspace-fixture";

const SOURCE = "transfer-source";
const DESTINATION = "transfer-destination";
const EMPTY = "transfer-empty";
async function command<T>(
  request: APIRequestContext,
  name: string,
  input: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: SOURCE, ...input },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function createProject(request: APIRequestContext, repository = false) {
  return command<Project>(request, "project_create", {
    name: "Transfer " + crypto.randomUUID(),
    description: "Synthetic browser transfer",
    importance: "high",
    importanceNote: "Customer-facing dependency",
    portfolio: {
      status: "excluded",
      reason: "Private infrastructure",
      url: null,
      reviewDate: null,
    },
    ...(repository
      ? {
          firstRepository: {
            fullName: "example/" + crypto.randomUUID(),
            description: "Synthetic transfer repository",
            classification: "maintained",
            lifecycle: "active",
            expectations: DEFAULT_EXPECTATIONS,
          },
        }
      : {}),
  });
}
function url(project: Project, workspaceId = SOURCE, section = "overview") {
  return (
    "/projects/" +
    project.id +
    "?" +
    new URLSearchParams({ workspace: workspaceId, section })
  );
}
async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function inspect(page: Page, project: Project) {
  await page.goto(url(project));
  await page
    .getByRole("button", { name: "Move to workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Move project to another workspace",
      exact: true,
    }),
  ).toBeFocused();
  await select(page, "Destination workspace", "Transfer destination");
  await page
    .getByRole("button", { name: "Inspect destination", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What moves", exact: true }),
  ).toBeVisible();
}
async function review(page: Page) {
  await page
    .getByRole("button", { name: "Review transfer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm workspace transfer",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /I reviewed the access/ }),
  ).toBeEnabled();
}

test("moves a reviewed project with explicit source mapping and retains original history and receipt", async ({
  page,
  request,
}) => {
  const project = await createProject(request, true);
  const view = await command<WorkspaceView>(request, "workspace_view", {
    view: "projects",
  });
  const repository = view.records.repositories!.find(
    (item) => item.projectId === project.id,
  )!;
  const source = await command<Connection>(request, "source_enroll", {
    sourceId: crypto.randomUUID(),
    source: {
      name: "Original source " + crypto.randomUUID(),
      enabled: true,
      freshnessMinutes: 15,
      repositoryIds: [repository.id],
    },
  });
  const destination = await command<Connection>(request, "source_enroll", {
    workspaceId: DESTINATION,
    sourceId: crypto.randomUUID(),
    source: {
      name: "Destination source " + crypto.randomUUID(),
      enabled: false,
      freshnessMinutes: 15,
      repositoryIds: [],
    },
  });
  await command(request, "activity_add", {
    eventId: crypto.randomUUID(),
    kind: "note",
    title: "Retained transfer decision",
    summary: "History stays here",
    resourceId: project.id,
  });
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await inspect(page, project);
  const dialog = page.getByRole("alertdialog", {
    name: "Move project to another workspace",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Review transfer", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("heading", { name: "Resolve before moving" }),
  ).toBeVisible();
  await select(
    page,
    source.name + " (local)",
    destination.name + " (disabled)",
  );
  await page
    .getByRole("button", { name: "Refresh preview", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Resolve before moving" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("row", { name: /Source reader/ }),
  ).toContainText("Loses current access");
  await expect(
    dialog.getByRole("row", { name: /Destination reader/ }),
  ).toContainText("Gains access");
  await review(page);
  const reviewURL = page.url();
  await expect(
    page.getByRole("button", { name: "Confirm move", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Confirm workspace transfer",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /I reviewed the access/ }).check();
  await page.getByRole("button", { name: "Confirm move", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Project moved", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Open project in destination" })
    .click();
  await expect(page).toHaveURL(new RegExp("workspace=" + DESTINATION));
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  const moved = await command<Project>(request, "project_get", {
    workspaceId: DESTINATION,
    projectId: project.id,
  });
  expect(moved.importance).toBe("high");
  expect(moved.portfolio).toEqual(project.portfolio);
  await page.goto(url(project));
  await expect(
    page.getByText(/read-only history, not the project's current state/),
  ).toBeVisible();
  const beforeHistory = requests.length;
  await expect(
    page.getByRole("link", { name: "View retained Activity" }),
  ).toBeVisible();
  expect(
    requests
      .slice(beforeHistory)
      .some((path) => path.includes("activity_feed")),
  ).toBe(false);
  await page.getByRole("link", { name: "View retained Activity" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Retained transfer decision",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0);
  await page.goto("/repositories/" + repository.id + "?workspace=" + SOURCE);
  await expect(
    page.getByText(/read-only history, not the repository's current state/),
  ).toBeVisible();
  await page.goto(reviewURL);
  await expect(
    page.getByRole("heading", { name: "Project moved", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close receipt" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(requests).not.toContain("/api/commands/workspace_snapshot");
  expect(errors).toEqual([]);
});

test("keeps choices on cancel, rejects a stale review, and requires a new review", async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await inspect(page, project);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Destination workspace" }),
  ).toHaveText("Transfer destination");
  await review(page);
  await command(request, "project_update", {
    projectId: project.id,
    revision: project.revision,
    project: projectFields.parse({
      name: project.name,
      description: "Changed after review",
      lifecycle: project.lifecycle,
      importance: project.importance,
      importanceNote: project.importanceNote,
      portfolio: project.portfolio,
    }),
  });
  await page
    .getByRole("button", { name: "Inspect saved result", exact: true })
    .click();
  await expect(
    page.getByText("This review is stale.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm move", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to choices", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Destination workspace" }),
  ).toHaveText("Transfer destination");
  await expect(
    page.getByRole("button", { name: "Review transfer", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Refresh preview", exact: true })
    .click();
  await review(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Move to workspace", exact: true }),
  ).toBeFocused();
});

test("retries an interrupted plan using the original review reference", async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await inspect(page, project);
  const reviews: string[] = [];
  await page.route("**/api/commands/project_transfer_plan", async (route) => {
    reviews.push(route.request().postDataJSON().reviewId);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBeTruthy();
    if (reviews.length === 1) await route.abort("connectionfailed");
    else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Review transfer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry preparing review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm workspace transfer",
      exact: true,
    }),
  ).toBeVisible();
  expect(reviews).toHaveLength(2);
  expect(reviews[1]).toBe(reviews[0]);
  expect(new URL(page.url()).searchParams.get("transfer")).toBe(reviews[0]);
});

test("recovers the same receipt after the confirmation response is interrupted", async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await inspect(page, project);
  await review(page);
  const reviewId = new URL(page.url()).searchParams.get("transfer");
  let applies = 0;
  await page.route("**/api/commands/project_transfer_apply", async (route) => {
    applies++;
    const result = await route.fetch();
    expect(result.ok(), await result.text()).toBeTruthy();
    await route.abort("connectionfailed");
  });
  await page.getByRole("checkbox", { name: /I reviewed the access/ }).check();
  await page.getByRole("button", { name: "Confirm move", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Project moved", exact: true }),
  ).toBeVisible();
  expect(applies).toBe(1);
  const receipt = await command<TransferReview>(
    request,
    "project_transfer_review",
    { reviewId },
  );
  expect(receipt.state).toBe("applied");
  expect(receipt.receipt?.projectId).toBe(project.id);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Project moved", exact: true }),
  ).toBeVisible();
  expect(applies).toBe(1);
});

test("prepares disabled empty local and GitHub sources through Settings", async ({
  page,
}) => {
  await page.goto("/settings/publishers?workspace=" + EMPTY);
  await page
    .getByRole("button", { name: "Enroll publisher", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Publisher name", { exact: true })
    .fill("Empty source " + crypto.randomUUID());
  await expect(
    dialog.getByRole("checkbox", { name: /Allow publishing/ }),
  ).not.toBeChecked();
  await dialog
    .getByRole("button", { name: "Enroll publisher", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "All settings", exact: true }).click();
  await page.getByRole("link", { name: /^GitHub evidence / }).click();
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await dialog
    .getByLabel("Connection name", { exact: true })
    .fill("Empty GitHub " + crypto.randomUUID());
  await expect(
    dialog.getByRole("checkbox", { name: /Enable read-only collection/ }),
  ).not.toBeChecked();
  await dialog
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
});

test("shows missing Owner authority without fetching cross-workspace transfer details", async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    capabilities: snapshot.capabilities.filter(
      (value) => value !== CAPABILITY.ADMIN,
    ),
  }));
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(url(project));
  await expect(
    page.getByRole("button", { name: "Move to workspace", exact: true }),
  ).toBeDisabled();
  await page.goto(url(project) + "&transfer=" + crypto.randomUUID());
  await expect(
    page.getByText(/Owner access is required in both workspaces/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm move", exact: true }),
  ).toBeDisabled();
  expect(
    requests.some((path) =>
      /project_transfer_(review|destinations)/.test(path),
    ),
  ).toBe(false);
});

test("hides saved review details after destination authority is lost and preserves destination choices", async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  await inspect(page, project);
  await review(page);
  await page.route("**/api/commands/project_transfer_review", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "forbidden",
          message: "Destination Owner access was revoked",
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Inspect saved result", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm move", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "What moves", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to choices", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Destination workspace", exact: true }),
  ).toHaveText("Transfer destination");
  await expect(
    page.getByRole("heading", {
      name: "Who can access the project",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review transfer", exact: true }),
  ).toBeDisabled();
});

test("expired saved reviews cannot be confirmed", async ({ page, request }) => {
  const project = await createProject(request);
  await inspect(page, project);
  await review(page);
  await page.route("**/api/commands/project_transfer_review", async (route) => {
    const response = await route.fetch();
    const saved = await response.json();
    await route.fulfill({
      response,
      json: {
        ...saved,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        state: "expired",
      },
    });
  });
  await page.reload();
  await expect(
    page.getByText("This review expired.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /I reviewed the access/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Confirm move", exact: true }),
  ).toBeDisabled();
});

for (const theme of ["light", "dark"] as const)
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(
      "transfer completion returns focus and scrolling to the receipt at " +
        viewport.width +
        "px in " +
        theme,
      async ({ page, request }) => {
        const project = await createProject(request, true);
        await page.setViewportSize(viewport);
        await page.addInitScript(
          (value) => localStorage.setItem("hq.theme.v1", value),
          theme,
        );
        await inspect(page, project);
        await review(page);
        await page
          .getByRole("checkbox", { name: /I reviewed the access/ })
          .check();
        const body = page.locator(".transfer-scroll");
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        if (viewport.width === 390)
          expect(
            await body.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
        await page
          .getByRole("button", { name: "Confirm move", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Project moved", exact: true }),
        ).toBeFocused();
        await expect
          .poll(() => body.evaluate((element) => element.scrollTop))
          .toBe(0);
        await expect(
          page.getByRole("heading", {
            name: "Move recorded in both workspaces",
          }),
        ).toBeInViewport();
        await expect(page.getByRole("alertdialog")).toContainText(
          "The completed move is recorded below.",
        );
      },
    );
    test(
      "transfer review is keyboard-accessible with contained scrolling at " +
        viewport.width +
        "px in " +
        theme,
      async ({ page, request }) => {
        const project = await createProject(request, true);
        await page.setViewportSize(viewport);
        await page.addInitScript(
          (value) => localStorage.setItem("hq.theme.v1", value),
          theme,
        );
        await inspect(page, project);
        await review(page);
        const dialog = page.getByRole("alertdialog", {
          name: "Confirm workspace transfer",
          exact: true,
        });
        expect(
          (
            await new AxeBuilder({ page })
              .include('[role="alertdialog"]')
              .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
              .analyze()
          ).violations,
        ).toEqual([]);
        expect(
          await dialog.evaluate((element) => ({
            fits:
              element.getBoundingClientRect().left >= 0 &&
              element.getBoundingClientRect().right <= innerWidth &&
              element.getBoundingClientRect().bottom <= innerHeight,
            scrolls:
              element.querySelector(".transfer-scroll")!.scrollWidth <=
              element.querySelector(".transfer-scroll")!.clientWidth,
          })),
        ).toEqual({ fits: true, scrolls: true });
        await page
          .getByRole("checkbox", { name: /I reviewed the access/ })
          .focus();
        await page.keyboard.press("Space");
        await expect(
          page.getByRole("button", { name: "Confirm move", exact: true }),
        ).toBeEnabled();
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() =>
            Boolean(document.activeElement?.closest('[role="alertdialog"]')),
          ),
        ).toBe(true);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("button", { name: "Discard changes", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Move to workspace", exact: true }),
        ).toBeFocused();
      },
    );
  }
