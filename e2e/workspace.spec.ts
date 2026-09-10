import { test, expect, type APIRequestContext } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspaceView } from "./workspace-fixture";
import {
  DEFAULT_EXPECTATIONS,
  type Repository,
  type Snapshot,
} from "../shared/domain";

const workspaceId = "development";
const headers = { "X-HQ-Client": "cli" };

async function api<T>(
  request: APIRequestContext,
  command: string,
  input: unknown,
): Promise<T> {
  const response = await request.post("/api/commands/" + command, {
    headers,
    data: input,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test("repository filters distinguish active records from searchable archives", async ({
  page,
  request,
}) => {
  const prefix = "example/filter-" + crypto.randomUUID();
  const names = {
    active: prefix + "-active",
    archived: prefix + "-archived",
  };
  for (const lifecycle of ["active", "archived"] as const) {
    await api<Repository>(request, "repository_create", {
      workspaceId,
      repository: {
        fullName: names[lifecycle],
        description: "Synthetic repository filter verification",
        projectId: "development-default",
        classification: "reference",
        lifecycle,
        expectations: DEFAULT_EXPECTATIONS,
      },
    });
  }
  await page.goto("/repositories");
  const active = page.getByRole("button", {
    name: "Active repositories",
    exact: true,
  });
  await expect(active).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Search repositories" }).fill(prefix);
  await expect(
    page.getByRole("heading", { name: names.active, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: names.archived, exact: true }),
  ).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    expect(
      await page
        .getByRole("group", { name: "Repository status" })
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            element.scrollWidth <= element.clientWidth &&
            Array.from(element.querySelectorAll("button")).every((button) => {
              const rect = button.getBoundingClientRect();
              return (
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                button.scrollWidth <= button.clientWidth
              );
            })
          );
        }),
    ).toBe(true);
  }
  const archived = page.getByRole("button", { name: "Archived", exact: true });
  await archived.focus();
  await page.keyboard.press("Enter");
  await expect(archived).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: names.archived, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: names.active, exact: true }),
  ).toHaveCount(0);
  await active.focus();
  await page.keyboard.press("Enter");
  await expect(active).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: names.active, exact: true }),
  ).toBeVisible();
});

test("enroll, edit, cancel, conflict recovery, and audit without JSON editing", async ({
  page,
  request,
}) => {
  const name = "example/browser-" + Date.now();
  await page.goto("/repositories");
  await page
    .getByRole("button", { name: "Enroll repository", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Enroll repository", exact: true })
    .click();
  await expect(
    dialog.getByText("Enter a repository as owner/name"),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Repository name", { exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Repository name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("A synthetic browser test repository");
  await dialog
    .getByRole("combobox", { name: "Owning project" })
    .click();
  await page.getByRole("option", { name: "Development", exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "Continuous integration" })
    .click();
  await page.getByRole("option", { name: "Optional", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Enroll repository", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Optional", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit expectations" }).click();
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("This draft must not be saved");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "This draft must not be saved",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByText("A synthetic browser test repository", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit expectations" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Edit expectations" }).click();
  await dialog
    .locator("summary")
    .filter({ hasText: "Review and maintainer context" })
    .click();
  await dialog
    .getByLabel("Maintainer context", { exact: true })
    .fill("A deliberate expectation exception");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Expectations saved" }),
  ).toBeVisible();
  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: "Maintainer context" })
    .click();
  await expect(
    page.getByText("A deliberate expectation exception", { exact: true }),
  ).toBeVisible();
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  const saved = snapshot.repositories.find(
    (repository) => repository.fullName === name,
  )!;
  await page.getByRole("button", { name: "Edit expectations" }).click();
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("My preserved draft");
  const {
    id,
    revision,
    workspaceId: savedWorkspace,
    updatedAt: _updatedAt,
    ...fields
  } = saved;
  await api<Repository>(request, "repository_update", {
    workspaceId: savedWorkspace,
    repositoryId: id,
    revision,
    repository: { ...fields, description: "Changed through another client" },
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "This repository changed while you were editing",
  );
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "My preserved draft",
  );
  await dialog
    .getByRole("button", { name: "Discard draft and load latest" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "Changed through another client",
  );
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Search activity" }).fill(name);
  await expect(
    page.getByRole("heading", { name: "Repository enrolled", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Repository enrolled" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Repository updated" }).first(),
  ).toBeVisible();
});

test("goal objectives remain exact and visible while journal filters change", async ({
  page,
  request,
}) => {
  const now = new Date().toISOString();
  const input = {
    workspaceId,
    goalId: crypto.randomUUID(),
    sourceId: "browser-test",
    objective:
      "Verbatim /goal\nKeep spaces, punctuation, and the full objective.",
    status: "active",
    startedAt: now,
    reportedAt: now,
  };
  await api(request, "goal_sync", input);
  await page.goto("/activity");
  const objective = page
    .locator(".goal-objective")
    .filter({ hasText: "Verbatim /goal" });
  await expect(objective).toHaveText(input.objective);
  expect(await objective.textContent()).toBe(input.objective);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search activity" })
    .fill("no-event-matches-this");
  await expect(objective).toBeVisible();
  await api(request, "goal_sync", {
    ...input,
    status: "complete",
    reportedAt: new Date().toISOString(),
  });
  await expect(objective).toHaveCount(0, { timeout: 10000 });
  await page.getByRole("button", { name: "All activity", exact: true }).click();
  await page.getByRole("textbox", { name: "Search activity" }).fill("");
  const group = page
    .locator(".goal-group")
    .filter({ hasText: "Verbatim /goal" });
  await expect(
    group.getByRole("button", { name: input.objective }),
  ).toHaveAttribute("aria-expanded", "false");
  await group.getByRole("button", { name: input.objective }).click();
  await expect(group.locator(".activity-event")).toHaveCount(2);
  expect(await group.locator(".goal-group-objective").textContent()).toBe(
    input.objective,
  );
});

test("delayed and retried goal reports stay stale until the source confirms its status", async ({
  page,
  request,
}) => {
  const oldReport = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const input = {
    workspaceId,
    goalId: crypto.randomUUID(),
    sourceId: "delayed-browser-source",
    objective:
      "  Preserve this delayed /goal verbatim.\nDo not confuse retries with fresh source reports.  ",
    status: "active",
    startedAt: oldReport,
    reportedAt: oldReport,
  };
  const first = await api(request, "goal_sync", input);
  expect(await api(request, "goal_sync", input)).toEqual(first);
  await page.goto("/activity");
  const card = page
    .locator(".checkpoint-card")
    .filter({ hasText: input.objective.trim().split("\n")[0] });
  await expect(card.getByText("Awaiting goal sync")).toBeVisible();
  expect(await card.locator(".goal-objective").textContent()).toBe(
    input.objective,
  );
  await api(request, "goal_sync", {
    ...input,
    reportedAt: new Date().toISOString(),
    status: "blocked",
  });
  await expect(card.getByText("Awaiting goal sync")).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(card.getByText("BLOCKED /GOAL", { exact: true })).toBeVisible();
  expect(await card.locator(".goal-objective").textContent()).toBe(
    input.objective,
  );
  await api(request, "goal_sync", {
    ...input,
    reportedAt: new Date().toISOString(),
    status: "complete",
  });
  await expect(card).toHaveCount(0, { timeout: 10000 });
});

test("overview treats missing evidence as unverified and review reminders as actionable", async ({
  page,
  request,
}) => {
  const name = "example/review-" + Date.now();
  await api(request, "repository_create", {
    workspaceId,
    repository: {
      fullName: name,
      description: "Synthetic review test",
      classification: "maintained",
      lifecycle: "active",
      projectId: "development-default",
      expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2020-01-01" },
    },
  });
  await page.goto(
    "/overview?workspace=" + workspaceId + "&q=" + encodeURIComponent(name),
  );
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Expectation review overdue", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not collected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Reviews / }).click();
  await expect(page.getByText("Not collected", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(page.getByText("2020-01-01", { exact: true })).toBeVisible();
});

test("desktop and mobile views remain accessible in both themes", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"]) {
      await page.goto("/repositories");
      await page.evaluate((value) => {
        localStorage.setItem("hq.theme.v1", value);
      }, theme);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Repositories", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page
        .getByRole("button", { name: "Enroll repository", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("dialog").evaluate(async (dialog) => {
        await Promise.all(
          dialog.getAnimations().map((animation) => animation.finished),
        );
      });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    }
  }
});

test("keyboard dismissal, failed saves, and browser navigation preserve an unsaved draft", async ({
  page,
  request,
}) => {
  const name = "example/draft-" + Date.now();
  await api(request, "repository_create", {
    workspaceId,
    repository: {
      fullName: name,
      description: "Original description",
      classification: "maintained",
      lifecycle: "active",
      projectId: "development-default",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  await page.goto("/repositories");
  await page.getByRole("link").filter({ hasText: name }).click();
  await page.getByRole("button", { name: "Edit expectations" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Still here after a failure");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await page.route("**/api/commands/repository_update", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "unavailable",
          message: "Synthetic service interruption",
        },
      }),
    }),
  );
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Your changes were not confirmed",
  );
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "Still here after a failure",
  );
  await page.goBack();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
    "Still here after a failure",
  );
  await page.goBack();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("read-only workspace access explains disabled controls", async ({
  page,
  request,
}) => {
  const name = "example/viewer-" + Date.now();
  await api(request, "repository_create", {
    workspaceId,
    repository: {
      fullName: name,
      description: "Read-only browser fixture",
      classification: "maintained",
      lifecycle: "active",
      projectId: "development-default",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role: "viewer" },
    capabilities: ["read"],
  }));
  await page.goto("/repositories");
  await expect(
    page.getByRole("button", { name: "Enroll repository", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Your workspace role can view repositories but cannot change their expectations.",
    ),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search repositories" }).fill(name);
  await page.getByRole("link").filter({ hasText: name }).click();
  await expect(
    page.getByRole("button", { name: "Edit expectations" }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "This session cannot edit expectations. See Access & operations for the required role or client scope.",
    ),
  ).toBeVisible();
});
