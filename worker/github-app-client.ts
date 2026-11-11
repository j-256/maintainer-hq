import { z } from "zod";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppPermissionsSchema,
  githubProviderIdSchema,
  githubRepositoryNameSchema,
  type GitHubAppPermissions,
  type GitHubAppRepositoryPage,
} from "../shared/github-apps";
import { DomainError } from "./errors";
import { signGitHubAppJwt } from "./github-app-crypto";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
export const GITHUB_APP_USER_AGENT = "maintainer-hq";
const accountSchema = z.object({
  id: githubProviderIdSchema,
  login: z.string().min(1).max(100),
  type: z.enum(["User", "Organization"]),
});
const providerPermissionsSchema = z
  .record(
    z.string().regex(/^[a-z_]{1,80}$/),
    z.enum(["read", "write", "admin"]),
  )
  .refine((value) => Object.keys(value).length <= 100);
const installationSchema = z.object({
  id: githubProviderIdSchema,
  app_id: githubProviderIdSchema,
  account: accountSchema,
  permissions: providerPermissionsSchema,
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.iso.datetime({ offset: true }).nullable(),
});
const repositorySchema = z.object({
  id: githubProviderIdSchema,
  full_name: githubRepositoryNameSchema,
  private: z.boolean(),
  owner: z.object({ id: githubProviderIdSchema }),
});
const tokenScopeSchema = z
  .object({
    installationId: githubProviderIdSchema,
    repositoryIds: z
      .array(githubProviderIdSchema)
      .min(1)
      .max(LIMITS.REPOSITORIES)
      .refine((ids) => new Set(ids).size === ids.length),
    permissions: githubAppPermissionsSchema,
  })
  .strict();
const tokenResponseSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(LIMITS.TOKEN_BYTES)
    .regex(/^[\x21-\x7e]+$/),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: providerPermissionsSchema,
  repository_selection: z.enum(["all", "selected"]).optional(),
  repositories: z.array(repositorySchema).min(1).max(LIMITS.REPOSITORIES),
});
export type GitHubAppClientOptions = {
  appId: number;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  budgetMs?: number;
};
export type GitHubAppIdentity = {
  id: number;
  slug: string;
  name: string;
  account: z.infer<typeof accountSchema>;
  permissions: z.infer<typeof providerPermissionsSchema>;
};
export type GitHubInstallationMetadata = {
  id: number;
  appId: number;
  account: z.infer<typeof accountSchema>;
  permissions: z.infer<typeof providerPermissionsSchema>;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
};
export type GitHubInstallationPage = {
  items: GitHubInstallationMetadata[];
  nextCursor: string | null;
  limited: boolean;
};
export type GitHubRepositoryIdentity = {
  id: number;
  fullName: string;
  private: boolean;
  ownerId: number;
};
export type GitHubAppTokenScope = z.infer<typeof tokenScopeSchema>;
export type GitHubAppToken = {
  token: string;
  expiresAt: string;
  repositoryIds: number[];
  repositories: GitHubRepositoryIdentity[];
  permissions: GitHubAppPermissions;
};
export class GitHubAppProviderError extends DomainError {
  constructor(
    code: string,
    message: string,
    status = 503,
    readonly retryAt: string | null = null,
  ) {
    super(code, message, status);
  }
}
export function githubAppRemainingBudget(remainingBudgetMs?: () => number) {
  const remaining = Math.min(
    LIMITS.REQUEST_TIMEOUT_MS,
    remainingBudgetMs?.() ?? LIMITS.REQUEST_TIMEOUT_MS,
  );
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new GitHubAppProviderError(
      "github_app_budget_exhausted",
      "App verification exceeded its execution budget. Retry through the saved scope.",
    );
  return remaining;
}
function invalidInput(): never {
  throw new DomainError(
    "github_app_input_invalid",
    "Select a bounded App installation, repository set and supported permissions.",
  );
}
function invalidResponse(): never {
  throw new GitHubAppProviderError(
    "github_app_response_invalid",
    "GitHub did not return the exact bounded App identity or authority requested. No result was accepted.",
  );
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : invalidResponse();
}
export async function readGitHubAppResponse(response: Response) {
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.RESPONSE_BYTES) {
        await reader.cancel();
        invalidResponse();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return invalidResponse();
  } finally {
    reader.releaseLock();
  }
}
function normalizeRepository(
  value: z.infer<typeof repositorySchema>,
): GitHubRepositoryIdentity {
  return {
    id: value.id,
    fullName: value.full_name,
    private: value.private,
    ownerId: value.owner.id,
  };
}

export class GitHubAppClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly deadline: number;
  readonly #options: GitHubAppClientOptions;
  #requests = 0;
  get requests() {
    return this.#requests;
  }
  constructor(options: GitHubAppClientOptions) {
    this.#options = options;
    if (
      !githubProviderIdSchema.safeParse(options.appId).success ||
      (options.budgetMs !== undefined &&
        (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0))
    )
      invalidInput();
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.deadline =
      performance.now() + (options.budgetMs ?? LIMITS.REQUEST_TIMEOUT_MS);
  }
  private async request(
    path: string,
    body?: unknown,
    installationToken?: string,
  ) {
    const remaining = Math.min(
      LIMITS.REQUEST_TIMEOUT_MS,
      this.deadline - performance.now(),
    );
    if (remaining <= 0)
      throw new GitHubAppProviderError(
        "github_app_budget_exhausted",
        "App verification exceeded its execution budget. Retry through the saved review.",
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const jwt =
        installationToken ??
        (await signGitHubAppJwt(
          this.#options.privateKey,
          this.#options.appId,
          this.now(),
        ));
      if (controller.signal.aborted) throw new Error();
      this.#requests++;
      const response = await this.fetcher(API_ORIGIN + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": GITHUB_APP_USER_AGENT,
          Authorization: "Bearer " + jwt,
          "X-GitHub-Api-Version": API_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get("retry-after");
        const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
        if (
          response.status === 429 ||
          (response.status === 403 && (retry !== null || exhausted))
        ) {
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
          const reset = response.headers.get("x-ratelimit-reset");
          const resetAt =
            reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
          const retryAt =
            seconds !== null
              ? this.now() + Math.min(seconds, 86400) * 1000
              : resetAt;
          throw new GitHubAppProviderError(
            "github_app_rate_limited",
            "GitHub App authority could not be verified because its shared quota is limited.",
            429,
            retryAt !== null &&
              Number.isFinite(retryAt) &&
              retryAt <= 8640000000000000
              ? new Date(retryAt).toISOString()
              : null,
          );
        }
        if ([401, 403, 404].includes(response.status))
          throw new GitHubAppProviderError(
            "github_app_denied",
            "GitHub did not authorize the selected App or installation scope.",
            403,
          );
        throw new GitHubAppProviderError(
          "github_app_unavailable",
          "GitHub App verification is unavailable. Preserve the review before retrying.",
        );
      }
      return await readGitHubAppResponse(response);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new GitHubAppProviderError(
        "github_app_unavailable",
        "GitHub App verification did not complete. No authority was accepted.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async getApp(): Promise<GitHubAppIdentity> {
    const app = parse(
      z.object({
        id: githubProviderIdSchema,
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/),
        name: z.string().min(1).max(80),
        owner: accountSchema,
        permissions: providerPermissionsSchema,
      }),
      await this.request("/app"),
    );
    if (app.id !== this.#options.appId) invalidResponse();
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      account: app.owner,
      permissions: app.permissions,
    };
  }
  private installation(value: unknown): GitHubInstallationMetadata {
    const installation = parse(installationSchema, value);
    if (installation.app_id !== this.#options.appId) invalidResponse();
    return {
      id: installation.id,
      appId: installation.app_id,
      account: installation.account,
      permissions: installation.permissions,
      repositorySelection: installation.repository_selection,
      suspendedAt: installation.suspended_at,
    };
  }
  async listInstallations(cursor?: string): Promise<GitHubInstallationPage> {
    if (cursor !== undefined && !/^[1-9]\d{0,4}$/.test(cursor)) invalidInput();
    const page = cursor === undefined ? 1 : Number(cursor);
    if (page > LIMITS.MAX_PAGE) invalidInput();
    const value = parse(
      z.array(z.unknown()).max(LIMITS.PAGE_SIZE),
      await this.request(
        `/app/installations?per_page=${LIMITS.PAGE_SIZE}&page=${page}`,
      ),
    );
    const items = value.map((item) => this.installation(item));
    if (new Set(items.map((item) => item.id)).size !== items.length)
      invalidResponse();
    return {
      items,
      limited: items.length === LIMITS.PAGE_SIZE && page === LIMITS.MAX_PAGE,
      nextCursor:
        items.length === LIMITS.PAGE_SIZE && page < LIMITS.MAX_PAGE
          ? String(page + 1)
          : null,
    };
  }
  async getInstallation(
    installationId: number,
  ): Promise<GitHubInstallationMetadata> {
    if (!githubProviderIdSchema.safeParse(installationId).success)
      invalidInput();
    const result = this.installation(
      await this.request(`/app/installations/${installationId}`),
    );
    if (result.id !== installationId) invalidResponse();
    return result;
  }
  async mintToken(request: GitHubAppTokenScope): Promise<GitHubAppToken> {
    const scope = tokenScopeSchema.safeParse(request);
    if (!scope.success) invalidInput();
    const { installationId, repositoryIds, permissions } = scope.data;
    const response = parse(
      tokenResponseSchema,
      await this.request(`/app/installations/${installationId}/access_tokens`, {
        repository_ids: repositoryIds,
        permissions,
      }),
    );
    const returnedIds = response.repositories.map(
      (repository) => repository.id,
    );
    if (
      returnedIds.length !== repositoryIds.length ||
      new Set(returnedIds).size !== returnedIds.length ||
      returnedIds.some((id) => !repositoryIds.includes(id))
    )
      invalidResponse();
    for (const [name, level] of Object.entries(response.permissions)) {
      if (name === "metadata" && level === "read") continue;
      if (permissions[name as keyof GitHubAppPermissions] !== level)
        invalidResponse();
    }
    for (const [name, level] of Object.entries(permissions)) {
      if (name === "metadata" && level === "read") continue;
      if (response.permissions[name] !== level) invalidResponse();
    }
    const expires = Date.parse(response.expires_at);
    if (
      expires <= this.now() + LIMITS.TOKEN_MARGIN_MS ||
      expires >
        this.now() + LIMITS.TOKEN_MAX_LIFETIME_MS + LIMITS.TOKEN_MARGIN_MS
    )
      invalidResponse();
    return {
      token: response.token,
      expiresAt: new Date(expires).toISOString(),
      repositoryIds: returnedIds,
      repositories: response.repositories.map(normalizeRepository),
      permissions: githubAppPermissionsSchema.parse({
        ...response.permissions,
        metadata: "read",
      }),
    };
  }
  // Only the privileged installation-inventory service may use this unnarrowed metadata token
  async listInstallationRepositories(
    installationId: number,
    cursor?: string,
  ): Promise<GitHubAppRepositoryPage> {
    if (cursor !== undefined && !/^[1-9]\d{0,4}$/.test(cursor)) invalidInput();
    const page = cursor === undefined ? 1 : Number(cursor);
    if (page > LIMITS.MAX_PAGE) invalidInput();
    const installation = await this.getInstallation(installationId);
    if (installation.suspendedAt)
      throw new GitHubAppProviderError(
        "github_app_denied",
        "This installation is suspended. Ask its account owner to restore access.",
        403,
      );
    const credential = parse(
      tokenResponseSchema.omit({ repositories: true }),
      await this.request(`/app/installations/${installationId}/access_tokens`, {
        permissions: { metadata: "read" },
      }),
    );
    if (
      Object.entries(credential.permissions).some(
        ([name, level]) => name !== "metadata" || level !== "read",
      ) ||
      Date.parse(credential.expires_at) <=
        this.now() + LIMITS.TOKEN_MARGIN_MS ||
      Date.parse(credential.expires_at) >
        this.now() + LIMITS.TOKEN_MAX_LIFETIME_MS + LIMITS.TOKEN_MARGIN_MS
    )
      invalidResponse();
    const response = parse(
      z.object({
        repositories: z.array(repositorySchema).max(LIMITS.PAGE_SIZE),
        total_count: z.number().int().nonnegative().safe(),
      }),
      await this.request(
        `/installation/repositories?per_page=${LIMITS.PAGE_SIZE}&page=${page}`,
        undefined,
        credential.token,
      ),
    );
    const items = response.repositories.map(normalizeRepository);
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => item.ownerId !== installation.account.id)
    )
      invalidResponse();
    const more =
      items.length === LIMITS.PAGE_SIZE &&
      response.total_count > page * LIMITS.PAGE_SIZE;
    return {
      items,
      nextCursor: more && page < LIMITS.MAX_PAGE ? String(page + 1) : null,
      limited: more && page === LIMITS.MAX_PAGE,
    };
  }
  async verifyRepository(
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubRepositoryIdentity> {
    const token = await this.mintToken({
      installationId,
      repositoryIds: [repositoryId],
      permissions: { metadata: "read" },
    });
    return token.repositories[0];
  }
}
