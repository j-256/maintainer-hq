import { describe, expect, it, vi } from "vitest";
import { upstreamDependencyDocument } from "../shared/dependency-upstream";
import { DEPENDENCY_LIMITS } from "../shared/dependency-policy";

describe("Credential-free bounded upstream reads", () => {
  it("uses only the fixed public registry and rejects arbitrary paths", async () => {
    const fetcher = vi.fn(async (target, init) => {
      expect(String(target)).toBe(
        "https://registry.npmjs.org/%40example%2Frunner/latest",
      );
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      return Response.json({ name: "@example/runner", version: "1.0.0" });
    });
    await upstreamDependencyDocument("@example/runner", fetcher);
    await expect(
      upstreamDependencyDocument("https://private.invalid/path", fetcher),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds stalled fetches and bodies even when a transport ignores abort", async () => {
    const stalledFetch = vi.fn(() => new Promise<Response>(() => {}));
    await expect(
      upstreamDependencyDocument("runner", stalledFetch, 10),
    ).rejects.toThrow(/timed out/);
    const stalledBody = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        ),
    );
    await expect(
      upstreamDependencyDocument("runner", stalledBody, 10),
    ).rejects.toThrow(/timed out/);
  });
  it("rejects oversized bodies without leaking their contents", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("x".repeat(DEPENDENCY_LIMITS.UPSTREAM_BYTES + 1)),
    );
    await expect(upstreamDependencyDocument("runner", fetcher)).rejects.toThrow(
      /limit/,
    );
  });
});
