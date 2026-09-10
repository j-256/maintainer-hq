import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { upstreamDependencyDocument } from "../shared/dependency-upstream";
import {
  DEPENDENCY_LIMITS as LIMITS,
  DEPENDENCY_POLICY_PATH,
  analyzeDependencyPolicy,
  dependencyPolicySchema,
  dependencyUpstreamEvidence,
  type DependencyDocuments,
} from "../shared/dependency-policy";
import {
  dependencyReportSchema,
  type DependencyReport,
} from "../shared/dependency-report";

export class DependencyCheckError extends Error {
  constructor(
    message: string,
    public exitCode = 2,
  ) {
    super(message);
  }
}
export function dependencyDigest(text: string) {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DependencyCheckError(label + " must contain valid JSON");
  }
}
async function readBounded(root: string, path: string, limit: number) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new DependencyCheckError(
      "Choose a relative file path within the repository root",
    );
  let current = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (
      !info ||
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new DependencyCheckError(
        "A required dependency input is missing, linked, or not a regular file within real directories",
      );
  }
  const file = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!file)
    throw new DependencyCheckError(
      "A required dependency input could not be opened",
    );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new DependencyCheckError(
        "A dependency input exceeds its file-size limit or is not a regular file",
      );
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit)
      throw new DependencyCheckError(
        "A dependency input exceeds its file-size limit",
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await file.close();
  }
}
export async function checkDependencies(
  options: {
    root?: string;
    policy?: string;
    upstream?: boolean;
    now?: number;
    fetcher?: typeof fetch;
  } = {},
): Promise<DependencyReport> {
  const root = resolve(options.root ?? process.cwd());
  const policyText = await readBounded(
    root,
    options.policy ?? DEPENDENCY_POLICY_PATH,
    LIMITS.POLICY_BYTES,
  );
  const parsed = dependencyPolicySchema.safeParse(
    parseJson(policyText, "Dependency policy"),
  );
  if (!parsed.success)
    throw new DependencyCheckError(
      "Dependency policy is invalid; check the lifecycle schema and review window",
    );
  const documents: DependencyDocuments[] = [];
  const files: DependencyReport["files"] = [];
  for (const declaration of parsed.data.manifests) {
    const manifestText = await readBounded(
      root,
      declaration.path,
      LIMITS.FILE_BYTES,
    );
    const lockPath =
      dirname(declaration.path) === "."
        ? "package-lock.json"
        : dirname(declaration.path) + "/package-lock.json";
    const lockText = await readBounded(root, lockPath, LIMITS.FILE_BYTES);
    documents.push({
      manifestPath: declaration.path,
      manifest: parseJson(manifestText, "Package manifest"),
      lock: parseJson(lockText, "Package lockfile"),
    });
    files.push({
      manifestPath: declaration.path,
      manifestDigest: dependencyDigest(manifestText),
      lockDigest: dependencyDigest(lockText),
    });
  }
  const analysis = analyzeDependencyPolicy(parsed.data, documents, options.now);
  if (options.upstream) {
    const names = [
      ...new Set(analysis.findings.map((finding) => finding.rule.parent)),
    ];
    const upstream = new Map<string, unknown>();
    for (
      let start = 0;
      start < names.length;
      start += LIMITS.UPSTREAM_CONCURRENCY
    ) {
      await Promise.all(
        names
          .slice(start, start + LIMITS.UPSTREAM_CONCURRENCY)
          .map(async (name) => {
            try {
              upstream.set(
                name,
                await upstreamDependencyDocument(name, options.fetcher ?? fetch),
              );
            } catch {
              upstream.set(name, null);
            }
          }),
      );
    }
    for (const finding of analysis.findings) {
      const data = upstream.get(finding.rule.parent);
      finding.upstream =
        data === null
          ? {
              state: "unavailable",
              checkedAt: new Date(options.now ?? Date.now()).toISOString(),
              parentVersion: null,
              requested: null,
            }
          : dependencyUpstreamEvidence(finding.rule, data, options.now);
    }
  }
  const result = dependencyReportSchema.parse({
    schemaVersion: 1,
    kind: "npm-override-lifecycle",
    policyDigest: dependencyDigest(policyText),
    files,
    analysis,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.REPORT_BYTES)
    throw new DependencyCheckError(
      "Dependency evidence exceeds the report-size limit",
      1,
    );
  return result;
}
export function dependencyCheckExitCode(
  report: DependencyReport,
  requestedUpstream: boolean,
) {
  if (report.analysis.outcome === "failed") return 4;
  if (
    requestedUpstream &&
    report.analysis.findings.some((finding) =>
      ["unavailable", "unsupported"].includes(finding.upstream.state),
    )
  )
    return 1;
  return 0;
}
