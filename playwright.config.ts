import { defineConfig } from "@playwright/test";

const port = Number(process.env.HQ_E2E_PORT ?? 5179);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
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
    command: "npm run dev -- --mode e2e --port " + port,
    url: "http://127.0.0.1:" + port + "/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
