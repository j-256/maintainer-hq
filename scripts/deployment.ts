import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, lstat, open, unlink, chmod, cp, rename } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { parse } from "jsonc-parser";
import { confinedPath, xdgRoot, profileFile, privateDirectory, DeploymentPathError } from "./deployment-paths";
import { wranglerDiagnostics } from "./deployment-diagnostics";
import { verifyArtifact } from "./release-artifact";
import { readReleaseProfile, sha256 } from "./release-profile";
import { clientConfiguration } from "../cli/client";
import { checkTarget, assertUploaded, smokeApplication, smokeDocs, type Target, type TargetSnapshot, DeploymentProviderError } from "./deployment-provider";

const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const ASSET_FILE_BYTES = 25 * 1024 * 1024;
const ASSET_FILES = 20_000;
const MAX_ASSET_DEPTH = 20;
const absolutePath = z.string().min(1).refine(isAbsolute);
export const configurationSchema = z.object({
  profile: absolutePath,
  keychain: z.object({ path: absolutePath, account: z.string().min(1), tokenService: z.string().min(1), accessClientIdService: z.string().min(1), accessClientSecretService: z.string().min(1) }).strict().optional(),
}).strict();
export type DeploymentMode = "app" | "docs";
export const configPath = () => confinedPath(xdgRoot(process.env.XDG_CONFIG_HOME, join(homedir(), ".config")), "hq-deploy", "config.json");
export const statePath = () => confinedPath(xdgRoot(process.env.XDG_STATE_HOME, join(homedir(), ".local/state")), "hq-deploy");
export class DeploymentError extends Error { constructor(message: string, readonly exitCode = 1) { super(message); } }

export async function savedConfiguration(path = configPath()) {
  try {
    await privateDirectory(dirname(path), false);
    const file = await profileFile(path);
    return configurationSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch { throw new DeploymentError("Missing, unsafe, or invalid deployment configuration; inspect it or configure a new installation with --save-profile <absolute-profile.json>", 2); }
}
export async function saveProfile(profile: string) {
  profile = await profileFile(profile);
  try { await readReleaseProfile(profile); } catch { throw new DeploymentError("Use a readable valid deployment profile JSON file", 2); }
  const path = configPath();
  await privateDirectory(dirname(path));
  let existing = {};
  try {
    await lstat(path);
    existing = await savedConfiguration(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = confinedPath(dirname(path), "config-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify({ ...existing, profile }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return path;
}

export function deploymentStages(mode: DeploymentMode, dryRun: boolean) {
  return ["checks", "build", "verify", ...dryRun ? [] : ["preflight", "backup", ...mode === "app" ? ["rehearse"] : [], "recheck", ...mode === "app" ? ["migrate"] : [], "upload", "readback", "smoke"]];
}
export async function runStages(names: string[], directory: string, action: (name: string) => Promise<void>, metadata: Record<string, unknown> = {}) {
  const stages: { name: string; status: string; startedAt: string; durationMs?: number }[] = [];
  const persist = () => writeFile(join(directory, "receipt.json"), JSON.stringify({ ...metadata, stages }, null, 2) + "\n", { mode: 0o600 });
  for (const name of names) {
    const stage = { name, status: "running", startedAt: new Date().toISOString(), durationMs: 0 };
    stages.push(stage);
    await persist();
    const start = performance.now();
    process.stderr.write("hq-deploy: " + name + "\n");
    try { await action(name); stage.status = "complete"; }
    catch (error) {
      metadata.failureReason = error instanceof DeploymentError || error instanceof DeploymentProviderError || error instanceof DeploymentPathError ? error.message : "Stage failed; unsupported input or response (details suppressed)";
      stage.status = "failed";
      stage.durationMs = Math.round(performance.now() - start);
      await persist();
      const mutationStarted = stages.some(stage => ["migrate", "upload"].includes(stage.name));
      throw new DeploymentError(`Deployment stopped at ${name}; inspect ${join(directory, "receipt.json")}` + (mutationStarted ? ". A migration/upload may have taken effect; inspect production before another attempt" : ""));
    }
    stage.durationMs = Math.round(performance.now() - start);
    await persist();
  }
}
export async function sealDirectory(directory: string) {
  const files: Record<string, string> = {};
  async function walk(path: string, prefix: string, depth: number) {
    if (depth > MAX_ASSET_DEPTH) throw new DeploymentError("Static artifact nesting exceeds the limit");
    for (const entry of await readdir(path)) {
      const full = join(path, entry);
      const name = prefix + entry;
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new DeploymentError("Static artifact contains a symlink");
      if (info.isDirectory()) await walk(full, name + "/", depth + 1);
      else if (!info.isFile() || info.size > ASSET_FILE_BYTES) throw new DeploymentError("Static artifact has an unsupported file or exceeds Free asset size limits");
      else {
        files[name] = sha256(await readFile(full));
        if (Object.keys(files).length > ASSET_FILES) throw new DeploymentError("Static artifact exceeds Free asset file limits");
      }
    }
  }
  if ((await lstat(directory)).isSymbolicLink()) throw new DeploymentError("Static artifact root is a symlink");
  await walk(directory, "", 0);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export function documentationSearchPath(seal: Record<string, string>) {
  const path = seal["pagefind/pagefind.js"] ? "pagefind/pagefind.js" : undefined;
  if (!path) throw new DeploymentError("Docs search assets are missing");
  return "/" + path;
}
export async function assertDirectorySeal(directory: string, seal: Record<string, string>) {
  if (JSON.stringify(await sealDirectory(directory)) !== JSON.stringify(seal)) throw new DeploymentError("Static artifact changed after verification");
}
function localEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "1".repeat(32) };
  for (const key of Object.keys(environment)) if (/^(HQ_|CLOUDFLARE_|WRANGLER_ENV$|CLOUDFLARE_ENV$)/.test(key)) delete environment[key as keyof typeof environment];
  return { ...environment, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "1".repeat(32) };
}
async function command(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath?: string, failureLog?: { path: string; operation: string; migrations: string[] }) {
  try {
    const result = await execute(file, args, { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT });
    if (logPath) await writeFile(logPath, result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (logPath) await writeFile(logPath, (failure.stdout ?? "") + (failure.stderr ?? ""), { mode: 0o600 });
    if (failureLog) await writeFile(failureLog.path, JSON.stringify({
      operation: failureLog.operation,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      outcome: "Inspect production; a migration or upload may have taken effect",
      ...wranglerDiagnostics((failure.stdout ?? "") + (failure.stderr ?? ""), failureLog.migrations),
    }, null, 2) + "\n", { mode: 0o600 });
    throw new DeploymentError("Deployment subprocess failed" + (typeof failure.code === "number" ? " (exit " + failure.code + ")" : " or exceeded its resource/time limit") + (logPath ? "; inspect " + logPath : failureLog ? "; inspect " + failureLog.path : "; private command output is suppressed"));
  }
}
async function sourceState(root: string) {
  const env = localEnvironment();
  const status = await command("git", ["status", "--porcelain", "--untracked-files=normal"], root, env);
  if (status.trim()) throw new DeploymentError("Commit or preserve checkout changes before deployment", 2);
  return (await command("git", ["rev-parse", "HEAD"], root, env)).trim();
}
async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return String(port);
}
async function smokeConfiguration(origin: string, config: z.infer<typeof configurationSchema>) {
  const env = process.env;
  if (env.HQ_TOKEN || env.HQ_ACCESS_TOKEN || !config.keychain) return clientConfiguration(origin, false);
  const store = config.keychain;
  async function secret(service: string) {
    try { return (await execute("/usr/bin/security", ["find-generic-password", "-a", store.account, "-s", service, "-w", store.path], { timeout: 30_000, maxBuffer: 32_768 })).stdout.trim(); }
    catch { throw new DeploymentError("Cannot read deployment smoke credential from the configured Keychain; restore access without changing its locking policy", 2); }
  }
  return clientConfiguration(origin, false, await secret(store.tokenService), undefined, await secret(store.accessClientIdService), await secret(store.accessClientSecretService));
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function sqliteValueProjection(column: string) {
  const name = quote(column);
  return `CASE typeof(${name}) WHEN 'text' THEN 'text:' || hex(CAST(${name} AS BLOB)) WHEN 'blob' THEN 'blob:' || hex(${name}) WHEN 'real' THEN 'real:' || printf('%!.26g', ${name}) ELSE typeof(${name}) || ':' || quote(${name}) END`;
}
const sqlResults = (text: string) => z.array(z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.unknown())) })).parse(JSON.parse(text));

export async function rehearseDatabase(root: string, backup: string, persist: string, config: string, wr: (args: string[], network: boolean) => Promise<string>) {
  const snapshot = z.array(z.object({ name: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) })).parse(JSON.parse(await command("python3", [join(root, "scripts/deployment-rehearsal.py"), backup], root, localEnvironment())));
  if (!snapshot.length) throw new DeploymentError("Export contains no application tables");
  await wr(["d1", "execute", "HQ_DB", "--local", "--config", config, "--persist-to", persist, "--file", backup], false);
  const queries = snapshot.map(table => `SELECT ${table.columns.map((column, index) => `${sqliteValueProjection(column)} AS c${index}`).join(",")} FROM ${quote(table.name)};`);
  const comparison = join(dirname(backup), "restore-comparison.sql");
  await writeFile(comparison, queries.join("\n"), { mode: 0o600 });
  const results = sqlResults(await wr(["d1", "execute", "HQ_DB", "--local", "--config", config, "--persist-to", persist, "--file", comparison, "--json"], false));
  if (results.length !== snapshot.length) throw new DeploymentError("Restored database table inventory differs from the export");
  for (const [index, table] of snapshot.entries()) {
    const rows = results[index].results.map(row => table.columns.map((_, index) => row["c" + index])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (JSON.stringify(rows) !== JSON.stringify(table.rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))) throw new DeploymentError("Restored database rows differ from the export");
  }
  await wr(["d1", "migrations", "apply", "HQ_DB", "--local", "--config", config, "--persist-to", persist], false);
  const result = sqlResults(await wr(["d1", "execute", "HQ_DB", "--local", "--config", config, "--persist-to", persist, "--command", "PRAGMA quick_check; PRAGMA foreign_key_check;", "--json"], false));
  if (result.length !== 2 || result[0].results.length !== 1 || Object.values(result[0].results[0])[0] !== "ok" || result[1].results.length) throw new DeploymentError("Migrated rehearsal database integrity check failed");
}

export async function deploy(root: string, mode: DeploymentMode, options: { profile?: string; dryRun?: boolean }) {
  let saved: z.infer<typeof configurationSchema>;
  if (options.profile) saved = { profile: await profileFile(options.profile) };
  else saved = await savedConfiguration();
  const profilePath = await profileFile(saved.profile);
  const { profile, fingerprint } = await readReleaseProfile(profilePath).catch(() => { throw new DeploymentError("Use a readable valid deployment profile JSON file", 2); });
  for (const tool of ["git", "npm"]) {
    try { await execute(tool, ["--version"]); } catch { throw new DeploymentError("Deployment requires " + tool, 3); }
  }
  const source = await sourceState(root);
  for (const dependency of ["node_modules/wrangler/bin/wrangler.js", "node_modules/tsx/dist/cli.mjs", "node_modules/@playwright/test/cli.js", ...mode === "docs" ? ["site/node_modules/astro/package.json"] : []]) {
    try { await lstat(join(root, dependency)); }
    catch { throw new DeploymentError("Install locked dependencies with npm ci and npm --prefix site ci; install Chromium with npx playwright install chromium", 3); }
  }
  if (mode === "app") {
    try { await execute("python3", ["-c", "import sqlite3"]); }
    catch { throw new DeploymentError("Application migration rehearsal requires Python 3 with sqlite3", 3); }
  }
  const state = statePath();
  await privateDirectory(state);
  const target: Target = { accountId: profile.accountId, workerName: profile.workerName, hostname: profile.intendedHostname, profile };
  let docsConfig: Record<string, unknown> = {};
  if (mode === "docs") {
    const errors: import("jsonc-parser").ParseError[] = [];
    docsConfig = parse(await readFile(join(root, "site/wrangler.jsonc"), "utf8"), errors);
    const schema = z.object({ $schema: z.string().optional(), name: z.string().min(1), compatibility_date: z.string(), send_metrics: z.literal(false), workers_dev: z.literal(false), preview_urls: z.literal(false), routes: z.array(z.object({ pattern: z.string().regex(/^[a-z0-9.-]+$/), custom_domain: z.literal(true) }).strict()).length(1), assets: z.object({ directory: z.literal("./dist"), html_handling: z.literal("auto-trailing-slash"), not_found_handling: z.literal("404-page") }).strict() }).strict();
    if (errors.length) throw new DeploymentError("Invalid docs configuration", 2);
    const checked = schema.safeParse(docsConfig);
    if (!checked.success) throw new DeploymentError("Docs configuration is outside the supported static deployment contract", 2);
    const parsed = checked.data;
    target.workerName = parsed.name;
    target.hostname = parsed.routes[0].pattern;
    delete target.profile;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!options.dryRun && !token) throw new DeploymentError("Set CLOUDFLARE_API_TOKEN before deployment", 2);
  const smoke = !options.dryRun && mode === "app" ? await smokeConfiguration("https://" + target.hostname, saved) : undefined;
  const runId = randomUUID();
  const run = join(state, runId);
  await mkdir(run, { mode: 0o700 });
  const lockPath = join(state, sha256(target.accountId + "/" + target.workerName) + ".lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new DeploymentError("Another deployment holds the target lock; inspect the retained lock and receipt before removing a stale lock", 2); }
  await lock.writeFile(JSON.stringify({ runId, pid: process.pid, receipt: join(run, "receipt.json") }));
  const local = localEnvironment();
  const remote: NodeJS.ProcessEnv = { ...local, CLOUDFLARE_ACCOUNT_ID: target.accountId, CLOUDFLARE_API_TOKEN: token, CI: "true" };
  const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
  const artifact = join(run, "artifact");
  const config = join(artifact, "wrangler.json");
  const wr = async (args: string[], network: boolean) => command(process.execPath, [wrangler, ...args], artifact, network ? remote : local, undefined, {
    path: join(run, "wrangler-failure.json"),
    operation: args[0] === "deploy" ? "upload" : args.slice(0, 3).join(" "),
    migrations: mode === "app" ? (await readdir(join(artifact, "migrations"))).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)) : [],
  });
  const npm = async (script: string, env: NodeJS.ProcessEnv = local) => command("npm", ["run", script], root, env, join(run, script.replaceAll(":", "-") + ".log"));
  const backup = join(run, "database.sql");
  const persist = join(run, "rehearsal");
  let artifactFingerprint = "";
  let docsSeal: Record<string, string> = {};
  let previous: TargetSnapshot;
  let searchPath = "";
  const metadata: Record<string, unknown> = { runId, mode, source, profileFingerprint: fingerprint, accountId: target.accountId, workerName: target.workerName, hostname: target.hostname, dryRun: Boolean(options.dryRun) };
  async function verify() {
    if ((await sourceState(root)) !== source || (await readReleaseProfile(profilePath)).fingerprint !== fingerprint) throw new DeploymentError("Deployment source or profile changed");
    if (mode === "app") await verifyArtifact(artifact, fingerprint, artifactFingerprint);
    else {
      await assertDirectorySeal(join(artifact, "assets"), docsSeal);
      if (sha256(await readFile(config)) !== artifactFingerprint) throw new DeploymentError("Docs deployment configuration changed");
    }
  }
  try {
    await runStages(deploymentStages(mode, Boolean(options.dryRun)), run, async stage => {
      switch (stage) {
        case "checks":
          if (mode === "app") { await npm("check"); await npm("test:release"); }
          else { await npm("docs:check"); await npm("docs:test:browser", { ...local, HQ_DOCS_TEST_PORT: await availablePort() }); }
          break;
        case "build":
          if (mode === "app") {
            const built = await command(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "cli/release.ts"), "build", "--profile", profilePath, "--review", fingerprint, "--output", artifact], root, local, join(run, "build.log"));
            artifactFingerprint = z.object({ artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(built)).artifactFingerprint;
          }
          else {
            docsSeal = await sealDirectory(join(root, "site/dist"));
            if (!docsSeal["index.html"] || !docsSeal["404.html"]) throw new DeploymentError("Docs output is incomplete");
            searchPath = documentationSearchPath(docsSeal);
            await mkdir(artifact);
            await cp(join(root, "site/dist"), join(artifact, "assets"), { recursive: true, dereference: false });
            const { $schema: _schema, ...portable } = docsConfig;
            await writeFile(config, JSON.stringify({ ...portable, account_id: target.accountId, routes: [], upload_source_maps: false, assets: { ...docsConfig.assets as object, directory: "./assets" } }, null, 2) + "\n");
            artifactFingerprint = sha256(await readFile(config));
            await writeFile(join(run, "assets-manifest.json"), JSON.stringify(docsSeal, null, 2));
          }
          metadata.artifactFingerprint = artifactFingerprint;
          break;
        case "verify": await verify(); await wr(["deploy", "--dry-run", "--config", config, "--outdir", join(run, "dry-run")], false); break;
        case "preflight":
          previous = await checkTarget(target, token!);
          metadata.previous = previous;
          if (smoke) await smokeApplication(smoke, profile.accessIssuer);
          break;
        case "backup":
          if (mode === "app") {
            await wr(["d1", "export", "HQ_DB", "--remote", "--config", config, "--output", backup, "--skip-confirmation"], true);
            await chmod(backup, 0o600);
          }
          break;
        case "rehearse": await rehearseDatabase(root, backup, persist, config, wr); break;
        case "recheck": {
          await verify();
          const current = await checkTarget(target, token!);
          if (JSON.stringify(current) !== JSON.stringify(previous)) throw new DeploymentError("Deployment target changed during preparation");
          break;
        }
        case "migrate": await wr(["d1", "migrations", "apply", "HQ_DB", "--remote", "--config", config], true); break;
        case "upload":
          await verify();
          if (JSON.stringify(await checkTarget(target, token!)) !== JSON.stringify(previous)) throw new DeploymentError("Deployment target changed before upload");
          await wr(["deploy", "--config", config, "--keep-vars", "--tag", runId, "--strict"], true);
          break;
        case "readback": {
          const current = await checkTarget(target, token!);
          if (JSON.stringify(current.secretNames) !== JSON.stringify(previous.secretNames) || current.domainId !== previous.domainId || JSON.stringify(current.variableFingerprints) !== JSON.stringify(previous.variableFingerprints)) throw new DeploymentError("Secret names, non-secret variables, or hostname ownership changed after upload");
          metadata.deployed = await assertUploaded(target, token!, runId, previous);
          break;
        }
        case "smoke": if (smoke) await smokeApplication(smoke, profile.accessIssuer); else await smokeDocs(target, searchPath); break;
      }
    }, metadata);
    return { runId, receipt: join(run, "receipt.json"), dryRun: Boolean(options.dryRun) };
  } finally { await lock.close(); await unlink(lockPath); }
}
