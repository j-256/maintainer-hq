import { afterEach, describe, expect, it, vi } from "vitest";
import { HOOK_LIMITS } from "../shared/hooks";
import {
  callHookProvider,
  hookProvider,
  hookProviderReferences,
  type HookProvider,
} from "../worker/hook-client";
import type { Env } from "../worker/types";

const PRIVATE = "private-provider-response";
const token = "hkr_" + "a".repeat(43);
const descriptor = {
  workspaceId: "alpha",
  name: "Synthetic",
  binding: "HOOKRELAY_TEST",
  providerId: "test",
  revision: 1,
  token,
};
const subscriptions = {
  items: [],
  nextCursor: null,
  disappeared: 0,
  observedAt: new Date().toISOString(),
};
const success = (result: unknown = subscriptions) =>
  Response.json({ version: 1, capabilities: ["read"], result });
function provider(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  return {
    ...descriptor,
    fetcher: { fetch },
    identity: "a".repeat(64),
  } as unknown as HookProvider;
}
const call = (value: HookProvider) =>
  callHookProvider(value, "subscriptions", "alpha", "hq_actor");
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Hookrelay private client boundary", () => {
  it("only resolves deployment-owned workspace-scoped bindings and returns no credentials", async () => {
    const env = {
      HOOKRELAY_CREDENTIALS: JSON.stringify({ primary: descriptor }),
      HOOKRELAY_TEST: { fetch: async () => success() },
    } as unknown as Env;
    expect(hookProviderReferences(env, "alpha")).toEqual([
      { id: "primary", name: "Synthetic", available: true },
    ]);
    expect(hookProviderReferences(env, "beta")).toEqual([]);
    await expect(hookProvider(env, "beta", "primary")).rejects.toMatchObject({
      code: "hooks_not_configured",
    });
    const resolved = await hookProvider(env, "alpha", "primary");
    expect(resolved.identity).toMatch(/^[a-f0-9]{64}$/);
    for (const catalog of [
      "not JSON",
      JSON.stringify({
        primary: { ...descriptor, url: "https://unsafe.example" },
      }),
      " ".repeat(HOOK_LIMITS.CATALOG_BYTES + 1),
    ]) {
      expect(
        hookProviderReferences(
          { ...env, HOOKRELAY_CREDENTIALS: catalog },
          "alpha",
        ),
      ).toEqual([]);
    }
  });

  it("creates fresh authorization headers and never follows a redirect", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://hookrelay.internal/admin/api/v1");
      expect(init.redirect).toBe("manual");
      expect(Object.fromEntries(new Headers(init.headers))).toEqual({
        authorization: "Bearer " + token,
        "content-type": "application/json",
      });
      expect(JSON.parse(init.body as string)).toEqual({
        command: "subscriptions",
        input: { workspaceId: "alpha", actorId: "hq_actor" },
      });
      return new Response(PRIVATE, {
        status: 302,
        headers: { location: "https://unsafe.example" },
      });
    });
    await expect(call(provider(fetch))).rejects.toMatchObject({
      code: "hooks_provider_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported versions, malformed and private fields, and missing read authority", async () => {
    for (const response of [
      success({ ...subscriptions, bearerRoute: PRIVATE }),
      Response.json({
        version: 1,
        capabilities: ["read"],
        result: subscriptions,
        secret: PRIVATE,
      }),
      Response.json({
        version: 1,
        capabilities: ["retry"],
        result: subscriptions,
      }),
      new Response(PRIVATE, {
        headers: { "content-type": "application/json" },
      }),
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
      Response.json(
        { error: { code: PRIVATE, message: PRIVATE } },
        { status: 500 },
      ),
    ]) {
      const error = await call(provider(async () => response)).catch(
        (value: unknown) => value,
      );
      expect(error).toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(PRIVATE);
    }
    await expect(
      call(
        provider(async () =>
          Response.json({
            version: 2,
            capabilities: ["read"],
            result: subscriptions,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "hooks_provider_version" });
    await expect(
      call(
        provider(async () =>
          Response.json(
            { error: { code: "unauthorized", message: PRIVATE } },
            { status: 401 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "hooks_provider_unauthorized" });
  });

  it("caps actual streamed bytes even when content-length is absent or inaccurate", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HOOK_LIMITS.RESPONSE_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(
      call(
        provider(
          async () =>
            new Response(stream, {
              headers: {
                "content-type": "application/json",
                "content-length": "1",
              },
            }),
        ),
      ),
    ).rejects.toMatchObject({ code: "hooks_provider_metadata_invalid" });
    expect(canceled).toBe(true);
  });

  it("bounds both response headers and body stalls without replaying requests", async () => {
    vi.useFakeTimers();
    const stalled = vi.fn(() => new Promise<Response>(() => {}));
    const headers = expect(call(provider(stalled))).rejects.toMatchObject({
      code: "hooks_provider_timeout",
    });
    await vi.advanceTimersByTimeAsync(HOOK_LIMITS.PROVIDER_TIMEOUT_MS + 1);
    await headers;
    expect(stalled).toHaveBeenCalledTimes(1);
    let canceled = false;
    const body = call(
      provider(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const outcome = expect(body).rejects.toMatchObject({
      code: "hooks_provider_timeout",
    });
    await vi.advanceTimersByTimeAsync(HOOK_LIMITS.PROVIDER_TIMEOUT_MS + 1);
    await outcome;
    expect(canceled).toBe(true);
  });
});
