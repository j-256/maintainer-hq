export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000",
});
export const STATIC_CACHE_CONTROL = "private, max-age=0, must-revalidate";
export const API_CACHE_CONTROL = "no-store";

export function secureResponse(response: Response, assets = false): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  headers.set(
    "Cache-Control",
    assets ? STATIC_CACHE_CONTROL : API_CACHE_CONTROL,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
}

export function staticHeaderRules() {
  return (
    "/*\n" +
    Object.entries({
      ...SECURITY_HEADERS,
      "Cache-Control": STATIC_CACHE_CONTROL,
    })
      .map(([name, value]) => "  " + name + ": " + value)
      .join("\n") +
    "\n"
  );
}
