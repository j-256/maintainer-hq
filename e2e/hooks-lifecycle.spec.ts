import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { mockHookLifecycle } from "./hooks-lifecycle-fixture";
const HOOKS_URL = "/hooks?workspace=development";
test("reviews private destination creation, clears credentials, and opens an addressable receipt", async ({ page }) => {
  const state = await mockHookLifecycle(page);
  await page.goto(HOOKS_URL);
  await page.getByRole("button", { name: "Manage destinations", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination name").fill("Synthetic phone");
  await dialog.getByRole("button", { name: "Review destination", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Review lifecycle change" })).toBeVisible();
  await dialog.getByLabel("Topic", { exact: true }).fill("synthetic-private-topic");
  await dialog.getByRole("button", { name: "Supply private destination", exact: true }).click();
  await expect(dialog.getByLabel("Topic", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply lifecycle change", exact: true }).click();
  await expect(dialog).toContainText("Lifecycle change accepted");
  expect(state.applies).toBe(1); expect(state.privateInputs).toBe(1);
  await expect(page).toHaveURL(/lifecycle=[a-f0-9-]+/);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  const receiptURL = page.url();
  await dialog.getByRole("button", { name: "Close receipt", exact: true }).click();
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page.getByRole("button", { name: "Open receipt", exact: true }).click();
  await expect(dialog).toContainText("Lifecycle change accepted");
  expect(new URL(page.url()).searchParams.get("lifecycle")).toBe(new URL(receiptURL).searchParams.get("lifecycle"));
});
test("exposes subscription and owned-hook controls with explicit upstream deletion", async ({ page }) => {
  await mockHookLifecycle(page);
  await page.goto(HOOKS_URL + "&view=subscriptions");
  await page.getByRole("button", { name: "Manage subscription", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Subscription lifecycle" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review subscription retirement", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review upstream hook deletion", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review subscription retirement", exact: true }).click();
  await expect(dialog).toContainText("does not delete its upstream GitHub hook");
});
test("reports missing provider grants and retains mobile keyboard return focus in both themes", async ({ page }) => {
  await mockHookLifecycle(page, { grants: false });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.goto(HOOKS_URL);
    const trigger = page.getByRole("button", { name: "Manage destinations", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("provider credential needs lifecycle grants");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  }
});

test("clears private drafts on close and reload without persisting them", async ({ page }) => {
  await mockHookLifecycle(page);
  await page.goto(HOOKS_URL);
  await page.getByRole("button", { name: "Manage destinations", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination name").fill("Synthetic private draft");
  await dialog.getByRole("button", { name: "Review destination", exact: true }).click();
  await dialog.getByLabel("Topic", { exact: true }).fill("synthetic-private-draft-sentinel");
  const reviewURL = page.url();
  expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage, history: history.state, url: location.href }))).not.toContain("synthetic-private-draft-sentinel");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await page.goto(reviewURL);
  await expect(dialog.getByLabel("Topic", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Topic", { exact: true }).fill("synthetic-private-draft-sentinel");
  await page.reload();
  await expect(dialog.getByLabel("Topic", { exact: true })).toHaveValue("");
});
test("keeps retired subscriptions discoverable and restoration separate from routing enablement", async ({ page }) => {
  await mockHookLifecycle(page, { retired: true });
  await page.goto(HOOKS_URL + "&view=subscriptions");
  await expect(page.locator(".hook-subscription-grid")).toContainText("Retired");
  await page.getByRole("button", { name: "Manage subscription", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Review subscription retirement", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Review subscription restoration", exact: true }).click();
  await expect(dialog).toContainText("keeps the subscription disabled until a separate routing review");
});

test("lists enabled destination references and prevents retirement until routing unlinks them", async ({ page }) => {
  await mockHookLifecycle(page, { referenced: true });
  await page.goto(HOOKS_URL);
  await page.getByRole("button", { name: "Manage destinations", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review retirement", exact: true }).click();
  await expect(dialog).toContainText("Synthetic enabled subscription");
  await expect(dialog).toContainText("Remove those destinations through Edit routing");
  await expect(dialog.getByRole("button", { name: "Apply lifecycle change", exact: true })).toBeDisabled();
});

test("destination retirement and restoration use provision authority independently of routing", async ({ page }) => {
  await mockHookLifecycle(page, { configure: true, provision: false });
  await page.goto(HOOKS_URL);
  await page.getByRole("button", { name: "Manage destinations", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Review retirement", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Review restoration", exact: true })).toBeDisabled();
});

test("clears a private draft when refreshed eligibility is withdrawn", async ({ page }) => {
  const state = await mockHookLifecycle(page);
  await page.goto(HOOKS_URL);
  await page.getByRole("button", { name: "Manage destinations", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination name").fill("Synthetic eligibility change");
  await dialog.getByRole("button", { name: "Review destination", exact: true }).click();
  await dialog.getByLabel("Topic", { exact: true }).fill("synthetic-private-eligibility-sentinel");
  state.reviews.values().next().value!.canSupplyPrivate = false;
  await dialog.getByRole("button", { name: "Reconcile saved receipt", exact: true }).click();
  await expect(dialog.getByLabel("Topic", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Topic", { exact: true })).toHaveValue("");
});
