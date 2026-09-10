import { expect, test } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";

test("invite validation, failure recovery, cancellation and reviewed revocation", async ({
  page,
}) => {
  await page.goto("/settings/members");
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(dialog.getByRole("alert")).toContainText("valid email");
  await expect(dialog.getByLabel("Email address")).toBeFocused();
  const email = "browser-" + Date.now() + "@example.test";
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Operator", exact: true }).click();
  await page.route(
    "**/api/commands/invitation_create",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "unavailable",
            message: "Synthetic interruption. Your draft is still here.",
          },
        }),
      }),
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Synthetic interruption",
  );
  await expect(dialog.getByLabel("Email address")).toHaveValue(email);
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(dialog).not.toBeVisible();
  const invitation = page.getByRole("article", { name: email, exact: true });
  await expect(invitation).toContainText("Operator access");
  await expect(page.getByRole("status")).toContainText("no email was sent");
  await invitation.getByRole("button", { name: "Revoke", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    invitation.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeFocused();
  await invitation.getByRole("button", { name: "Revoke", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(invitation).toContainText("revoked");
  await page.reload();
  await expect(invitation).toContainText("revoked");
});

test("role draft survives conflicts, requires a fresh review, and removal preserves the owner", async ({
  page,
  request,
}) => {
  await page.goto("/settings/members");
  const member = page.getByRole("article", {
    name: "Synthetic member",
    exact: true,
  });
  await member.getByRole("button", { name: "Change role" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Role", exact: true }).click();
  await page.getByRole("option", { name: "Owner", exact: true }).click();
  const response = await request.post("/api/commands/member_update", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: "development",
      subject: "synthetic-member",
      revision: 1,
      role: "operator",
    },
  });
  expect(response.ok()).toBeTruthy();
  await dialog.getByRole("button", { name: "Save role" }).click();
  await expect(dialog.getByRole("alert")).toContainText("draft is preserved");
  await expect(
    dialog.getByRole("combobox", { name: "Role", exact: true }),
  ).toContainText("Owner");
  await expect(
    dialog.getByRole("button", { name: "Save role" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Review latest access" }).click();
  await expect(dialog).toContainText("Reviewed role: Operator");
  await dialog.getByRole("button", { name: "Save role" }).click();
  await expect(member).toContainText("Owner");
  await member.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toContainText("revokes its workspace credentials");
  await dialog
    .getByRole("button", { name: "Remove member", exact: true })
    .click();
  await expect(member).not.toBeVisible();
  const owner = page.getByRole("article", {
    name: "Local maintainer",
    exact: true,
  });
  await expect(
    owner.getByRole("button", { name: "Remove", exact: true }),
  ).toBeDisabled();
  await expect(
    owner.getByRole("button", { name: "Change role" }),
  ).toBeDisabled();
});

test("mobile invitation form and desktop access are accessible in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/members");
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Email address")).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Invite member", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("owner setup review and account invitations render without inventing membership", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        principal: {
          subject: "synthetic-owner",
          displayName: "owner@example.test",
        },
        workspaces: [],
        development: false,
      },
    }),
  );
  const fingerprint = "a".repeat(64);
  await page.route("**/api/commands/setup_status", (route) =>
    route.fulfill({
      json: {
        state: "ready",
        fingerprint,
        workspaceId: "synthetic-workspace",
        workspaceName: "Synthetic workspace",
        owner: "owner@example.test",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    }),
  );
  await page.route("**/api/commands/invitations_mine", (route) =>
    route.fulfill({
      json: [
        {
          id: "synthetic-invitation",
          role: "viewer",
          revision: 1,
          workspaceName: "Invited workspace",
          workspaceId: "invited",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      ],
    }),
  );
  await page.route("**/api/commands/setup_apply", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ fingerprint });
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: "setup_expired",
          message: "The setup approval expired. Review setup again.",
        },
      },
    });
  });
  await page.goto("/activity");
  await expect(
    page.getByRole("heading", { name: "Find your workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create workspace", exact: true }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: /accept responsibility/ }).check();
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("approval expired");
  await expect(
    page.getByRole("button", { name: "Join workspace", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
