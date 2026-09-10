import { SECRET_LIMITS } from "../shared/secrets";
import { DomainError } from "./errors";
import type { Env } from "./types";

export async function reapSecretInputs(env: Env, now = Date.now()) {
  await env.HQ_DB.prepare(
    `DELETE FROM secret_payloads WHERE (workspace_id,review_id) IN
    (SELECT workspace_id,id FROM secret_reviews WHERE input_expires_at<=? AND EXISTS
      (SELECT 1 FROM secret_payloads p WHERE p.workspace_id=secret_reviews.workspace_id AND p.review_id=secret_reviews.id)
      ORDER BY input_expires_at,workspace_id,id LIMIT ?)`,
  )
    .bind(new Date(now).toISOString(), SECRET_LIMITS.STAGED_WORKSPACE)
    .run();
}

export function privateInputError(): never {
  throw new DomainError(
    "secret_input_invalid",
    "Private input was not accepted. Inspect the review before retrying; do not send a value through ordinary commands.",
    400,
  );
}

export async function readSecretInput(
  request: Request,
  bounds = {
    bytes: SECRET_LIMITS.UPLOAD_BYTES,
    timeoutMs: SECRET_LIMITS.INPUT_READ_MS,
  },
): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
      "application/json" ||
    request.headers.has("Content-Encoding")
  )
    privateInputError();
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > bounds.bytes)
  )
    privateInputError();
  const reader = request.body?.getReader();
  if (!reader) privateInputError();
  const chunks: Uint8Array[] = [];
  let bytes: Uint8Array | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let size = 0;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Private input deadline")),
      bounds.timeoutMs,
    );
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > bounds.bytes) privateInputError();
      chunks.push(value);
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return privateInputError();
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    for (const chunk of chunks) chunk.fill(0);
    bytes?.fill(0);
  }
}
