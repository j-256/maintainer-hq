import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  mockCloudflareSecrets,
  CLOUDFLARE_CONNECTION,
} from "./cloudflare-secrets-fixture";
import { SECRET_CONNECTION } from "./secrets-fixture";

const URL = "/secrets?workspace=development";
const VALUE = "synthetic-browser-private-value\n\u03bb\n";
async function audit(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function prepare(page: Page) {
  await page
    .getByRole("button", { name: "Supply a new secret", exact: true })
    .click();
  const group = page.getByRole("group", { name: "Destination 1", exact: true });
  await group.getByLabel("Secret name", { exact: true }).fill("MixedCaseToken");
  await page
    .getByRole("button", { name: "Prepare destinations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Supply the value privately" }),
  ).toBeVisible();
}
async function confirm(page: Page) {
  await page
    .getByRole("button", {
      name: "Review and confirm distribution",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText(/Cloudflare changes activate a new Worker deployment/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Confirm distribution", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Confirm distribution", exact: true })
    .click();
}
for (const theme of ["light", "dark"]) {
  for (const mobile of [false, true]) {
    test(`Cloudflare native inventory, private confirmation and receipts are usable in ${theme} ${mobile ? "mobile" : "desktop"}`, async ({
      page,
    }) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1360, height: 960 },
      );
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const { state, extra } = await mockCloudflareSecrets(page);
      await page.goto(URL);
      await expect(
        page.getByText("MixedCaseToken", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(
          /Cloudflare does not expose their values, timestamps or individual secret versions/,
        ),
      ).toBeVisible();
      await audit(page);
      await page
        .getByRole("button", { name: "Variables", exact: true })
        .click();
      await expect(page.getByText("ApiOrigin", { exact: true })).toBeVisible();
      await expect(
        page.getByText("https://api.example.test", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Unmanaged by HQ", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Supply a new secret", exact: true }),
      ).toHaveCount(0);
      await audit(page);
      await page.getByRole("button", { name: "Secrets", exact: true }).click();
      await expect(
        page.getByText("MixedCaseToken", { exact: true }),
      ).toBeVisible();
      await prepare(page);
      expect(state.writes).toBe(0);
      await page
        .getByText("Worker deployment affected", { exact: true })
        .click();
      await expect(
        page.getByText("11111111-1111-4111-8111-111111111111", { exact: true }),
      ).toBeVisible();
      const input = page.getByLabel("Supplied value (visible while editing)");
      await expect(
        page.getByRole("button", {
          name: "Review and confirm distribution",
          exact: true,
        }),
      ).toBeDisabled();
      await input.fill(VALUE);
      await input.press("Tab");
      await expect(
        page.getByRole("button", {
          name: "Review and confirm distribution",
          exact: true,
        }),
      ).toBeFocused();
      expect(
        await page.evaluate(() =>
          JSON.stringify({
            local: Object.entries(localStorage),
            session: Object.entries(sessionStorage),
          }),
        ),
      ).not.toContain(VALUE);
      expect(await page.content()).not.toContain(VALUE);
      await audit(page);
      await confirm(page);
      await expect(
        page.getByText("Provider accepted", { exact: true }),
      ).toBeVisible();
      await expect(input).toHaveCount(0);
      expect(extra.privateRequests).toBe(1);
      expect(state.values).toEqual([VALUE]);
      expect(state.calls.some((call) => call.name === "secrets_run")).toBe(
        false,
      );
      expect(JSON.stringify(state.calls)).not.toContain(VALUE);
      await audit(page);
    });
  }
}
test("mixed-provider UI keeps the sealed value transiently for Cloudflare and never places it in ordinary state", async ({
  page,
}) => {
  const { state, extra } = await mockCloudflareSecrets(page, true);
  await page.goto(URL);
  await page.getByRole("combobox", { name: "Connection", exact: true }).click();
  await page
    .getByRole("option", { name: CLOUDFLARE_CONNECTION.name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Supply a new secret", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Destination 1", exact: true })
    .getByLabel("Secret name", { exact: true })
    .fill("MixedCaseToken");
  await page.getByRole("button", { name: /Add destination/ }).click();
  const second = page.getByRole("group", {
    name: "Destination 2",
    exact: true,
  });
  await second
    .getByRole("combobox", { name: "Connection", exact: true })
    .click();
  await page
    .getByRole("option", { name: SECRET_CONNECTION.name, exact: true })
    .click();
  await second.getByLabel("Secret name", { exact: true }).fill("TOKEN");
  await page
    .getByRole("button", { name: "Prepare destinations", exact: true })
    .click();
  const input = page.getByLabel("Supplied value (visible while editing)");
  await input.fill(VALUE);
  await page
    .getByRole("button", {
      name: "Seal value and prepare final review",
      exact: true,
    })
    .click();
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toHaveValue(VALUE);
  expect(state.values).toEqual([VALUE]);
  await confirm(page);
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toHaveCount(2);
  expect(state.values).toEqual([VALUE, VALUE]);
  expect(extra.privateRequests).toBe(1);
  expect(JSON.stringify(state.calls)).not.toContain(VALUE);
  await expect(input).toHaveCount(0);
});
test("lost Cloudflare execution responses recover the receipt without replay or retained-input recovery", async ({
  page,
}) => {
  const { state, extra } = await mockCloudflareSecrets(page);
  extra.loseTransientResponse = true;
  await page.goto(URL);
  await prepare(page);
  await page.getByLabel("Supplied value (visible while editing)").fill(VALUE);
  await confirm(page);
  await expect(page.getByRole("alert")).toContainText("interrupted or refused");
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toBe(1);
  await page
    .getByRole("button", { name: "Reload receipt", exact: true })
    .click();
  expect(extra.privateRequests).toBe(1);
  await expect(
    page.getByLabel("Supplied value (visible while editing)"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Review recovery/ }),
  ).toHaveCount(0);
});
test("uncertain Cloudflare writes remain uncertain after metadata checks and require a new deliberate value", async ({
  page,
}) => {
  const { state, extra } = await mockCloudflareSecrets(page);
  state.uncertainWrite = true;
  await page.goto(URL);
  await prepare(page);
  await page.getByLabel("Supplied value (visible while editing)").fill(VALUE);
  await confirm(page);
  await expect(
    page.getByText("Acceptance uncertain", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/No value is retained for Cloudflare recovery/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Check metadata 1", exact: true })
    .click();
  await expect(
    page.getByText("Acceptance uncertain", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Name observed present", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Review recovery/ }),
  ).toHaveCount(0);
  expect(extra.privateRequests).toBe(1);
  await audit(page);
});
