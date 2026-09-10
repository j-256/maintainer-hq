import { z } from "zod";
import { repositoryFields } from "../shared/domain";
import { GITHUB_LIMITS, githubBranchSchema } from "../shared/github-evidence";
import { githubShaSchema } from "../shared/github-context";
import {
  DEPENDENCIES_LIMITS as LIMITS,
  dependencyEvidenceSchema,
  type DependencyEvidence,
} from "../shared/dependencies";
import {
  DEPENDENCY_LIMITS,
  DEPENDENCY_POLICY_PATH,
  analyzeDependencyPolicy,
  dependencyPolicySchema,
  dependencyUpstreamEvidence,
  type DependencyPolicy,
  type DependencyDocuments,
} from "../shared/dependency-policy";
import { upstreamDependencyDocument } from "../shared/dependency-upstream";
import { dependencyReportSchema } from "../shared/dependency-report";
import { GitHubReader, ProviderFailure } from "./github-client";

const metadataSchema = z.object({
  full_name: repositoryFields.shape.fullName,
  default_branch: githubBranchSchema,
});
const headSchema = z.object({
  name: githubBranchSchema,
  commit: z.object({
    sha: githubShaSchema,
    commit: z.object({ tree: z.object({ sha: githubShaSchema }) }),
  }),
});
const candidateSchema = z.object({
  number: z.number().int().positive(),
  state: z.literal("open"),
  head: z.object({
    ref: githubBranchSchema,
    sha: githubShaSchema,
    repo: z.object({ full_name: repositoryFields.shape.fullName }),
  }),
  base: z.object({
    repo: z.object({ full_name: repositoryFields.shape.fullName }),
  }),
});
const treeSchema = z.object({
  sha: githubShaSchema,
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string().max(1024),
        mode: z.string().max(6),
        type: z.enum(["blob", "tree", "commit"]),
        sha: githubShaSchema,
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(LIMITS.TREE_ENTRIES),
});
const blobSchema = z.object({
  sha: githubShaSchema,
  size: z.number().int().nonnegative().max(LIMITS.FILE_BYTES),
  encoding: z.literal("base64"),
  content: z.string().max(2 * LIMITS.FILE_BYTES),
});
type Files = Map<string, string>;
export type DependencyRead = {
  evidence: DependencyEvidence;
  files: Files;
  modes: Map<string, "100644" | "100755">;
  policy: DependencyPolicy | null;
  documents: DependencyDocuments[];
};
export async function dependencyHash(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return (
    "sha256:" +
    Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
function invalid(): never {
  throw new ProviderFailure(
    "error",
    "Repository dependency evidence could not be verified",
    null,
    "response_invalid",
  );
}
function limited(): never {
  throw new ProviderFailure(
    "limited",
    "Dependency evidence exceeds the hosted read limit",
    null,
    "response_size",
  );
}
export async function inspectDependencyFiles(
  fullName: string,
  token: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    pullNumber?: number;
  } = {},
): Promise<DependencyRead> {
  const now = options.now ?? Date.now;
  const started = performance.now();
  const reader = new GitHubReader(token, {
    ...options,
    maxRequests: LIMITS.REQUESTS,
  });
  const files: Files = new Map();
  const modes = new Map<string, "100644" | "100755">();
  const documents: DependencyDocuments[] = [];
  let policy: DependencyPolicy | null = null;
  const evidence: DependencyEvidence = {
    inspectionId: crypto.randomUUID(),
    observedAt: new Date(now()).toISOString(),
    retryAt: null,
    requests: 0,
    upstreamRequests: 0,
    elapsedMs: 0,
    read: { state: "unobserved", reason: "not_attempted" },
    branch: null,
    pullNumber: options.pullNumber ?? null,
    headSha: null,
    treeSha: null,
    policy: "unknown",
    report: null,
  };
  try {
    const repository = repositoryFields.shape.fullName.parse(fullName);
    if (!token || /[\s\u0000-\u001f\u007f]/.test(token))
      throw new ProviderFailure(
        "unavailable",
        "Invalid read credential",
        null,
        "configuration",
      );
    const base =
      "/repos/" + repository.split("/").map(encodeURIComponent).join("/");
    const read = async (path: string) =>
      (
        await reader.request(
          "repository",
          new URL(base + path, GITHUB_LIMITS.API_ORIGIN),
        )
      ).data;
    const metadata = metadataSchema.parse(await read(""));
    if (metadata.full_name.toLowerCase() !== repository.toLowerCase())
      invalid();
    const candidate = options.pullNumber
      ? candidateSchema.parse(await read("/pulls/" + options.pullNumber))
      : null;
    if (
      candidate &&
      (candidate.number !== options.pullNumber ||
        candidate.head.repo.full_name.toLowerCase() !==
          repository.toLowerCase() ||
        candidate.base.repo.full_name.toLowerCase() !==
          repository.toLowerCase())
    )
      invalid();
    const branch = candidate?.head.ref ?? metadata.default_branch;
    const head = headSchema.parse(
      await read("/branches/" + encodeURIComponent(branch)),
    );
    if (
      head.name !== branch ||
      (candidate && candidate.head.sha !== head.commit.sha)
    )
      invalid();
    evidence.branch = head.name;
    evidence.headSha = head.commit.sha;
    evidence.treeSha = head.commit.commit.tree.sha;
    const tree = treeSchema.parse(
      await read("/git/trees/" + evidence.treeSha + "?recursive=1"),
    );
    if (tree.sha !== evidence.treeSha) invalid();
    if (tree.truncated) limited();
    const paths = new Map(tree.tree.map((entry) => [entry.path, entry]));
    if (paths.size !== tree.tree.length) invalid();
    if (!paths.has(DEPENDENCY_POLICY_PATH)) {
      evidence.policy = "absent";
      evidence.read = { state: "observed", reason: "complete" };
    } else {
      let total = 0;
      async function file(path: string, limit: number) {
        const entry = paths.get(path);
        if (
          !entry ||
          entry.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode) ||
          entry.size === undefined
        )
          invalid();
        if (entry.size > limit || total + entry.size > LIMITS.TOTAL_BYTES)
          limited();
        const blob = blobSchema.parse(await read("/git/blobs/" + entry.sha));
        if (
          blob.sha !== entry.sha ||
          blob.size !== entry.size ||
          !/^[A-Za-z0-9+/=\n\r]*$/.test(blob.content)
        )
          invalid();
        let text: string;
        try {
          const encoded = blob.content.replace(/[\n\r]/g, "");
          const binary = atob(encoded);
          if (btoa(binary) !== encoded || binary.length !== blob.size)
            invalid();
          const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0),
          );
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (new TextEncoder().encode(text).byteLength !== bytes.byteLength)
            invalid();
          const prefix = new TextEncoder().encode(
            "blob " + bytes.byteLength + "\0",
          );
          const object = new Uint8Array(prefix.byteLength + bytes.byteLength);
          object.set(prefix);
          object.set(bytes, prefix.byteLength);
          const digest = await crypto.subtle.digest(
            blob.sha.length === 40 ? "SHA-1" : "SHA-256",
            object,
          );
          if (
            Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("") !== blob.sha
          )
            invalid();
          JSON.parse(text);
        } catch {
          invalid();
        }
        total += blob.size;
        files.set(path, text);
        modes.set(path, entry.mode as "100644" | "100755");
        return text;
      }
      const policyText = await file(
        DEPENDENCY_POLICY_PATH,
        DEPENDENCY_LIMITS.POLICY_BYTES,
      );
      policy = dependencyPolicySchema.parse(JSON.parse(policyText));
      evidence.policy = "present";
      const digests = [];
      for (const manifest of policy.manifests) {
        const manifestText = await file(manifest.path, LIMITS.FILE_BYTES);
        const lockText = await file(
          manifest.path.replace(/package\.json$/, "package-lock.json"),
          LIMITS.FILE_BYTES,
        );
        documents.push({
          manifestPath: manifest.path,
          manifest: JSON.parse(manifestText),
          lock: JSON.parse(lockText),
        });
        digests.push({
          manifestPath: manifest.path,
          manifestDigest: await dependencyHash(manifestText),
          lockDigest: await dependencyHash(lockText),
        });
      }
      evidence.report = dependencyReportSchema.parse({
        schemaVersion: 1,
        kind: "npm-override-lifecycle",
        policyDigest: await dependencyHash(policyText),
        files: digests,
        analysis: analyzeDependencyPolicy(policy, documents, now()),
      });
      if (
        new TextEncoder().encode(JSON.stringify(evidence.report)).byteLength >
        DEPENDENCY_LIMITS.REPORT_BYTES
      )
        limited();
      evidence.read = { state: "observed", reason: "complete" };
    }
  } catch (error) {
    evidence.report = null;
    policy = null;
    files.clear();
    modes.clear();
    documents.length = 0;
    evidence.read =
      error instanceof ProviderFailure
        ? { state: error.state, reason: error.reason }
        : {
            state: "error",
            reason:
              error instanceof z.ZodError ? "response_invalid" : "unexpected",
          };
  }
  evidence.requests = reader.diagnostics().requests;
  evidence.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  evidence.retryAt =
    reader.retryAt === null ? null : new Date(reader.retryAt).toISOString();
  return {
    evidence: dependencyEvidenceSchema.parse(evidence),
    files,
    modes,
    policy,
    documents,
  };
}
export async function collectDependencies(
  fullName: string,
  token: string,
  options: { now: () => number; checkUpstream?: boolean; pullNumber?: number },
) {
  const started = performance.now();
  const { evidence } = await inspectDependencyFiles(fullName, token, options);
  if (options.checkUpstream && evidence.report) {
    const findings = evidence.report.analysis.findings;
    const names = [
      ...new Set(findings.map((finding) => finding.rule.parent)),
    ].slice(0, LIMITS.UPSTREAM_PACKAGES);
    await Promise.all(
      names.map(async (name) => {
        evidence.upstreamRequests++;
        let data: unknown = null;
        try {
          data = await upstreamDependencyDocument(name);
        } catch {
          /* Missing upstream evidence remains explicit */
        }
        for (const finding of findings.filter(
          (item) => item.rule.parent === name,
        )) {
          finding.upstream =
            data === null
              ? {
                  state: "unavailable",
                  checkedAt: new Date(options.now()).toISOString(),
                  parentVersion: null,
                  requested: null,
                }
              : dependencyUpstreamEvidence(finding.rule, data, options.now());
        }
      }),
    );
  }
  evidence.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  return dependencyEvidenceSchema.parse(evidence);
}
