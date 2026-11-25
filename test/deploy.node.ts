import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deploymentStages, runStages, savedConfiguration, sealDirectory, assertDirectorySeal } from "../scripts/deployment";
import { checkTarget, smokeApplication, cloudflareList } from "../scripts/deployment-provider";
import { readReleaseProfile } from "../scripts/release-profile";

const fixture = (await readReleaseProfile("fixtures/release-profile.json")).profile;

test("deployment order places rehearsed migration and target checks before upload", () => {
  const app = deploymentStages("app", false);
  assert.ok(app.indexOf("rehearse") < app.indexOf("migrate"));
  assert.ok(app.indexOf("recheck") < app.indexOf("migrate"));
  assert.ok(app.indexOf("migrate") < app.indexOf("upload"));
  assert.ok(app.indexOf("upload") < app.indexOf("readback"));
  assert.equal(app.at(-1), "smoke");
  for (const mode of ["app", "docs"] as const) {
    assert.deepEqual(deploymentStages(mode, true), ["checks", "build", "verify"]);
  }
  assert.ok(!deploymentStages("docs", false).includes("migrate"));
});

test("a failed stage retains a safe receipt and never runs subsequent operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-deploy-test-"));
  try {
    const seen: string[] = [];
    await assert.rejects(runStages(["backup", "migrate", "upload"], directory, async name => {
      seen.push(name);
      if (name === "migrate") throw new Error("sensitive-provider-response");
    }), /migrate/);
    assert.deepEqual(seen, ["backup", "migrate"]);
    const receipt = await readFile(join(directory, "receipt.json"), "utf8");
    assert.doesNotMatch(receipt, /sensitive-provider-response/);
    assert.equal(JSON.parse(receipt).stages.at(-1).status, "failed");
  } finally { await rm(directory, { recursive: true }); }
});

test("saved configuration requires paths, not inline credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-deploy-config-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ profile: "/private/production.json" }));
    assert.equal((await savedConfiguration(path)).profile, "/private/production.json");
    await writeFile(path, JSON.stringify({ profile: "/private/production.json", token: "secret" }));
    await assert.rejects(savedConfiguration(path), /configuration/);
  } finally { await rm(directory, { recursive: true }); }
});

test("sealed static artifacts reject changes, extra files, and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-deploy-assets-"));
  try {
    await writeFile(join(directory, "index.html"), "original");
    const seal = await sealDirectory(directory);
    await assertDirectorySeal(directory, seal);
    await writeFile(join(directory, "index.html"), "changed");
    await assert.rejects(assertDirectorySeal(directory, seal), /changed/);
  } finally { await rm(directory, { recursive: true }); }
});

function providerFetch(patch: Record<string, unknown> = {}) {
  return (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname.replace(/^\/client\/v4/, "");
    const result = path.endsWith("/workers/domains") ? [{ hostname: fixture.intendedHostname, service: fixture.workerName, environment: "production" }]
      : path.endsWith("/workers/scripts") ? [{ id: fixture.workerName, tag: "worker-id" }]
      : path.endsWith("/access/apps") ? [{ id: "app-id", aud: fixture.accessAudience, destinations: [{ type: "worker", worker_id: "worker-id" }] }]
      : path.endsWith("/settings") ? { bindings: [{ type: "d1", name: "HQ_DB", id: fixture.databaseId }, { type: "plain_text", name: "ACCESS_ISSUER", text: fixture.accessIssuer }, { type: "plain_text", name: "ACCESS_AUDIENCE", text: fixture.accessAudience }] }
      : path.includes("/d1/database/") ? { uuid: fixture.databaseId, name: fixture.databaseName }
      : path.endsWith("/subdomain") ? { enabled: false, previews_enabled: false }
      : path.endsWith("/deployments") ? { deployments: [{ id: "deployment-id", versions: [{ version_id: "old-version", percentage: 100 }] }] }
      : undefined;
    return Response.json({ success: true, result: path in patch ? patch[path] : result, result_info: { page: 1, total_pages: 1 } });
  }) as typeof fetch;
}

test("target mismatch stops deployment instead of reassigning hostname or database", async () => {
  const target = { accountId: fixture.accountId, workerName: fixture.workerName, hostname: fixture.intendedHostname, profile: fixture };
  await checkTarget(target, "synthetic", providerFetch());
  const path = `/accounts/${fixture.accountId}/workers/domains`;
  await assert.rejects(checkTarget(target, "synthetic", providerFetch({ [path]: [{ hostname: fixture.intendedHostname, service: "different-worker" }] })), /hostname/);
  const settings = `/accounts/${fixture.accountId}/workers/scripts/${fixture.workerName}/settings`;
  await assert.rejects(checkTarget(target, "synthetic", providerFetch({ [settings]: { bindings: [{ type: "d1", name: "HQ_DB", id: fixture.retainedDatabaseId }, { type: "plain_text", name: "ACCESS_ISSUER", text: fixture.accessIssuer }, { type: "plain_text", name: "ACCESS_AUDIENCE", text: fixture.accessAudience }] } })), /database/);
});

test("Cloudflare inventories paginate rather than trusting a first-page sample", async () => {
  let calls = 0;
  const fake = (async () => Response.json({ success: true, result: [{ id: ++calls }], result_info: { page: calls, total_pages: 2 } })) as typeof fetch;
  assert.deepEqual(await cloudflareList("/accounts/synthetic/workers/domains", "synthetic", fake), [{ id: 1 }, { id: 2 }]);
  assert.equal(calls, 2);
});

test("smoke checks reject a login redirect or anonymous JSON as authenticated success", async () => {
  const config = { origin: "https://synthetic.example", headers: { Authorization: "Bearer secret" } };
  const redirect = (async () => new Response(null, { status: 302, headers: { location: "https://login.example" } })) as typeof fetch;
  await assert.rejects(smokeApplication(config, fixture.accessIssuer, redirect));
});

test("deploy commands show help and reject unknown options without loading credentials", () => {
  for (const mode of ["app", "docs"]) {
    for (const flag of ["-h", "--help"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "cli/deploy.ts", mode, flag], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /dry-run/);
      assert.equal(result.stderr, "");
    }
    const invalid = spawnSync(process.execPath, ["--import", "tsx", "cli/deploy.ts", mode, "--unexpected"], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
  }
});

test("every failed stage short-circuits and leaves its exact stage durable", async () => {
  const names = deploymentStages("app", false);
  for (const failure of ["preflight", "rehearse", "recheck", "migrate", "upload", "smoke"]) {
    const directory = await mkdtemp(join(tmpdir(), "hq-stage-failure-"));
    const seen: string[] = [];
    try {
      await assert.rejects(runStages(names, directory, async stage => {
        seen.push(stage);
        if (stage === failure) throw new Error("must-not-be-logged");
      }), new RegExp(failure));
      assert.deepEqual(seen, names.slice(0, names.indexOf(failure) + 1));
      const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
      assert.equal(receipt.stages.at(-1).name, failure);
      assert.equal(receipt.stages.at(-1).status, "failed");
    } finally { await rm(directory, { recursive: true }); }
  }
});

test("application smoke requires both outer denial and a real authenticated workspace", async () => {
  const config = { origin: "https://synthetic.example", headers: { Authorization: "Bearer synthetic" } };
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!Object.keys(init?.headers ?? {}).length) return new Response(null, { status: 302, headers: { location: fixture.accessIssuer + "/cdn-cgi/access/login" } });
    if (String(url).endsWith("/healthz")) return Response.json({ status: "ok" });
    if (String(url).endsWith("/api/session")) return Response.json({ workspaces: [{ id: "synthetic" }] });
    return new Response("<html>application</html>", { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  await smokeApplication(config, fixture.accessIssuer, fake);
  await assert.rejects(smokeApplication(config, fixture.accessIssuer, (async () => Response.json({ status: "ok" })) as typeof fetch), /Anonymous/);
});

test("upload readback accepts only this run's fully serving version", async () => {
  const { assertUploaded } = await import("../scripts/deployment-provider");
  const target = { accountId: fixture.accountId, workerName: fixture.workerName, hostname: fixture.intendedHostname };
  const previous = { deploymentId: "previous", versions: [{ version_id: "old", percentage: 100 }], secretNames: [], variableFingerprints: {}, serviceBindings: [] };
  const fake = (async (url: string | URL | Request) => Response.json({ success: true, result: String(url).includes("/deployments") ? { deployments: [{ id: "next", versions: [{ version_id: "new", percentage: 100 }] }] } : { annotations: { "workers/tag": "this-run" } } })) as typeof fetch;
  await assertUploaded(target, "synthetic", "this-run", previous, fake);
  await assert.rejects(assertUploaded(target, "synthetic", "different-run", previous, fake), /does not match/);
});

test("local D1 restoration preserves exact exported rows before migrating", { timeout: 90_000 }, async () => {
  const { rehearseDatabase } = await import("../scripts/deployment");
  const { mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "hq-rehearsal-test-"));
  try {
    await mkdir(join(directory, "migrations"));
    await writeFile(join(directory, "migrations/0001.sql"), "ALTER TABLE synthetic ADD COLUMN extra TEXT;\n");
    const config = join(directory, "wrangler.json");
    const backup = join(directory, "backup.sql");
    await writeFile(config, JSON.stringify({ name: "synthetic-rehearsal", compatibility_date: "2026-09-07", d1_databases: [{ binding: "HQ_DB", database_name: "synthetic", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "migrations" }] }));
    await writeFile(backup, "CREATE TABLE synthetic (id TEXT PRIMARY KEY, text TEXT, value BLOB); INSERT INTO synthetic VALUES ('one', '  retained whitespace\n', X'0001FF');\n");
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "1".repeat(32), WRANGLER_SEND_METRICS: "false", CI: "true" };
    const wr = async (args: string[], network: boolean) => {
      assert.equal(network, false);
      assert.ok(!args.includes("--remote"));
      return (await execute(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), ...args], { cwd: directory, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    };
    await rehearseDatabase(process.cwd(), backup, join(directory, "state"), config, wr);
    const data = JSON.parse(await wr(["d1", "execute", "HQ_DB", "--local", "--config", config, "--persist-to", join(directory, "state"), "--command", "SELECT extra FROM synthetic", "--json"], false));
    assert.deepEqual(data[0].results, [{ extra: null }]);
  } finally { await rm(directory, { recursive: true }); }
});


test("documentation upload checks the actual Pagefind entrypoint", async () => {
  const { documentationSearchPath } = await import("../scripts/deployment");
  assert.equal(documentationSearchPath({ "index.html": "synthetic", "pagefind/pagefind.js": "synthetic" }), "/pagefind/pagefind.js");
  assert.throws(() => documentationSearchPath({ "index.html": "synthetic" }), /search/);
});

test("stale service bindings are rejected before migration or upload", async () => {
  const profile = { ...fixture, monitoringBindings: [{ binding: "MONITORING_PRIMARY", service: "expected-provider" }] };
  const target = { accountId: profile.accountId, workerName: profile.workerName, hostname: profile.intendedHostname, profile };
  await assert.rejects(checkTarget(target, "synthetic", providerFetch()), /service binding/);
});

test("SQLite restoration projections distinguish text after embedded NUL bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-null-projection-"));
  try {
    const projections: string[] = [];
    for (const suffix of ["first", "second"]) {
      const path = join(directory, suffix + ".sql");
      await writeFile(path, `CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('same' || char(0) || '${suffix}');`);
      const result = spawnSync("python3", ["scripts/deployment-rehearsal.py", path], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      projections.push(result.stdout);
    }
    assert.notEqual(projections[0], projections[1]);
  } finally { await rm(directory, { recursive: true }); }
});

test("remote failure diagnostics retain known migration names and error categories without supplied values", async () => {
  const { wranglerDiagnostics } = await import("../scripts/deployment-diagnostics");
  const result = wranglerDiagnostics("Applying 0001_expected.sql; FOREIGN KEY constraint failed [code: 7500]. supplied=secret-do-not-store; 9999_untrusted.sql", ["0001_expected.sql"]);
  assert.deepEqual(result.mentionedMigrations, ["0001_expected.sql"]);
  assert.deepEqual(result.providerCodes, ["7500"]);
  assert.ok(result.categories.includes("FOREIGN KEY constraint failed"));
  assert.doesNotMatch(JSON.stringify(result), /secret-do-not-store|9999_untrusted/);
});
