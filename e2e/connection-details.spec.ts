import { test, expect, type Page } from "./test-fixture";
import type { WebSocketRoute } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  PUSH_CLOSE,
  PUSH_LIMITS,
  type PushTopic,
} from "../shared/workspace-push";
import { syncScopeSchema } from "../shared/workspace-sync";
import { QUERY_REFRESH_LIMITS } from "../src/lib/workspace-query-refresh";
import { coverageFixture } from "./github-coverage-fixture";
import { mockWorkspaceView } from "./workspace-fixture";
import { verifyFlatContrast } from "./flat-contrast";

const WORKSPACE = "development";
const BASE = "/overview?workspace=" + WORKSPACE;
const SETTLE_MS = PUSH_LIMITS.COALESCE_MS + 50;

async function controlledPush(page: Page, accept = () => true) {
  const sockets: WebSocketRoute[] = [];
  let send: (topics: PushTopic[]) => void = () => {
    throw new Error("No synthetic socket");
  };
  await page.routeWebSocket("**/api/events?**", (socket) => {
    sockets.push(socket);
    const params = new URL(socket.url()).searchParams;
    const scope = syncScopeSchema.parse({
      view: params.get("view"),
      ...(params.has("repositoryId")
        ? { repositoryId: params.get("repositoryId") }
        : {}),
    });
    let cursor = Number(params.get("cursor"));
    let revision = 0;
    const frame = (type: "ready" | "update", topics: PushTopic[]) => {
      const from = cursor;
      if (type === "update") cursor++;
      socket.send(
        JSON.stringify({
          version: 2,
          type,
          workspaceId: WORKSPACE,
          revision: revision++,
          scope,
          topics,
          ...(type === "ready"
            ? { expiresAt: Date.now() + PUSH_LIMITS.CONNECTION_MS }
            : {}),
          update: {
            type: "delta",
            from,
            cursor,
            generatedAt: new Date().toISOString(),
            upserts: {},
            removals: [],
          },
        }),
      );
    };
    socket.onMessage((message) => {
      if (message === PUSH_LIMITS.PING) socket.send(PUSH_LIMITS.PONG);
    });
    if (accept()) frame("ready", []);
    send = (topics) => frame("update", topics);
  });
  return { sockets, send: (topics: PushTopic[]) => send(topics) };
}

function requests(page: Page) {
  const reads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) reads.push(path.split("/").at(-1)!);
  });
  return reads;
}

for (const theme of ["light", "dark"])
  for (const width of [1440, 390])
    test(`connection details remain usable with keyboard in ${theme} at ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await page.clock.install();
      const push = await controlledPush(page);
      const reads = requests(page);
      await page.goto(BASE);
      const trigger = page.getByRole("button", {
        name: "Connection details",
        exact: true,
      });
      await expect(trigger).toContainText("Live updates");
      await page.waitForLoadState("networkidle");
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "Connection details",
        exact: true,
      });
      await expect(
        dialog.getByRole("heading", { name: "Live updates", exact: true }),
      ).toBeVisible();
      const timings = dialog
        .locator("summary")
        .filter({ hasText: "Connection timings" });
      await timings.focus();
      await page.keyboard.press("Enter");
      await expect(
        dialog.getByText("Last transport response", { exact: true }),
      ).toBeVisible();
      await expect(dialog.locator("time").first()).toHaveText(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );
      const before = [...reads];
      await page.clock.runFor(10000);
      expect(reads).toEqual(before);
      await page.clock.resume();
      const audit = await new AxeBuilder({ page })
        .include(".connection-dialog")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(audit.violations).toEqual([]);
      for (const finding of audit.incomplete)
        for (const node of finding.nodes) {
          await page.locator(node.target[0] as string).scrollIntoViewIfNeeded();
          await verifyFlatContrast(page, [{ ...finding, nodes: [node] }]);
        }
      await dialog.locator(".connection-detail-body").evaluate((node) => {
        node.scrollTop = 0;
      });
      expect(
        await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await page.screenshot({
        path: info.outputPath("connection-" + theme + "-" + width + ".png"),
      });
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
      await push.sockets[0].close({
        code: PUSH_CLOSE.ROTATE,
        reason: "private-close-text-must-not-render",
      });
      await expect(
        dialog.getByRole("heading", {
          name: "Renewing live updates",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog).toContainText("Scheduled renewal");
      await expect(dialog).not.toContainText("private-close-text");
      await page.clock.runFor(PUSH_LIMITS.RECONNECT_MIN_MS * 2);
      await expect(
        dialog.getByRole("heading", { name: "Live updates", exact: true }),
      ).toBeVisible();
      await page.clock.resume();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
        BASE,
      );
    });

test("fallback and offline recovery remain bounded and explain transport without claiming provider health", async ({
  page,
  context,
}) => {
  await page.clock.install();
  let accept = true;
  const push = await controlledPush(page, () => accept);
  const reads = requests(page);
  await page.goto(BASE);
  const trigger = page.getByRole("button", {
    name: "Connection details",
    exact: true,
  });
  await expect(trigger).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Connection details",
    exact: true,
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  accept = false;
  await push.sockets.at(-1)!.close({ code: PUSH_CLOSE.TEMPORARY });
  await expect(
    dialog.getByRole("heading", { name: "Reconnecting", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("Live service temporarily unavailable");
  await page.clock.runFor(
    PUSH_LIMITS.FALLBACK_MS + PUSH_LIMITS.HANDSHAKE_MS + SETTLE_MS,
  );
  await expect(
    dialog.getByRole("heading", { name: "Fallback refresh", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("checks for changes once a minute");
  expect(reads.filter((name) => name === "workspace_changes")).toHaveLength(1);
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await expect(
    dialog.getByRole("heading", { name: "Offline", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Check current view", exact: true }),
  ).toBeDisabled();
  const offline = [...reads];
  const connections = push.sockets.length;
  await page.clock.runFor(PUSH_LIMITS.FALLBACK_MS * 2);
  expect(reads).toEqual(offline);
  expect(push.sockets).toHaveLength(connections);
  accept = true;
  await page.clock.resume();
  await context.setOffline(false);
  await expect(
    dialog.getByRole("heading", { name: "Live updates", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Check current view", exact: true }),
  ).toBeEnabled();
});

test("view refresh errors do not turn a live connection into provider failure or reload navigation", async ({
  page,
}) => {
  await controlledPush(page);
  await page.goto(BASE);
  const trigger = page.getByRole("button", {
    name: "Connection details",
    exact: true,
  });
  await expect(trigger).toContainText("Live updates");
  const href = page.url();
  await page.evaluate(() => performance.mark("hq-preserved-page"));
  await page.route("**/api/commands/workspace_view", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "unavailable", message: "Synthetic read interrupted" },
      },
    }),
  );
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Connection details",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Check current view", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Current view data", exact: true }),
  ).toContainText("The view refresh was interrupted");
  await expect(
    dialog.getByRole("heading", { name: "Live updates", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("A heartbeat does not prove");
  expect(page.url()).toBe(href);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hq-preserved-page").length,
    ),
  ).toBe(1);
  await page.unroute("**/api/commands/workspace_view");
  await dialog
    .getByRole("button", { name: "Check current view", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Showing the last accepted HQ data",
  );
});

test("coverage bursts retain an in-flight read and converge through one trailing read without idle polling", async ({
  page,
}) => {
  const fixture = coverageFixture();
  await page.clock.install();
  const push = await controlledPush(page);
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: fixture.repositories,
    connections: fixture.sources,
    observations: fixture.observations,
  }));
  let reads = 0;
  let delay = false;
  let release: (() => void) | undefined;
  const failures: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/github_coverage"))
      failures.push(request.failure()?.errorText ?? "failed");
  });
  await page.route("**/api/commands/github_coverage", async (route) => {
    reads++;
    if (delay) {
      delay = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.fulfill({
      json: fixture.response(route.request().postDataJSON()),
    });
  });
  try {
    await page.goto("/settings/github?workspace=" + WORKSPACE);
    await expect(
      page.locator(".coverage-table tbody > tr").first(),
    ).toBeVisible();
    await expect(page.locator(".connection-trigger")).toContainText(
      "Live updates",
    );
    await page.waitForLoadState("networkidle");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
    await page.clock.runFor(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 2);
    await page.waitForLoadState("networkidle");
    const before = reads;
    const initialFailures = [...failures];
    delay = true;
    for (let index = 0; index < 5; index++) {
      push.send(["sources"]);
      await page.clock.runFor(SETTLE_MS);
    }
    await expect.poll(() => reads).toBe(before + 1);
    expect(failures).toEqual(initialFailures);
    release!();
    await page.waitForLoadState("networkidle");
    await page.clock.runFor(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS);
    await expect.poll(() => reads).toBe(before + 2);
    await page.waitForLoadState("networkidle");
    await page.clock.runFor(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 3);
    expect(reads).toBe(before + 2);
    expect(failures).toEqual(initialFailures);
  } finally {
    release?.();
  }
});

test("a history opened without a run ID pins its first receipt while newer runs arrive", async ({
  page,
}) => {
  const fixture = coverageFixture();
  await page.clock.install();
  const push = await controlledPush(page);
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: fixture.repositories,
    connections: fixture.sources,
  }));
  const first = fixture.receipt(fixture.sources[0].id);
  const newer = { ...first, id: "newer-synthetic-receipt" };
  let history = [first];
  const readIds: string[] = [];
  await page.route("**/api/commands/github_refreshes_list", (route) =>
    route.fulfill({ json: history }),
  );
  await page.route("**/api/commands/github_refresh_get", (route) => {
    const id = route.request().postDataJSON().refreshId;
    readIds.push(id);
    return route.fulfill({ json: id === first.id ? first : newer });
  });
  await page.goto(
    "/settings/github?workspace=" +
      WORKSPACE +
      "&view=connections&source=" +
      first.sourceId,
  );
  const dialog = page.getByRole("dialog", {
    name: "GitHub refresh history",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Refresh reference", { exact: true }),
  ).toHaveValue(first.id);
  await page.waitForLoadState("networkidle");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  const href = page.url();
  const before = [...readIds];
  history = [newer, first];
  push.send(["sources"]);
  await page.clock.runFor(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS + SETTLE_MS);
  await dialog
    .getByRole("combobox", { name: "Refresh receipt", exact: true })
    .click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByLabel("Refresh reference", { exact: true }),
  ).toHaveValue(first.id);
  expect(readIds).toEqual(before);
  expect(page.url()).toBe(href);
  for (const value of ["hidden", "visible"]) {
    await page.evaluate((visibility) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: visibility,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, value);
  }
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.clock.runFor(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS);
  expect(readIds).toEqual(before);
  await push.sockets.at(-1)!.close({ code: PUSH_CLOSE.ROTATE });
  await page.clock.runFor(
    PUSH_LIMITS.RECONNECT_MIN_MS * 2 + QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS,
  );
  await expect(
    dialog.getByLabel("Refresh reference", { exact: true }),
  ).toHaveValue(first.id);
  expect(readIds).toEqual(before);
});
