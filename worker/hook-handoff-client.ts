import { z } from "zod";
import { HANDOFF_PRIVATE_BYTES } from "../shared/hook-handoff";
import { HOOK_LIMITS } from "../shared/hooks";
import { HookProviderError, type HookProvider } from "./hook-client";

export async function callPrivateHandoff<T>(provider: HookProvider, action: "adopt_plan" | "reveal" | "export", workspaceId: string, actorId: string, input: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const body = JSON.stringify({ action, input: { ...input, workspaceId, actorId } });
  if (new TextEncoder().encode(body).length > HANDOFF_PRIVATE_BYTES) throw new HookProviderError("validation");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new HookProviderError("unavailable")); }, HOOK_LIMITS.PROVIDER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await provider.fetcher.fetch("https://hookrelay.internal/admin/api/v1/private/github-handoff", { method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + provider.token }, body });
      if (controller.signal.aborted || !response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || response.headers.get("cache-control") !== "no-store") {
        void response.body?.cancel().catch(() => {}); throw new HookProviderError("unavailable");
      }
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > HANDOFF_PRIVATE_BYTES) { void reader.cancel().catch(() => {}); throw new HookProviderError("metadata_invalid"); } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (response.status !== 200) throw new HookProviderError("unavailable");
      return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    })()]);
  } catch (error) { if (error instanceof HookProviderError) throw error; throw new HookProviderError("unavailable"); }
  finally { clearTimeout(timer); }
}
