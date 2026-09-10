import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname)

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.dev.jsonc' }, miniflare: { bindings: { TEST_MIGRATIONS: migrations } } })],
  test: { include: ['test/**/*.test.ts'] },
})
