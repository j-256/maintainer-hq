import { z } from "zod";
import { HOOK_LIFECYCLE_PRIVATE_BYTES, lifecycleSelectionInput, lifecycleReviewSchema, lifecyclePrivateSchema, lifecycleInputReceiptSchema } from "./hook-lifecycle";

export class LifecycleInputError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
export async function supplyLifecycleInput(input: { selection: unknown; review: (selection: z.infer<typeof lifecycleSelectionInput>) => Promise<unknown>; read: () => Promise<Uint8Array>; send: (path: string, init: RequestInit) => Promise<Response> }) {
  const selected = lifecycleSelectionInput.safeParse(input.selection);
  if (!selected.success) throw new LifecycleInputError("Select the exact lifecycle workspace, plan and fingerprint before reading private input.");
  const selection = selected.data;
  const parsed = lifecycleReviewSchema.safeParse(await input.review(selection));
  if (!parsed.success || parsed.data.id !== selection.planId || parsed.data.workspaceId !== selection.workspaceId || parsed.data.fingerprint !== selection.fingerprint || !parsed.data.actorMatches) throw new LifecycleInputError("Lifecycle authority changed or belongs to another actor. No private input was read.");
  const review = parsed.data;
  if (review.privateInputReceived || review.operation || review.state === "applied") return { planId: review.id, state: review.state, privateInputReceived: review.privateInputReceived, submitted: false };
  if (!review.canSupplyPrivate || !review.privateInputRequired || review.state !== "ready" || Date.parse(review.expiresAt) <= Date.now()) throw new LifecycleInputError("The review expired or no longer accepts private input. No private input was read.");
  const value = await input.read();
  try {
    if (!value.byteLength || value.byteLength > HOOK_LIFECYCLE_PRIVATE_BYTES) throw new LifecycleInputError("Supply a bounded destination JSON document through a private file or stdin.");
    let body: string;
    try { body = JSON.stringify(lifecyclePrivateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)))); }
    catch { throw new LifecycleInputError("Use the documented private destination JSON document. Nothing was submitted."); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const deadline = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Private input deadline")), { once: true }));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([input.send("/api/hooks/lifecycle-input/" + selection.planId, { method: "POST", redirect: "error", cache: "no-store", headers: { "Content-Type": "application/json", "X-Workspace-Id": selection.workspaceId, "If-Match": selection.fingerprint }, body, signal: controller.signal }), deadline]);
      if (!response.ok || response.headers.get("cache-control") !== "no-store" || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await Promise.race([reader.read(), deadline]); if (done) break; size += value.byteLength; if (size > HOOK_LIFECYCLE_PRIVATE_BYTES) throw new Error(); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = lifecycleInputReceiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (result.planId !== selection.planId || !result.privateInputReceived) throw new Error();
      return result;
    } catch { throw new LifecycleInputError("Destination input acceptance is uncertain or was refused. Reconcile this same review before another input; consumed input never compares a new value.", true); }
    finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
  } finally { value.fill(0); }
}
