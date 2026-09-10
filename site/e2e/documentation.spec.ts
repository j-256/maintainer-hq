import { readdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const GUIDES = readdirSync(new URL("../../docs/", import.meta.url))
  .filter((name) => name.endsWith(".md"))
  .map((name) => name === "index.md" ? "/" : "/" + name.slice(0, -3) + "/");
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(viewport.width + "px " + theme, () => {
      test.use({ viewport, colorScheme: theme });
      for (const path of GUIDES) {
        test(path + " is readable, accessible, and self-contained", async ({ page, baseURL }) => {
          const errors: string[] = [];
          const external: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (new URL(request.url()).origin !== baseURL) external.push(request.url());
          });
          const response = await page.goto(path);
          expect(response?.status()).toBe(200);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.evaluate(() => document.fonts.ready);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
          const fontSize = await page.locator(".sl-markdown-content p").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
          expect(fontSize).toBeGreaterThanOrEqual(16);
          const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
          expect(audit.violations).toEqual([]);
          expect(errors).toEqual([]);
          expect(external).toEqual([]);
        });
      }
    });
  }
}

test("search is local, keyboard accessible, addressable, and clear when empty", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.requestIdleCallback = (callback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 200);
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Search/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("textbox", { name: "Search documentation" });
  await expect(search).toBeFocused();
  await search.fill("workspace transfers");
  const result = page.locator(".pagefind-ui__result-link").filter({ hasText: "Project workspace transfers" }).first();
  await expect(result).toBeVisible();
  expect(await page.locator(".pagefind-ui__result-excerpt").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(15);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await search.fill("zxqv_no_matching_document_9821");
  await expect(page.getByText(/No results/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await search.fill("workspace transfers");
  await expect(result).toBeVisible();
  await result.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/project-transfers\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Project workspace transfers");
  expect(errors).toEqual([]);
});

for (const width of [1440, 390, 320]) {
  for (const theme of ["light", "dark"] as const) {
    test("search has compact readable typography at " + width + "px in " + theme, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/repositories/");
      const trigger = page.getByRole("button", { name: "Search", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const input = page.getByRole("textbox", { name: "Search documentation" });
      await expect(input).toBeFocused();
      await input.fill("operational");
      const pageTitle = page.locator(".pagefind-ui__result-inner > .pagefind-ui__result-title").first();
      const sectionLink = page.locator(".pagefind-ui__result-nested .pagefind-ui__result-link").first();
      const excerpt = page.locator(".pagefind-ui__result-excerpt").first();
      await expect(sectionLink).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const typography = (element: Element) => {
        const style = getComputedStyle(element);
        return { size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize) };
      };
      expect(await input.evaluate(typography)).toEqual({ size: 16, leading: 1.5 });
      expect(await pageTitle.evaluate(typography)).toEqual({ size: 17, leading: 1.5 });
      expect(await sectionLink.evaluate(typography)).toEqual({ size: 16, leading: 1.5 });
      expect(await excerpt.evaluate(typography)).toEqual({ size: 15, leading: 1.5 });
      expect(await input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("search.png") });
      await page.evaluate(() => document.documentElement.style.fontSize = "20px");
      expect((await input.evaluate(typography)).size).toBe(20);
      expect((await excerpt.evaluate(typography)).size).toBe(18.75);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });
  }
}

test("mobile navigation and theme selection remain usable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#starlight__sidebar:popover-open")).toBeVisible();
  await page.getByRole("combobox", { name: "Select theme" }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Getting started", exact: true }).click();
  await expect(page).toHaveURL(/\/getting-started\//);
  await expect(page.locator("#starlight__sidebar:popover-open")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Tab");
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search documentation" }).fill("workspace transfers");
  await expect(page.locator(".pagefind-ui__result-link").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
});

test("edge response headers, genuine 404, and script evaluation restrictions", async ({ page, request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const missing = await page.goto("/not-a-real-guide/");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("404");
  await page.goto("/");
  await page.route("**/csp-test-probe.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: "try { new Function('return true')(); document.body.dataset.cspProbe = 'allowed'; } catch (error) { document.body.dataset.cspProbe = error instanceof EvalError ? 'denied' : 'unexpected'; }",
  }));
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "/csp-test-probe.js";
    document.head.append(script);
  });
  await expect(page.locator("body")).toHaveAttribute("data-csp-probe", "denied");
});
