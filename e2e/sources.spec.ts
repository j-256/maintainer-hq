import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspaceView } from "./workspace-fixture";
import {
  DEFAULT_EXPECTATIONS,
  type Connection,
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
  expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}
async function enrollRepository(request: APIRequestContext, prefix: string) {
  return api<Repository>(request, "repository_create", {
    workspaceId,
    repository: {
      fullName: "example/" + prefix + "-" + crypto.randomUUID(),
      description: "Synthetic browser fixture",
      projectId: "development-default",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
}
async function enrollSource(
  request: APIRequestContext,
  repositoryId: string,
  name: string,
) {
  return api<Connection>(request, "source_enroll", {
    workspaceId,
    sourceId: crypto.randomUUID(),
    source: {
      name,
      repositoryIds: [repositoryId],
      freshnessMinutes: 5,
      enabled: true,
    },
  });
}
async function settleDialog(page: Page) {
  await page.getByRole("dialog").evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
}

test("publisher enrollment, one-time credential, stale reports, refresh, and revocation", async ({
  page,
  request,
}) => {
  const repository = await enrollRepository(request, "publisher");
  const name = "Browser publisher " + crypto.randomUUID();
  await page.goto("/settings/publishers");
  await page
    .getByRole("button", { name: "Enroll publisher", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Enroll publisher", exact: true })
    .click();
  await expect(
    dialog.getByText("Enter a name for this publisher"),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Publisher name", { exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Publisher name", { exact: true }).fill(name);
  await dialog
    .getByLabel("Find repositories to allow")
    .fill(repository.fullName);
  await dialog
    .getByRole("checkbox", { name: repository.fullName, exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Enroll publisher", exact: true })
    .click();
  const card = page.getByRole("article", { name, exact: true });
  await expect(card.getByText("No active credential")).toBeVisible();
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  const source = snapshot.connections.find((item) => item.name === name)!;
  await card.getByRole("button", { name: "Credentials", exact: true }).click();
  await dialog
    .getByLabel("Credential name", { exact: true })
    .fill("Browser test credential");
  await dialog
    .getByRole("button", { name: "Create publisher credential" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Save this credential now" }),
  ).toBeVisible();
  const token = await dialog
    .getByLabel("Publisher credential value")
    .inputValue();
  expect(/^hqp_[a-f0-9]{64}$/.test(token)).toBe(true);
  await expect(dialog.getByLabel("Publisher credential value")).toHaveAttribute(
    "type",
    "password",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Have you saved the credential?",
  );
  await page.getByRole("button", { name: "Keep credential open" }).click();
  await dialog
    .getByRole("button", { name: "I have saved the credential" })
    .click();
  await expect(dialog.getByLabel("Publisher credential value")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Credentials", exact: true }),
  ).toBeFocused();
  await expect(card.getByText("Awaiting first report")).toBeVisible();
  const send = (input: unknown) =>
    request.post("/api/commands/observations_publish", {
      headers: { Authorization: "Bearer " + token },
      data: input,
    });
  const payload = {
    workspaceId,
    sourceId: source.id,
    reportId: crypto.randomUUID(),
    observations: [
      {
        repositoryId: repository.id,
        branch: "main",
        dirty: false,
        ahead: 0,
        observedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
  };
  expect((await send(payload)).status()).toBe(200);
  await expect(card.getByText("Reports stale")).toBeVisible({ timeout: 10000 });
  expect((await send(payload)).status()).toBe(200);
  await page.getByRole("button", { name: "Refresh view" }).click();
  await expect(card.getByText("Reports stale")).toBeVisible();
  const fresh = {
    ...payload,
    reportId: crypto.randomUUID(),
    observations: [
      { ...payload.observations[0], observedAt: new Date().toISOString() },
    ],
  };
  await expect(async () =>
    expect((await send(fresh)).status()).toBe(200),
  ).toPass({ timeout: 10000, intervals: [1000] });
  await expect(card.getByText("Reports current")).toBeVisible({
    timeout: 10000,
  });
  await card
    .getByRole("link", { name: repository.fullName, exact: true })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^Expectation check/ })
    .click();
  await expect(page.getByText("CI has not been verified")).toBeVisible();
  await page.goto("/settings/publishers");
  await card.getByRole("button", { name: "Credentials", exact: true }).click();
  await dialog
    .getByRole("button", {
      name: "Revoke Browser test credential",
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible();
  expect((await send(fresh)).status()).toBe(401);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(card.getByText("No active credential")).toBeVisible();
});

test("source settings preserve drafts across conflicts, failures, and navigation", async ({
  page,
  request,
}) => {
  const repository = await enrollRepository(request, "source-draft");
  const source = await enrollSource(
    request,
    repository.id,
    "Draft publisher " + crypto.randomUUID(),
  );
  await page.goto("/settings/publishers");
  const card = page.getByRole("article", { name: source.name, exact: true });
  await card.getByRole("button", { name: "Edit settings" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Publisher name", { exact: true })
    .fill("Unsaved publisher name");
  await page.keyboard.press("Escape");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Keep editing" })
    .click();
  await expect(
    dialog.getByLabel("Publisher name", { exact: true }),
  ).toHaveValue("Unsaved publisher name");
  await api(request, "source_update", {
    workspaceId,
    sourceId: source.id,
    revision: source.revision,
    source: {
      name: source.name + " updated elsewhere",
      repositoryIds: source.repositoryIds,
      enabled: true,
      freshnessMinutes: 10,
    },
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "This source changed while you were editing",
  );
  await expect(
    dialog.getByLabel("Publisher name", { exact: true }),
  ).toHaveValue("Unsaved publisher name");
  await dialog
    .getByRole("button", { name: "Discard draft and load latest" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Publisher name", { exact: true }),
  ).toHaveValue(source.name + " updated elsewhere");
  await dialog
    .getByLabel("Publisher name", { exact: true })
    .fill(source.name + " retained after failure");
  await page.route("**/api/commands/source_update", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unavailable", message: "Synthetic outage" },
      }),
    }),
  );
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Synthetic outage");
  await expect(
    dialog.getByLabel("Publisher name", { exact: true }),
  ).toHaveValue(source.name + " retained after failure");
  await page.unroute("**/api/commands/source_update");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  const updated = page.getByRole("article", {
    name: source.name + " updated elsewhere",
    exact: true,
  });
  await expect(
    updated.getByRole("button", { name: "Edit settings" }),
  ).toBeFocused();
  await updated.getByRole("button", { name: "Edit settings" }).click();
  await dialog.getByRole("checkbox", { name: /Allow publishing/ }).uncheck();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(updated.getByText("Disabled", { exact: true })).toBeVisible();
});

test("source forms are keyboard-accessible and fit mobile and desktop in both themes", async ({
  page,
  request,
}) => {
  const repository = await enrollRepository(request, "source-accessibility");
  const source = await enrollSource(
    request,
    repository.id,
    "Accessibility publisher " + crypto.randomUUID(),
  );
  for (const width of [1440, 390])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.goto("/settings/publishers");
      await expect(
        page.getByRole("heading", { name: "Local publishers", exact: true }),
      ).toBeVisible();
      await page.evaluate(async (dark) => {
        document.documentElement.classList.toggle("dark", dark);
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished),
        );
      }, dark);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const card = page.getByRole("article", {
        name: source.name,
        exact: true,
      });
      await card.getByRole("button", { name: "Edit settings" }).click();
      await settleDialog(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Cancel", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Save changes", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await expect(
        page.getByLabel("Publisher name", { exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await card
        .getByRole("button", { name: "Credentials", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Create publisher credential" }),
      ).toBeEnabled();
      await settleDialog(page);
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
});

test("non-owners see the source controls with a permission explanation", async ({
  page,
  request,
}) => {
  const snapshot = await api<Snapshot>(request, "workspace_snapshot", {
    workspaceId,
  });
  await mockWorkspaceView(page, () => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role: "viewer" },
    capabilities: ["read"],
  }));
  await page.goto("/settings/publishers");
  await expect(
    page.getByRole("button", { name: "Enroll publisher", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Only workspace owners can enroll sources, change their scope, or manage publisher credentials.",
    ),
  ).toBeVisible();
  for (const button of await page
    .getByRole("button", { name: "Credentials", exact: true })
    .all())
    await expect(button).toBeDisabled();
});
