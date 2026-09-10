import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { mockSecrets } from "../../e2e/secrets-fixture";
import { buildArtifact, verifyArtifact } from "../../scripts/release-artifact";
import { readReleaseProfile, sha256 } from "../../scripts/release-profile";
import {
  SECURITY_HEADERS,
  API_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
} from "../../shared/security";

test(
  "a real portable release serves the authenticated dashboard under its security policy",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hq-release-runtime-"));
    const artifact = join(temporary, "artifact");
    const profile = join(temporary, "push-profile.json");
    const base = (await readReleaseProfile("fixtures/release-profile.json"))
      .profile;
    await writeFile(profile, JSON.stringify({ ...base, workspacePush: true }));
    const review = (await readReleaseProfile(profile)).fingerprint;
    const receipt = await buildArtifact(
      process.cwd(),
      profile,
      review,
      artifact,
    );
    assert.equal(
      (await verifyArtifact(artifact, review, receipt.artifactFingerprint))
        .deploymentAuthorized,
      false,
    );
    const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
    const state = join(temporary, "state");
    const token = "synthetic-release-runtime-token";
    const created = new Date().toISOString();
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const seed = `
INSERT INTO workspaces (id,name,created_at) VALUES ('release-test','Release fixture','${created}');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('release-test','synthetic-operator','Release operator','operator');
INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('synthetic','release-test','synthetic-operator','Release test','${sha256(token)}','["read","metadata:write","activity:write","goals:write"]','${created}','${expiry}');
INSERT INTO projects (workspace_id,id,name,description) VALUES ('release-test','seed-project','Seed project','');
`;
    await writeFile(join(temporary, "seed.sql"), seed);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "1".repeat(32),
      WRANGLER_SEND_METRICS: "false",
    };
    delete environment.CLOUDFLARE_ENV;
    delete environment.WRANGLER_ENV;
    execFileSync(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "HQ_DB",
        "--local",
        "--config",
        "wrangler.json",
        "--persist-to",
        state,
      ],
      { cwd: artifact, env: environment, stdio: "pipe", timeout: 30_000 },
    );
    execFileSync(
      process.execPath,
      [
        wrangler,
        "d1",
        "execute",
        "HQ_DB",
        "--local",
        "--config",
        "wrangler.json",
        "--persist-to",
        state,
        "--file",
        join(temporary, "seed.sql"),
      ],
      { cwd: artifact, env: environment, stdio: "pipe", timeout: 30_000 },
    );
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    const origin = "http://127.0.0.1:" + port;
    const server = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
        "--config",
        "wrangler.json",
        "--persist-to",
        state,
      ],
      { cwd: artifact, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    server.stdout.on("data", (part) => {
      logs = (logs + part).slice(-8000);
    });
    server.stderr.on("data", (part) => {
      logs = (logs + part).slice(-8000);
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null)
          throw new Error("Packaged runtime stopped: " + logs);
        ready = await fetch(origin + "/healthz")
          .then((r) => r.ok)
          .catch(() => false);
        if (ready) break;
        await delay(100);
      }
      assert.equal(ready, true, logs);
      for (const [path, status, cache] of [
        ["/activity", 200, STATIC_CACHE_CONTROL],
        ["/api/session", 401, API_CACHE_CONTROL],
        ["/healthz", 200, API_CACHE_CONTROL],
      ] as const) {
        const response = await fetch(origin + path);
        assert.equal(response.status, status);
        for (const [key, value] of Object.entries(SECURITY_HEADERS))
          assert.equal(response.headers.get(key), value, path + " " + key);
        assert.equal(response.headers.get("Cache-Control"), cache);
      }
      const requestHeaders = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "X-HQ-Client": "cli",
      };
      const objective =
        "  Verbatim /goal in a production build\nKeep the original whitespace.  ";
      const goal = await fetch(origin + "/api/commands/goal_sync", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          workspaceId: "release-test",
          sourceId: "release-source",
          goalId: "release-goal",
          objective,
          status: "active",
          startedAt: created,
          reportedAt: created,
        }),
      });
      assert.equal(goal.status, 200, await goal.text());
      browser = await chromium.launch(
        process.env.HQ_BROWSER_EXECUTABLE
          ? { executablePath: process.env.HQ_BROWSER_EXECUTABLE }
          : {},
      );
      const context = await browser.newContext({
        extraHTTPHeaders: { Authorization: "Bearer " + token },
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(origin + "/activity");
      await expect(page.locator(".connection-state")).toContainText(
        "Live updates",
      );
      await expect(page.locator(".goal-objective")).toHaveText(objective);
      const connection = page.getByRole("button", {
        name: "Connection details",
        exact: true,
      });
      await connection.click();
      const details = page.getByRole("dialog", {
        name: "Connection details",
        exact: true,
      });
      await expect(
        details.getByRole("heading", { name: "Live updates", exact: true }),
      ).toBeVisible();
      await details
        .getByRole("button", { name: "Check current view", exact: true })
        .click();
      await expect(details.getByRole("status")).toContainText(
        "Showing the last accepted HQ data",
      );
      await page.keyboard.press("Escape");
      await expect(connection).toBeFocused();
      assert.equal(
        await page.locator(".goal-objective").textContent(),
        objective,
      );
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      const signOut = page.getByRole("alertdialog", {
        name: "Sign out of your account?",
      });
      await expect(
        signOut.getByRole("button", { name: "Stay signed in" }),
      ).toBeFocused();
      await expect(
        signOut.getByRole("link", { name: "Sign out of Access" }),
      ).toHaveAttribute("href", "/cdn-cgi/access/logout");
      await signOut.getByRole("button", { name: "Stay signed in" }).click();
      assert.equal(
        await page.locator(".goal-objective").textContent(),
        objective,
      );
      await page
        .getByRole("link", { name: "Repositories", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Enroll repository", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByLabel("Repository name", { exact: true }),
      ).toBeFocused();
      await dialog
        .getByLabel("Repository name", { exact: true })
        .fill("example/release-test");
      await dialog
        .getByRole("button", { name: "Enroll repository", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "example/release-test",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await dialog
        .getByLabel("Project name", { exact: true })
        .fill("Release project");
      await dialog
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Release project", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Release project", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("navigation", { name: "Project sections" })
        .getByRole("link", { name: "Repositories", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Link existing repository", exact: true })
        .click();
      await dialog
        .getByRole("button", {
          name: "example/release-test Seed project",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByRole("combobox", {
          name: "Owning project",
          exact: true,
        }),
      ).toHaveText("Release project");
      await dialog
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        page.getByRole("table", { name: "Repository inventory" }),
      ).toContainText("example/release-test");
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await expect(page.locator("html")).toHaveClass(/dark/);
      await page.reload();
      await expect(page.locator("html")).toHaveClass(/dark/);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      await page.keyboard.press("Escape");
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      assert.deepEqual(errors, []);
      const secrets = await mockSecrets(page, { owner: true });
      await page.goto(origin + "/secrets?workspace=release-test");
      await page
        .getByRole("button", { name: "Distribute supplied value", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Prepare destinations", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Review secret distribution",
          exact: true,
        }),
      ).toBeFocused();
      const supplied = "synthetic-packaged-browser-value\n";
      await page
        .getByLabel("Supplied value (visible while editing)")
        .fill(supplied);
      await page
        .getByRole("button", {
          name: "Seal value and prepare final review",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Review and confirm distribution",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Supplied value (visible while editing)"),
      ).toHaveCount(0);
      assert.deepEqual(secrets.values, [supplied]);
      assert.equal(secrets.writes, 0);
      assert.equal(JSON.stringify(secrets.calls).includes(supplied), false);
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser?.close();
      if (server.exitCode === null) {
        const stopped = once(server, "exit");
        server.kill("SIGTERM");
        await stopped;
      }
      await rm(temporary, { recursive: true });
    }
  },
);
