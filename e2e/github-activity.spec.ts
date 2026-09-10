import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  type Activity,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import type { GitHubSource, GitHubRefresh } from "../shared/github";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import { githubReceiptHref } from "../shared/github-refresh-summary";
import { mockWorkspaceView } from "./workspace-fixture";

const WORKSPACE_ID = "development";
const ACTIVITY_URL = "/activity?workspace=" + WORKSPACE_ID;
const NOW = "2026-09-07T18:30:00.000Z";

async function api<T>(
  request: APIRequestContext,
  name: string,
  input: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE_ID, ...input },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function fixture(page: Page, request: APIRequestContext) {
  const repository = await api<Repository>(request, "repository_create", {
    repository: {
      fullName: "example/receipt-" + crypto.randomUUID(),
      description: "Synthetic receipt navigation fixture",
      projectId: "development-default",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  const source = await api<GitHubSource>(request, "github_source_enroll", {
    sourceId: crypto.randomUUID(),
    source: {
      name: "Synthetic fleet evidence",
      enabled: true,
      freshnessMinutes: 30,
      refreshIntervalMinutes: 15,
      repositoryIds: [repository.id],
      credentialRef: null,
    },
  });
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {});
  await mockWorkspaceView(page, () => ({ ...snapshot, connections: [source] }));
  const receipt: GitHubRefresh = {
    id: crypto.randomUUID(),
    sourceId: source.id,
    sourceRevision: 1,
    actor: "Scheduled GitHub collector",
    trigger: "scheduled",
    status: "partial",
    summary:
      "Evidence changed: CI results. Security coverage remains unavailable.",
    createdAt: NOW,
    completedAt: NOW,
    total: 1,
    finished: 1,
    items: [
      {
        repositoryId: repository.id,
        fullName: repository.fullName,
        status: "partial",
        attempts: 1,
        summary: "Failing CI, unavailable security coverage",
        updatedAt: NOW,
        observedAt: NOW,
        changes: ["ci", "assessment"],
        evidence: {
          checks: GITHUB_CHECK_KEYS.map((key) => ({
            key,
            state: key === "codeScanning" ? "unavailable" : "observed",
            summary:
              key === "codeScanning"
                ? "Feature or permission unavailable"
                : "Observed",
          })),
        },
        diagnostics: {
          elapsedMs: 100,
          requests: 7,
          pages: 5,
          endpoints: GITHUB_CHECK_KEYS.map((key) => ({
            key,
            requests: 1,
            pages: ["repository", "head"].includes(key) ? 0 : 1,
            reason: key === "codeScanning" ? "permission" : "complete",
          })),
        },
      },
    ],
  };
  const event: Activity = {
    id: crypto.randomUUID(),
    type: "github.refresh.partial",
    title: "GitHub refresh completed: " + source.name,
    summary: receipt.summary,
    actor: receipt.actor,
    createdAt: NOW,
    resourceId: null,
    goalId: null,
    githubSourceId: source.id,
    githubSourceName: source.name,
    githubRefreshId: receipt.id,
  };
  let receiptReads = 0;
  let snapshotReads = 0;
  let unavailable = false;
  const requested: object[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/workspace_snapshot")) snapshotReads++;
  });
  await page.route("**/api/commands/activity_feed", (route) =>
    route.fulfill({
      json: {
        groups: [{ kind: "event", event }],
        nextCursor: null,
        viewCursor: "synthetic-page",
      },
    }),
  );
  await page.route("**/api/commands/github_refreshes_list", (route) => {
    receiptReads++;
    return route.fulfill({
      json: [{ ...receipt, id: "newer-receipt", items: undefined }],
    });
  });
  await page.route("**/api/commands/github_refresh_get", (route) => {
    receiptReads++;
    const input = route.request().postDataJSON();
    requested.push(input);
    return unavailable
      ? route.fulfill({
          status: 404,
          json: { error: { code: "not_found", message: "Refresh not found" } },
        })
      : route.fulfill({ json: { ...receipt, id: input.refreshId } });
  });
  return {
    receipt,
    source,
    event,
    requested,
    reads: () => ({ receiptReads, snapshotReads }),
    expire: () => {
      unavailable = true;
    },
  };
}

for (const theme of ["light", "dark"]) {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`Activity receipt keeps context and keyboard focus (${theme}, ${viewport.width})`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      const data = await fixture(page, request);
      await page.goto(ACTIVITY_URL);
      await page
        .getByRole("textbox", { name: "Search activity" })
        .fill("Evidence");
      const link = page.getByRole("link", { name: "View refresh receipt" });
      await expect(link).toBeVisible();
      expect(data.reads()).toEqual({ receiptReads: 0, snapshotReads: 0 });
      await expect(link).toHaveAttribute(
        "href",
        githubReceiptHref(WORKSPACE_ID, data.source.id, data.receipt.id),
      );
      await link.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByText("Access / feature gap", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Changed: CI results, Assessment", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
        data.receipt.id,
      );
      await expect(
        dialog.getByRole("combobox", { name: "Refresh receipt", exact: true }),
      ).not.toBeEmpty();
      expect(new URL(page.url()).pathname).toBe("/activity");
      expect(data.requested).toContainEqual({
        workspaceId: WORKSPACE_ID,
        sourceId: data.source.id,
        refreshId: data.receipt.id,
      });
      const audit = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .analyze();
      expect(audit.violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(link).toBeFocused();
      await expect(
        page.getByRole("textbox", { name: "Search activity" }),
      ).toHaveValue("Evidence");
      expect(data.reads().snapshotReads).toBe(0);
    });
  }
}

test("inline Activity receipt selection preserves the journal URL", async ({
  page,
  request,
}) => {
  await fixture(page, request);
  await page.goto(ACTIVITY_URL);
  const link = page.getByRole("link", { name: "View refresh receipt" });
  await link.click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Refresh receipt", exact: true })
    .click();
  await page.getByRole("option").filter({ hasText: "(scheduled)" }).click();
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    "newer-receipt",
  );
  await expect(page).toHaveURL(new RegExp(ACTIVITY_URL.replace("?", "\\?")));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(link).toBeFocused();
});

test("expired Activity receipt explains retention without losing the journal", async ({
  page,
  request,
}) => {
  const data = await fixture(page, request);
  data.expire();
  await page.goto(ACTIVITY_URL);
  const link = page.getByRole("link", { name: "View refresh receipt" });
  await link.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    "The Activity entry is retained",
  );
  await expect(dialog.getByRole("combobox")).toContainText(
    "Unavailable receipt",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(link).toBeFocused();
  await expect(
    page.getByRole("heading", { name: data.event.title, exact: true }),
  ).toBeVisible();
});

test("direct receipt URLs preserve the exact run across reload, selection and back", async ({
  page,
  request,
}) => {
  const data = await fixture(page, request);
  const url =
    githubReceiptHref(WORKSPACE_ID, data.source.id, data.receipt.id) +
    "&context=retained";
  await page.goto(url);
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    data.receipt.id,
  );
  await page.reload();
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    data.receipt.id,
  );
  await dialog
    .getByRole("combobox", { name: "Refresh receipt", exact: true })
    .click();
  await page.getByRole("option").filter({ hasText: "(scheduled)" }).click();
  await expect(page).toHaveURL(/refresh=newer-receipt/);
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    "newer-receipt",
  );
  await page.goBack();
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    data.receipt.id,
  );
  expect(new URL(page.url()).searchParams.get("refresh")).toBe(data.receipt.id);
  await page.goForward();
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    "newer-receipt",
  );
  await page.goBack();
  await expect(dialog.getByLabel("Refresh reference")).toHaveValue(
    data.receipt.id,
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "GitHub evidence", exact: true }),
  ).toBeFocused();
  const after = new URL(page.url());
  expect(after.searchParams.get("context")).toBe("retained");
  expect(after.searchParams.get("workspace")).toBe(WORKSPACE_ID);
  expect(after.searchParams.has("source")).toBe(false);
  expect(after.searchParams.has("refresh")).toBe(false);
});

test("unavailable or invalid source links cannot fetch an unrelated receipt", async ({
  page,
  request,
}) => {
  const data = await fixture(page, request);
  await page.goto(
    githubReceiptHref(WORKSPACE_ID, "unknown-source", data.receipt.id),
  );
  await expect(page.getByRole("alert")).toContainText(
    "unavailable in this workspace",
  );
  expect(data.reads()).toEqual({ receiptReads: 0, snapshotReads: 0 });
  await page.goto(
    "/settings/github?workspace=" +
      WORKSPACE_ID +
      "&refresh=" +
      data.receipt.id,
  );
  await expect(page.getByRole("alert")).toContainText("incomplete or invalid");
  expect(data.reads().receiptReads).toBe(0);
});
