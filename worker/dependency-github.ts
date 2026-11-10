import { GITHUB_APP_LIMITS } from "../shared/github-apps";
import { APP_AUTHENTICATION_RETRIES } from "./provider-effect-errors";
import { DomainError } from "./errors";
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
  #authenticationRetries = 0;
  #token: string;
  constructor(
    readonly repository: string,
    token: string,
    readonly fetcher: typeof fetch = fetch,
    readonly timeoutMs: number = LIMITS.REQUEST_MS,
    readonly deadline = Infinity,
    readonly authorizeRequest?: (
      method: "GET" | "POST",
      suffix: string,
      remainingBudgetMs: () => number,
    ) => Promise<{
      token: string;
      assertLive: () => Promise<void>;
      rejectCredential?: () => void;
      recordResponse?: (response: Response) => Promise<void>;
    }>,
  ) {
    this.#token = token;
    repositoryFields.shape.fullName.parse(repository);
    if (
      token.length > GITHUB_APP_LIMITS.TOKEN_BYTES ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      throw new DependencyProviderFailure("provider_unavailable");
    this.base =
      "/repos/" + repository.split("/").map(encodeURIComponent).join("/");
  }
  private async request(
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
    retry?: {
      attempts: number;
      serialized: string | undefined;
      deadline: number;
    },
  ): Promise<unknown> {
    const serialized = retry
      ? retry.serialized
      : body === undefined
        ? undefined
        : JSON.stringify(body);
    const deadline =
      retry?.deadline ?? Math.min(this.deadline, Date.now() + this.timeoutMs);
    const remainingBudgetMs = () => deadline - Date.now();
    const timeout = remainingBudgetMs();
    if (timeout <= 0)
      throw new DependencyProviderFailure("provider_unavailable");
    if (
      this.requests - this.#authenticationRetries >= LIMITS.REQUESTS ||
      (serialized &&
        new TextEncoder().encode(serialized).byteLength > LIMITS.REQUEST_BYTES)
    )
      throw new DependencyProviderFailure("provider_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = controller.signal;
    let dispatched = false;
    try {
      const authority = this.authorizeRequest
        ? await this.authorizeRequest(method, suffix, remainingBudgetMs)
        : null;
      signal.throwIfAborted();
      if (remainingBudgetMs() <= 0)
        throw new DependencyProviderFailure("provider_unavailable");
      this.requests++;
      dispatched = true;
      const response = await bounded(
        this.fetcher(new URL(this.base + suffix, GITHUB_LIMITS.API_ORIGIN), {
          method,
          redirect: "error",
          signal,
          headers: {
            Authorization: "Bearer " + (authority?.token ?? this.#token),
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_LIMITS.API_VERSION,
            "User-Agent": "Maintainer-HQ",
          },
          ...(serialized ? { body: serialized } : {}),
        }),
        signal,
      );
      await authority?.recordResponse?.(response);
      if (
        response.status === 401 &&
        authority?.rejectCredential &&
        this.#authenticationRetries < APP_AUTHENTICATION_RETRIES
      ) {
        void response.body?.cancel().catch(() => undefined);
        this.#authenticationRetries++;
        authority.rejectCredential();
        return this.request(method, suffix, body, {
          attempts: (retry?.attempts ?? 0) + 1,
          serialized,
          deadline,
        });
      }
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
      if (authority) await authority.assertLive();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if (
        error instanceof DependencyProviderFailure ||
        error instanceof DomainError
      )
        throw error;
      throw new DependencyProviderFailure(
        method === "POST" && dispatched
          ? "outcome_unknown"
          : "provider_unavailable",
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
    return pullSchema.extend({ merged: z.boolean() }).parse(
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
