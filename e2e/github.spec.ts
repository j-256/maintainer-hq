import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  CAPABILITY,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import type { GitHubSource, GitHubRefresh } from "../shared/github";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import { mockWorkspaceView } from "./workspace-fixture";

const workspaceId = "development";
async function api<T>(
  request: APIRequestContext,
  command: string,
  data: unknown,
) {
  const response = await request.post("/api/commands/" + command, {
    headers: { "X-HQ-Client": "cli" },
    data,
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}
async function repository(request: APIRequestContext) {
  return api<Repository>(request, "repository_create", {
    workspaceId,
    repository: {
      fullName: "example/github-" + crypto.randomUUID(),
      description: "Synthetic GitHub browser fixture",
      projectId: "development-default",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
}
const fields = (repositoryId: string, name: string) => ({
  name,
  enabled: true,
  freshnessMinutes: 30,
  refreshIntervalMinutes: 15,
  repositoryIds: [repositoryId],
  credentialRef: null,
});
async function settle(page: Page) {
  await page.getByRole("dialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
}

test("GitHub connection form validates, saves without credentials, and retains conflicting drafts", async ({
  page,
  request,
}) => {
  const repo = await repository(request);
  const name = "Browser GitHub " + crypto.randomUUID();
  await page.goto("/settings/github?view=connections");
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await settle(page);
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog.getByLabel("Connection name")).toBeFocused();
  await expect(
    dialog.getByText("Enter a name for this GitHub source"),
  ).toBeVisible();
  await dialog.getByLabel("Connection name").fill(name);
  await dialog.getByLabel("Find GitHub repositories").fill(repo.fullName);
  await dialog
    .getByRole("checkbox", { name: repo.fullName, exact: true })
    .check();
  await dialog
    .getByLabel("Consider evidence stale after", { exact: true })
    .fill("10");
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(
    dialog.getByText(
      "Allow at least two refresh intervals before evidence becomes stale",
    ),
  ).toBeVisible();
  await dialog
    .getByLabel("Consider evidence stale after", { exact: true })
    .fill("30");
  await expect(
    dialog.getByText(/A server administrator must provision/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.getByRole("article", { name, exact: true });
  await expect(card.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Refresh GitHub" }),
  ).toBeDisabled();
  await card.getByRole("button", { name: "Refresh history" }).click();
  await expect(
    dialog.getByRole("heading", { name: "No refreshes yet" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Refresh history" }),
  ).toBeFocused();
  await card.getByRole("button", { name: "Edit GitHub settings" }).click();
  await settle(page);
  await dialog.getByLabel("Connection name").fill("Unsaved GitHub draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Discard unsaved changes?",
  );
  await page.getByRole("button", { name: "Keep editing" }).click();
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  const source = snapshot.connections.find((source) => source.name === name)!;
  await api(request, "github_source_update", {
    workspaceId,
    sourceId: source.id,
    revision: source.revision,
    source: { ...fields(repo.id, name), freshnessMinutes: 60 },
  });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Your draft has not been saved",
  );
  await expect(dialog.getByLabel("Connection name")).toHaveValue(
    "Unsaved GitHub draft",
  );
  await dialog
    .getByRole("button", { name: "Discard draft and load latest" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog.getByLabel("Connection name")).toHaveValue(name);
  await expect(
    dialog.getByLabel("Consider evidence stale after", { exact: true }),
  ).toHaveValue("60");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

for (const interruption of ["network", "body"]) {
  test(`an interrupted ${interruption} enrollment preserves the draft and retries the same source identity`, async ({
    page,
    request,
  }) => {
    const repo = await repository(request);
    const name = "Interrupted GitHub " + crypto.randomUUID();
    const ids: string[] = [];
    let first = true;
    await page.route("**/api/commands/github_source_enroll", async (route) => {
      ids.push(route.request().postDataJSON().sourceId);
      if (first) {
        first = false;
        await route.fetch();
        if (interruption === "network") await route.abort("failed");
        else await route.fulfill({
          contentType: "application/json",
          body: "synthetic-private-response-canary",
        });
      } else await route.continue();
    });
    await page.goto("/settings/github?view=connections");
    await page
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Connection name").fill(name);
    await dialog.getByLabel("Find GitHub repositories").fill(repo.fullName);
    await dialog
      .getByRole("checkbox", { name: repo.fullName, exact: true })
      .check();
    await dialog.getByRole("button", { name: "Save connection" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    if (interruption === "body") {
      await expect(dialog.getByRole("alert")).toContainText(
        "A write may have succeeded",
      );
      await expect(dialog.getByRole("alert")).not.toContainText(
        "synthetic-private-response-canary",
      );
    }
    await expect(dialog.getByLabel("Connection name")).toHaveValue(name);
    await dialog.getByRole("button", { name: "Save connection" }).click();
    await expect(dialog).toHaveCount(0);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(1);
    const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
      workspaceId,
    });
    expect(
      snapshot.connections.filter((source) => source.name === name),
    ).toHaveLength(1);
  });
}

test("synthetic refresh receipts expose incomplete coverage, cancellation, and repository provenance", async ({
  page,
  request,
}) => {
  const repo = await repository(request);
  const source = await api<GitHubSource>(request, "github_source_enroll", {
    workspaceId,
    sourceId: crypto.randomUUID(),
    source: fields(repo.id, "Synthetic online GitHub"),
  });
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  const shown: GitHubSource = { ...source, credentialConfigured: true };
  let receipt: GitHubRefresh | null = null;
  const now = new Date().toISOString();
  await mockWorkspaceView(page, () => ({ ...snapshot, connections: [shown] }));
  await page.route("**/api/commands/github_refresh", async (route) => {
    const input = route.request().postDataJSON();
    receipt = {
      id: input.refreshId,
      sourceId: source.id,
      sourceRevision: 1,
      actor: "Synthetic operator",
      trigger: "manual",
      status: "running",
      summary: "Synthetic interrupted collection",
      createdAt: now,
      completedAt: null,
      total: 1,
      finished: 0,
      items: [
        {
          repositoryId: repo.id,
          fullName: repo.fullName,
          status: "running",
          attempts: 1,
          summary: "Reading GitHub evidence",
          updatedAt: now,
          observedAt: null,
          evidence: null,
          diagnostics: null,
        },
      ],
    };
    await route.fulfill({ json: receipt });
  });
  await page.route("**/api/commands/github_refreshes_list", (route) =>
    route.fulfill({ json: receipt ? [receipt] : [] }),
  );
  await page.route("**/api/commands/github_refresh_get", (route) =>
    route.fulfill({ json: receipt }),
  );
  await page.route("**/api/commands/github_refresh_cancel", async (route) => {
    expect(route.request().postDataJSON().refreshId).toBe(receipt!.id);
    receipt = {
      ...receipt!,
      status: "cancelled",
      summary: "Synthetic cancellation accepted",
      completedAt: now,
      finished: 1,
      items: receipt!.items!.map((item) => ({ ...item, status: "cancelled" })),
    };
    await route.fulfill({ json: receipt });
  });
  await page.goto("/settings/github?view=connections");
  await page
    .getByRole("button", { name: "Refresh GitHub", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("0 / 1 repositories finished")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Cancel refresh", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel refresh", exact: true })
    .click();
  await expect(
    dialog.getByText("Synthetic cancellation accepted"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel refresh", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const evidence = {
    defaultBranch: "main",
    headSha: "a".repeat(40),
    checks: GITHUB_CHECK_KEYS.map((key) => ({
      key,
      state:
        key === "secretScanning"
          ? ("unavailable" as const)
          : ("observed" as const),
      summary:
        key === "secretScanning"
          ? "Permission is unavailable; no clean result can be inferred"
          : "Synthetic observed result",
    })),
  };
  receipt = {
    ...receipt!,
    id: crypto.randomUUID(),
    status: "partial",
    summary: "Some GitHub evidence is unavailable",
    finished: 1,
    items: [
      {
        repositoryId: repo.id,
        fullName: repo.fullName,
        status: "partial",
        attempts: 1,
        summary: "Secret scanning unavailable",
        updatedAt: now,
        observedAt: now,
        evidence,
        diagnostics: {
          elapsedMs: 2400,
          requests: 7,
          pages: 4,
          endpoints: GITHUB_CHECK_KEYS.map((key) => ({
            key,
            requests: 1,
            pages: [
              "checks",
              "statuses",
              "dependabot",
              "codeScanning",
            ].includes(key)
              ? 1
              : 0,
            reason: key === "secretScanning" ? "permission" : "complete",
          })),
        },
      },
    ],
  };
  shown.github.lastRefreshId = receipt.id;
  shown.github.lastRefreshStatus = "partial";
  snapshot.observations = [
    {
      sourceId: source.id,
      resourceType: "repository",
      resourceId: repo.id,
      name: repo.fullName,
      provider: "github",
      health: "unknown",
      summary: receipt.summary,
      observedAt: now,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      receivedAt: now,
      details: { ci: "passing", github: evidence },
    },
  ];
  await page.getByRole("button", { name: "Refresh view" }).click();
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Permission is unavailable; no clean result can be inferred",
    ),
  ).toBeVisible();
  await settle(page);
  const diagnostics = dialog.locator(".github-diagnostics summary");
  await expect(diagnostics).toHaveText(
    "Collection diagnostics: 7 requests, 4 list pages, 2.4s elapsed",
  );
  await diagnostics.focus();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByText(/Access or feature unavailable. 1 request started/),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Refresh reference", { exact: true }),
  ).toHaveValue(receipt.id);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(
        (theme) =>
          document.documentElement.classList.toggle("dark", theme === "dark"),
        theme,
      );
      await settle(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
    }
  }
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("article", { name: source.name, exact: true })
    .locator(".source-scope-summary > summary")
    .click();
  await page
    .getByRole("article", { name: source.name, exact: true })
    .getByRole("link", { name: repo.fullName, exact: true })
    .click();
  await page.locator(".repository-full-evidence > summary").click();
  await expect(
    page.getByText(
      "Permission is unavailable; no clean result can be inferred",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Observed evidence" }),
  ).toContainText("Coverage incomplete");
});

test("GitHub settings remain accessible on mobile in both themes and explain viewer limits", async ({
  page,
  request,
}) => {
  const repo = await repository(request);
  const name = "Mobile GitHub " + crypto.randomUUID();
  await api(request, "github_source_enroll", {
    workspaceId,
    sourceId: crypto.randomUUID(),
    source: fields(repo.id, name),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/github?view=connections");
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await settle(page);
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      dialog.getByRole("button", { name: "Save connection" }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("github-settings-mobile-" + theme + ".png"),
    });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("heading", { name: "Connect GitHub", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  await mockWorkspaceView(page, () => ({
    ...snapshot,
    capabilities: [CAPABILITY.READ],
    workspace: { ...snapshot.workspace, role: "viewer" },
  }));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Only workspace owners can configure GitHub connections."),
  ).toBeVisible();
  const card = page.getByRole("article", {
    name,
    exact: true,
  });
  await expect(
    card.getByRole("button", { name: "Edit GitHub settings" }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Refresh GitHub" }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Refresh history" }),
  ).toBeEnabled();
});
