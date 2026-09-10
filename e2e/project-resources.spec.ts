import { test, expect, type Page } from "./test-fixture";
import { projectSchema } from "../shared/domain";
import type {
  ProjectResourceKind,
  ResourceProject,
} from "../shared/project-resources";
import { mockWorkspaceView } from "./workspace-fixture";
import {
  mockMonitoring,
  MONITOR_CONNECTION,
  MONITOR_TARGET,
} from "./monitoring-fixture";
import { mockSecrets, SECRET_CONNECTION } from "./secrets-fixture";

const PROJECT = projectSchema.parse({
  id: "synthetic-project",
  workspaceId: "development",
  name: "Synthetic project",
  description: "Metadata-only project",
  revision: 4,
  updatedAt: "2026-09-07T00:00:00.000Z",
});
async function projectContext(page: Page) {
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    projects: [PROJECT],
  }));
  await page.route("**/api/commands/project_get", (route) =>
    route.fulfill({ json: PROJECT }),
  );
}
async function association(
  page: Page,
  kind: ProjectResourceKind,
  connectionId: string,
  resourceKey: string,
) {
  const state = {
    saved: null as Record<string, unknown> | null,
    value: {
      workspaceId: PROJECT.workspaceId,
      kind,
      connectionId,
      resourceKey,
      projectId: null,
      revision: 0,
      connectionRevision: 1,
      updatedAt: null,
    } as ResourceProject,
  };
  await page.route("**/api/commands/resource_project*", (route) => {
    const input = route.request().postDataJSON();
    expect(input).toMatchObject({
      workspaceId: PROJECT.workspaceId,
      kind,
      connectionId,
      resourceKey,
    });
    if (route.request().url().endsWith("resource_project_save")) {
      state.saved = input;
      state.value = {
        ...state.value,
        projectId: input.projectId,
        revision: input.revision + 1,
        updatedAt: PROJECT.updatedAt,
      };
    }
    return route.fulfill({ json: state.value });
  });
  return state;
}
test("project resources page through exact local metadata without fetching providers", async ({
  page,
}) => {
  await projectContext(page);
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  await page.route("**/api/commands/project_resources", (route) => {
    const input = route.request().postDataJSON();
    expect(input).toMatchObject({
      workspaceId: PROJECT.workspaceId,
      projectId: PROJECT.id,
      kind: "hook",
    });
    const item = {
      kind: "hook",
      connectionId: "hooks-test",
      connectionName: "Synthetic hooks",
      connectionEnabled: true,
      connectionRevision: 1,
      resourceKey: input.cursor ? "Older subscription" : "Shared subscription",
      label: input.cursor ? "Older subscription" : "Shared subscription",
      projectId: PROJECT.id,
      direct: !input.cursor,
      repositoryCount: 1,
      sharedRepositoryCount: 2,
    };
    return route.fulfill({
      json: {
        items: [item],
        nextCursor: input.cursor
          ? null
          : {
              workspaceId: PROJECT.workspaceId,
              projectId: PROJECT.id,
              filter: "hook",
              kind: "hook",
              connectionId: item.connectionId,
              resourceKey: item.resourceKey,
            },
      },
    });
  });
  await page.goto(
    "/projects/" +
      PROJECT.id +
      "?workspace=development&section=hooks&projectList=" +
      encodeURIComponent("q=Synthetic&importance=high&workspace=ignored"),
  );
  await expect(
    page.getByRole("heading", { name: "Shared subscription" }),
  ).toBeVisible();
  await expect(
    page.getByText("Primary project", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "1 linked repository in this project; 2 outside this project.",
      { exact: true },
    ),
  ).toBeVisible();
  const link = page.getByRole("link", { name: "Open hooks", exact: true });
  const url = new URL(
    (await link.getAttribute("href")) ?? "",
    "https://hq.invalid",
  );
  expect(url.searchParams.get("subscription")).toBe("Shared subscription");
  expect(url.searchParams.get("project")).toBe(PROJECT.id);
  expect(url.searchParams.get("projectList")).toBe(
    "q=Synthetic&importance=high",
  );
  const browse = new URL(
    (await page
      .getByRole("link", { name: "Browse and link", exact: true })
      .getAttribute("href"))!,
    "https://hq.invalid",
  );
  expect(browse.searchParams.get("projectList")).toBe(
    "q=Synthetic&importance=high",
  );
  await page
    .getByRole("navigation", { name: "Hooks project resource pages" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Older subscription" }),
  ).toBeVisible();
  await expect(
    page.getByText("Via repositories", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Shared subscription" }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        calls.filter((call) => call.name === "project_resources").at(-1)?.input
          .cursor,
    )
    .toBeNull();
  expect(
    calls.some((call) =>
      /^(hooks_|monitoring_|secrets_|activity_)/.test(call.name),
    ),
  ).toBe(false);
  expect(calls.some((call) => call.name === "workspace_snapshot")).toBe(false);
});

test("monitor project associations use HQ metadata without preparing a provider operation", async ({
  page,
}) => {
  const monitor = await mockMonitoring(page);
  await projectContext(page);
  const state = await association(
    page,
    "monitor",
    MONITOR_CONNECTION.id,
    MONITOR_TARGET.id,
  );
  await page.goto(
    "/monitoring?workspace=development&project=" +
      PROJECT.id +
      "&connection=" +
      MONITOR_CONNECTION.id +
      "&target=" +
      MONITOR_TARGET.id,
  );
  const target = page.getByRole("dialog");
  await expect(
    target.getByRole("heading", { name: MONITOR_TARGET.id, exact: true }),
  ).toBeVisible();
  await target
    .getByRole("button", { name: "Project association", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Project association",
    exact: true,
  });
  await expect(
    editor.getByRole("combobox", { name: "Primary project", exact: true }),
  ).toHaveText(PROJECT.name);
  await editor
    .getByRole("button", { name: "Save association", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  expect(state.saved).toMatchObject({
    kind: "monitor",
    projectId: PROJECT.id,
    projectRevision: PROJECT.revision,
    connectionRevision: 1,
    revision: 0,
  });
  expect(
    monitor.calls.some(
      (call) => call.name.includes("prepare") || call.name.includes("apply"),
    ),
  ).toBe(false);
});

test("Secrets deep links select the exact resource, allow metadata-only project linking, and fail visibly for unknown targets", async ({
  page,
}) => {
  const secrets = await mockSecrets(page);
  const chosen = {
    id: "second-resource",
    label: "example/second-resource",
    repositoryIds: [],
  };
  const connection = {
    ...SECRET_CONNECTION,
    id: "second-connection",
    name: "Second connection",
    resourceIds: [chosen.id],
    resources: [chosen],
  };
  secrets.connections.push(connection);
  await projectContext(page);
  const state = await association(page, "secret", connection.id, chosen.id);
  const url =
    "/secrets?workspace=development&project=" +
    PROJECT.id +
    "&connection=" +
    connection.id +
    "&resource=" +
    chosen.id +
    "&projectList=" +
    encodeURIComponent("q=Synthetic&sort=name&workspace=ignored");
  await page.goto(url);
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  expect(
    secrets.calls.find((call) => call.name === "secrets_inventory")?.input,
  ).toMatchObject({
    connectionId: connection.id,
    target: { resourceId: chosen.id },
  });
  await page
    .getByRole("button", { name: "Project association", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Project association",
    exact: true,
  });
  await expect(
    editor.getByRole("combobox", { name: "Primary project", exact: true }),
  ).toHaveText(PROJECT.name);
  await editor
    .getByRole("button", { name: "Save association", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  expect(state.saved).toMatchObject({
    kind: "secret",
    connectionId: connection.id,
    resourceKey: chosen.id,
    projectId: PROJECT.id,
    projectRevision: PROJECT.revision,
  });
  expect(secrets.writes).toBe(0);
  expect(secrets.values).toEqual([]);
  const before = secrets.calls.filter(
    (call) => call.name === "secrets_inventory",
  ).length;
  await page.goto(url.replace("resource=" + chosen.id, "resource=unknown"));
  await expect(
    page.getByText(
      "The selected connection and resource are not available for reading.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Project association", exact: true }),
  ).toBeDisabled();
  expect(
    secrets.calls.filter((call) => call.name === "secrets_inventory"),
  ).toHaveLength(before);
  await page.getByRole("link", { name: PROJECT.name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: PROJECT.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Projects", exact: true })
    .last()
    .click();
  await expect(page).toHaveURL(
    /\/projects\?workspace=development&q=Synthetic&sort=name$/,
  );
  await expect(
    page.getByRole("textbox", { name: "Search projects" }),
  ).toHaveValue("Synthetic");
});
