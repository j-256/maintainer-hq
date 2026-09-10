import type { Page } from "./test-fixture";

export async function navigateSection(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name, exact: true })
    .click();
}
