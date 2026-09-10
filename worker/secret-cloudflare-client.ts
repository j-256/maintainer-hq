import { z } from "zod";
import {
  CLOUDFLARE_SECRET_LIMITS as LIMITS,
  CLOUDFLARE_SECRETS_API,
  CLOUDFLARE_SECRET_TYPE,
  CLOUDFLARE_VARIABLE_TYPE,
  cloudflareBindingMetadataSchema,
  cloudflareDeploymentSchema,
  cloudflareSecretNameSchema,
  cloudflareSettingsBindingSchema,
  cloudflareVariableBindingSchema,
  cloudflareWorkerMetadataSchema,
  type CloudflareActivation,
} from "../shared/cloudflare-secrets";
import {
  cloudflareAccountIdSchema,
  cloudflareWorkerNameSchema,
} from "../shared/provider-credentials";
import type { SecretMetadata, SecretWriteResult } from "../shared/secrets";
import { DomainError } from "./errors";

export type CloudflareSecretCredential = {
  accountId: string;
  workerNames: string[];
  token: string;
  writable: boolean;
};
const envelopeSchema = z.object({ success: z.boolean(), result: z.unknown() });
const secretBindingListSchema = z
  .array(cloudflareBindingMetadataSchema)
  .max(LIMITS.BINDINGS)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
  );
const settingsBindingListSchema = z
  .array(cloudflareSettingsBindingSchema)
  .max(LIMITS.BINDINGS)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
  );

function invalid(): never {
  throw new DomainError(
    "secret_provider_invalid",
    "Cloudflare returned unsupported or inconsistent metadata. No complete inventory or safe mutation preflight was accepted.",
    503,
  );
}
function changed(): never {
  throw new DomainError(
    "secret_identity_changed",
    "The Worker identity or serving deployment changed during this read. Inspect its deployment and prepare a fresh review.",
    409,
  );
}

export class SecretCloudflareClient {
  constructor(
    readonly credential: CloudflareSecretCredential,
    readonly request: typeof fetch = fetch,
  ) {
    if (
      !cloudflareAccountIdSchema.safeParse(credential.accountId).success ||
      !/^[\x21-\x7e]{1,2048}$/.test(credential.token)
    ) {
      throw new DomainError(
        "secret_provider_unavailable",
        "The scoped Cloudflare credential is unavailable.",
        503,
      );
    }
  }
  private path(worker: string, metadata = false) {
    if (
      !cloudflareWorkerNameSchema.safeParse(worker).success ||
      !this.credential.workerNames.includes(worker)
    ) {
      throw new DomainError(
        "secret_worker_denied",
        "This Worker is outside the Cloudflare credential's approved account and Worker scope.",
        403,
      );
    }
    return (
      "/accounts/" +
      this.credential.accountId +
      "/workers/" +
      (metadata ? "workers/" : "scripts/") +
      encodeURIComponent(worker)
    );
  }
  private async response(path: string, method = "GET", body?: object) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.REQUEST_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Provider request deadline")),
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        this.request(CLOUDFLARE_SECRETS_API + path, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: "Bearer " + this.credential.token,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        aborted,
      ]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, envelope: null };
      }
      if (
        response.headers.get("Content-Type")?.split(";")[0]?.trim() !==
        "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Provider content type");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing provider body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > LIMITS.RESPONSE_BYTES)
            throw new Error("Provider response too large");
          chunks.push(next.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = envelopeSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      return {
        status: response.status,
        envelope: parsed.success ? parsed.data : null,
      };
    } catch {
      throw new DomainError(
        "secret_provider_interrupted",
        "The Cloudflare request was interrupted or returned an unreadable response. Submitted writes require receipt review; no retry was made.",
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.response(path);
    if (response.status !== 200) {
      const code =
        response.status === 429
          ? "secret_rate_limited"
          : response.status === 401 || response.status === 403
            ? "secret_permission_denied"
            : response.status === 404
              ? "secret_resource_unavailable"
              : "secret_provider_failed";
      throw new DomainError(
        code,
        "Cloudflare did not permit or complete this metadata read. Unavailable metadata is not an empty inventory.",
        503,
      );
    }
    if (!response.envelope?.success) invalid();
    const parsed = schema.safeParse(response.envelope.result);
    if (!parsed.success) invalid();
    return parsed.data;
  }
  async worker(name: string) {
    const worker = await this.read(
      this.path(name, true),
      cloudflareWorkerMetadataSchema,
    );
    if (worker.name !== name) changed();
    return worker;
  }
  private async deployment(name: string) {
    const result = await this.read(
      this.path(name) + "/deployments",
      z.object({
        deployments: z
          .array(cloudflareDeploymentSchema)
          .min(1)
          .max(LIMITS.DEPLOYMENTS),
      }),
    );
    return result.deployments[0]!;
  }
  private async configurationState(
    name: string,
    source: "secrets" | "settings",
    mutation = false,
  ) {
    const worker = await this.worker(name);
    const deployment = await this.deployment(name);
    const secrets =
      mutation || source === "secrets"
        ? await this.read(
            this.path(name) + "/secrets",
            secretBindingListSchema,
          )
        : [];
    const settings =
      mutation || source === "settings"
        ? (
            await this.read(
              this.path(name) + "/settings",
              z.object({ bindings: settingsBindingListSchema }),
            )
          ).bindings
        : [];
    const bindings = source === "settings" || mutation ? settings : secrets;
    const after = await this.deployment(name);
    if (
      JSON.stringify(after) !== JSON.stringify(deployment) ||
      (await this.worker(name)).id !== worker.id
    )
      changed();
    const textNames = (items: { name: string; type: string }[]) =>
      items
        .filter((item) => item.type === CLOUDFLARE_SECRET_TYPE)
        .map((item) => item.name)
        .sort();
    if (
      mutation &&
      JSON.stringify(textNames(bindings)) !== JSON.stringify(textNames(secrets))
    )
      invalid();
    const single =
      deployment.versions.length === 1 &&
      deployment.versions[0]!.percentage === 100;
    if (mutation && !single) {
      throw new DomainError(
        "secret_worker_deployment_unsupported",
        "Reviewed secret changes require one fully serving Worker version. Resolve the gradual deployment before preparing a secret write.",
        409,
      );
    }
    const revision = single
      ? JSON.stringify([deployment.id, deployment.versions[0]!.version_id])
      : null;
    const activation: CloudflareActivation | null = single
      ? {
          accountId: this.credential.accountId,
          workerName: name,
          deploymentId: deployment.id,
          versionId: deployment.versions[0]!.version_id,
        }
      : null;
    return {
      resourceIdentity: this.credential.accountId + "/" + worker.id,
      revision,
      activation,
      bindings,
      secrets,
    };
  }
  async state(name: string, mutation = false) {
    const state = await this.configurationState(name, "secrets", mutation);
    const items: SecretMetadata[] = state.secrets
      .filter((item) => item.type === CLOUDFLARE_SECRET_TYPE)
      .map((item) => ({
        name: item.name,
        createdAt: null,
        updatedAt: null,
        version: state.revision,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      resourceIdentity: state.resourceIdentity,
      revision: state.revision,
      activation: state.activation,
      items,
      bindings: state.bindings.map((binding) => ({
        name: binding.name,
        type: binding.type,
      })),
      excludedBindings: state.secrets.length - items.length,
    };
  }
  async variables(name: string) {
    const state = await this.configurationState(name, "settings");
    const items = state.bindings
      .flatMap((binding) => {
        const parsed = cloudflareVariableBindingSchema.safeParse(binding);
        if (!parsed.success) return [];
        return [
          parsed.data.type === CLOUDFLARE_VARIABLE_TYPE.TEXT
            ? {
                name: parsed.data.name,
                value: parsed.data.text,
                valueFormat: "text" as const,
              }
            : {
                name: parsed.data.name,
                value: JSON.stringify(parsed.data.json),
                valueFormat: "json" as const,
              },
        ];
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      resourceIdentity: state.resourceIdentity,
      revision: state.revision,
      activation: state.activation,
      items,
      excludedBindings: state.bindings.length - items.length,
    };
  }
  private async write(
    name: string,
    method: "PUT" | "DELETE",
    secretName: string,
    text?: string,
  ): Promise<SecretWriteResult> {
    if (!this.credential.writable)
      return { status: "rejected", reason: "credential_read_only" };
    const parsed = cloudflareSecretNameSchema.safeParse(secretName);
    if (!parsed.success)
      throw new DomainError(
        "secret_name_invalid",
        "Select an exact supported Cloudflare binding name.",
        400,
      );
    const path =
      this.path(name) +
      "/secrets" +
      (method === "DELETE" ? "/" + encodeURIComponent(secretName) : "");
    if (
      method === "PUT" &&
      (text === undefined ||
        new TextEncoder().encode(text).byteLength > LIMITS.VALUE_BYTES)
    ) {
      throw new DomainError(
        "secret_input_invalid",
        "Cloudflare input exceeds the bounded UTF-8 value limit.",
        400,
      );
    }
    try {
      const response = await this.response(
        path,
        method,
        method === "PUT"
          ? { name: secretName, text, type: CLOUDFLARE_SECRET_TYPE }
          : undefined,
      );
      if (response.status === 429)
        return { status: "rejected", reason: "rate_limited" };
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      )
        return { status: "rejected", reason: "provider_rejected" };
      const result = cloudflareBindingMetadataSchema.safeParse(
        response.envelope?.result,
      );
      const accepted =
        response.envelope?.success &&
        (method === "DELETE"
          ? response.status === 200 && response.envelope.result === null
          : [200, 201].includes(response.status) &&
            result.success &&
            result.data.name === secretName &&
            result.data.type === CLOUDFLARE_SECRET_TYPE);
      return accepted
        ? { status: "accepted", reason: null }
        : { status: "indeterminate", reason: "provider_result_uncertain" };
    } catch {
      return { status: "indeterminate", reason: "provider_result_uncertain" };
    }
  }
  put(worker: string, name: string, value: string) {
    return this.write(worker, "PUT", name, value);
  }
  remove(worker: string, name: string) {
    return this.write(worker, "DELETE", name);
  }
}
