import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

const D1_TEST_WORKER_LIMIT = 4;

const migrations = await readD1Migrations(
  new URL("./migrations", import.meta.url).pathname,
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.dev.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    // Bound simultaneous real-D1 fixtures on shared runners
    maxWorkers: Math.min(D1_TEST_WORKER_LIMIT, availableParallelism()),
    include: ["test/**/*.test.ts"],
    deps: { optimizer: { ssr: { enabled: true, include: ["cron-parser"] } } },
  },
});
