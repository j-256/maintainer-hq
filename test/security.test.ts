import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  API_CACHE_CONTROL,
  SECURITY_HEADERS,
  STATIC_CACHE_CONTROL,
  secureResponse,
  staticHeaderRules,
} from "../shared/security";
import { createApplication } from "../worker/app";
import { DomainError } from "../worker/errors";
import type { Env } from "../worker/types";
import headerRules from "../public/_headers?raw";

describe("Browser and API security policy", () => {
  it("keeps static rules identical and allows WebAssembly without JavaScript string evaluation", () => {
    expect(headerRules).toBe(staticHeaderRules());
    const scripts = SECURITY_HEADERS["Content-Security-Policy"]
      .split(";")
      .find((part) => part.trim().startsWith("script-src"));
    expect(scripts?.trim()).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain(
      "'unsafe-eval'",
    );
    expect(scripts).not.toContain("'unsafe-inline'");
  });
  it("preserves response semantics while overriding unsafe headers", async () => {
    const response = secureResponse(
      new Response("moved", {
        status: 307,
        headers: {
          Location: "/activity",
          "Cache-Control": "public",
          "X-Frame-Options": "ALLOWALL",
        },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/activity");
    expect(response.headers.get("Cache-Control")).toBe(API_CACHE_CONTROL);
    for (const [key, value] of Object.entries(SECURITY_HEADERS))
      expect(response.headers.get(key)).toBe(value);
    expect(await response.text()).toBe("moved");
  });
  it("protects successful, error, health and Worker-served asset responses", async () => {
    const app = createApplication(async () => {
      throw new DomainError("unauthorized", "Sign in to continue", 401);
    });
    const bindings = {
      ...env,
      ASSETS: {
        fetch: async () =>
          new Response("<main>Static shell</main>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    } as unknown as Env;
    for (const [path, status, cache] of [
      ["/api/session", 401, API_CACHE_CONTROL],
      ["/healthz", 200, API_CACHE_CONTROL],
      ["/activity", 200, STATIC_CACHE_CONTROL],
    ] as const) {
      const response = await app.fetch(
        new Request("https://workspace.example" + path),
        bindings,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe(cache);
      for (const [key, value] of Object.entries(SECURITY_HEADERS))
        expect(response.headers.get(key)).toBe(value);
    }
  });
});
