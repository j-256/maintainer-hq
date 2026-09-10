import { z } from "zod";
import { intersects, satisfies, valid, validRange } from "semver";

const DAY_MS = 86400000;
export const DEPENDENCY_LIMITS = Object.freeze({
  MANIFESTS: 8,
  OVERRIDES: 32,
  PACKAGES: 20000,
  MATCHES: 64,
  FILE_BYTES: 8 * 1024 * 1024,
  POLICY_BYTES: 64 * 1024,
  REPORT_BYTES: 128 * 1024,
  REVIEW_MS: 30 * DAY_MS,
  CLOCK_SKEW_MS: 5 * 60 * 1000,
  UPSTREAM_BYTES: 128 * 1024,
  UPSTREAM_MS: 10000,
  UPSTREAM_CONCURRENCY: 4,
});
export const DEPENDENCY_POLICY_PATH = ".maintainer-hq/dependencies.json";
export const DEPENDENCY_STATUS = Object.freeze({
  MITIGATED: "mitigated",
  VULNERABLE: "vulnerable",
  REVIEW_DUE: "review_due",
  UNUSED: "unused",
  INVALID: "invalid",
  RESOLVED: "resolved",
} as const);
export const dependencyPackageSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
function exactVersion(value: string) {
  return (
    /^[0-9]/.test(value) && value.trim() === value && valid(value) !== null
  );
}
export const dependencyVersionSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(exactVersion, "Use an exact semantic version");
export const dependencyManifestPathSchema = z
  .string()
  .max(240)
  .regex(/^(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*package\.json$/)
  .refine((value) => !value.split("/").includes("node_modules"));
export const dependencyOverrideSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    lifecycle: z.enum(["active", "removed"]),
    parent: dependencyPackageSchema,
    package: dependencyPackageSchema,
    requested: dependencyVersionSchema,
    replacement: dependencyVersionSchema,
    advisory: z
      .string()
      .regex(
        /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/,
      ),
    vulnerable: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => validRange(value) !== null),
    reason: z.string().trim().min(20).max(800),
    owner: z.string().trim().min(1).max(80),
    reviewedAt: z.iso.datetime(),
    reviewBy: z.iso.datetime(),
    removeWhen: z.string().trim().min(20).max(500),
  })
  .strict()
  .superRefine((rule, context) => {
    const duration = Date.parse(rule.reviewBy) - Date.parse(rule.reviewedAt);
    if (duration <= 0 || duration > DEPENDENCY_LIMITS.REVIEW_MS)
      context.addIssue({
        code: "custom",
        path: ["reviewBy"],
        message: "Schedule review within thirty days of the recorded review",
      });
    if (
      satisfies(rule.replacement, rule.vulnerable, { includePrerelease: true })
    )
      context.addIssue({
        code: "custom",
        path: ["replacement"],
        message:
          "The replacement must not satisfy the advisory's affected range",
      });
  });
export type DependencyOverride = z.infer<typeof dependencyOverrideSchema>;
export const dependencyPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    manifests: z
      .array(
        z
          .object({
            path: dependencyManifestPathSchema,
            overrides: z
              .array(dependencyOverrideSchema)
              .max(DEPENDENCY_LIMITS.OVERRIDES),
          })
          .strict(),
      )
      .min(1)
      .max(DEPENDENCY_LIMITS.MANIFESTS),
  })
  .strict()
  .superRefine((policy, context) => {
    const paths = new Set<string>();
    const ids = new Set<string>();
    let count = 0;
    for (const manifest of policy.manifests) {
      if (paths.has(manifest.path))
        context.addIssue({
          code: "custom",
          message: "List each manifest once",
        });
      paths.add(manifest.path);
      const selectors = new Set<string>();
      for (const rule of manifest.overrides) {
        const selector = JSON.stringify([
          rule.parent,
          rule.package,
          rule.requested,
        ]);
        if (ids.has(rule.id) || selectors.has(selector))
          context.addIssue({
            code: "custom",
            message: "Override identities and selectors must be unique",
          });
        ids.add(rule.id);
        selectors.add(selector);
        count++;
      }
    }
    if (count > DEPENDENCY_LIMITS.OVERRIDES)
      context.addIssue({
        code: "custom",
        message: "The policy exceeds the override limit",
      });
  });
export type DependencyPolicy = z.infer<typeof dependencyPolicySchema>;

export const dependencyIssueSchema = z
  .object({
    code: z.enum([
      "unsupported_lockfile",
      "invalid_lockfile",
      "manifest_drift",
      "unsupported_override",
      "untracked_override",
      "override_missing",
      "override_changed",
      "override_still_present",
      "unused_override",
      "vulnerable_resolution",
      "missing_resolution",
      "invalid_resolution",
      "review_due",
      "future_review",
      "evidence_limit",
    ]),
    manifestPath: dependencyManifestPathSchema,
    overrideId: z.string().max(64).nullable(),
    message: z.string().max(400),
  })
  .strict();
export type DependencyIssue = z.infer<typeof dependencyIssueSchema>;
export const dependencyMatchSchema = z
  .object({
    parentVersion: dependencyVersionSchema,
    requested: z.string().max(160),
    resolved: dependencyVersionSchema.nullable(),
    scope: z.enum(["development", "runtime"]),
    overridden: z.boolean(),
  })
  .strict();
export const dependencyUpstreamSchema = z
  .object({
    state: z.enum([
      "not_checked",
      "unavailable",
      "not_fixed",
      "fix_available",
      "unsupported",
    ]),
    checkedAt: z.iso.datetime().nullable(),
    parentVersion: dependencyVersionSchema.nullable(),
    requested: z.string().max(160).nullable(),
  })
  .strict();
export type DependencyUpstream = z.infer<typeof dependencyUpstreamSchema>;
export const dependencyFindingSchema = z
  .object({
    manifestPath: dependencyManifestPathSchema,
    rule: dependencyOverrideSchema,
    status: z.enum(DEPENDENCY_STATUS),
    matches: z.array(dependencyMatchSchema).max(DEPENDENCY_LIMITS.MATCHES),
    resolvedVersions: z
      .array(dependencyVersionSchema)
      .max(DEPENDENCY_LIMITS.MATCHES),
    upstream: dependencyUpstreamSchema,
  })
  .strict();
export type DependencyFinding = z.infer<typeof dependencyFindingSchema>;
export const dependencyAnalysisSchema = z
  .object({
    outcome: z.enum(["passed", "failed"]),
    checkedAt: z.iso.datetime(),
    manifestCount: z.number().int().min(1).max(DEPENDENCY_LIMITS.MANIFESTS),
    findings: z.array(dependencyFindingSchema).max(DEPENDENCY_LIMITS.OVERRIDES),
    issues: z.array(dependencyIssueSchema).max(256),
  })
  .strict();
export type DependencyAnalysis = z.infer<typeof dependencyAnalysisSchema>;
export type DependencyDocuments = {
  manifestPath: string;
  manifest: unknown;
  lock: unknown;
};
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function packageAt(path: string, name: string) {
  return (
    path === "node_modules/" + name || path.endsWith("/node_modules/" + name)
  );
}
function installedDependency(
  packages: JsonObject,
  parent: string,
  name: string,
) {
  let base = parent;
  for (;;) {
    const candidate = (base ? base + "/" : "") + "node_modules/" + name;
    if (Object.hasOwn(packages, candidate)) return packages[candidate];
    if (!base) return null;
    const separator = base.lastIndexOf("/node_modules/");
    base = separator < 0 ? "" : base.slice(0, separator);
  }
}
function stableDependencies(value: unknown) {
  if (value === undefined) return "{}";
  if (
    !object(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    return null;
  return JSON.stringify(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function analyzeDependencyPolicy(
  rawPolicy: unknown,
  documents: DependencyDocuments[],
  now = Date.now(),
): DependencyAnalysis {
  const policy = dependencyPolicySchema.parse(rawPolicy);
  const issues: DependencyIssue[] = [];
  const findings: DependencyFinding[] = [];
  const checkedAt = new Date(now).toISOString();
  const issueCodes = new Map<string, Set<DependencyIssue["code"]>>();
  const add = (
    code: DependencyIssue["code"],
    manifestPath: string,
    overrideId: string | null,
    message: string,
  ) => {
    const key = JSON.stringify([manifestPath, overrideId]);
    const codes = issueCodes.get(key) ?? new Set<DependencyIssue["code"]>();
    if (codes.has(code)) return;
    codes.add(code);
    issueCodes.set(key, codes);
    if (issues.length < 255)
      issues.push({ code, manifestPath, overrideId, message });
    else if (issues.length === 255)
      issues.push({
        code: "evidence_limit",
        manifestPath,
        overrideId: null,
        message:
          "More policy failures exist than this bounded report can display",
      });
  };
  for (const declared of policy.manifests) {
    const { path: manifestPath } = declared;
    const selected = documents.filter(
      (item) => item.manifestPath === manifestPath,
    );
    const document = selected.length === 1 ? selected[0] : null;
    const manifest = document?.manifest;
    const lock = document?.lock;
    let packages: JsonObject | null = null;
    if (!object(manifest))
      add(
        "manifest_drift",
        manifestPath,
        null,
        "The declared manifest is missing or invalid",
      );
    if (!object(lock) || lock.lockfileVersion !== 3 || !object(lock.packages)) {
      add(
        "unsupported_lockfile",
        manifestPath,
        null,
        "A complete npm lockfileVersion 3 packages map is required",
      );
    } else if (Object.keys(lock.packages).length > DEPENDENCY_LIMITS.PACKAGES) {
      add(
        "evidence_limit",
        manifestPath,
        null,
        "The lockfile exceeds the package inspection limit",
      );
    } else {
      packages = lock.packages;
      const root = packages[""];
      const invalidPath = Object.keys(packages).some(
        (path) =>
          path !== "" &&
          (!path.startsWith("node_modules/") ||
            path.includes("\\") ||
            /[\x00-\x20]/.test(path) ||
            path
              .split("/")
              .some((part) => part === "." || part === ".." || part === "")),
      );
      const invalidEntry = Object.entries(packages).some(
        ([path, entry]) =>
          path !== "" &&
          (!object(entry) ||
            entry.link === true ||
            typeof entry.version !== "string" ||
            !exactVersion(entry.version)),
      );
      if (invalidPath || invalidEntry || !object(root)) {
        add(
          "invalid_lockfile",
          manifestPath,
          null,
          "Lock entries must be exact installed package versions; workspace links are unsupported",
        );
        packages = null;
      } else if (object(manifest)) {
        for (const key of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]) {
          const expected = stableDependencies(manifest[key]);
          if (expected === null || expected !== stableDependencies(root[key]))
            add(
              "manifest_drift",
              manifestPath,
              null,
              "Manifest dependency declarations do not match the lockfile root",
            );
        }
      }
    }
    const overrideObject =
      object(manifest) && object(manifest.overrides) ? manifest.overrides : {};
    if (
      object(manifest) &&
      manifest.overrides !== undefined &&
      !object(manifest.overrides)
    )
      add(
        "unsupported_override",
        manifestPath,
        null,
        "Overrides must use the supported parent and exact dependency-version form",
      );
    const tracked = new Set(
      declared.overrides.map((rule) =>
        JSON.stringify([rule.parent, rule.package + "@" + rule.requested]),
      ),
    );
    for (const [parent, children] of Object.entries(overrideObject)) {
      if (
        !dependencyPackageSchema.safeParse(parent).success ||
        !object(children) ||
        Object.keys(children).length === 0
      ) {
        add(
          "unsupported_override",
          manifestPath,
          null,
          "Use a package parent containing exact dependency-version replacements",
        );
        continue;
      }
      for (const [selector, replacement] of Object.entries(children)) {
        if (!tracked.has(JSON.stringify([parent, selector])))
          add(
            "untracked_override",
            manifestPath,
            null,
            "An override has no matching lifecycle record",
          );
        if (!dependencyVersionSchema.safeParse(replacement).success)
          add(
            "unsupported_override",
            manifestPath,
            null,
            "Override replacements must be exact semantic versions",
          );
      }
    }
    for (const rule of declared.overrides) {
      const children = overrideObject[rule.parent];
      const selector = rule.package + "@" + rule.requested;
      const active = rule.lifecycle === "active";
      const present = object(children) && Object.hasOwn(children, selector);
      if (!active && present)
        add(
          "override_still_present",
          manifestPath,
          rule.id,
          "The lifecycle record claims removal but the override is still configured",
        );
      if (active && !present)
        add(
          "override_missing",
          manifestPath,
          rule.id,
          "The lifecycle record does not match a configured override",
        );
      else if (
        active &&
        object(children) &&
        children[selector] !== rule.replacement
      )
        add(
          "override_changed",
          manifestPath,
          rule.id,
          "The configured replacement differs from the reviewed lifecycle record",
        );
      if (Date.parse(rule.reviewedAt) > now + DEPENDENCY_LIMITS.CLOCK_SKEW_MS)
        add(
          "future_review",
          manifestPath,
          rule.id,
          "The recorded review time is in the future",
        );
      if (active && Date.parse(rule.reviewBy) <= now)
        add(
          "review_due",
          manifestPath,
          rule.id,
          "The review deadline has passed; remove the override or deliberately renew its review",
        );
      const matches: z.infer<typeof dependencyMatchSchema>[] = [];
      const versions = new Set<string>();
      let matchingRequests = 0;
      if (packages) {
        for (const [path, entry] of Object.entries(packages)) {
          if (!object(entry)) continue;
          if (packageAt(path, rule.package)) {
            if (entry.name !== undefined && entry.name !== rule.package)
              add(
                "invalid_resolution",
                manifestPath,
                rule.id,
                "A matching package path contains an alias rather than the reviewed package",
              );
            const version = entry.version as string;
            versions.add(version);
            if (
              satisfies(version, rule.vulnerable, { includePrerelease: true })
            )
              add(
                "vulnerable_resolution",
                manifestPath,
                rule.id,
                "The lockfile still resolves a package version affected by the advisory",
              );
          }
          if (!packageAt(path, rule.parent)) continue;
          if (entry.name !== undefined && entry.name !== rule.parent) {
            add(
              "invalid_resolution",
              manifestPath,
              rule.id,
              "A parent package path contains an unsupported alias",
            );
            continue;
          }
          const dependencies = object(entry.dependencies)
            ? entry.dependencies
            : {};
          const optional = object(entry.optionalDependencies)
            ? entry.optionalDependencies
            : {};
          const requested =
            optional[rule.package] ?? dependencies[rule.package];
          if (requested === undefined) continue;
          if (
            typeof requested !== "string" ||
            requested.length > 160 ||
            validRange(requested) === null
          ) {
            add(
              "invalid_resolution",
              manifestPath,
              rule.id,
              "The parent requests an unsupported dependency source",
            );
            continue;
          }
          const overridden = active && intersects(requested, rule.requested);
          if (overridden) matchingRequests++;
          const resolved = installedDependency(packages, path, rule.package);
          const version =
            object(resolved) && typeof resolved.version === "string"
              ? resolved.version
              : null;
          if (!version)
            add(
              "missing_resolution",
              manifestPath,
              rule.id,
              "A parent dependency cannot be resolved from the lockfile",
            );
          else if (
            overridden
              ? version !== rule.replacement
              : !satisfies(version, requested)
          )
            add(
              "invalid_resolution",
              manifestPath,
              rule.id,
              "A parent dependency resolves outside its reviewed or declared version",
            );
          if (matches.length < DEPENDENCY_LIMITS.MATCHES)
            matches.push({
              parentVersion: entry.version as string,
              requested,
              resolved: version,
              scope: entry.dev === true ? "development" : "runtime",
              overridden,
            });
          else
            add(
              "evidence_limit",
              manifestPath,
              rule.id,
              "The override exceeds the parent evidence limit",
            );
        }
        if (active && !matchingRequests)
          add(
            "unused_override",
            manifestPath,
            rule.id,
            "No installed parent still requests the overridden version; remove the override and verify the regenerated dependency tree",
          );
      }
      if (versions.size > DEPENDENCY_LIMITS.MATCHES)
        add(
          "evidence_limit",
          manifestPath,
          rule.id,
          "The package exceeds the resolved-version evidence limit",
        );
      const own = [
        ...(issueCodes.get(JSON.stringify([manifestPath, rule.id])) ?? []),
      ];
      const invalid =
        !packages ||
        issues.some(
          (issue) =>
            issue.manifestPath === manifestPath && issue.overrideId === null,
        ) ||
        own.some(
          (code) =>
            ![
              "review_due",
              "unused_override",
              "vulnerable_resolution",
            ].includes(code),
        );
      const status = own.includes("vulnerable_resolution")
        ? DEPENDENCY_STATUS.VULNERABLE
        : invalid
          ? DEPENDENCY_STATUS.INVALID
          : !active
            ? DEPENDENCY_STATUS.RESOLVED
            : own.includes("unused_override")
              ? DEPENDENCY_STATUS.UNUSED
              : own.includes("review_due")
                ? DEPENDENCY_STATUS.REVIEW_DUE
                : DEPENDENCY_STATUS.MITIGATED;
      findings.push({
        manifestPath,
        rule,
        status,
        matches,
        resolvedVersions: [...versions]
          .sort()
          .slice(0, DEPENDENCY_LIMITS.MATCHES),
        upstream: {
          state: "not_checked",
          checkedAt: null,
          parentVersion: null,
          requested: null,
        },
      });
    }
  }
  return dependencyAnalysisSchema.parse({
    outcome: issues.length ? "failed" : "passed",
    checkedAt,
    manifestCount: policy.manifests.length,
    findings,
    issues,
  });
}

export function dependencyUpstreamEvidence(
  rule: DependencyOverride,
  data: unknown,
  now = Date.now(),
): DependencyUpstream {
  const checkedAt = new Date(now).toISOString();
  const unavailable: DependencyUpstream = {
    state: "unsupported",
    checkedAt,
    parentVersion: null,
    requested: null,
  };
  if (
    !object(data) ||
    data.name !== rule.parent ||
    !dependencyVersionSchema.safeParse(data.version).success
  )
    return unavailable;
  const dependencies = object(data.dependencies) ? data.dependencies : {};
  const optional = object(data.optionalDependencies)
    ? data.optionalDependencies
    : {};
  const requested = optional[rule.package] ?? dependencies[rule.package];
  if (
    typeof requested !== "string" ||
    requested.length > 160 ||
    validRange(requested) === null
  )
    return { ...unavailable, parentVersion: data.version as string };
  return {
    state: intersects(requested, rule.vulnerable, { includePrerelease: true })
      ? "not_fixed"
      : "fix_available",
    checkedAt,
    parentVersion: data.version as string,
    requested,
  };
}
