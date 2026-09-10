import { test, expect, type APIRequestContext } from "./test-fixture";
import { DEFAULT_EXPECTATIONS, type Repository } from "../shared/domain";
import type { WorkspaceView } from "../shared/workspace-sync";

const workspaceId = "polling-test";
async function command<T>(
  request: APIRequestContext,
  name: string,
  data: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test("Repositories receives only its view and changed records, then switches subscriptions to Activity", async ({
  page,
  request,
}) => {
  const fields = {
    fullName: "example/incremental-" + crypto.randomUUID(),
    description: "Original incremental description",
    projectId: "polling-default",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
  const repo = await command<Repository>(request, "repository_create", {
    repository: fields,
  });
  const requests: string[] = [];
  const frames: {
    scope: { view: string };
    type: string;
    update: { upserts?: { repositories?: Repository[] }; cursor: number };
  }[] = [];
  const subscriptions: string[] = [];
  const views: WorkspaceView[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      requests.push(new URL(request.url()).pathname.split("/").at(-1)!);
  });
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/api/commands/workspace_view") &&
      response.ok()
    )
      views.push(await response.json());
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/events") return;
    subscriptions.push(
      new URL(socket.url()).searchParams.get("view") ?? "legacy",
    );
    socket.on("framereceived", ({ payload }) => {
      if (String(payload).startsWith("{"))
        frames.push(JSON.parse(String(payload)));
    });
  });
  await page.goto("/repositories?workspace=" + workspaceId);
  await expect(
    page.getByRole("heading", { name: "Repositories", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  expect(views).toHaveLength(1);
  expect(Object.keys(views[0].records).sort()).toEqual([
    "observations",
    "projects",
    "repositories",
  ]);
  expect(requests).toEqual(["workspace_view"]);
  const frameCount = frames.length;
  const title = "Activity outside the Repositories tab " + crypto.randomUUID();
  await command(request, "activity_add", {
    eventId: crypto.randomUUID(),
    kind: "note",
    title,
    summary: "Off-tab delivery verification",
    resourceId: repo.id,
    goalId: null,
  });
  await page.waitForLoadState("networkidle");
  expect(frames).toHaveLength(frameCount);
  expect(requests).toEqual(["workspace_view"]);
  await page.getByPlaceholder("Find a repository...").fill(repo.fullName);
  await command(request, "repository_update", {
    repositoryId: repo.id,
    revision: repo.revision,
    repository: {
      ...fields,
      description: "A single pushed repository record",
      classification: "reference",
    },
  });
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: repo.fullName })
      .getByRole("cell", { name: "Reference", exact: true }),
  ).toBeVisible();
  const update = [...frames]
    .reverse()
    .find((frame) => frame.type === "update")!;
  expect(update.scope.view).toBe("repositories");
  expect(update.update.upserts?.repositories).toHaveLength(1);
  expect(update.update.upserts?.repositories?.[0].id).toBe(repo.id);
  expect(requests).toEqual(["workspace_view"]);
  expect(await page.getByPlaceholder("Find a repository...").inputValue()).toBe(
    repo.fullName,
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect.poll(() => subscriptions.at(-1)).toBe("activity");
  expect(requests).not.toContain("workspace_snapshot");
  expect(views.at(-1)?.records).not.toHaveProperty("observations");
  expect(errors).toEqual([]);
});

test("an authority reset reconnects using the replacement view's membership revision", async ({
  page,
  request,
}) => {
  const fields = {
    fullName: "example/authority-" + crypto.randomUUID(),
    description: "Before authority recovery",
    projectId: "polling-default",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
  const repo = await command<Repository>(request, "repository_create", {
    repository: fields,
  });
  let views = 0;
  let actualRevision = 0;
  const subscriptions: number[] = [];
  await page.route("**/api/commands/workspace_view", async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as WorkspaceView;
    actualRevision = view.memberRevision;
    views++;
    await route.fulfill({
      response,
      json: {
        ...view,
        memberRevision: view.memberRevision + (views === 1 ? 1 : 0),
      },
    });
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/events") return;
    subscriptions.push(
      Number(new URL(socket.url()).searchParams.get("memberRevision")),
    );
  });
  await page.goto("/repositories?workspace=" + workspaceId);
  await expect.poll(() => subscriptions.length).toBe(2);
  expect(subscriptions).toEqual([actualRevision + 1, actualRevision]);
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  expect(views).toBe(2);
  await page.getByPlaceholder("Find a repository...").fill(repo.fullName);
  await command(request, "repository_update", {
    repositoryId: repo.id,
    revision: repo.revision,
    repository: {
      ...fields,
      description: "Push works after authority recovery",
      classification: "reference",
    },
  });
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: repo.fullName })
      .getByRole("cell", { name: "Reference", exact: true }),
  ).toBeVisible();
  expect(views).toBe(2);
  expect(subscriptions).toEqual([actualRevision + 1, actualRevision]);
});
