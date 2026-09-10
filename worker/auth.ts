import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { CAPABILITY, type Principal } from "../shared/domain";
import { DomainError } from "./errors";
import type { Env } from "./types";
import { credentialHash } from "./credential-hash";

export const AUTH_LIMITS = Object.freeze({
  ASSERTION_BYTES: 16384,
  BEARER_BYTES: 1024,
  JWKS_BYTES: 128 * 1024,
  JWKS_KEYS: 32,
  JWKS_TIMEOUT_MS: 5000,
  JWKS_ISSUERS: 4,
  JWKS_CACHE_MS: 10 * 60 * 1000,
  JWKS_COOLDOWN_MS: 30000,
  CLOCK_SKEW_SECONDS: 30,
});
const capabilities = z
  .array(z.enum(Object.values(CAPABILITY)))
  .min(1)
  .max(20);
const subject = z.string().regex(/^[\x21-\x7e]{1,255}$/);
const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

async function boundedKeys(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
) {
  const signal = init.signal!;
  signal.throwIfAborted();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader?.cancel().catch(() => {});
      reject(new Error("Identity keys unavailable"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      interrupted,
      (async () => {
        const response = await fetcher(url, { ...init, redirect: "manual" });
        if (signal.aborted) void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error("Identity keys unavailable");
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > AUTH_LIMITS.JWKS_BYTES) {
            await reader.cancel();
            throw new Error("Identity keys exceed limit");
          }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const keys = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
          !Array.isArray(keys?.keys) ||
          keys.keys.length > AUTH_LIMITS.JWKS_KEYS
        )
          throw new Error("Invalid identity keys");
        return Response.json(keys);
      })(),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function accessConfiguration(env: Env) {
  try {
    if (
      !env.ACCESS_ISSUER ||
      !env.ACCESS_AUDIENCE ||
      env.ACCESS_ISSUER.length > 512 ||
      env.ACCESS_AUDIENCE.length > 255
    )
      throw new Error("Missing identity configuration");
    const issuer = new URL(env.ACCESS_ISSUER);
    if (
      issuer.protocol !== "https:" ||
      issuer.origin !== env.ACCESS_ISSUER ||
      issuer.username ||
      issuer.password ||
      issuer.port
    )
      throw new Error("Invalid identity configuration");
    if (!/^[\x21-\x7e]+$/.test(env.ACCESS_AUDIENCE))
      throw new Error("Invalid identity audience");
    return { issuer: issuer.origin, audience: env.ACCESS_AUDIENCE };
  } catch {
    throw new DomainError(
      "not_configured",
      "Workspace sign-in has not been configured",
      503,
    );
  }
}

export function createProductionPrincipalResolver(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
) {
  const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  return async function resolvePrincipal(
    request: Request,
    env: Env,
  ): Promise<Principal> {
    const authorization = request.headers.get("Authorization");
    if (authorization !== null) {
      if (
        !/^Bearer [\x21-\x7e]+$/.test(authorization) ||
        authorization.length > AUTH_LIMITS.BEARER_BYTES
      )
        throw new DomainError("unauthorized", "Sign in to continue", 401);
      const hash = await credentialHash(authorization.slice(7));
      const row = await env.HQ_DB.prepare(
        "SELECT c.id, c.workspace_id, c.owner_subject, c.scopes_json, c.source_id, c.reporter_id, c.automation_profile, c.name, c.expires_at, m.display_name FROM credentials c JOIN members m ON m.workspace_id = c.workspace_id AND m.subject = c.owner_subject WHERE c.token_hash = ? AND c.revoked_at IS NULL AND c.expires_at > ?",
      )
        .bind(hash, new Date(now()).toISOString())
        .first<{
          id: string;
          workspace_id: string;
          owner_subject: string;
          scopes_json: string;
          source_id: string | null;
          reporter_id: string | null;
          automation_profile: string | null;
          name: string;
          display_name: string;
          expires_at: string;
        }>();
      if (!row)
        throw new DomainError(
          "unauthorized",
          "This credential is invalid or expired",
          401,
        );
      let scopes;
      try {
        scopes = capabilities.parse(JSON.parse(row.scopes_json));
      } catch {
        throw new DomainError(
          "unauthorized",
          "This credential is invalid or expired",
          401,
        );
      }
      return {
        subject: row.owner_subject,
        expiresAt: Date.parse(row.expires_at),
        displayName: row.automation_profile
          ? row.name + " (automation)"
          : row.display_name,
        tokenId: row.id,
        workspaceId: row.workspace_id,
        scopes,
        sourceId: row.source_id ?? undefined,
        reporterId: row.reporter_id ?? undefined,
      };
    }
    const configuration = accessConfiguration(env);
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > AUTH_LIMITS.ASSERTION_BYTES)
      throw new DomainError("unauthorized", "Sign in to continue", 401);
    try {
      const keysUrl = new URL("/cdn-cgi/access/certs", configuration.issuer)
        .href;
      let keys = jwks.get(keysUrl);
      if (!keys) {
        keys = createRemoteJWKSet(new URL(keysUrl), {
          timeoutDuration: AUTH_LIMITS.JWKS_TIMEOUT_MS,
          cooldownDuration: AUTH_LIMITS.JWKS_COOLDOWN_MS,
          cacheMaxAge: AUTH_LIMITS.JWKS_CACHE_MS,
          [customFetch]: (url, init) => boundedKeys(url, init, fetcher),
        });
        if (jwks.size >= AUTH_LIMITS.JWKS_ISSUERS)
          jwks.delete(jwks.keys().next().value!);
        jwks.set(keysUrl, keys);
      }
      const { payload } = await jwtVerify(token, keys, {
        ...configuration,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp", "type"],
        currentDate: new Date(now()),
      });
      if (
        payload.type !== "app" ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.exp <= payload.iat ||
        payload.iat > now() / 1000 + AUTH_LIMITS.CLOCK_SKEW_SECONDS ||
        payload.common_name !== undefined
      )
        throw new Error("Invalid application identity");
      const identity = subject.parse(payload.sub);
      const address = email.safeParse(payload.email);
      return {
        subject: identity,
        expiresAt: payload.exp * 1000,
        displayName: address.success ? address.data : "Workspace member",
        access: {
          ...configuration,
          ...(address.success ? { email: address.data } : {}),
        },
      };
    } catch {
      throw new DomainError(
        "unauthorized",
        "Your sign-in could not be verified",
        401,
      );
    }
  };
}

export const resolveProductionPrincipal = createProductionPrincipalResolver();
