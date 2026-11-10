import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./test-fixture";
import { mockGitHubApps } from "./github-apps-fixture";
const BASE = "/settings/github?workspace=development&view=authentication";
test("keeps advanced token setup available without an App", async ({
  page,
}) => {
  await mockGitHubApps(page, { empty: true });
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Advanced token configuration", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Credential reference", { exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    dialog.getByRole("button", { name: "Save connection", exact: true }),
  ).toBeEnabled();
});
test("guides a deployment operator through registration and separate workspace acceptance", async ({
  page,
}) => {
  const state = await mockGitHubApps(page, { empty: true });
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Register a GitHub App", exact: true })
    .click();
  await page
    .getByLabel("App name", { exact: true })
    .fill("My repository operator");
  await page.getByLabel("GitHub account", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "Prepare GitHub registration", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Continue to GitHub", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.find((call) => call.name === "github_app_manifest_start")?.input
      .name,
  ).toBe("My repository operator");
  expect(
    state.calls.some((call) => call.name === "github_app_grant_accept"),
  ).toBe(false);
});
test("requires workspace-owner acceptance of the exact offered repository scope", async ({
  page,
}) => {
  const state = await mockGitHubApps(page, { offer: true });
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Review workspace grant", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Workspace grant review" }),
  ).toContainText("example/project");
  await page
    .getByRole("button", { name: "Accept workspace grant", exact: true })
    .click();
  await expect(
    page.getByText("grant-development", { exact: true }).first(),
  ).toBeVisible();
  expect(
    state.calls.filter((call) => call.name === "github_app_grant_accept"),
  ).toHaveLength(1);
});
test("keeps an import draft after a concurrent registration conflict", async ({
  page,
}) => {
  const state = await mockGitHubApps(page, { empty: true });
  state.conflict = true;
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import existing App", exact: true })
    .click();
  await page.getByLabel("App name", { exact: true }).fill("Preserve my draft");
  await page.getByLabel("GitHub App ID", { exact: true }).fill("42");
  await page
    .getByRole("button", { name: "Review registration", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await expect(page.getByLabel("App name", { exact: true })).toHaveValue(
    "Preserve my draft",
  );
});
test("uses a paged repository picker and explains missing installation permissions", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  state.missingPermission = true;
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Offer workspace grant", exact: true })
    .first()
    .click();
  await page
    .getByRole("combobox", { name: "Installation", exact: true })
    .selectOption("91");
  await expect(
    page.getByText("Missing approved permissions", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByLabel("example/project", { exact: true }),
  ).toBeVisible();
});
test("offers protected recovery for an interrupted callback without retrying conversion", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  await page.goto(
    "/settings?workspace=development&githubAppOutcome=indeterminate&githubAppAttempt=attempt&githubAppWorkspace=development",
  );
  await page
    .getByRole("link", { name: "Inspect App registration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Registration recovery", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.some((call) => call.name === "github_app_manifest_start"),
  ).toBe(false);
});
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`authentication is accessible in ${theme} at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      const fixture = await mockGitHubApps(page, { offer: true });
      fixture.offers[0].repositories.push({
        id: 102,
        fullName: "example/" + "long-identifier-".repeat(7),
        ownerId: 50,
        private: true,
      });
      await page.goto(BASE);
      await expect(
        page.getByRole("heading", {
          name: "Workspace App access",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath("authentication.png") });
    });
test("lets one operator review and accept a same-workspace offer without skipping either authorization", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Offer workspace grant", exact: true })
    .first()
    .click();
  await page
    .getByRole("combobox", { name: "Installation", exact: true })
    .selectOption("91");
  await page
    .getByRole("checkbox", { name: "example/project", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Review workspace offer", exact: true })
    .click();
  expect(
    state.calls.some((call) => call.name === "github_app_grant_accept"),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Accept workspace grant", exact: true })
    .click();
  expect(
    state.calls.filter((call) => call.name === "github_app_grant_plan"),
  ).toHaveLength(1);
  expect(
    state.calls.filter((call) => call.name === "github_app_grant_accept"),
  ).toHaveLength(1);
  await expect(
    page.getByText("Workspace grant accepted.", { exact: false }),
  ).toBeVisible();
});
test("shows rotation impact and keeps protected input outside ordinary controls", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review key rotation", exact: true })
    .click();
  await expect(
    page.getByText("This change affects the following workspaces:", {
      exact: false,
    }),
  ).toContainText("other-workspace");
  await expect(page.getByLabel("Private App input file")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Supply protected App material" }),
  ).toBeDisabled();
  expect(JSON.stringify(state.calls)).not.toMatch(
    /privateKey|webhookSecret|BEGIN PRIVATE/,
  );
});
test("limits viewers to explanatory access guidance", async ({ page }) => {
  const state = await mockGitHubApps(page, { viewer: true });
  await page.goto(BASE);
  await expect(
    page.getByRole("button", { name: "Manage deployment Apps", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeDisabled();
  expect(
    state.calls.some((call) =>
      ["github_app_grant_list", "github_app_connection_requests_list"].includes(
        call.name,
      ),
    ),
  ).toBe(false);
});
test("opens App setup from a connection editor after honoring its draft guard", async ({
  page,
}) => {
  await mockGitHubApps(page, { empty: true });
  await page.goto("/settings/github?workspace=development&view=connections");
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Connection name")
    .fill("Preserve or discard explicitly");
  await dialog
    .getByRole("link", { name: "Manage App access", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0, { timeout: 3000 });
  await expect(
    page.getByRole("heading", { name: "Workspace App access", exact: true }),
  ).toBeVisible();
});
test("moves keyboard focus into inline setup and review steps", async ({
  page,
}) => {
  await mockGitHubApps(page, { offer: true });
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Review workspace grant", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workspace grant review", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Close grant review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Register a GitHub App", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Register a GitHub App", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("App name", { exact: true })).toBeFocused();
});
test("restores the same protected registration review after a browser reload without replanning", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review key rotation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Registration review", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Registration review", exact: true }),
  ).toBeVisible({ timeout: 3000 });
  expect(
    state.calls.filter((call) => call.name === "github_app_registration_plan"),
  ).toHaveLength(1);
  expect(
    state.calls.some((call) => call.name === "github_app_registration_get"),
  ).toBe(true);
});
test("guards a selected private App file while retaining the exact recovery URL", async ({
  page,
}) => {
  const state = await mockGitHubApps(page);
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review key rotation", exact: true })
    .click();
  await page.getByLabel("Private App input file").setInputFiles({
    name: "synthetic-app.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ version: 1, privateKey: "synthetic-not-a-real-key" }),
    ),
  });
  const reviewUrl = page.url();
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  expect(page.url()).toBe(reviewUrl);
  await expect(page.getByLabel("Private App input file")).toHaveValue(
    /synthetic-app\.json$/,
  );
  expect(JSON.stringify(state.calls)).not.toContain("synthetic-not-a-real-key");
});
test("restores an accepted workspace grant receipt without applying it again", async ({
  page,
}) => {
  const state = await mockGitHubApps(page, { offer: true });
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Review workspace grant", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Accept workspace grant", exact: true })
    .click();
  await expect(
    page.getByText("Workspace grant accepted.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Workspace grant review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept workspace grant", exact: true }),
  ).toBeDisabled();
  expect(
    state.calls.filter((call) => call.name === "github_app_grant_accept"),
  ).toHaveLength(1);
});
test("hides operator review metadata after workspace ownership is lost", async ({
  page,
}) => {
  const options = { viewer: false };
  await mockGitHubApps(page, options);
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Manage deployment Apps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review key rotation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Registration review", exact: true }),
  ).toBeVisible();
  options.viewer = true;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Registration review", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Private App input file")).toHaveCount(0);
});
