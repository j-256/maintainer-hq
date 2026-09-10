import { env, applyD1Migrations } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { AUTH_LIMITS, createProductionPrincipalResolver } from "../worker/auth";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ISSUER = "https://identity.example";
const AUDIENCE = "synthetic-application";
const SUBJECT = "fixture-owner";
const EMAIL = "owner@example.test";
const NOW = Date.parse("2026-09-05T12:00:00Z");
const configured: Env = {
  ...bindings,
  ACCESS_ISSUER: ISSUER,
  ACCESS_AUDIENCE: AUDIENCE,
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let other: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: { keys: Awaited<ReturnType<typeof exportJWK>>[] };

beforeAll(async () => {
  await applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS);
  pair = await generateKeyPair("RS256");
  other = await generateKeyPair("RS256");
  keys = {
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        kid: "fixture",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
});
beforeEach(async () => {
  await bindings.HQ_DB.prepare("DELETE FROM credentials").run();
  await bindings.HQ_DB.prepare("DELETE FROM workspaces").run();
  await bindings.HQ_DB.prepare("DELETE FROM installation_setup").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function token(overrides: JWTPayload = {}, key = pair.privateKey) {
  return new SignJWT({
    iss: ISSUER,
    aud: [AUDIENCE],
    sub: SUBJECT,
    email: EMAIL,
    type: "app",
    iat: NOW / 1000 - 10,
    nbf: NOW / 1000 - 10,
    exp: NOW / 1000 + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(key);
}
function request(assertion?: string, extra: HeadersInit = {}) {
  return new Request("https://hq.example/api/session", {
    headers: {
      ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
      ...extra,
    },
  });
}
function fixture(
  response = () => Response.json(keys),
  now: () => number = () => NOW,
) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(ISSUER + "/cdn-cgi/access/certs");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return response();
  });
  return {
    fetcher,
    resolve: createProductionPrincipalResolver(fetcher as typeof fetch, now),
  };
}

describe("Production Access identity", () => {
  it("uses a real signed session through the production API for first-owner enrollment", async () => {
    const now = Date.now();
    const { resolve } = fixture(undefined, () => now);
    const application = createApplication(resolve);
    const runtime = {
      ...configured,
      INITIAL_OWNER_SETUP: JSON.stringify({
        setupId: "signed-setup",
        workspaceId: "signed-workspace",
        workspaceName: "Signed workspace",
        ownerSubject: SUBJECT,
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      }),
    };
    const assertion = await token({
      iat: Math.floor(now / 1000) - 1,
      nbf: Math.floor(now / 1000) - 1,
      exp: Math.floor(now / 1000) + 300,
    });
    const call = (name: string, input: unknown) =>
      application.fetch(
        new Request("https://hq.example/api/commands/" + name, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://hq.example",
            "Cf-Access-Jwt-Assertion": assertion,
          },
          body: JSON.stringify(input),
        }),
        runtime,
      );
    const status = await call("setup_status", {});
    expect(status.status).toBe(200);
    const plan = (await status.json()) as {
      state: string;
      fingerprint: string;
    };
    expect(plan.state).toBe("ready");
    expect(
      (await call("setup_apply", { fingerprint: plan.fingerprint })).status,
    ).toBe(200);
    const session = await application.fetch(request(assertion), runtime);
    expect(await session.json()).toMatchObject({
      workspaces: [{ id: "signed-workspace", role: "owner" }],
      development: false,
    });
  });
  it("refreshes rotated keys after cooldown while bounding unknown-key traffic", async () => {
    let time = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    let current = keys;
    const { resolve, fetcher } = fixture(() => Response.json(current));
    await resolve(request(await token()), configured);
    const rotated = await new SignJWT({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: SUBJECT,
      type: "app",
      iat: NOW / 1000 - 1,
      exp: NOW / 1000 + 300,
    })
      .setProtectedHeader({ alg: "RS256", kid: "rotated" })
      .sign(other.privateKey);
    current = {
      keys: [
        {
          ...(await exportJWK(other.publicKey)),
          kid: "rotated",
          alg: "RS256",
          use: "sig",
        },
      ],
    };
    await expect(resolve(request(rotated), configured)).rejects.toMatchObject({
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += AUTH_LIMITS.JWKS_COOLDOWN_MS + 1;
    expect(await resolve(request(rotated), configured)).toMatchObject({
      subject: SUBJECT,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("verifies real signatures and carries bounded identity provenance without granting membership", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { resolve, fetcher } = fixture();
    const assertion = await token({ email: "Owner@Example.Test" });
    expect(await resolve(request(assertion), configured)).toEqual({
      subject: SUBJECT,
      displayName: EMAIL,
      expiresAt: NOW + 300000,
      access: { issuer: ISSUER, audience: AUDIENCE, email: EMAIL },
    });
    const response = await createApplication(resolve).fetch(
      request(assertion),
      configured,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaces: [],
      development: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid signatures, issuer, audience, times, application type, and identity shape", async () => {
    const { resolve } = fixture();
    const variants: JWTPayload[] = [
      { iss: "https://wrong.example" },
      { aud: "wrong" },
      { exp: NOW / 1000 - 1 },
      { nbf: NOW / 1000 + 60 },
      { iat: NOW / 1000 + 60 },
      { iat: NOW / 1000 + 0.5 },
      { type: "org" },
      { sub: "" },
      { sub: "has a space" },
      { sub: "x".repeat(256) },
      { common_name: "service.access" },
      { exp: NOW / 1000 - 20 },
    ];
    for (const claims of variants)
      await expect(
        resolve(request(await token(claims)), configured),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      resolve(request(await token({}, other.privateKey)), configured),
    ).rejects.toMatchObject({ status: 401 });
    for (const field of ["sub", "exp", "iat", "type"]) {
      const claims = {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: SUBJECT,
        exp: NOW / 1000 + 300,
        iat: NOW / 1000,
        type: "app",
      } as JWTPayload;
      delete claims[field];
      const assertion = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .sign(pair.privateKey);
      await expect(
        resolve(request(assertion), configured),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
  it("uses safe display fallback for invalid or missing email and does not authorize that email", async () => {
    const { resolve } = fixture();
    for (const email of [
      null,
      "not-an-address",
      "x".repeat(300),
      { value: EMAIL },
    ]) {
      const principal = await resolve(
        request(await token({ email })),
        configured,
      );
      expect(principal.displayName).toBe("Workspace member");
      expect(principal.access?.email).toBeUndefined();
    }
  });
  it("fails closed for missing or malformed configuration before loading keys", async () => {
    const { resolve, fetcher } = fixture();
    for (const issuer of [
      undefined,
      "http://identity.example",
      ISSUER + "/",
      ISSUER + "/path",
      "https://user:pass@identity.example",
      ISSUER + "?query=1",
      ISSUER + ":8443",
    ])
      await expect(
        resolve(request(await token()), {
          ...configured,
          ACCESS_ISSUER: issuer,
        }),
      ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolve(request(await token()), { ...configured, ACCESS_AUDIENCE: " " }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolve(request(undefined, { "X-Dev-User": "owner" }), configured),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      resolve(request("x".repeat(AUTH_LIMITS.ASSERTION_BYTES + 1)), configured),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses redirected, unavailable, malformed, oversized, and excessive key responses", async () => {
    const assertion = await token();
    for (const response of [
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example" },
        }),
      () => new Response("private upstream details", { status: 500 }),
      () => new Response("not-json"),
      () =>
        Response.json({
          keys: Array.from(
            { length: AUTH_LIMITS.JWKS_KEYS + 1 },
            () => keys.keys[0],
          ),
        }),
      () => new Response("x".repeat(AUTH_LIMITS.JWKS_BYTES + 1)),
    ]) {
      const { resolve, fetcher } = fixture(response);
      await expect(
        resolve(request(assertion), configured),
      ).rejects.toMatchObject({
        status: 401,
        message: "Your sign-in could not be verified",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it(
    "bounds slow key bodies even when the stream never finishes",
    async () => {
      const assertion = await token();
      const cancel = vi.fn();
      const { resolve } = fixture(
        () => new Response(new ReadableStream({ cancel })),
      );
      const result = expect(
        resolve(request(assertion), configured),
      ).rejects.toMatchObject({ status: 401 });
      await result;
      expect(cancel).toHaveBeenCalled();
    },
    AUTH_LIMITS.JWKS_TIMEOUT_MS + 5000,
  );
  it("never falls back to an Access assertion when an explicit bearer header is invalid", async () => {
    const { resolve, fetcher } = fixture();
    const assertion = await token();
    for (const authorization of [
      "",
      "Basic invalid",
      "Bearer",
      "Bearer synthetic-unknown",
      "Bearer " + "x".repeat(AUTH_LIMITS.BEARER_BYTES),
    ])
      await expect(
        resolve(
          request(assertion, { Authorization: authorization }),
          configured,
        ),
      ).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("resolves only unrevoked unexpired bearer credentials belonging to a live member", async () => {
    const { resolve } = fixture();
    const bearer = "synthetic-hq-credential";
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?)",
      ).bind(new Date(NOW).toISOString()),
      bindings.HQ_DB.prepare(
        "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha',?,'Owner','owner')",
      ).bind(SUBJECT),
      bindings.HQ_DB.prepare(
        "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('credential','alpha',?,'Automation',?,'[\"read\"]',?,?)",
      ).bind(
        SUBJECT,
        await credentialHash(bearer),
        new Date(NOW).toISOString(),
        new Date(NOW + 60000).toISOString(),
      ),
    ]);
    const req = request(undefined, { Authorization: "Bearer " + bearer });
    expect(await resolve(req, configured)).toMatchObject({
      subject: SUBJECT,
      tokenId: "credential",
      workspaceId: "alpha",
      scopes: ["read"],
    });
    expect((await resolve(req, configured)).access).toBeUndefined();
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json='[\"invalid\"]'",
    ).run();
    await expect(resolve(req, configured)).rejects.toMatchObject({
      status: 401,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json='[\"read\"]', revoked_at=?",
    )
      .bind(new Date(NOW).toISOString())
      .run();
    await expect(resolve(req, configured)).rejects.toMatchObject({
      status: 401,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=NULL, expires_at=?",
    )
      .bind(new Date(NOW).toISOString())
      .run();
    await expect(resolve(req, configured)).rejects.toMatchObject({
      status: 401,
    });
    await bindings.HQ_DB.prepare("UPDATE credentials SET expires_at=?")
      .bind(new Date(NOW + 60000).toISOString())
      .run();
    await bindings.HQ_DB.prepare("DELETE FROM members").run();
    await expect(resolve(req, configured)).rejects.toMatchObject({
      status: 401,
    });
  });
});
