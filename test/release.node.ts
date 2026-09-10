import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { staticHeaderRules } from "../shared/security";
import {
  buildArtifact,
  verifyArtifact,
  MissingBuildDependency,
} from "../scripts/release-artifact";
import {
  readReleaseProfile,
  profileFingerprint,
  portableConfig,
  releaseProfileSchema,
  sha256,
  verifyGeneratedConfig,
} from "../scripts/release-profile";

const fixture = (await readReleaseProfile("fixtures/release-profile.json"))
  .profile;
const review = profileFingerprint(fixture);
const digest = "a".repeat(64);
const cli = (args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", "cli/release.ts", ...args], {
    encoding: "utf8",
  });

test("release profiles reject unknown fields, shared targets, and invalid identity or ingress", () => {
  for (const patch of [
    { accountId: "0".repeat(32) },
    { databaseId: fixture.retainedDatabaseId },
    { workerName: fixture.retainedWorkerName },
    { workerName: "maintainer-hq-development" },
    { accessIssuer: "https://fixture.cloudflareaccess.com:444" },
    { accessIssuer: "https://fixture.cloudflareaccess.com/" },
    { accessAudience: "" },
    { routes: ["workspace.example/*"] },
    { secret: "must-not-print" },
    { intendedHostname: "https://workspace.example" },
    { scheduledCollection: "yes" },
  ])
    assert.equal(
      releaseProfileSchema.safeParse({ ...fixture, ...patch }).success,
      false,
    );
  assert.notEqual(
    profileFingerprint({ ...fixture, scheduledCollection: true }),
    review,
  );
  assert.equal(profileFingerprint({ ...fixture }), review);
});

test("generated config rejects merged databases, inherited schedules and unreviewed bindings", () => {
  const config = {
    ...portableConfig(fixture),
    main: "index.js",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  };
  assert.doesNotThrow(() => verifyGeneratedConfig(config, fixture));
  assert.deepEqual(config.limits, {
    cpu_ms: 2000,
    subrequests: 1000,
  });
  for (const patch of [
    { d1_databases: [...config.d1_databases, ...config.d1_databases] },
    { triggers: { crons: ["*/5 * * * *"] } },
    { routes: ["workspace.example/*"] },
    { workers_dev: true },
    { preview_urls: true },
    { limits: { cpu_ms: 30_000, subrequests: 10_000 } },
    { vars: { ...config.vars, EXTRA: "unreviewed" } },
    { services: [{ binding: "UNREVIEWED", service: "other" }] },
    { future_binding: {} },
    { env: { production: {} } },
    { assets: { ...config.assets, run_worker_first: false } },
    { d1_databases: [{ ...config.d1_databases[0], remote: true }] },
  ])
    assert.throws(() =>
      verifyGeneratedConfig({ ...config, ...patch }, fixture),
    );
});

test("private monitoring bindings are exact reviewed authority alongside hooks", () => {
  const enabled = releaseProfileSchema.parse({
    ...fixture,
    hookrelayBindings: [
      { binding: "HOOKRELAY_PRIMARY", service: "synthetic-hookrelay" },
    ],
    monitoringBindings: [
      { binding: "MONITORING_PRIMARY", service: "synthetic-monitor" },
    ],
  });
  const config = {
    ...portableConfig(enabled),
    main: "index.js",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  };
  assert.deepEqual(config.services, [
    ...enabled.hookrelayBindings!,
    ...enabled.monitoringBindings!,
  ]);
  assert.doesNotThrow(() => verifyGeneratedConfig(config, enabled));
  assert.throws(() =>
    verifyGeneratedConfig(
      { ...config, services: enabled.hookrelayBindings },
      enabled,
    ),
  );
  assert.throws(() => verifyGeneratedConfig(config, fixture));
  assert.notEqual(profileFingerprint(enabled), review);
  for (const binding of [
    { binding: "ARBITRARY", service: "synthetic-monitor" },
    { binding: "MONITORING_CREDENTIALS", service: "synthetic-monitor" },
    { binding: "MONITORING_PRIMARY", service: fixture.workerName },
    { binding: "MONITORING_PRIMARY", service: fixture.retainedWorkerName },
    {
      binding: "MONITORING_PRIMARY",
      service: "synthetic-monitor",
      entrypoint: "Unsafe",
    },
    {
      binding: "MONITORING_PRIMARY",
      service: "synthetic-monitor",
      environment: "production",
    },
  ])
    assert.equal(
      releaseProfileSchema.safeParse({
        ...fixture,
        monitoringBindings: [binding],
      }).success,
      false,
    );
  assert.equal(
    releaseProfileSchema.safeParse({
      ...enabled,
      monitoringBindings: [
        ...enabled.monitoringBindings!,
        ...enabled.monitoringBindings!,
      ],
    }).success,
    false,
  );
});

test("scheduled release profiles drain bounded batches on a minute cadence", () => {
  const enabled = { ...fixture, scheduledCollection: true };
  const config = {
    ...portableConfig(enabled),
    main: "index.js",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  };
  assert.deepEqual(config.triggers.crons, ["* * * * *"]);
  assert.doesNotThrow(() => verifyGeneratedConfig(config, enabled));
  assert.throws(() =>
    verifyGeneratedConfig(
      { ...config, triggers: { crons: ["*/5 * * * *"] } },
      enabled,
    ),
  );
  assert.deepEqual(portableConfig(fixture).triggers.crons, []);
});

test("push bindings and SQLite class migrations are explicit reviewed authority", () => {
  const enabled = { ...fixture, workspacePush: true };
  const config = {
    ...portableConfig(enabled),
    main: "index.js",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  };
  assert.doesNotThrow(() => verifyGeneratedConfig(config, enabled));
  assert.notEqual(profileFingerprint(enabled), review);
  assert.throws(() => verifyGeneratedConfig(config, fixture));
  for (const patch of [
    { durable_objects: { bindings: [] } },
    {
      durable_objects: {
        bindings: [
          {
            name: "WORKSPACE_EVENTS",
            class_name: "WorkspaceEvents",
            script_name: "other-worker",
          },
        ],
      },
    },
    {
      durable_objects: {
        bindings: [{ name: "UNREVIEWED", class_name: "WorkspaceEvents" }],
      },
    },
    { migrations: [] },
    {
      migrations: [
        { tag: "workspace-events-v1", new_classes: ["WorkspaceEvents"] },
      ],
    },
  ])
    assert.throws(() =>
      verifyGeneratedConfig({ ...config, ...patch }, enabled),
    );
});

test("private Hookrelay bindings require exact reviewed targets without inherited authority", () => {
  const enabled = releaseProfileSchema.parse({
    ...fixture,
    hookrelayBindings: [
      { binding: "HOOKRELAY_PRIMARY", service: "synthetic-hookrelay" },
    ],
  });
  const config = {
    ...portableConfig(enabled),
    main: "index.js",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  };
  assert.notEqual(profileFingerprint(enabled), review);
  assert.doesNotThrow(() => verifyGeneratedConfig(config, enabled));
  assert.throws(() =>
    verifyGeneratedConfig({ ...config, services: [] }, enabled),
  );
  assert.throws(() => verifyGeneratedConfig(config, fixture));
  for (const service of [
    { binding: "ARBITRARY", service: "synthetic-hookrelay" },
    { binding: "HOOKRELAY_PRIMARY", service: fixture.workerName },
    { binding: "HOOKRELAY_PRIMARY", service: fixture.retainedWorkerName },
    {
      binding: "HOOKRELAY_PRIMARY",
      service: "synthetic-hookrelay",
      environment: "production",
    },
    {
      binding: "HOOKRELAY_PRIMARY",
      service: "synthetic-hookrelay",
      entrypoint: "Unsafe",
    },
  ])
    assert.equal(
      releaseProfileSchema.safeParse({
        ...fixture,
        hookrelayBindings: [service],
      }).success,
      false,
    );
  assert.equal(
    releaseProfileSchema.safeParse({
      ...enabled,
      hookrelayBindings: [
        ...enabled.hookrelayBindings!,
        ...enabled.hookrelayBindings!,
      ],
    }).success,
    false,
  );
  assert.throws(() =>
    verifyGeneratedConfig(
      {
        ...config,
        services: [{ ...enabled.hookrelayBindings![0], entrypoint: "Unsafe" }],
      },
      enabled,
    ),
  );
});

test("release CLI keeps help, results and errors on their documented channels", () => {
  for (const flag of ["-h", "--help"]) {
    const result = cli([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Exit statuses/);
    assert.equal(result.stderr, "");
  }
  for (const args of [
    [],
    ["deploy"],
    ["inspect"],
    ["inspect", "--profile", ""],
    [
      "build",
      "-p",
      "fixtures/release-profile.json",
      "-r",
      digest,
      "-o",
      "unused",
    ],
    ["verify", "-a", "unused", "-r", review],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.ok(result.stderr);
  }
  const result = cli(["inspect", "-p", "fixtures/release-profile.json"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).fingerprint, review);
  assert.equal(JSON.parse(result.stdout).deploymentAuthorized, false);
});

test("artifact verification binds every packaged byte to a separately retained digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "hq-artifact-test-"));
  try {
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "migrations"));
    const content: Record<string, string> = {
      "worker.js":
        "export default { fetch() { return new Response('synthetic') } }",
      "wrangler.json": JSON.stringify(portableConfig(fixture), null, 2) + "\n",
      "assets/index.html": "<main>Synthetic fixture</main>",
      "assets/encoded.js":
        'const encoded="AGFzbQEAAA' +
        "/" +
        "c" +
        "/AAAA" +
        "/" +
        "z" +
        '/AAAA";',
      "assets/_headers": staticHeaderRules(),
      "migrations/0001.sql": "CREATE TABLE synthetic (id TEXT);",
    };
    const files: Record<string, string> = {};
    for (const name of Object.keys(content).sort((a, b) =>
      a.localeCompare(b),
    )) {
      await writeFile(join(root, name), content[name]);
      files[name] = sha256(content[name]);
    }
    const manifest = JSON.stringify({
      schemaVersion: 1,
      profile: fixture,
      profileFingerprint: review,
      sourceFingerprint: digest,
      files,
    });
    await writeFile(join(root, "manifest.json"), manifest);
    const artifactDigest = sha256(manifest);
    assert.equal(
      (await verifyArtifact(root, review, artifactDigest)).deploymentAuthorized,
      false,
    );
    for (const directory of ["c", "z", "Users"]) {
      const privatePath = "/" + directory + "/synthetic-private-context";
      for (const prefix of ["", "file://", " ", "\n", "\t"]) {
        await writeFile(
          join(root, "assets/encoded.js"),
          JSON.stringify(prefix + privatePath),
        );
        await assert.rejects(
          verifyArtifact(root, review, artifactDigest),
          /private paths or credential material/,
        );
      }
    }
    for (const credential of [
      "ghp" + "_" + "a".repeat(24),
      "hqa" + "_" + "a".repeat(64),
      "hkr" + "_" + "a".repeat(43),
    ]) {
      await writeFile(
        join(root, "assets/encoded.js"),
        JSON.stringify(credential),
      );
      await assert.rejects(
        verifyArtifact(root, review, artifactDigest),
        /private paths or credential material/,
      );
    }
    await writeFile(
      join(root, "assets/encoded.js"),
      content["assets/encoded.js"],
    );
    await assert.rejects(
      verifyArtifact(root, digest, artifactDigest),
      /profile/,
    );
    await writeFile(join(root, "worker.js"), content["worker.js"] + "\n");
    await assert.rejects(
      verifyArtifact(root, review, artifactDigest),
      /checksums/,
    );
    await writeFile(join(root, "worker.js"), content["worker.js"]);
    await writeFile(join(root, "manifest.json"), manifest + "\n");
    await assert.rejects(
      verifyArtifact(root, review, artifactDigest),
      /retained build digest/,
    );
    await writeFile(join(root, "manifest.json"), manifest);
    await symlink(join(root, "worker.js"), join(root, "assets", "linked.js"));
    await assert.rejects(
      verifyArtifact(root, review, artifactDigest),
      /symlink/,
    );
    await rm(join(root, "assets", "linked.js"));
    await writeFile(join(root, "assets", "unreviewed.json"), "{}");
    await assert.rejects(
      verifyArtifact(root, review, artifactDigest),
      /checksums/,
    );
    const cliResult = cli([
      "verify",
      "-a",
      root,
      "-r",
      review,
      "-d",
      artifactDigest,
    ]);
    assert.equal(cliResult.status, 1);
    assert.equal(cliResult.stdout, "");
    assert.ok(cliResult.stderr);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("build fails before compilation with missing dependencies or a changed review", async () => {
  const root = await mkdtemp(join(tmpdir(), "hq-build-test-"));
  try {
    await assert.rejects(
      buildArtifact(
        root,
        "fixtures/release-profile.json",
        review,
        join(root, "artifact"),
      ),
      MissingBuildDependency,
    );
    await assert.rejects(
      buildArtifact(
        root,
        "fixtures/release-profile.json",
        digest,
        join(root, "artifact"),
      ),
      /Profile changed/,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
