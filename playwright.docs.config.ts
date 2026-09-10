import { defineConfig } from "@playwright/test";

const port = Number(process.env.HQ_DOCS_TEST_PORT ?? 5182);

export default defineConfig({
  testDir: "./site/e2e",
  outputDir: "site/test-results",
  workers: 2,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:" + port,
    trace: "retain-on-failure",
    launchOptions: process.env.HQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HQ_BROWSER_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: "wrangler dev --local --config site/wrangler.jsonc --port " + port + " --ip 127.0.0.1",
    url: "http://127.0.0.1:" + port,
    reuseExistingServer: !process.env.CI,
    env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    timeout: 30000,
  },
});
