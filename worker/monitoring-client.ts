import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  MONITOR_CAPABILITIES,
  MONITOR_LIMITS,
  monitorIdentity,
  monitorResultSchemas,
  type MonitorCommand,
  type MonitorResult,
} from "../shared/monitoring";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { Env } from "./types";

const descriptorSchema = z
  .object({
    workspaceId: idSchema,
    name: z.string().trim().min(1).max(80),
    binding: z.string().regex(/^MONITORING_[A-Z0-9_]{1,40}$/),
    providerId: monitorIdentity,
    revision: z.number().int().positive(),
    token: z.string().regex(/^epm_[A-Za-z0-9_-]{43}$/),
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
export type MonitorProvider = Descriptor & {
  fetcher: Fetcher;
  identity: string;
};
export const monitorActor = async (subject: string) =>
  "hq_" + (await credentialHash(subject));
function catalog(env: Env): Map<string, Descriptor> {
  try {
    if (
      !env.MONITORING_CREDENTIALS ||
      env.MONITORING_CREDENTIALS.length > MONITOR_LIMITS.CATALOG_BYTES
    )
      return new Map();
    const entries = Object.entries(
      z
        .record(idSchema, descriptorSchema)
        .parse(JSON.parse(env.MONITORING_CREDENTIALS)),
    );
    return entries.length <= MONITOR_LIMITS.PROVIDERS
      ? new Map(entries)
      : new Map();
  } catch {
    return new Map();
  }
}
function binding(env: Env, name: string): Fetcher | null {
  const value = (env as unknown as Record<string, unknown>)[name] as
    Fetcher | undefined;
  return value && typeof value.fetch === "function" ? value : null;
}
export function monitorProviderReferences(env: Env, workspaceId: string) {
  return [...catalog(env)]
    .filter(([, value]) => value.workspaceId === workspaceId)
    .map(([id, value]) => ({
      id,
      name: value.name,
      available: Boolean(binding(env, value.binding)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function monitorProvider(
  env: Env,
  workspaceId: string,
  reference: string,
): Promise<MonitorProvider> {
  const value = catalog(env).get(reference);
  const fetcher = value ? binding(env, value.binding) : null;
  if (!value || value.workspaceId !== workspaceId || !fetcher)
    throw new DomainError(
      "monitoring_not_configured",
      "The monitoring credential or private service binding is unavailable. Ask the deployment owner to restore it.",
      503,
    );
  return {
    ...value,
    fetcher,
    identity: await credentialHash(JSON.stringify(value)),
  };
}
const messages = {
  unauthorized: "The monitoring management credential is invalid or expired.",
  forbidden: "The monitoring credential does not allow this operation.",
  not_found:
    "The target, incident, or scoped operation was not found. It may have been removed or its receipt may have expired.",
  conflict:
    "Monitoring state changed or the review expired. Keep your draft and reload saved state before preparing another review.",
  validation:
    "The provider rejected this configuration or action. Check response expectations, duplicate URLs, snooze time, and schedule capacity; your draft is still here.",
  capacity:
    "The provider's review or receipt capacity is full. Existing recovery receipts have been preserved.",
  too_large:
    "The monitoring document exceeds the provider's size limit. Your draft is still here.",
  unconfigured:
    "The provider has no valid management credential configuration.",
  unavailable:
    "The monitoring provider could not complete the request. Reconcile any uncertain operation before acting again.",
  timeout:
    "The monitoring provider did not respond before the deadline. Reconcile any uncertain operation before acting again.",
  metadata_invalid:
    "The monitoring response does not match the supported contract. No provider state can be inferred from it.",
} as const;
export class MonitorProviderError extends DomainError {
  constructor(readonly providerCode: keyof typeof messages) {
    super(
      "monitoring_provider_" + providerCode,
      messages[providerCode],
      providerCode === "not_found"
        ? 404
        : ["conflict", "capacity"].includes(providerCode)
          ? 409
          : ["validation", "too_large"].includes(providerCode)
            ? 400
            : 503,
    );
  }
}
export async function callMonitorProvider<K extends MonitorCommand>(
  provider: MonitorProvider,
  command: K,
  workspaceId: string,
  input: Record<string, unknown> = {},
): Promise<{
  result: MonitorResult<K>;
  capabilities: (typeof MONITOR_CAPABILITIES)[number][];
}> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MonitorProviderError("timeout"));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, MONITOR_LIMITS.PROVIDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await provider.fetcher.fetch(
          "https://monitoring.internal/admin/api/v1",
          {
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + provider.token,
            },
            body: JSON.stringify({
              version: 1,
              command,
              input: { ...input, workspaceId },
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
          throw new MonitorProviderError("unavailable");
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MONITOR_LIMITS.RESPONSE_BYTES) {
            void reader.cancel().catch(() => {});
            throw new MonitorProviderError("metadata_invalid");
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
          const parsed = z
            .object({ error: z.object({ code: z.string().max(80) }) })
            .safeParse(data);
          throw new MonitorProviderError(
            parsed.success && Object.hasOwn(messages, parsed.data.error.code)
              ? (parsed.data.error.code as keyof typeof messages)
              : "unavailable",
          );
        }
        const envelope = z
          .object({
            version: z.literal(1),
            capabilities: z
              .array(z.enum(MONITOR_CAPABILITIES))
              .min(1)
              .max(MONITOR_CAPABILITIES.length),
            result: z.unknown(),
          })
          .strict()
          .safeParse(data);
        if (!envelope.success)
          throw new MonitorProviderError("metadata_invalid");
        if (!envelope.data.capabilities.includes("read"))
          throw new MonitorProviderError("forbidden");
        const parsed = monitorResultSchemas[command].safeParse(
          envelope.data.result,
        );
        if (!parsed.success) throw new MonitorProviderError("metadata_invalid");
        return {
          result: parsed.data as MonitorResult<K>,
          capabilities: envelope.data.capabilities,
        };
      })(),
    ]);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new MonitorProviderError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}
