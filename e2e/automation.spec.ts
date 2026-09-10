import { test, expect, type APIRequestContext } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { CAPABILITY } from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";
import type { AutomationCredential } from "../shared/automation";

const workspaceId = "development";
async function credentials(request: APIRequestContext) {
  const response = await request.post(
    "/api/commands/automation_credentials_list",
    { headers: { "X-HQ-Client": "cli" }, data: { workspaceId } },
  );
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<AutomationCredential[]>;
}

test("automation review, one-time value, navigation guard, live reporting, and revocation", async ({
  page,
  request,
}) => {
  const name = "Browser reporter " + Date.now();
  await page.goto("/settings/automation");
  await page
    .getByRole("button", { name: "Create automation credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review permissions" }).click();
  await expect(
    dialog.getByLabel("Credential name", { exact: true }),
  ).toBeFocused();
  await dialog.getByLabel("Credential name", { exact: true }).fill(name);
  await dialog.getByLabel("Reporter ID").fill("browser-reporter");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(
    dialog.getByLabel("Credential name", { exact: true }),
  ).toHaveValue(name);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Review permissions" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Review automation access" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Exact permissions: activity:write, goals:write"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await expect(dialog.getByLabel("Reporter ID")).toHaveValue(
    "browser-reporter",
  );
  await dialog.getByRole("button", { name: "Review permissions" }).click();
  await dialog
    .getByRole("button", { name: "Create reviewed credential" })
    .click();
  const value = dialog.getByLabel("Automation credential value");
  await expect(value).toHaveAttribute("type", "password");
  const token = await value.inputValue();
  expect(/^hqa_[a-f0-9]{64}$/.test(token)).toBeTruthy();
  await dialog.getByRole("button", { name: "Reveal value" }).click();
  await expect(value).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "Hide value" }).click();
  await expect(value).toHaveAttribute("type", "password");
  expect(
    await page.evaluate(
      (secret) =>
        !Object.values(localStorage)
          .concat(Object.values(sessionStorage))
          .some((item) => String(item).includes(secret)),
      token,
    ),
  ).toBeTruthy();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Have you saved the credential?",
  );
  await page.getByRole("button", { name: "Keep credential open" }).click();
  const goal = {
    workspaceId,
    goalId: "automation-browser-goal-" + Date.now(),
    sourceId: "browser-reporter",
    objective: "  Browser reporter /goal\nExactly as written.  ",
    status: "active",
    startedAt: new Date().toISOString(),
    reportedAt: new Date().toISOString(),
  };
  const response = await request.post("/api/commands/goal_sync", {
    headers: { Authorization: "Bearer " + token },
    data: goal,
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).objective).toBe(goal.objective);
  const denied = await request.post("/api/commands/workspace_snapshot", {
    headers: { Authorization: "Bearer " + token },
    data: { workspaceId },
  });
  expect(denied.status()).toBe(403);
  await dialog
    .getByRole("button", { name: "I have saved the credential" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Create automation credential",
      exact: true,
    }),
  ).toBeFocused();
  const record = (await credentials(request)).find(
    (credential) => credential.name === name,
  )!;
  expect(record.reporterId).toBe("browser-reporter");
  await page
    .getByRole("button", { name: "Revoke " + name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Revoke " + name, exact: true }),
  ).toBeDisabled();
  const revoked = await request.post("/api/commands/goal_sync", {
    headers: { Authorization: "Bearer " + token },
    data: goal,
  });
  expect(revoked.status()).toBe(401);
});

test("lost issuance response offers inspection and revocation without re-revealing a value", async ({
  page,
  request,
}) => {
  const name = "Lost browser value " + Date.now();
  await page.route(
    "**/api/commands/automation_credential_issue",
    async (route) => {
      await route.fetch();
      await route.abort("failed");
    },
  );
  await page.goto("/settings/automation");
  await page
    .getByRole("button", { name: "Create automation credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Credential name", { exact: true }).fill(name);
  await dialog.getByRole("combobox", { name: "Permission profile" }).click();
  await page.getByRole("option", { name: "Reader", exact: true }).click();
  await expect(dialog.getByLabel("Reporter ID")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Review permissions" }).click();
  await expect(
    dialog.getByText("Exact permissions: read", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Create reviewed credential" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Inspect the credential list",
  );
  await expect(dialog.getByLabel("Automation credential value")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Inspect credential list" }).click();
  expect(
    (await credentials(request)).find((credential) => credential.name === name)
      ?.revokedAt,
  ).toBeNull();
  await page
    .getByRole("button", { name: "Revoke " + name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (await credentials(request)).find((credential) => credential.name === name)
      ?.revokedAt,
  ).toBeTruthy();
});

test("expired reviews preserve drafts, and viewers receive an explicit permission notice", async ({
  page,
}) => {
  await page.route(
    "**/api/commands/automation_credential_plan",
    async (route) => {
      const input = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ...input,
          actor: "Synthetic owner",
          workspaceName: "Synthetic workspace",
          planId: "expired",
          fingerprint: "0".repeat(64),
          scopes: [CAPABILITY.ACTIVITY, CAPABILITY.GOALS],
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      });
    },
  );
  await page.goto("/settings/automation");
  await page
    .getByRole("button", { name: "Create automation credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Credential name", { exact: true })
    .fill("Preserved draft");
  await dialog.getByLabel("Reporter ID").fill("preserved-reporter");
  await dialog.getByRole("button", { name: "Review permissions" }).click();
  await expect(dialog.getByRole("alert")).toContainText("This review expired");
  await expect(
    dialog.getByRole("button", { name: "Create reviewed credential" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Back to edit" }).click();
  await expect(
    dialog.getByLabel("Credential name", { exact: true }),
  ).toHaveValue("Preserved draft");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role: "viewer" },
    capabilities: [CAPABILITY.READ],
  }));
  await page.reload();
  await expect(
    page.getByText(
      "Only a workspace owner can review or manage automation credentials.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Create automation credential",
      exact: true,
    }),
  ).toHaveCount(0);
});
