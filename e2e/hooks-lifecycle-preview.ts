import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { mockHookLifecycle } from "./hooks-lifecycle-fixture";

const PREVIEW_PORT = 5210;
const UPSTREAM_ORIGIN = "http://127.0.0.1:5207";
type Fulfillment = { status?: number; json?: unknown; body?: string; headers?: Record<string, string>; response?: Response };
type Route = { request: () => { url: () => string; postDataJSON: () => unknown }; fulfill: (value: Fulfillment) => Promise<void>; fallback: () => Promise<void>; fetch: () => Promise<Response> };
const handlers: { pattern: RegExp; handle: (route: Route) => Promise<void> }[] = [];
const page = { route: async (pattern: string, handle: (route: Route) => Promise<void>) => {
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*");
  handlers.push({ pattern: new RegExp("^" + expression + "$"), handle });
} } as unknown as Page;
await mockHookLifecycle(page);
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (chunks.reduce((size, value) => size + value.length, 0) > 65536) { response.writeHead(413).end(); return; } }
  const bytes = Buffer.concat(chunks);
  const url = new URL(request.url!, "http://127.0.0.1:" + PREVIEW_PORT);
  const upstream = async () => fetch(new URL(url.pathname + url.search, UPSTREAM_ORIGIN), { method: request.method, redirect: "manual", headers: { "content-type": request.headers["content-type"] ?? "application/json", origin: UPSTREAM_ORIGIN }, ...(bytes.length ? { body: bytes } : {}) });
  const write = async (result: Response) => { response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); };
  let index = handlers.length;
  const next = async (): Promise<void> => {
    while (index > 0) { const handler = handlers[--index]!; if (!handler.pattern.test(url.href)) continue;
      await handler.handle({ request: () => ({ url: () => url.href, postDataJSON: () => JSON.parse(bytes.toString()) }), fallback: next, fetch: upstream, fulfill: async value => {
        const headers = { ...Object.fromEntries(value.response?.headers ?? []), ...value.headers, ...(value.json !== undefined ? { "content-type": "application/json" } : {}) };
        delete (headers as Record<string, string>)["content-length"];
        delete (headers as Record<string, string>)["content-encoding"];
        response.writeHead(value.status ?? value.response?.status ?? 200, headers); response.end(value.json !== undefined ? JSON.stringify(value.json) : value.body ?? "");
      } }); return;
    }
    await write(await upstream());
  };
  try { await next(); } catch { if (!response.headersSent) response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "fixture_unavailable", message: "Synthetic fixture unavailable" } })); }
});
server.listen(PREVIEW_PORT, "127.0.0.1", () => console.error("Synthetic lifecycle preview: http://127.0.0.1:" + PREVIEW_PORT + "/hooks?workspace=development"));
