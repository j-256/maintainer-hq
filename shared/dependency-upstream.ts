import {
  DEPENDENCY_LIMITS as LIMITS,
  dependencyPackageSchema,
} from "./dependency-policy";

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("Upstream dependency read timed out"));
    signal.addEventListener("abort", stop, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
  });
}
export async function upstreamDependencyDocument(
  name: string,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = LIMITS.UPSTREAM_MS,
): Promise<unknown> {
  dependencyPackageSchema.parse(name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = controller.signal;
  try {
    const response = await bounded(
      fetcher(
        "https://registry.npmjs.org/" + encodeURIComponent(name) + "/latest",
        {
          headers: { Accept: "application/json" },
          redirect: "error",
          signal,
        },
      ),
      signal,
    );
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("Content-Length")) > LIMITS.UPSTREAM_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Upstream dependency read unavailable or oversized");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await bounded(reader.read(), signal);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > LIMITS.UPSTREAM_BYTES)
          throw new Error("Upstream dependency response exceeded its limit");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
