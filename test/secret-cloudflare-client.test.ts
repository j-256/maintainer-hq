import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretCloudflareClient } from "../worker/secret-cloudflare-client";
import { CLOUDFLARE_SECRET_LIMITS } from "../shared/cloudflare-secrets";

const ACCOUNT = "a".repeat(32);
const WORKER_ID = "b".repeat(32);
const DEPLOYMENT = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const DIFFERENT = "33333333-3333-4333-8333-333333333333";
const TOKEN = "synthetic-cf-provider-token-canary";
const VALUE = "synthetic-private-value \u03bb\n";
const WORKER = "selected-worker";
const credential = {
  accountId: ACCOUNT,
  workerNames: [WORKER],
  token: TOKEN,
  writable: true,
};
const json = (result: unknown, status = 200) =>
  Response.json({ success: true, result, errors: [] }, { status });
function fixture(
  options: {
    split?: boolean;
    changed?: "identity" | "deployment";
    invalid?: boolean;
    inconsistent?: boolean;
  } = {},
) {
  let identities = 0;
  let deployments = 0;
  const paths: string[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + TOKEN,
    );
    paths.push(url.pathname);
    if (
      url.pathname ===
      "/client/v4/accounts/" + ACCOUNT + "/workers/workers/" + WORKER
    ) {
      identities++;
      return json({
        id:
          options.changed === "identity" && identities > 1
            ? "c".repeat(32)
            : WORKER_ID,
        name: options.invalid ? "unselected" : WORKER,
        token: TOKEN,
      });
    }
    if (url.pathname.endsWith("/deployments")) {
      deployments++;
      return json({
        deployments: [
          {
            id:
              options.changed === "deployment" && deployments > 1
                ? DIFFERENT
                : DEPLOYMENT,
            strategy: "percentage",
            versions: [
              { version_id: VERSION, percentage: options.split ? 50 : 100 },
              ...(options.split
                ? [{ version_id: DIFFERENT, percentage: 50 }]
                : []),
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/secrets"))
      return json([
        { name: "lowercase", type: "secret_text", text: VALUE },
        { name: "Lowercase", type: "secret_text" },
        { name: "key", type: "secret_key", text: VALUE },
      ]);
    if (url.pathname.endsWith("/settings"))
      return json({
        bindings: [
          { name: "lowercase", type: "secret_text", text: VALUE },
          ...(!options.inconsistent
            ? [{ name: "Lowercase", type: "secret_text" }]
            : []),
          { name: "ordinary", type: "plain_text", text: VALUE },
          {
            name: "jsonConfig",
            type: "json",
            json: { enabled: true, retries: 2 },
          },
          { name: "cache", type: "kv_namespace" },
        ],
      });
    throw new Error("Unexpected provider path");
  });
  return {
    client: new SecretCloudflareClient(credential, request),
    request,
    paths,
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare secret client", () => {
  it("rejects inconsistent text-secret inventories even when the deployment token is unchanged", async () => {
    const { client } = fixture({ inconsistent: true });
    await expect(client.state(WORKER, true)).rejects.toMatchObject({
      code: "secret_provider_invalid",
    });
  });
  it("reads one exact Worker with stable deployment evidence and strips all value-like fields", async () => {
    const { client, paths } = fixture();
    const state = await client.state(WORKER, true);
    expect(paths).toEqual([
      "/client/v4/accounts/" + ACCOUNT + "/workers/workers/" + WORKER,
      "/client/v4/accounts/" +
        ACCOUNT +
        "/workers/scripts/" +
        WORKER +
        "/deployments",
      "/client/v4/accounts/" +
        ACCOUNT +
        "/workers/scripts/" +
        WORKER +
        "/secrets",
      "/client/v4/accounts/" +
        ACCOUNT +
        "/workers/scripts/" +
        WORKER +
        "/settings",
      "/client/v4/accounts/" +
        ACCOUNT +
        "/workers/scripts/" +
        WORKER +
        "/deployments",
      "/client/v4/accounts/" + ACCOUNT + "/workers/workers/" + WORKER,
    ]);
    expect(state.resourceIdentity).toBe(ACCOUNT + "/" + WORKER_ID);
    expect(state.items.map((item) => item.name)).toEqual([
      "Lowercase",
      "lowercase",
    ]);
    expect(
      state.items.every(
        (item) => item.createdAt === null && item.updatedAt === null,
      ),
    ).toBe(true);
    expect(state.activation).toEqual({
      accountId: ACCOUNT,
      workerName: WORKER,
      deploymentId: DEPLOYMENT,
      versionId: VERSION,
    });
    expect(state.revision).toBe(JSON.stringify([DEPLOYMENT, VERSION]));
    expect(state.excludedBindings).toBe(1);
    expect(JSON.stringify(state)).not.toContain(VALUE);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(state.bindings.find((item) => item.name === "ordinary")).toEqual({
      name: "ordinary",
      type: "plain_text",
    });
  });
  it("reads bounded plaintext and JSON variables from settings", async () => {
    const { client, paths } = fixture();
    const state = await client.variables(WORKER);
    expect(state.items).toEqual([
      {
        name: "jsonConfig",
        value: '{"enabled":true,"retries":2}',
        valueFormat: "json",
      },
      { name: "ordinary", value: VALUE, valueFormat: "text" },
    ]);
    expect(state.excludedBindings).toBe(3);
    expect(paths.some((path) => path.endsWith("/settings"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/secrets"))).toBe(false);
    expect(state.items.map((item) => item.value)).toContain(VALUE);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });
  it("never discovers outside the selected account/Worker scope or follows an injected path", async () => {
    const { client, request } = fixture();
    for (const name of [
      "unselected",
      "../selected-worker",
      "Selected-worker",
      "https://untrusted.example",
    ])
      await expect(client.state(name)).rejects.toMatchObject({
        code: "secret_worker_denied",
      });
    expect(request).not.toHaveBeenCalled();
    expect(
      () =>
        new SecretCloudflareClient(
          { ...credential, accountId: "../account" },
          request,
        ),
    ).toThrow();
    expect(
      () =>
        new SecretCloudflareClient(
          { ...credential, token: "token\nheader" },
          request,
        ),
    ).toThrow();
  });
  it("rejects identity and deployment changes without reporting a coherent snapshot", async () => {
    for (const changed of ["identity", "deployment"] as const)
      await expect(
        fixture({ changed }).client.state(WORKER, true),
      ).rejects.toMatchObject({ code: "secret_identity_changed" });
    await expect(
      fixture({ invalid: true }).client.worker(WORKER),
    ).rejects.toMatchObject({ code: "secret_identity_changed" });
  });
  it("permits bounded inventory during a split deployment but refuses mutation preparation", async () => {
    const read = await fixture({ split: true }).client.state(WORKER);
    expect(read.revision).toBeNull();
    expect(read.items.every((item) => item.version === null)).toBe(true);
    expect(read.activation).toBeNull();
    await expect(
      fixture({ split: true }).client.state(WORKER, true),
    ).rejects.toMatchObject({ code: "secret_worker_deployment_unsupported" });
  });
  it("keeps provider failures, malformed bodies, redirects and capacity failures distinct from empty inventory", async () => {
    for (const status of [302, 401, 403, 404, 429, 500]) {
      const request = vi.fn<typeof fetch>(
        async () => new Response(VALUE, { status }),
      );
      await expect(
        new SecretCloudflareClient(credential, request).worker(WORKER),
      ).rejects.toThrow(/Cloudflare/);
      expect(request).toHaveBeenCalledTimes(1);
    }
    for (const result of [
      { success: false, result: { id: WORKER_ID, name: WORKER } },
      { success: true, result: { id: TOKEN, name: WORKER } },
    ]) {
      const client = new SecretCloudflareClient(credential, async () =>
        Response.json(result),
      );
      await expect(client.worker(WORKER)).rejects.toMatchObject({
        code: "secret_provider_invalid",
      });
    }
    const base = fixture();
    const client = new SecretCloudflareClient(
      credential,
      async (input, init) =>
        String(input).endsWith("/secrets")
          ? json(
              Array.from(
                { length: CLOUDFLARE_SECRET_LIMITS.BINDINGS + 1 },
                (_, index) => ({
                  name: "binding" + index,
                  type: "secret_text",
                }),
              ),
            )
          : base.request(input, init),
    );
    await expect(client.state(WORKER)).rejects.toMatchObject({
      code: "secret_provider_invalid",
    });
  });
  it("bounds header/body deadlines and response bytes without depending on fetch cancellation", async () => {
    vi.useFakeTimers();
    for (const phase of ["headers", "body"]) {
      const request = vi.fn<typeof fetch>(async () =>
        phase === "headers"
          ? new Promise<Response>(() => {})
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"success":'));
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
      );
      const pending = new SecretCloudflareClient(credential, request).worker(
        WORKER,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: "secret_provider_interrupted",
      });
      await vi.advanceTimersByTimeAsync(
        CLOUDFLARE_SECRET_LIMITS.REQUEST_MS + 1,
      );
      await rejected;
      expect(request).toHaveBeenCalledTimes(1);
    }
    const huge = new SecretCloudflareClient(
      credential,
      async () =>
        new Response("x".repeat(CLOUDFLARE_SECRET_LIMITS.RESPONSE_BYTES + 1), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(huge.worker(WORKER)).rejects.toMatchObject({
      code: "secret_provider_interrupted",
    });
  });
  it("sends exact supplied UTF-8 text with native case-sensitive binding names and checks the acceptance envelope", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://api.cloudflare.com/client/v4/accounts/" +
          ACCOUNT +
          "/workers/scripts/" +
          WORKER +
          "/secrets",
      );
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "mixed-case",
        type: "secret_text",
        text: VALUE,
      });
      return json(
        { name: "mixed-case", type: "secret_text", ignored: VALUE },
        201,
      );
    });
    const result = await new SecretCloudflareClient(credential, request).put(
      WORKER,
      "mixed-case",
      VALUE,
    );
    expect(result).toEqual({ status: "accepted", reason: null });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("refuses read-only, oversized UTF-8 and dot-segment writes before sending", async () => {
    const request = vi.fn<typeof fetch>();
    expect(
      await new SecretCloudflareClient(
        { ...credential, writable: false },
        request,
      ).put(WORKER, "token", VALUE),
    ).toEqual({ status: "rejected", reason: "credential_read_only" });
    const client = new SecretCloudflareClient(credential, request);
    await expect(
      client.put(WORKER, "token", "\u03bb".repeat(2561)),
    ).rejects.toMatchObject({ code: "secret_input_invalid" });
    for (const name of [".", "..", "invalid\nname"])
      await expect(client.remove(WORKER, name)).rejects.toMatchObject({
        code: "secret_name_invalid",
      });
    expect(request).not.toHaveBeenCalled();
  });
  it("retains uncertainty for lost or invalid successful responses and never retries writes", async () => {
    for (const mode of [
      "lost",
      "identity",
      "type",
      "envelope",
      "timeout",
      "redirect",
      "server",
    ]) {
      const request = vi.fn<typeof fetch>(async () => {
        if (mode === "lost") throw new Error(VALUE);
        if (mode === "timeout") return new Response(VALUE, { status: 408 });
        if (mode === "redirect") return new Response(VALUE, { status: 302 });
        if (mode === "server") return new Response(VALUE, { status: 500 });
        if (mode === "envelope")
          return Response.json({
            success: false,
            result: { name: "token", type: "secret_text" },
            errors: [VALUE],
          });
        return json({
          name: mode === "identity" ? "Token" : "token",
          type: mode === "type" ? "secret_key" : "secret_text",
        });
      });
      expect(
        await new SecretCloudflareClient(credential, request).put(
          WORKER,
          "token",
          VALUE,
        ),
      ).toEqual({
        status: "indeterminate",
        reason: "provider_result_uncertain",
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
    for (const status of [400, 403, 404, 409, 429]) {
      const client = new SecretCloudflareClient(
        credential,
        async () => new Response(VALUE, { status }),
      );
      expect((await client.put(WORKER, "token", VALUE)).status).toBe(
        "rejected",
      );
    }
  });
  it("encodes a selected deletion name without reading stored values", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("/secrets/opaque%2Fname");
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBeUndefined();
      return json(null);
    });
    expect(
      await new SecretCloudflareClient(credential, request).remove(
        WORKER,
        "opaque/name",
      ),
    ).toEqual({ status: "accepted", reason: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
