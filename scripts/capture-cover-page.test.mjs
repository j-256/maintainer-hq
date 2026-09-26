import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { captureCoverPage } from "./capture-cover-page.mjs";

const projects = [["Workshop Planner"], ["Delivery Relay"]];
const content = '<a href="/project/workshop">Workshop Planner</a><a href="/project/relay">Delivery Relay</a><p>Live updates</p>';
const TEST_TIMEOUT_MS = 15_000;
const MISSING_CONTENT_TIMEOUT_MS = 5_000;
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function fixture(t, html, status = 200) {
  const server = createServer((request, response) => {
    if (request.url.startsWith("/broken")) return request.socket.destroy();
    if (request.url.startsWith("/api/")) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      return response.end("private-response-canary");
    }
    response.writeHead(status, { "Content-Type": "text/html" });
    response.end(typeof html === "function" ? html(origin) : html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
  t.after(async () => { await context.close(); });
  const page = await context.newPage();
  return { page, origin };
}

async function failure(page, options) {
  let diagnostic;
  await assert.rejects(captureCoverPage(page, { projects, ...options }), error => {
    assert.match(error.message, /^Cover capture failed: /);
    diagnostic = JSON.parse(error.message.slice("Cover capture failed: ".length));
    return true;
  });
  return diagnostic;
}

test("captures only after delayed project content is visible and removes diagnostic listeners", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, `<script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(content)}; }, 50);</script>`);
  const png = await captureCoverPage(page, { origin, projects });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(await page.getByRole("link", { name: "Workshop Planner", exact: true }).isVisible(), true);
  assert.equal(page.listenerCount("pageerror"), 0);
  assert.equal(page.listenerCount("response"), 0);
});

test("reports JavaScript failure immediately instead of waiting for missing project links", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, '<script>throw new Error("cover-render-canary")</script>');
  const diagnostic = await failure(page, { origin });
  assert.equal(diagnostic.error, "cover-render-canary");
  assert.ok(diagnostic.events.some(event => event.type === "pageerror" && event.message === "cover-render-canary"));
  assert.equal(page.listenerCount("pageerror"), 0);
});

test("reports an unsuccessful document response at navigation", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, "private-document-canary", 503);
  const diagnostic = await failure(page, { origin });
  assert.equal(diagnostic.stage, "navigation");
  assert.match(diagnostic.error, /HTTP 503/);
  assert.ok(diagnostic.events.some(event => event.path === "/projects" && event.status === 503));
  assert.ok(!JSON.stringify(diagnostic).includes("private-document-canary"));
});

test("keeps API and console evidence on a readiness timeout without URL credentials or response bodies", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, origin => `<script>
    fetch("/api/commands/projects_list?token=query-canary");
    console.error(${JSON.stringify(origin.replace("http://", "http://username-canary:password-canary@") + "/api/commands/projects_list?token=query-canary#fragment-canary")});
  </script>`);
  const diagnostic = await failure(page, { origin, timeoutMs: MISSING_CONTENT_TIMEOUT_MS });
  assert.equal(diagnostic.stage, "project link: Workshop Planner");
  assert.ok(diagnostic.events.some(event => event.path === "/api/commands/projects_list" && event.status === 503));
  assert.ok(diagnostic.events.some(event => event.type === "console"));
  assert.ok(!JSON.stringify(diagnostic).includes("canary"));
});

test("retains transport failure evidence when the page stays empty", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, '<script>fetch("/broken?token=query-canary").catch(() => {})</script>');
  const diagnostic = await failure(page, { origin, timeoutMs: MISSING_CONTENT_TIMEOUT_MS });
  assert.ok(diagnostic.events.some(event => event.type === "requestfailed" && event.path === "/broken"));
  assert.ok(!JSON.stringify(diagnostic).includes("query-canary"));
});

test("bounds noisy diagnostics while preserving the fatal browser error", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, '<script>for (let i = 0; i < 100; i++) console.error("x".repeat(10000)); throw new Error("fatal-canary");</script>');
  const diagnostic = await failure(page, { origin });
  assert.equal(diagnostic.error, "fatal-canary");
  assert.ok(diagnostic.omittedEvents > 0);
  assert.ok(JSON.stringify(diagnostic).length < 15_000);
});

test("bounds the font readiness wait after project links have rendered", { timeout: TEST_TIMEOUT_MS }, async t => {
  const { page, origin } = await fixture(t, `${content}<script>Object.defineProperty(document.fonts, "ready", { value: new Promise(() => {}) });</script>`);
  const diagnostic = await failure(page, { origin, timeoutMs: MISSING_CONTENT_TIMEOUT_MS });
  assert.equal(diagnostic.stage, "fonts");
  assert.match(diagnostic.error, /Readiness deadline exceeded/);
});
