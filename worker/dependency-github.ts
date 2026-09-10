import { z } from "zod";
import { repositoryFields } from "../shared/domain";
import { GITHUB_LIMITS, githubBranchSchema } from "../shared/github-evidence";
import { githubShaSchema } from "../shared/github-context";
import { DEPENDENCY_OPERATION_LIMITS as LIMITS } from "../shared/dependency-operations";

export class DependencyProviderFailure extends Error {
  constructor(
    readonly reason:
      | "provider_rejected"
      | "provider_unavailable"
      | "outcome_unknown"
      | "identity_changed",
    readonly status = 0,
  ) {
    super(reason);
  }
}
const commitSchema = z.object({
  sha: githubShaSchema,
  tree: z.object({ sha: githubShaSchema }),
  parents: z.array(z.object({ sha: githubShaSchema })).max(1),
});
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha: githubShaSchema }),
});
const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  body: z.string().max(65536).nullable(),
  head: z.object({
    ref: githubBranchSchema,
    sha: githubShaSchema,
    repo: z.object({ full_name: repositoryFields.shape.fullName }).nullable(),
  }),
  base: z.object({
    ref: githubBranchSchema,
    repo: z.object({ full_name: repositoryFields.shape.fullName }),
  }),
});
export type DependencyPull = z.infer<typeof pullSchema>;
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("Request timed out"));
    signal.addEventListener("abort", stop, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
  });
}
export class DependencyGitHub {
  readonly base: string;
  requests = 0;
  constructor(
    readonly repository: string,
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
    readonly timeoutMs: number = LIMITS.REQUEST_MS,
    readonly deadline = Infinity,
  ) {
    repositoryFields.shape.fullName.parse(repository);
    if (!/^[\x21-\x7e]{1,2048}$/.test(token))
      throw new DependencyProviderFailure("provider_unavailable");
    this.base =
      "/repos/" + repository.split("/").map(encodeURIComponent).join("/");
  }
  private async request(
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const timeout = Math.min(this.timeoutMs, this.deadline - Date.now());
    if (timeout <= 0)
      throw new DependencyProviderFailure("provider_unavailable");
    if (
      this.requests >= LIMITS.REQUESTS ||
      (serialized &&
        new TextEncoder().encode(serialized).byteLength > LIMITS.REQUEST_BYTES)
    )
      throw new DependencyProviderFailure("provider_unavailable");
    this.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = controller.signal;
    try {
      const response = await bounded(
        this.fetcher(new URL(this.base + suffix, GITHUB_LIMITS.API_ORIGIN), {
          method,
          redirect: "error",
          signal,
          headers: {
            Authorization: "Bearer " + this.token,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_LIMITS.API_VERSION,
            "User-Agent": "Maintainer-HQ",
          },
          ...(serialized ? { body: serialized } : {}),
        }),
        signal,
      );
      if (response.status !== (method === "POST" ? 201 : 200)) {
        void response.body?.cancel().catch(() => undefined);
        throw new DependencyProviderFailure(
          method === "POST"
            ? response.status >= 400 && response.status < 500
              ? "provider_rejected"
              : "outcome_unknown"
            : "provider_unavailable",
          response.status,
        );
      }
      if (
        !response.body ||
        Number(response.headers.get("Content-Length")) > LIMITS.RESPONSE_BYTES
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Unbounded response");
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await bounded(reader.read(), signal);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > LIMITS.RESPONSE_BYTES) throw new Error("Response limit");
          chunks.push(next.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if (error instanceof DependencyProviderFailure) throw error;
      throw new DependencyProviderFailure(
        method === "POST" ? "outcome_unknown" : "provider_unavailable",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async tree(
    base: string,
    files: { path: string; mode: string; content: string }[],
  ) {
    return z.object({ sha: githubShaSchema }).parse(
      await this.request("POST", "/git/trees", {
        base_tree: base,
        tree: files.map((file) => ({ ...file, type: "blob" })),
      }),
    ).sha;
  }
  async commit(parent: string, tree: string, message: string) {
    const result = commitSchema.parse(
      await this.request("POST", "/git/commits", {
        message,
        tree,
        parents: [parent],
      }),
    );
    if (
      result.tree.sha !== tree ||
      result.parents.length !== 1 ||
      result.parents[0]!.sha !== parent
    )
      throw new DependencyProviderFailure("outcome_unknown");
    return result.sha;
  }
  async branch(name: string, sha: string) {
    const ref = "refs/heads/" + name;
    const result = refSchema.parse(
      await this.request("POST", "/git/refs", { ref, sha }),
    );
    if (result.ref !== ref || result.object.sha !== sha)
      throw new DependencyProviderFailure("outcome_unknown");
  }
  async readBranch(name: string) {
    const result = refSchema.parse(
      await this.request("GET", "/git/ref/heads/" + encodeURIComponent(name)),
    );
    if (result.ref !== "refs/heads/" + name)
      throw new DependencyProviderFailure("identity_changed");
    return result.object.sha;
  }
  async pull(head: string, base: string, title: string, body: string) {
    return pullSchema
      .extend({ merged: z.boolean() })
      .parse(
        await this.request("POST", "/pulls", {
          head,
          base,
          title,
          body,
          maintainer_can_modify: false,
        }),
      );
  }
  async findPull(head: string) {
    const params = new URLSearchParams({
      state: "all",
      head: this.repository.split("/")[0] + ":" + head,
      per_page: "2",
    });
    return z
      .array(pullSchema)
      .max(2)
      .parse(await this.request("GET", "/pulls?" + params));
  }
  async readPull(number: number) {
    return pullSchema
      .extend({ merged: z.boolean() })
      .parse(await this.request("GET", "/pulls/" + number));
  }
}
