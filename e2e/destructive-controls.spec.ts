import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./test-fixture";
import { mockProviderCredentials } from "./provider-credentials-fixture";

const URL = "/secrets?workspace=development&view=providers";

async function audit(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const theme of ["light", "dark"]) {
  test(`retirement controls remain readable at rest, on hover, and on keyboard focus in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (value) => localStorage.setItem("hq.theme.v1", value),
      theme,
    );
    const state = await mockProviderCredentials(page);
    await page.goto(URL);
    await page
      .getByRole("button", { name: "Review retirement", exact: true })
      .click();
    const retire = page.getByRole("button", {
      name: "Retire credential from HQ",
      exact: true,
    });
    await expect(retire).toBeVisible();
    await audit(page);
    await retire.hover();
    await audit(page);
    await retire.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    const cancel = dialog.getByRole("button", {
      name: "Keep credential",
      exact: true,
    });
    await expect(cancel).toBeFocused();
    await audit(page);
    const confirm = dialog.getByRole("button", {
      name: "Retire from HQ",
      exact: true,
    });
    await confirm.hover();
    await audit(page);
    await confirm.focus();
    await audit(page);
    await cancel.click();
    expect(state.credentials[0]?.status).toBe("available");
    expect(state.privateInputs).toEqual([]);
  });
}
