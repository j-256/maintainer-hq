import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  HOOK_LIMITS,
  hookResultSchemas,
  type HookCommand,
  type HookResult,
} from "../shared/hooks";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { Env } from "./types";

const descriptorSchema = z
  .object({
    workspaceId: idSchema,
    name: z.string().trim().min(1).max(80),
    binding: z.string().regex(/^HOOKRELAY_[A-Z0-9_]{1,40}$/),
    providerId: idSchema,
    revision: z.number().int().positive(),
    token: z.string().regex(/^hkr_[A-Za-z0-9_-]{43}$/),
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
export type HookProvider = Descriptor & { fetcher: Fetcher; identity: string };
export const hookProviderActor = async (subject: string) =>
  "hq_" + (await credentialHash(subject));

function catalog(env: Env): Map<string, Descriptor> {
  try {
    if (
      !env.HOOKRELAY_CREDENTIALS ||
      env.HOOKRELAY_CREDENTIALS.length > HOOK_LIMITS.CATALOG_BYTES
    )
      return new Map();
    const entries = Object.entries(
      z
        .record(idSchema, descriptorSchema)
        .parse(JSON.parse(env.HOOKRELAY_CREDENTIALS)),
    );
    return entries.length <= HOOK_LIMITS.PROVIDERS
      ? new Map(entries)
      : new Map();
  } catch {
    return new Map();
  }
}
function binding(env: Env, name: string): Fetcher | null {
  const value = (env as unknown as Record<string, unknown>)[name] as
    | Fetcher
    | undefined;
  return value && typeof value.fetch === "function" ? value : null;
}
export function hookProviderReferences(env: Env, workspaceId: string) {
  return [...catalog(env)]
    .filter(([, value]) => value.workspaceId === workspaceId)
    .map(([id, value]) => ({
      id,
      name: value.name,
      available: Boolean(binding(env, value.binding)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function hookProvider(
  env: Env,
  workspaceId: string,
  reference: string,
): Promise<HookProvider> {
  const value = catalog(env).get(reference);
  const fetcher = value ? binding(env, value.binding) : null;
  if (!value || value.workspaceId !== workspaceId || !fetcher) {
    throw new DomainError(
      "hooks_not_configured",
      "The Hookrelay provider credential or private service binding is unavailable. Ask the deployment owner to restore it.",
      503,
    );
  }
  return {
    ...value,
    fetcher,
    identity: await credentialHash(JSON.stringify(value)),
  };
}

const providerMessages = {
  unauthorized: "The Hookrelay management credential is invalid or expired.",
  unconfigured: "Hookrelay has no valid management credential configuration.",
  forbidden: "The Hookrelay credential does not permit this operation.",
  not_found: "Hookrelay could not find this scoped resource or review.",
  conflict:
    "Hookrelay state changed or its review limit was reached. Refresh and review again.",
  expired:
    "The Hookrelay review expired. Inspect the resource and review again.",
  payload_unavailable:
    "Hookrelay no longer has the retained event needed for this retry.",
  metadata_invalid: "Hookrelay metadata could not be read safely.",
  validation:
    "Hookrelay does not support this request or the policy is invalid. Refresh the resource before reviewing again.",
  inactive:
    "Online routing is not enabled on this Hookrelay deployment. Its existing routing remains unchanged.",
  review_unavailable:
    "Hookrelay configuration changed or its pending review limit was reached. Refresh before reviewing again.",
} as const;
export class HookProviderError extends DomainError {
  constructor(readonly providerCode: string) {
    super(
      "hooks_provider_" + providerCode,
      providerMessages[providerCode as keyof typeof providerMessages] ??
        "Hookrelay could not complete the request. Reconcile any uncertain operation before acting again.",
      [
        "conflict",
        "expired",
        "payload_unavailable",
        "inactive",
        "validation",
        "review_unavailable",
      ].includes(providerCode)
        ? 409
        : 503,
    );
  }
}

export async function callHookProvider<K extends HookCommand>(
  provider: HookProvider,
  command: K,
  workspaceId: string,
  actorId: string,
  input: Record<string, unknown> = {},
): Promise<{ result: HookResult<K>; capabilities: ("read" | "retry")[] }> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DomainError(
          "hooks_provider_timeout",
          "Hookrelay did not respond before the deadline. Reconcile any uncertain operation before acting again.",
          503,
        ),
      );
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, HOOK_LIMITS.PROVIDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await provider.fetcher.fetch(
          "https://hookrelay.internal/admin/api/v1",
          {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + provider.token,
            },
            body: JSON.stringify({
              command,
              input: { ...input, workspaceId, actorId },
            }),
          },
        );
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        if (
          !response.body ||
          response.headers.get("content-type")?.split(";")[0]?.trim() !==
            "application/json"
        ) {
          void response.body?.cancel().catch(() => {});
          throw new HookProviderError("unavailable");
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > HOOK_LIMITS.RESPONSE_BYTES) {
            void reader.cancel().catch(() => {});
            throw new HookProviderError("metadata_invalid");
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const data: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (response.status !== 200) {
          const error = z
            .object({ error: z.object({ code: z.string().max(80) }) })
            .safeParse(data);
          const code =
            error.success &&
            Object.hasOwn(providerMessages, error.data.error.code)
              ? error.data.error.code
              : "unavailable";
          throw new HookProviderError(code);
        }
        const envelope = z
          .object({
            version: z.number().int(),
            capabilities: z
              .array(z.enum(["read", "retry"]))
              .min(1)
              .max(2),
            result: z.unknown(),
          })
          .strict()
          .parse(data);
        if (envelope.version !== 1)
          throw new DomainError(
            "hooks_provider_version",
            "This Hookrelay management version is not supported. Update the compatible provider and HQ contract together.",
            503,
          );
        if (!envelope.capabilities.includes("read"))
          throw new HookProviderError("forbidden");
        const result = hookResultSchemas[command].parse(
          envelope.result,
        ) as HookResult<K>;
        return { result, capabilities: envelope.capabilities };
      })(),
    ]);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new HookProviderError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}
