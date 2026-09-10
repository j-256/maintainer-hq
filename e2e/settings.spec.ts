import { test, expect } from "./test-fixture";

test("settings preserve open drafts across workspace refreshes without duplicate keys", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  let snapshots = 0;
  let updates = 0;
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      if (String(payload).includes('"type":"update"')) updates++;
    }),
  );
  page.on("response", (response) => {
    if (response.url().endsWith("/api/commands/workspace_view")) snapshots++;
  });
  await page.goto("/settings/automation");
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("button", { name: "Create automation credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("Credential name", { exact: true });
  await name.fill("Preserve this draft across a refresh");
  const previous = updates;
  const changed = await request.post("/api/commands/invitation_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: "development",
      invitationId: crypto.randomUUID(),
      email: "draft-refresh-" + crypto.randomUUID() + "@example.test",
      role: "viewer",
      expiresInDays: 1,
    },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await expect
    .poll(() => updates, { timeout: 10000 })
    .toBeGreaterThan(previous);
  expect(snapshots).toBe(1);
  await expect(name).toHaveValue("Preserve this draft across a refresh");
  expect(errors).toEqual([]);
});
