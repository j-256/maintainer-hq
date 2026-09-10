import { test as base } from "@playwright/test";

export {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    try {
      await use(page);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  },
});
