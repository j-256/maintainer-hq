import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readGitHubAppInputFile } from "../cli/github-app-input";
import { supplyGitHubAppMaterial } from "../shared/github-app-input";
import { normalizeGitHubAppKey } from "../worker/github-app-crypto";
import { githubAppTestKey } from "./helpers/github-app-keys";

const selection = {
  workspaceId: "administration",
  planId: "review",
  fingerprint: "sha256:" + "a".repeat(64),
};
const review = {
  id: "review",
  registrationId: "app-a",
  revision: 0,
  change: {
    kind: "save",
    fields: {
      name: "App",
      appId: 42,
      visibility: "public",
      capabilities: ["collection"],
    },
    replaceKey: true,
  },
  fingerprint: selection.fingerprint,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  privateInputRequired: true,
  applied: false,
  expired: false,
  impact: { affectedWorkspaceIds: ["administration"] },
  registration: null,
};

test("private App files reject symlinks, permissive modes and oversized content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-app-input-"));
  try {
    const path = join(directory, "input.json");
    const link = join(directory, "link.json");
    await writeFile(path, "synthetic-private-input", { mode: 0o600 });
    await symlink(path, link);
    await assert.rejects(readGitHubAppInputFile(link));
    assert.equal(
      new TextDecoder().decode(await readGitHubAppInputFile(path)),
      "synthetic-private-input",
    );
    await chmod(path, 0o644);
    await assert.rejects(readGitHubAppInputFile(path));
    await chmod(path, 0o600);
    await writeFile(path, "x".repeat(65537));
    await assert.rejects(readGitHubAppInputFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("App input checks the exact live review before reading any private material", async () => {
  for (const changed of [
    { ...review, fingerprint: "sha256:" + "b".repeat(64) },
    { ...review, expired: true },
    { ...review, privateInputRequired: false },
  ]) {
    let reads = 0;
    await assert.rejects(
      supplyGitHubAppMaterial({
        selection,
        review: async () => changed,
        read: async () => {
          reads++;
          return new TextEncoder().encode("private-canary");
        },
        send: async () => Response.json({}),
      }),
    );
    assert.equal(reads, 0);
  }
});

test("App input handles already-applied reviews without reading or comparing supplied values", async () => {
  let reads = 0;
  const result = await supplyGitHubAppMaterial({
    selection,
    review: async () => ({ ...review, applied: true }),
    read: async () => {
      reads++;
      return new Uint8Array();
    },
    send: async () => {
      throw new Error("No send expected");
    },
  });
  assert.equal(result.submitted, false);
  assert.equal(reads, 0);
});

test("Node normalizes both supported key encodings independently of Worker import", async () => {
  const key = await githubAppTestKey();
  assert.equal(
    (await normalizeGitHubAppKey(key.pkcs1)).fingerprint,
    key.fingerprint,
  );
  assert.equal(
    (await normalizeGitHubAppKey(key.pkcs8)).fingerprint,
    key.fingerprint,
  );
});

test("private App input sends only to the exact boundary and clears owned bytes", async () => {
  const value = new TextEncoder().encode(
    JSON.stringify({ version: 1, privateKey: "synthetic-private-canary" }),
  );
  const result = await supplyGitHubAppMaterial({
    selection,
    review: async () => review,
    read: async () => value,
    send: async (path, init) => {
      assert.equal(
        path,
        "/api/github-apps/input?workspaceId=administration&planId=review",
      );
      assert.equal(
        new Headers(init.headers).get("If-Match"),
        selection.fingerprint,
      );
      assert.equal(init.redirect, "error");
      return Response.json({
        submitted: true,
        review: { ...review, applied: true },
      });
    },
  });
  assert.equal(result.submitted, true);
  assert.equal(
    value.every((byte) => byte === 0),
    true,
  );
  assert.equal(
    JSON.stringify(result).includes("synthetic-private-canary"),
    false,
  );
});

test("uncertain App input is never automatically replayed", async () => {
  let sends = 0;
  await assert.rejects(
    supplyGitHubAppMaterial({
      selection,
      review: async () => review,
      read: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            privateKey: "synthetic-private-canary",
          }),
        ),
      send: async () => {
        sends++;
        return new Response("private-response-canary", { status: 503 });
      },
    }),
    { uncertain: true },
  );
  assert.equal(sends, 1);
});

test("App import CLI documents private input and both help forms", () => {
  for (const flag of ["-h", "--help"]) {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "cli/index.ts", "github-app-input", flag],
      {
        encoding: "utf8",
        env: { ...process.env, HQ_URL: "http://127.0.0.1:1" },
        timeout: 10000,
      },
    );
    assert.match(output, /--input/);
    assert.match(output, /never values in command arguments/);
    assert.match(output, /Exit statuses/);
  }
});
