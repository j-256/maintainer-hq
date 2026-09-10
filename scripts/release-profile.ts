import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

export const RELEASE_LIMITS = Object.freeze({
  PROFILE_BYTES: 8192,
  FILE_BYTES: 16 * 1024 * 1024,
  TOTAL_BYTES: 64 * 1024 * 1024,
  FILES: 1000,
  DEPTH: 12,
  BUILD_TIMEOUT_MS: 600_000,
  HOOK_BINDINGS: 20,
  MONITOR_BINDINGS: 20,
});
export const RELEASE_CRON = "* * * * *";
export const RELEASE_COMPATIBILITY_DATE = "2026-08-22";
export const RELEASE_WORKER_ROUTES = ["/api/*", "/mcp", "/healthz"];
export const RELEASE_WORKER_LIMITS = Object.freeze({
  cpu_ms: 2000,
  subrequests: 1000,
});
export const RELEASE_PUSH_BINDING = {
  name: "WORKSPACE_EVENTS",
  class_name: "WorkspaceEvents",
};
export const RELEASE_PUSH_MIGRATION = {
  tag: "workspace-events-v1",
  new_sqlite_classes: ["WorkspaceEvents"],
};
const name = z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const releaseProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .refine((value) => !/^0+$/.test(value)),
    workerName: name.refine((value) => !/(?:development|e2e)/.test(value)),
    databaseName: name,
    databaseId: z
      .uuid()
      .refine((value) => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)),
    retainedWorkerName: name,
    retainedDatabaseId: z.uuid(),
    intendedHostname: hostname,
    accessIssuer: z
      .url()
      .max(255)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.port &&
          url.origin === value &&
          url.hostname.endsWith(".cloudflareaccess.com")
        );
      }),
    accessAudience: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .refine((value) => !/^0+$/.test(value)),
    scheduledCollection: z.boolean(),
    workspacePush: z.boolean().optional(),
    hookrelayBindings: z
      .array(
        z
          .object({
            binding: z.string().regex(/^HOOKRELAY_[A-Z0-9_]{1,40}$/),
            service: name,
          })
          .strict(),
      )
      .max(RELEASE_LIMITS.HOOK_BINDINGS)
      .refine(
        (values) =>
          new Set(values.map((value) => value.binding)).size === values.length,
        { message: "Hookrelay binding names must be unique" },
      )
      .optional(),
    monitoringBindings: z
      .array(
        z
          .object({
            binding: z
              .string()
              .regex(/^MONITORING_[A-Z0-9_]{1,40}$/)
              .refine((value) => value !== "MONITORING_CREDENTIALS"),
            service: name,
          })
          .strict(),
      )
      .max(RELEASE_LIMITS.MONITOR_BINDINGS)
      .refine(
        (values) =>
          new Set(values.map((value) => value.binding)).size === values.length,
        { message: "Monitoring binding names must be unique" },
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.workerName !== value.retainedWorkerName &&
      value.databaseId !== value.retainedDatabaseId &&
      ![
        ...(value.hookrelayBindings ?? []),
        ...(value.monitoringBindings ?? []),
      ].some((binding) =>
        [value.workerName, value.retainedWorkerName].includes(binding.service),
      ),
    { message: "The candidate must use a distinct Worker and database" },
  );
export type ReleaseProfile = z.infer<typeof releaseProfileSchema>;
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const profileFingerprint = (profile: ReleaseProfile) =>
  sha256(JSON.stringify(releaseProfileSchema.parse(profile)));

export async function readReleaseProfile(path: string) {
  if (!path) throw new Error("Provide an explicit deployment profile file");
  const info = await stat(path);
  if (!info.isFile() || info.size > RELEASE_LIMITS.PROFILE_BYTES)
    throw new Error("Deployment profile must be a bounded JSON file");
  let profile: ReleaseProfile;
  try {
    profile = releaseProfileSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    throw new Error(
      "Invalid deployment profile: check the documented fields, distinct candidate identities, issuer, audience, and hostname. Do not include secrets or routes.",
    );
  }
  return { profile, fingerprint: profileFingerprint(profile) };
}
export function releaseOverrides(profile: ReleaseProfile) {
  const services = [
    ...(profile.hookrelayBindings ?? []),
    ...(profile.monitoringBindings ?? []),
  ];
  return {
    name: profile.workerName,
    account_id: profile.accountId,
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    limits: RELEASE_WORKER_LIMITS,
    routes: [],
    durable_objects: {
      bindings: profile.workspacePush ? [RELEASE_PUSH_BINDING] : [],
    },
    migrations: profile.workspacePush ? [RELEASE_PUSH_MIGRATION] : [],
    ...(services.length ? { services } : {}),
    triggers: { crons: profile.scheduledCollection ? [RELEASE_CRON] : [] },
    vars: {
      ACCESS_ISSUER: profile.accessIssuer,
      ACCESS_AUDIENCE: profile.accessAudience,
    },
    d1_databases: [
      {
        binding: "HQ_DB",
        database_name: profile.databaseName,
        database_id: profile.databaseId,
        migrations_dir: "migrations",
      },
    ],
  };
}

export function verifyGeneratedConfig(
  config: Record<string, unknown>,
  profile: ReleaseProfile,
) {
  const expected = releaseOverrides(profile);
  for (const key of [
    "name",
    "account_id",
    "workers_dev",
    "preview_urls",
    "send_metrics",
    "limits",
    "triggers",
    "vars",
    "durable_objects",
    "migrations",
  ] as const)
    if (JSON.stringify(config[key]) !== JSON.stringify(expected[key]))
      throw new Error(
        "Generated configuration differs from the reviewed profile: " + key,
      );
  if (
    (config.routes !== undefined &&
      (!Array.isArray(config.routes) || config.routes.length)) ||
    config.route ||
    config.env ||
    (Array.isArray(config.definedEnvironments) &&
      config.definedEnvironments.length)
  )
    throw new Error(
      "Release builds must not attach hostnames or inherit named environments",
    );
  const bindings = [
    "kv_namespaces",
    "r2_buckets",
    "workflows",
    "hyperdrive",
    "secrets_store_secrets",
    "dispatch_namespaces",
    "mtls_certificates",
    "pipelines",
    "analytics_engine_datasets",
    "vectorize",
    "vpc_services",
    "vpc_networks",
    "send_email",
    "ratelimits",
    "worker_loaders",
    "ai_search",
    "ai_search_namespaces",
    "agent_memory",
    "unsafe_hello_world",
    "artifacts",
    "flagship",
    "connect",
  ];
  if (
    JSON.stringify(config.services ?? []) !==
    JSON.stringify([
      ...(profile.hookrelayBindings ?? []),
      ...(profile.monitoringBindings ?? []),
    ])
  )
    throw new Error(
      "Generated service bindings differ from the reviewed provider targets",
    );
  for (const binding of bindings)
    if (
      config[binding] &&
      (!Array.isArray(config[binding]) || (config[binding] as unknown[]).length)
    )
      throw new Error("Unexpected deployment binding: " + binding);
  for (const binding of [
    "queues",
    "cloudchamber",
    "ai",
    "browser",
    "unsafe",
    "assets_only",
    "containers",
    "build",
    "legacy_env",
    "logfwdr",
    "exports",
  ])
    if (
      config[binding] &&
      JSON.stringify(config[binding]) !== "{}" &&
      JSON.stringify(config[binding]) !== "[]" &&
      JSON.stringify(config[binding]) !== '{"bindings":[]}' &&
      JSON.stringify(config[binding]) !== '{"producers":[],"consumers":[]}'
    )
      throw new Error("Unexpected deployment configuration: " + binding);
  const known = new Set([
    ...Object.keys(expected),
    ...bindings,
    "services",
    "configPath",
    "userConfigPath",
    "topLevelName",
    "definedEnvironments",
    "compatibility_date",
    "compatibility_flags",
    "jsx_factory",
    "jsx_fragment",
    "rules",
    "main",
    "assets",
    "durable_objects",
    "queues",
    "cloudchamber",
    "logfwdr",
    "exports",
    "migrations",
    "observability",
    "python_modules",
    "dev",
    "no_bundle",
  ]);
  for (const key of Object.keys(config))
    if (!known.has(key))
      throw new Error("Unreviewed generated configuration: " + key);
  const databases = config.d1_databases as Record<string, unknown>[];
  if (
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.binding !== "HQ_DB" ||
    databases[0]?.database_id !== profile.databaseId ||
    databases[0]?.database_name !== profile.databaseName ||
    databases[0]?.remote ||
    Object.keys(databases[0]).some(
      (key) =>
        !["binding", "database_id", "database_name", "migrations_dir"].includes(
          key,
        ),
    )
  )
    throw new Error("Generated database does not match the reviewed profile");
  const assets = config.assets as Record<string, unknown>;
  if (
    assets?.binding !== "ASSETS" ||
    assets.not_found_handling !== "single-page-application" ||
    JSON.stringify(assets.run_worker_first) !==
      JSON.stringify(RELEASE_WORKER_ROUTES) ||
    Object.keys(assets).some(
      (key) =>
        ![
          "binding",
          "not_found_handling",
          "run_worker_first",
          "directory",
        ].includes(key),
    )
  )
    throw new Error("Unexpected asset and API routing");
  if (
    config.compatibility_date !== RELEASE_COMPATIBILITY_DATE ||
    JSON.stringify(config.compatibility_flags) !== '["nodejs_compat"]' ||
    config.no_bundle !== true ||
    config.main !== "index.js" ||
    JSON.stringify(config.observability) !== '{"enabled":true}' ||
    JSON.stringify(config.rules) !==
      '[{"type":"ESModule","globs":["**/*.js","**/*.mjs"]}]'
  )
    throw new Error("Unexpected Worker build contract");
}

export function portableConfig(profile: ReleaseProfile) {
  return {
    ...releaseOverrides(profile),
    main: "worker.js",
    no_bundle: true,
    compatibility_date: RELEASE_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: "./assets",
      not_found_handling: "single-page-application",
      run_worker_first: RELEASE_WORKER_ROUTES,
    },
    observability: { enabled: true },
  };
}
