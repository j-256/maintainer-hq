import { z } from "zod";
import { idSchema, repositoryFields } from "../shared/domain";
import {
  GITHUB_SECRET_LIMITS as SECRET_LIMITS,
  SECRET_PROVIDER,
  secretMetadataSchema,
  secretPublicKeySchema,
  secretRepositorySchema,
  secretEnvironmentMetadataSchema,
  secretEnvironmentSchema,
  secretNameSchema,
  secretVariableMetadataSchema,
  type SecretMetadata,
  type SecretPage,
  type SecretProviderReference,
} from "../shared/github-secrets";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { Env } from "./types";
import {
  SECRET_ENTRY_KIND,
  type SecretEntryKind,
  type SecretScope,
  type SecretWriteResult,
} from "../shared/secrets";
import { MANAGED_CREDENTIAL_PREFIX } from "../shared/provider-credentials";

const CATALOG_BYTES = 256 * 1024;
const CATALOG_ENTRIES = 50;
const descriptorSchema = z
  .object({
    workspaceId: idSchema,
    name: z.string().trim().min(1).max(80),
    revision: z.number().int().positive(),
    token: z.string().regex(/^[\x21-\x7e]{1,2048}$/),
    expiresAt: z.iso.datetime(),
    repositoryNames: z
      .array(repositoryFields.shape.fullName)
      .min(1)
      .max(SECRET_LIMITS.REPOSITORIES),
    writable: z.boolean(),
  })
  .strict();
type SecretCredential = z.infer<typeof descriptorSchema>;

function catalog(env: Env): Map<string, SecretCredential> {
  const entries = new Map<string, SecretCredential>();
  const value = env.GITHUB_SECRET_CREDENTIALS;
  if (!value || value.length > CATALOG_BYTES) return entries;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return entries;
    const fields = Object.entries(parsed);
    if (fields.length > CATALOG_ENTRIES) return entries;
    for (const [id, field] of fields) {
      const descriptor = descriptorSchema.safeParse(field);
      if (
        !id.startsWith(MANAGED_CREDENTIAL_PREFIX) &&
        idSchema.safeParse(id).success &&
        descriptor.success
      )
        entries.set(id, descriptor.data);
    }
  } catch {
    // Invalid deployment bindings fail closed
  }
  return entries;
}

export function secretProviderReferences(
  env: Env,
  workspaceId: string,
  now = Date.now(),
): SecretProviderReference[] {
  return [...catalog(env)]
    .filter(([, item]) => item.workspaceId === workspaceId)
    .map(([id, item]) => ({
      id,
      name: item.name,
      revision: item.revision,
      repositoryNames: item.repositoryNames,
      expiresAt: item.expiresAt,
      writable: item.writable,
      available: Date.parse(item.expiresAt) > now,
    }));
}
export async function secretProvider(
  env: Env,
  workspaceId: string,
  reference: string,
  now = Date.now(),
) {
  const descriptor = catalog(env).get(reference);
  if (
    !descriptor ||
    descriptor.workspaceId !== workspaceId ||
    Date.parse(descriptor.expiresAt) <= now
  )
    throw new DomainError(
      "secret_provider_unavailable",
      "The selected Secrets credential is unavailable or expired. Ask the workspace owner to review it.",
      503,
    );
  return {
    descriptor,
    identity: await credentialHash(
      JSON.stringify({ reference, ...descriptor }),
    ),
    client: new SecretGitHubClient(descriptor),
  };
}

export class SecretGitHubClient {
  constructor(
    readonly credential: SecretCredential,
    readonly request: typeof fetch = fetch,
  ) {}

  private path(repository: string, environment?: string | null) {
    if (
      !repositoryFields.shape.fullName.safeParse(repository).success ||
      [".", ".."].includes(repository.split("/")[1]!) ||
      (environment != null &&
        !secretEnvironmentSchema.safeParse(environment).success)
    )
      throw new DomainError(
        "secret_scope_invalid",
        "Select a valid GitHub repository and environment scope.",
        400,
      );
    if (
      !this.credential.repositoryNames.some(
        (name) => name.toLowerCase() === repository.toLowerCase(),
      )
    )
      throw new DomainError(
        "secret_repository_denied",
        "This repository is outside the Secrets credential's approved scope.",
        403,
      );
    const root =
      "/repos/" + repository.split("/").map(encodeURIComponent).join("/");
    return environment === undefined
      ? root
      : root +
          (environment === null
            ? "/actions"
            : "/environments/" + encodeURIComponent(environment)) +
          "/secrets";
  }
  private inventoryPath(
    repository: string,
    scope: SecretScope,
    entryKind: SecretEntryKind,
  ) {
    const root = this.path(repository);
    const collection =
      entryKind === SECRET_ENTRY_KIND.SECRET ? "secrets" : "variables";
    if (scope.kind === "repository") return root + "/actions/" + collection;
    if (scope.kind === "environment") {
      if (!secretEnvironmentSchema.safeParse(scope.name).success)
        throw new DomainError(
          "secret_scope_invalid",
          "Select a valid GitHub environment scope.",
          400,
        );
      return (
        root +
        "/environments/" +
        encodeURIComponent(scope.name) +
        "/" +
        collection
      );
    }
    if (
      scope.kind !== "organization" ||
      scope.name.toLowerCase() !== repository.split("/")[0]!.toLowerCase()
    )
      throw new DomainError(
        "secret_scope_invalid",
        "Select the GitHub organization that owns this repository.",
        400,
      );
    return root + "/actions/organization-" + collection;
  }
  private async response(path: string, method = "GET", body?: object) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SECRET_LIMITS.REQUEST_MS,
    );
    try {
      const request = this.request(SECRET_PROVIDER.ORIGIN + path, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + this.credential.token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": SECRET_PROVIDER.API_VERSION,
          "User-Agent": "maintainer-hq",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const abort = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Bounded provider request interrupted")),
          { once: true },
        );
      });
      const response = await Promise.race([request, abort]);
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("X-RateLimit-Remaining") === "0" ||
            response.headers.has("Retry-After")));
      if (method !== "GET") {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, body: null, rateLimited };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, body: null, rateLimited };
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing provider body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), abort]);
          if (done) break;
          size += value.byteLength;
          if (size > SECRET_LIMITS.RESPONSE_BYTES)
            throw new Error("Oversized provider response");
          chunks.push(value);
        }
      } catch {
        void reader.cancel().catch(() => {});
        throw new Error("Unreadable provider response");
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        rateLimited,
      };
    } catch {
      throw new DomainError(
        "secret_provider_interrupted",
        "The GitHub request was interrupted. Metadata is not confirmed and submitted writes require receipt review.",
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async read<T>(
    path: string,
    schema: z.ZodType<T>,
    absent = false,
  ): Promise<T | null> {
    const response = await this.response(path);
    if (absent && response.status === 404) return null;
    if (response.status !== 200) {
      const code = response.rateLimited
        ? "secret_rate_limited"
        : response.status === 401 || response.status === 403
          ? "secret_permission_denied"
          : response.status === 404
            ? "secret_resource_unavailable"
            : "secret_provider_failed";
      throw new DomainError(
        code,
        "GitHub did not permit or complete this provider configuration read. Unavailable data is not an empty inventory.",
        503,
      );
    }
    const parsed = schema.safeParse(response.body);
    if (!parsed.success)
      throw new DomainError(
        "secret_provider_invalid",
        "GitHub returned invalid provider configuration metadata. No complete result was accepted.",
        503,
      );
    return parsed.data;
  }
  async repository(repository: string) {
    const result = (await this.read(
      this.path(repository),
      secretRepositorySchema,
    ))!;
    if (result.full_name.toLowerCase() !== repository.toLowerCase())
      throw new DomainError(
        "secret_identity_changed",
        "GitHub repository identity changed. Review repository enrollment.",
        409,
      );
    return result;
  }
  async environment(repository: string, environment: string) {
    if (!secretEnvironmentSchema.safeParse(environment).success)
      throw new DomainError(
        "secret_scope_invalid",
        "Select a valid GitHub environment scope.",
        400,
      );
    const result = (await this.read(
      this.path(repository) +
        "/environments/" +
        encodeURIComponent(environment),
      secretEnvironmentMetadataSchema,
    ))!;
    if (result.name.toLowerCase() !== environment.toLowerCase())
      throw new DomainError(
        "secret_identity_changed",
        "GitHub environment identity changed. Select it again from the inventory.",
        409,
      );
    return result;
  }
  async publicKey(repository: string, environment: string | null) {
    const key = (await this.read(
      this.path(repository, environment) + "/public-key",
      secretPublicKeySchema,
    ))!;
    if (btoa(atob(key.key)) !== key.key)
      throw new DomainError(
        "secret_provider_invalid",
        "GitHub returned a noncanonical encryption key.",
        503,
      );
    return key;
  }
  async metadata(
    repository: string,
    environment: string | null,
    name: string,
  ): Promise<SecretMetadata | null> {
    const result = await this.read(
      this.namedPath(repository, environment, name),
      secretMetadataSchema,
      true,
    );
    if (result && result.name !== name)
      throw new DomainError(
        "secret_identity_changed",
        "GitHub secret identity changed. Refresh the review.",
        409,
      );
    return result;
  }
  private page<T extends { name: string }>(
    items: T[],
    total: number,
    page: number,
  ): SecretPage<T> {
    const more = page * SECRET_LIMITS.PAGE_SIZE < total;
    if (
      (more && items.length !== SECRET_LIMITS.PAGE_SIZE) ||
      (items.length > 0 &&
        (page - 1) * SECRET_LIMITS.PAGE_SIZE + items.length > total) ||
      new Set(items.map((item) => item.name.toLowerCase())).size !==
        items.length
    )
      throw new DomainError(
        "secret_provider_invalid",
        "GitHub pagination changed during the read. Refresh this page.",
        503,
      );
    return {
      items,
      page,
      total,
      nextPage: more && page < SECRET_LIMITS.MAX_PAGE ? page + 1 : null,
      truncated: more && page === SECRET_LIMITS.MAX_PAGE,
    };
  }
  async environments(repository: string, page: number) {
    this.checkPage(page);
    const result = (await this.read(
      this.path(repository) +
        "/environments?per_page=" +
        SECRET_LIMITS.PAGE_SIZE +
        "&page=" +
        page,
      z.object({
        total_count: z.number().int().nonnegative(),
        environments: z
          .array(secretEnvironmentMetadataSchema)
          .max(SECRET_LIMITS.PAGE_SIZE),
      }),
    ))!;
    return this.page(result.environments, result.total_count, page);
  }
  async inventory(
    repository: string,
    environment: string | null,
    page: number,
  ) {
    this.checkPage(page);
    const result = (await this.read(
      this.path(repository, environment) +
        "?per_page=" +
        SECRET_LIMITS.PAGE_SIZE +
        "&page=" +
        page,
      z.object({
        total_count: z.number().int().nonnegative(),
        secrets: z.array(secretMetadataSchema).max(SECRET_LIMITS.PAGE_SIZE),
      }),
    ))!;
    return this.page(result.secrets, result.total_count, page);
  }
  async configurationInventory(
    repository: string,
    scope: SecretScope,
    entryKind: SecretEntryKind,
    page: number,
  ) {
    this.checkPage(page);
    if (
      entryKind === SECRET_ENTRY_KIND.SECRET &&
      scope.kind !== "organization"
    )
      return this.inventory(
        repository,
        scope.kind === "environment" ? scope.name : null,
        page,
      );
    const root =
      this.inventoryPath(repository, scope, entryKind) +
      "?per_page=" +
      SECRET_LIMITS.PAGE_SIZE +
      "&page=" +
      page;
    if (entryKind === SECRET_ENTRY_KIND.SECRET) {
      const result = (await this.read(
        root,
        z.object({
          total_count: z.number().int().nonnegative(),
          secrets: z.array(secretMetadataSchema).max(SECRET_LIMITS.PAGE_SIZE),
        }),
      ))!;
      return this.page(result.secrets, result.total_count, page);
    }
    const result = (await this.read(
      root,
      z.object({
        total_count: z.number().int().nonnegative(),
        variables: z
          .array(secretVariableMetadataSchema)
          .max(SECRET_LIMITS.PAGE_SIZE),
      }),
    ))!;
    return this.page(result.variables, result.total_count, page);
  }
  async variable(
    repository: string,
    environment: string | null,
    name: string,
  ) {
    const scope: SecretScope = environment
      ? { kind: "environment", name: environment }
      : { kind: "repository" };
    const canonical = secretNameSchema.safeParse(name);
    if (!canonical.success || canonical.data !== name)
      throw new DomainError(
        "secret_scope_invalid",
        "Select a valid canonical GitHub variable name.",
        400,
      );
    const path =
      this.inventoryPath(repository, scope, SECRET_ENTRY_KIND.VARIABLE) +
      "/" +
      encodeURIComponent(name);
    const result = await this.read(path, secretVariableMetadataSchema, true);
    if (result && result.name !== name)
      throw new DomainError(
        "secret_identity_changed",
        "GitHub variable identity changed. Refresh the managed configuration.",
        409,
      );
    if (!result)
      await this.configurationInventory(
        repository,
        scope,
        SECRET_ENTRY_KIND.VARIABLE,
        1,
      );
    return result;
  }
  private async write(
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: object,
  ): Promise<SecretWriteResult> {
    if (!this.credential.writable)
      return { status: "rejected", reason: "credential_read_only" };
    try {
      const response = await this.response(path, method, body);
      if (
        response.status === 204 ||
        (["POST", "PUT"].includes(method) && response.status === 201)
      )
        return { status: "accepted", reason: null };
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      )
        return {
          status: "rejected",
          reason: response.rateLimited ? "rate_limited" : "provider_rejected",
        };
      return { status: "indeterminate", reason: "provider_result_uncertain" };
    } catch {
      return { status: "indeterminate", reason: "provider_result_uncertain" };
    }
  }
  put(
    repository: string,
    environment: string | null,
    name: string,
    keyId: string,
    encryptedValue: string,
  ) {
    return this.write(this.namedPath(repository, environment, name), "PUT", {
      key_id: keyId,
      encrypted_value: encryptedValue,
    });
  }
  remove(repository: string, environment: string | null, name: string) {
    return this.write(this.namedPath(repository, environment, name), "DELETE");
  }
  createVariable(
    repository: string,
    environment: string | null,
    name: string,
    value: string,
  ) {
    return this.write(
      this.variableCollectionPath(repository, environment),
      "POST",
      {
        name: this.variableName(name),
        value: this.variableValue(value),
      },
    );
  }
  updateVariable(
    repository: string,
    environment: string | null,
    name: string,
    value: string,
  ) {
    const canonical = this.variableName(name);
    return this.write(
      this.variableCollectionPath(repository, environment) +
        "/" +
        encodeURIComponent(canonical),
      "PATCH",
      { name: canonical, value: this.variableValue(value) },
    );
  }
  removeVariable(
    repository: string,
    environment: string | null,
    name: string,
  ) {
    return this.write(
      this.variableCollectionPath(repository, environment) +
        "/" +
        encodeURIComponent(this.variableName(name)),
      "DELETE",
    );
  }
  private variableCollectionPath(
    repository: string,
    environment: string | null,
  ) {
    return this.inventoryPath(
      repository,
      environment === null
        ? { kind: "repository" }
        : { kind: "environment", name: environment },
      SECRET_ENTRY_KIND.VARIABLE,
    );
  }
  private variableName(name: string) {
    const parsed = secretNameSchema.safeParse(name);
    if (!parsed.success || parsed.data !== name)
      throw new DomainError(
        "secret_scope_invalid",
        "Select a valid canonical GitHub variable name.",
        400,
      );
    return parsed.data;
  }
  private variableValue(value: string) {
    const parsed = secretVariableMetadataSchema.shape.value.safeParse(value);
    if (!parsed.success)
      throw new DomainError(
        "secret_input_invalid",
        "The GitHub variable value exceeds the supported UTF-8 limit.",
        400,
      );
    return parsed.data;
  }
  private namedPath(
    repository: string,
    environment: string | null,
    name: string,
  ) {
    const parsed = secretNameSchema.safeParse(name);
    if (!parsed.success || parsed.data !== name)
      throw new DomainError(
        "secret_scope_invalid",
        "Select a valid canonical GitHub secret name.",
        400,
      );
    return this.path(repository, environment) + "/" + encodeURIComponent(name);
  }
  private checkPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > SECRET_LIMITS.MAX_PAGE)
      throw new DomainError(
        "secret_page_invalid",
        "Select a page within the supported inventory limit.",
        400,
      );
  }
}
