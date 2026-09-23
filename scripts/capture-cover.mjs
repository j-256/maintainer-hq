import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "docs/screenshots/cover.png");
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: node scripts/capture-cover.mjs\n\nBuild Maintainer HQ and capture its Projects view using isolated local D1 state\nand synthetic projects. Does not contact providers or use a deployed workspace.\nWrites docs/screenshots/cover.png. Requires Node 22.18+, npm ci, and\nnpx playwright install chromium. No environment variables are required;\nHQ_E2E_STATE is replaced with a temporary capture directory.\nExit status: 0 success, 1 capture failure, 2 usage error, 3 missing dependency.");
  process.exit(0);
}
if (args.length) {
  console.error("capture-cover: unexpected argument; see --help");
  process.exit(2);
}
const { chromium } = await import("@playwright/test").catch((error) => {
  console.error(`capture-cover: run npm ci first: ${error.message}`);
  process.exit(3);
});
const temporary = await mkdtemp(join(tmpdir(), "maintainer-hq-cover-"));
const projects = [
  ["Workshop Planner", "Plan physical storage and explain inventory moves"],
  ["Delivery Relay", "Route event notifications with reviewed delivery settings"],
  ["Docs Explorer", "Browse and search reference material"],
  ["Screenshot Tools", "Capture and refresh project documentation"],
];
let browser;
let server;
const previousState = process.env.HQ_E2E_STATE;
try {
  process.env.HQ_E2E_STATE = temporary;
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", timeout: 180_000 });
  execFileSync("npm", ["run", "db:e2e:prepare"], { cwd: root, stdio: "inherit", timeout: 180_000 });
  const { createServer } = await import("vite");
  server = await createServer({ root, mode: "e2e", server: { host: "127.0.0.1", port: 0, strictPort: true } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 4,
    colorScheme: "dark", reducedMotion: "reduce",
  });
  for (const [name, description] of projects) {
    const response = await context.request.post(`${origin}/api/commands/project_create`, {
      headers: { "X-HQ-Client": "cli" },
      data: { workspaceId: "development", name, description },
    });
    assert.ok(response.ok(), `Cannot seed ${name}: ${await response.text()}`);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/projects?workspace=development`);
  for (const [name] of projects) await page.getByRole("link", { name, exact: true }).waitFor();
  await page.getByText("Live updates", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(errors, []);
  await page.mouse.move(1439, 999);
  await mkdir(join(root, "docs/screenshots"), { recursive: true });
  const staged = join(root, "docs/screenshots/cover.tmp.png");
  await writeFile(staged, await page.screenshot({ animations: "disabled" }));
  await rename(staged, output);
  console.log(`Captured synthetic Projects workspace: ${output}`);
} catch (error) {
  console.error(`capture-cover: ${error.stack ?? error}`);
  process.exitCode = /Executable doesn't exist|ERR_MODULE_NOT_FOUND/.test(error.message) ? 3 : 1;
} finally {
  await browser?.close();
  await server?.close();
  if (previousState === undefined) delete process.env.HQ_E2E_STATE;
  else process.env.HQ_E2E_STATE = previousState;
  await rm(temporary, { recursive: true, force: true });
  await rm(join(root, "docs/screenshots/cover.tmp.png"), { force: true });
}
