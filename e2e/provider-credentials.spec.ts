import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./test-fixture";
import { mockProviderCredentials } from "./provider-credentials-fixture";
import { SECRET_RESOURCE } from "./secrets-fixture";

const URL = "/secrets?workspace=development&view=providers";
const PRIVATE = "synthetic-private-provider-browser-canary";
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function audit(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function prepare(page: Page) {
  await page
    .getByRole("button", { name: "Add provider access", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Deployment access");
  await dialog
    .getByLabel("Stop using in HQ (local time)")
    .fill("2099-01-01T12:00");
  await dialog
    .getByRole("checkbox", { name: SECRET_RESOURCE.label, exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Review access", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Provider access review" }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/\bvault\b/i)).toHaveCount(0);
  await expect(
    page.getByText(
      /HQ encrypts this provider credential for future authentication/,
    ),
  ).toBeVisible();
}

test("Owner setup isolates private input and returns to a focused list before enrolling resources", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page, { empty: true });
  await page.goto(URL);
  await prepare(page);
  expect(state.privateInputs).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "Provider access review" }),
  ).toBeFocused();
  await page.getByLabel("Private provider token").fill(PRIVATE);
  const token = page.getByLabel("Private provider token");
  expect(await token.getAttribute("name")).toBeNull();
  expect(await token.getAttribute("value")).toBeNull();
  await page.getByRole("button", { name: "Check review status" }).click();
  await expect(token).toHaveValue(PRIVATE);
  await page
    .getByRole("button", { name: "Save credential with this scope" })
    .click();
  await expect(
    page.getByText("The reviewed credential change is applied.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(token).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Provider access review" }),
  ).toBeFocused();
  expect(state.privateInputs).toEqual([PRIVATE]);
  expect(JSON.stringify(state.calls)).not.toContain(PRIVATE);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(PRIVATE);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Provider access", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Deployment access", exact: true }),
  ).toBeVisible();
  await audit(page);
  await page
    .getByRole("button", { name: "Connect resources", exact: true })
    .click();
  const connection = page.getByRole("dialog");
  await expect(
    connection.getByRole("combobox", {
      name: "Installed provider",
      exact: true,
    }),
  ).toHaveText("Deployment access (read only)");
  await expect(connection.locator('input[type="password"]')).toHaveCount(0);
});

test("an interrupted private submission recovers the same applied receipt without another upload", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page, { empty: true });
  state.loseInputResponse = true;
  await page.goto(URL);
  await prepare(page);
  await page.getByLabel("Private provider token").fill(PRIVATE);
  await page
    .getByRole("button", { name: "Save credential with this scope" })
    .click();
  await expect(page.getByRole("alert")).toContainText("uncertain");
  await expect(page.getByLabel("Private provider token")).toHaveValue("");
  await page.getByRole("button", { name: "Check review status" }).click();
  await expect(
    page.getByText("The reviewed credential change is applied.", {
      exact: false,
    }),
  ).toBeVisible();
  const reviewUrl = page.url();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Deployment access", exact: true }),
  ).toBeVisible();
  await page.goto(reviewUrl);
  await page.reload();
  await expect(
    page.getByText("The reviewed credential change is applied.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(page.url()).toBe(reviewUrl);
  expect(state.privateInputs).toEqual([PRIVATE]);
  expect(state.credentials).toHaveLength(1);
});

test("verification selects configuration kind and scope while preserving honest failure evidence", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page);
  await page.goto(URL);
  await choose(page, "Configuration kind", "Variable values");
  await choose(
    page,
    "GitHub scope",
    "Organization configuration shared with repository",
  );
  await page.getByRole("button", { name: "Verify read access" }).click();
  await expect(
    page.getByText("Variable values were readable", { exact: false }),
  ).toContainText("organization example");
  expect(
    state.calls.find((item) => item.name === "provider_credential_verify")
      ?.input,
  ).toMatchObject({
    entryKind: "variable",
    scope: { kind: "organization", name: "example" },
  });
  await choose(page, "Configuration kind", "Secret metadata");
  await choose(page, "GitHub scope", "Environment configuration");
  await expect(
    page.getByRole("button", { name: "Verify read access" }),
  ).toBeDisabled();
  await page
    .getByLabel("Environment name", { exact: true })
    .fill("Production / Blue");
  await page.getByRole("button", { name: "Verify read access" }).click();
  await expect(
    page.getByText("Secret metadata was readable", { exact: false }),
  ).toContainText("environment Production / Blue");
  await expect(
    page.getByText("This does not verify write permission", { exact: false }),
  ).toBeVisible();
  expect(
    state.calls
      .filter((item) => item.name === "provider_credential_verify")
      .at(-1)?.input.scope,
  ).toEqual({ kind: "environment", name: "Production / Blue" });
  state.verifyFailure = true;
  await page.getByRole("button", { name: "Verify read access" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic provider read unavailable",
  );
  await expect(
    page.getByText("Secret metadata was readable", { exact: false }),
  ).toHaveCount(0);
  expect(state.privateInputs).toEqual([]);
});

test("scope edits preserve drafts on conflicts and retirement requires separate confirmation", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Edit scope or rotate" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Renamed deployment access");
  state.conflict = true;
  await dialog
    .getByRole("button", { name: "Review access", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Keep your draft");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed deployment access",
  );
  state.conflict = false;
  await dialog
    .getByRole("button", { name: "Review access", exact: true })
    .click();
  await expect(page.getByLabel("Private provider token")).toHaveCount(0);
  await page.getByRole("button", { name: "Save reviewed settings" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Renamed deployment access" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review retirement" }).click();
  await expect(
    page.getByText("Retiring Renamed deployment access", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retire credential from HQ", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Keep credential" })
    .click();
  expect(state.credentials[0]?.status).toBe("available");
  await page
    .getByRole("button", { name: "Retire credential from HQ", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Retire from HQ", exact: true })
    .click();
  await expect(
    page.getByText("The credential was retired from HQ.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No UI-managed provider access" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retired credentials", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore with a new token" }),
  ).toBeVisible();
  expect(state.privateInputs).toEqual([]);
});

test("provider access paging and deployment readiness are explicit", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page, { storageReady: false });
  state.extraPage = true;
  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Add provider access", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Private credential storage is not enabled", {
      exact: false,
    }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", {
    name: "Provider credential pages",
  });
  await navigation.getByRole("button", { name: "Next" }).click();
  await expect(
    page.getByRole("heading", { name: "Second access page" }),
  ).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Next" })).toBeDisabled();
  await navigation.getByRole("button", { name: "Previous" }).click();
  await expect(
    page.getByRole("heading", { name: "Product repository access" }),
  ).toBeVisible();
  await audit(page);
});

test("viewers cannot enter credential management even through its URL", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page, { viewer: true });
  await page.goto(URL);
  await expect(
    page.getByRole("heading", { name: "Secrets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add provider access", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Provider access", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Provider access requires an Owner",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.calls).toEqual([]);
  await page
    .getByRole("button", { name: "Browse Secrets inventory", exact: true })
    .click();
  await expect(page).toHaveTitle("Secrets | Development | Maintainer HQ");
  await expect(
    page.getByRole("button", { name: "Inventory", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

for (const theme of ["light", "dark"]) {
  test(
    "mobile " +
      theme +
      " provider forms keep focus, guard private input, and avoid overflow",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      await mockProviderCredentials(page, { empty: true });
      await page.goto(URL);
      await prepare(page);
      await page.getByLabel("Private provider token").fill(PRIVATE);
      await page
        .getByRole("region", { name: "Provider access review", exact: true })
        .getByRole("button", { name: "Provider access", exact: true })
        .click();
      const confirm = page.getByRole("alertdialog");
      await expect(
        confirm.getByRole("heading", { name: "Leave private input?" }),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      expect(
        await confirm.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
      await confirm.getByRole("button", { name: "Keep editing" }).click();
      await expect(page.getByLabel("Private provider token")).toHaveValue(
        PRIVATE,
      );
      expect(
        await page
          .locator("html")
          .evaluate((element) => element.classList.contains("dark")),
      ).toBe(theme === "dark");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await audit(page);
      await page
        .getByRole("region", { name: "Provider access review", exact: true })
        .getByRole("button", { name: "Provider access", exact: true })
        .click();
      await confirm.getByRole("button", { name: "Leave review" }).click();
      await expect(page.getByLabel("Private provider token")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    },
  );
}

test("review expiry disables private submission without polling", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page, { empty: true });
  await page.goto(URL);
  await prepare(page);
  await page.getByLabel("Private provider token").fill(PRIVATE);
  const expiry = state.reviews.values().next().value!.expiresAt;
  const before = state.calls.length;
  await page.clock.install();
  await page.clock.fastForward(Date.parse(expiry) - Date.now() + 2000);
  await expect(
    page.getByRole("button", { name: "Save credential with this scope" }),
  ).toBeDisabled();
  expect(state.calls).toHaveLength(before);
  expect(state.privateInputs).toEqual([]);
});
