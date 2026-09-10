import {
  readFile,
  readdir,
  lstat,
  mkdir,
  copyFile,
  writeFile,
} from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { z } from "zod";
import { staticHeaderRules } from "../shared/security";
import {
  RELEASE_LIMITS,
  portableConfig,
  profileFingerprint,
  readReleaseProfile,
  releaseProfileSchema,
  sha256,
  verifyGeneratedConfig,
  type ReleaseProfile,
} from "./release-profile";

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: releaseProfileSchema,
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
const validPath = (path: string) =>
  /^(?:worker\.js|wrangler\.json|manifest\.json|(?:assets|migrations)\/[a-zA-Z0-9_./-]+)$/.test(
    path,
  ) && !path.split("/").some((part) => part === "." || part === ".." || !part);

async function inventory(directory: string) {
  const files: Record<string, string> = {};
  let total = 0;
  let entries = 0;
  async function walk(path: string, depth = 0) {
    if (depth > RELEASE_LIMITS.DEPTH)
      throw new Error("Artifact exceeds the directory depth limit");
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (++entries > RELEASE_LIMITS.FILES)
        throw new Error("Artifact exceeds the entry limit");
      const full = join(path, item.name);
      const name = relative(directory, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new Error("Artifact contains a symlink or non-file entry");
      if (info.isDirectory()) {
        if (!/^(?:assets|migrations)(?:\/[a-zA-Z0-9_.-]+)*$/.test(name))
          throw new Error("Artifact contains an unsupported directory");
        await walk(full, depth + 1);
        continue;
      }
      if (
        !validPath(name) ||
        info.size > RELEASE_LIMITS.FILE_BYTES ||
        Object.keys(files).length >= RELEASE_LIMITS.FILES
      )
        throw new Error(
          "Artifact contains unsupported paths or exceeds a file limit",
        );
      total += info.size;
      if (total > RELEASE_LIMITS.TOTAL_BYTES)
        throw new Error("Artifact exceeds the size limit");
      const content = await readFile(full);
      if (
        /\.(?:js|css|html|json|sql)$/.test(name) &&
        (/\/Users\/|(?:^|[^A-Za-z0-9+/]|file:\/\/|\\[nrt])\/(?:c|z)\//m.test(
          content.toString(),
        ) ||
          /\bhq[pa]_[a-f0-9]{64}\b/.test(content.toString()) ||
          /\bhkr_[A-Za-z0-9_-]{43}\b/.test(content.toString()) ||
          /\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{20,}\b/.test(content.toString()) ||
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
            content.toString(),
          ))
      )
        throw new Error(
          "Artifact contains private paths or credential material",
        );
      files[name] = sha256(content);
    }
  }
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Use a real artifact directory");
  await walk(directory);
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function sourceFingerprint(root: string) {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const records = await Promise.all(
    paths.map(async (path) => [path, sha256(await readFile(join(root, path)))]),
  );
  return sha256(JSON.stringify(records));
}

async function copyTree(source: string, destination: string) {
  await mkdir(destination);
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.isSymbolicLink())
      throw new Error("Do not package symlinked build outputs");
    if (item.isDirectory())
      await copyTree(join(source, item.name), join(destination, item.name));
    else if (item.isFile() && item.name !== ".assetsignore")
      await copyFile(join(source, item.name), join(destination, item.name));
    else if (!item.isFile()) throw new Error("Unsupported build output");
  }
}

export async function verifyArtifact(
  directory: string,
  expectedFingerprint: string,
  expectedArtifactFingerprint?: string,
) {
  const files = await inventory(directory);
  const artifactFingerprint = sha256(
    await readFile(join(directory, "manifest.json")),
  );
  if (
    expectedArtifactFingerprint &&
    artifactFingerprint !== expectedArtifactFingerprint
  )
    throw new Error(
      "Artifact does not match the separately retained build digest",
    );
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (
    manifest.profileFingerprint !== expectedFingerprint ||
    profileFingerprint(manifest.profile) !== expectedFingerprint
  )
    throw new Error("Artifact profile does not match the reviewed fingerprint");
  delete files["manifest.json"];
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("Artifact inventory or checksums changed");
  const config = JSON.parse(
    await readFile(join(directory, "wrangler.json"), "utf8"),
  );
  if (
    JSON.stringify(config) !== JSON.stringify(portableConfig(manifest.profile))
  )
    throw new Error(
      "Artifact configuration differs from the reviewed deployment contract",
    );
  if (
    (await readFile(join(directory, "assets/_headers"), "utf8")) !==
    staticHeaderRules()
  )
    throw new Error(
      "Artifact security headers do not match the application policy",
    );
  const worker = await readFile(join(directory, "worker.js"), "utf8");
  if (worker.includes("development-owner"))
    throw new Error("Development identity found in release artifact");
  if (
    !Object.keys(files).some(
      (file) => file.startsWith("migrations/") && file.endsWith(".sql"),
    ) ||
    !files["assets/index.html"]
  )
    throw new Error("Artifact is missing its schema or application shell");
  return {
    fingerprint: manifest.profileFingerprint,
    sourceFingerprint: manifest.sourceFingerprint,
    artifactFingerprint,
    workerName: manifest.profile.workerName,
    intendedHostname: manifest.profile.intendedHostname,
    attachedHostnames: [],
    deploymentAuthorized: false,
  };
}

async function runBuild(
  root: string,
  path: string,
  fingerprint: string,
  profile: ReleaseProfile,
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HQ_RELEASE_PROFILE: resolve(path),
    HQ_RELEASE_REVIEW: fingerprint,
    CLOUDFLARE_ACCOUNT_ID: profile.accountId,
    CLOUDFLARE_API_TOKEN: "",
  };
  delete environment.CLOUDFLARE_ENV;
  delete environment.WRANGLER_ENV;
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--mode",
        "release",
      ],
      {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RELEASE_LIMITS.BUILD_TIMEOUT_MS,
      },
    );
    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? done() : reject(new Error("Vite release build failed")),
    );
  });
}

export class MissingBuildDependency extends Error {}

async function requireBuildDependencies(root: string) {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    for (const path of [
      "node_modules/vite/bin/vite.js",
      "node_modules/typescript/bin/tsc",
      "package-lock.json",
    ])
      if (!(await lstat(join(root, path))).isFile())
        throw new Error("Missing dependency");
  } catch {
    throw new MissingBuildDependency(
      "Build requires Git and locked dependencies installed with npm ci",
    );
  }
}

export async function buildArtifact(
  root: string,
  profilePath: string,
  fingerprint: string,
  output: string,
) {
  const { profile, fingerprint: actual } =
    await readReleaseProfile(profilePath);
  if (actual !== fingerprint)
    throw new Error(
      "Profile changed: inspect and review its exact fingerprint before building",
    );
  const directory = resolve(output);
  await requireBuildDependencies(root);
  try {
    await lstat(directory);
    throw new Error(
      "Artifact output already exists; choose a new empty destination",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const source = await sourceFingerprint(root);
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RELEASE_LIMITS.BUILD_TIMEOUT_MS,
    },
  );
  await runBuild(root, profilePath, fingerprint, profile);
  if ((await sourceFingerprint(root)) !== source)
    throw new Error(
      "Source files changed during the build; start a fresh reviewed build",
    );
  const workerDirectory = join(root, "dist", "maintainer_hq");
  const generated = JSON.parse(
    await readFile(join(workerDirectory, "wrangler.json"), "utf8"),
  );
  verifyGeneratedConfig(generated, profile);
  await mkdir(directory, { recursive: false });
  await copyFile(
    join(workerDirectory, "index.js"),
    join(directory, "worker.js"),
  );
  await copyTree(join(root, "dist/client"), join(directory, "assets"));
  await copyTree(join(root, "migrations"), join(directory, "migrations"));
  await writeFile(
    join(directory, "wrangler.json"),
    JSON.stringify(portableConfig(profile), null, 2) + "\n",
    { flag: "wx" },
  );
  const files = await inventory(directory);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        profile,
        profileFingerprint: fingerprint,
        sourceFingerprint: source,
        files,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  if ((await sourceFingerprint(root)) !== source)
    throw new Error(
      "Source files changed during packaging; start a fresh reviewed build",
    );
  return verifyArtifact(directory, fingerprint);
}
