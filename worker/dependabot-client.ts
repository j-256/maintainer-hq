import { z } from "zod";
import { repositoryFields } from "../shared/domain";
import { GITHUB_LIMITS, githubBranchSchema } from "../shared/github-evidence";
import { githubShaSchema } from "../shared/github-context";
import {
  DEPENDABOT_PATHS,
  DEPENDABOT_LIMITS as LIMITS,
  dependabotEvidenceSchema,
  type DependabotEvidence,
} from "../shared/dependabot";
import { GitHubReader, ProviderFailure } from "./github-client";
import { dependencyHash } from "./dependency-client";
import {
  DependabotDocumentError,
  parseDependabotDocument,
} from "./dependabot-yaml";

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
const treeSchema = z.object({
  sha: githubShaSchema,
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
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
function invalid(): never {
  throw new ProviderFailure(
    "error",
    "Dependabot source identity could not be verified",
    null,
    "response_invalid",
  );
}
function limited(): never {
  throw new ProviderFailure(
    "limited",
    "Dependabot source exceeds its bounded read limit",
    null,
    "response_size",
  );
}
export async function readDependabotBlob(
  reader: GitHubReader,
  base: string,
  entry: { sha: string; size?: number },
) {
  const blob = blobSchema.parse(
    (
      await reader.request(
        "repository",
        new URL(base + "/git/blobs/" + entry.sha, GITHUB_LIMITS.API_ORIGIN),
      )
    ).data,
  );
  if (
    blob.sha !== entry.sha ||
    (entry.size !== undefined && blob.size !== entry.size) ||
    !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)
  )
    invalid();
  const encoded = blob.content.replace(/[\r\n]/g, "");
  const binary = atob(encoded);
  if (btoa(binary) !== encoded || binary.length !== blob.size) invalid();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const prefix = new TextEncoder().encode("blob " + bytes.length + "\0");
  const object = new Uint8Array(prefix.length + bytes.length);
  object.set(prefix);
  object.set(bytes, prefix.length);
  const actual = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        blob.sha.length === 40 ? "SHA-1" : "SHA-256",
        object,
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== blob.sha) invalid();
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    invalid();
  }
  if (new TextEncoder().encode(text).length !== bytes.length) invalid();
  return text;
}
export async function inspectDependabotFile(
  fullName: string,
  token: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const started = performance.now();
  const reader = new GitHubReader(token, {
    ...options,
    maxRequests: LIMITS.REQUESTS,
  });
  const files = new Map<string, string>();
  const modes = new Map<string, "100644" | "100755">();
  const evidence: DependabotEvidence = {
    inspectionId: crypto.randomUUID(),
    observedAt: new Date(now()).toISOString(),
    retryAt: null,
    requests: 0,
    elapsedMs: 0,
    read: { state: "unobserved", reason: "not_attempted" },
    branch: null,
    headSha: null,
    treeSha: null,
    file: null,
    configuration: "unknown",
    entries: [],
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
    const head = headSchema.parse(
      await read("/branches/" + encodeURIComponent(metadata.default_branch)),
    );
    if (head.name !== metadata.default_branch) invalid();
    evidence.branch = head.name;
    evidence.headSha = head.commit.sha;
    evidence.treeSha = head.commit.commit.tree.sha;
    async function tree(sha: string) {
      const result = treeSchema.parse(await read("/git/trees/" + sha));
      if (result.sha !== sha) invalid();
      if (result.truncated) limited();
      if (
        new Set(result.tree.map((entry) => entry.path)).size !==
          result.tree.length ||
        result.tree.some((entry) => [".", ".."].includes(entry.path))
      )
        invalid();
      return result.tree;
    }
    const root = await tree(evidence.treeSha);
    const github = root.find((entry) => entry.path === ".github");
    if (github && (github.type !== "tree" || github.mode !== "040000"))
      invalid();
    const contents = github ? await tree(github.sha) : [];
    const candidates = contents.filter((entry) =>
      DEPENDABOT_PATHS.some((path) => path === ".github/" + entry.path),
    );
    if (candidates.length > 1) evidence.configuration = "ambiguous";
    else if (!candidates.length) evidence.configuration = "missing";
    else {
      const entry = candidates[0]!;
      if (
        entry.type !== "blob" ||
        !["100644", "100755"].includes(entry.mode) ||
        entry.size === undefined
      )
        invalid();
      if (entry.size > LIMITS.FILE_BYTES) limited();
      const text = await readDependabotBlob(reader, base, {
        sha: entry.sha,
        size: entry.size,
      });
      const path = (".github/" +
        entry.path) as (typeof DEPENDABOT_PATHS)[number];
      evidence.file = {
        path,
        mode: entry.mode as "100644" | "100755",
        blobSha: entry.sha,
        digest: await dependencyHash(text),
      };
      try {
        evidence.entries = parseDependabotDocument(
          text,
          evidence.file.digest,
        ).entries;
        evidence.configuration = "present";
        if (
          new TextEncoder().encode(JSON.stringify(evidence)).byteLength >
          LIMITS.EVIDENCE_BYTES
        ) {
          evidence.entries = [];
          evidence.configuration = "limited";
        } else {
          files.set(path, text);
          modes.set(path, evidence.file.mode);
        }
      } catch (error) {
        evidence.configuration =
          error instanceof DependabotDocumentError ? error.kind : "unsupported";
      }
    }
    evidence.read = { state: "observed", reason: "complete" };
  } catch (error) {
    evidence.file = null;
    evidence.entries = [];
    files.clear();
    modes.clear();
    evidence.configuration =
      error instanceof ProviderFailure && error.state === "limited"
        ? "limited"
        : "unknown";
    evidence.read =
      error instanceof ProviderFailure
        ? { state: error.state, reason: error.reason }
        : { state: "error", reason: "response_invalid" };
  }
  evidence.requests = reader.diagnostics().requests;
  evidence.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  evidence.retryAt =
    reader.retryAt === null ? null : new Date(reader.retryAt).toISOString();
  return { evidence: dependabotEvidenceSchema.parse(evidence), files, modes };
}
