import { beforeAll, describe, expect, it } from "vitest";
import {
  normalizeGitHubAppKey,
  signGitHubAppJwt,
  sealGitHubAppMaterial,
  openGitHubAppMaterial,
  type GitHubMaterialContext,
} from "../worker/github-app-crypto";
import { githubAppTestKey } from "./helpers/github-app-keys";

let key: Awaited<ReturnType<typeof githubAppTestKey>>;
beforeAll(async () => {
  key = await githubAppTestKey();
});
const context: GitHubMaterialContext = {
  env: {
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "key-a",
      keys: [{ id: "key-a", key: btoa("a".repeat(32)) }],
    }),
  },
  deploymentId: "deployment-a",
  administrativeWorkspaceId: "administration",
  registrationId: "app-a",
  kind: "private-key",
  materialId: "signing-key-a",
  revision: 1,
};

describe("GitHub App protected material", () => {
  it("normalizes independently generated PKCS1 and PKCS8 to a public-key fingerprint", async () => {
    const first = await normalizeGitHubAppKey(key.pkcs1);
    const second = await normalizeGitHubAppKey(key.pkcs8);
    expect(first.pkcs8).toBe(second.pkcs8);
    expect(first.pkcs8).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(first.fingerprint).toBe(key.fingerprint);
    expect(second.fingerprint).toBe(key.fingerprint);
  });

  it("signs a time-bounded RS256 JWT verifiable by the independent public key", async () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const jwt = await signGitHubAppJwt(key.pkcs1, 42, now);
    const parts = jwt.split(".");
    expect(
      JSON.parse(Buffer.from(parts[0], "base64url").toString()),
    ).toMatchObject({ alg: "RS256" });
    expect(JSON.parse(Buffer.from(parts[1], "base64url").toString())).toEqual({
      iss: "42",
      iat: 1794225540,
      exp: 1794226140,
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key.publicKey,
        Buffer.from(parts[2], "base64url"),
        new TextEncoder().encode(parts.slice(0, 2).join(".")),
      ),
    ).toBe(true);
  });

  it("rejects weak, malformed, non-RSA and oversized material without echoing input", async () => {
    const weak = await githubAppTestKey(1024);
    const nonRsa = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const nonRsaPem =
      "-----BEGIN PRIVATE KEY-----\n" +
      Buffer.from(
        await crypto.subtle.exportKey("pkcs8", nonRsa.privateKey),
      ).toString("base64") +
      "\n-----END PRIVATE KEY-----\n";
    for (const input of [
      weak.pkcs8,
      nonRsaPem,
      "private-input-canary",
      "x".repeat(65537),
      key.pkcs8 + key.pkcs8,
    ]) {
      await expect(normalizeGitHubAppKey(input)).rejects.toMatchObject({
        code: "github_app_input_invalid",
      });
      try {
        await normalizeGitHubAppKey(input);
      } catch (error) {
        expect(String(error)).not.toContain(input);
      }
    }
    await expect(
      signGitHubAppJwt(key.pkcs8, 0, Date.now()),
    ).rejects.toMatchObject({ code: "github_app_input_invalid" });
  });

  it("encrypts with independent nonces and binds every identity dimension", async () => {
    const plaintext = new TextEncoder().encode(key.pkcs8);
    const first = await sealGitHubAppMaterial(context, plaintext);
    const second = await sealGitHubAppMaterial(context, plaintext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");
    expect(await openGitHubAppMaterial(context, first)).toEqual(plaintext);
    for (const change of [
      { deploymentId: "deployment-b" },
      { administrativeWorkspaceId: "other" },
      { registrationId: "app-b" },
      { kind: "webhook-secret" as const },
      { materialId: "signing-key-b" },
      { revision: 2 },
    ])
      await expect(
        openGitHubAppMaterial({ ...context, ...change }, first),
      ).rejects.toMatchObject({ code: "github_app_material_unavailable" });
    expect(new TextDecoder().decode(plaintext)).toContain("PRIVATE KEY");
  });

  it("preserves old ciphertext across encryption-key rotation and rejects key substitution", async () => {
    const bytes = new TextEncoder().encode("synthetic-webhook-canary");
    const first = await sealGitHubAppMaterial(context, bytes);
    const rotated = {
      ...context,
      env: {
        PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
          version: 1,
          activeKeyId: "key-b",
          keys: [
            { id: "key-a", key: btoa("a".repeat(32)) },
            { id: "key-b", key: btoa("b".repeat(32)) },
          ],
        }),
      },
    };
    expect((await sealGitHubAppMaterial(rotated, bytes)).keyId).toBe("key-b");
    expect(await openGitHubAppMaterial(rotated, first)).toEqual(bytes);
    await expect(
      openGitHubAppMaterial(rotated, { ...first, keyId: "key-b" }),
    ).rejects.toMatchObject({ code: "github_app_material_unavailable" });
    for (const changed of [
      { ...first, nonce: "bad" },
      { ...first, ciphertext: "x".repeat(100000) },
    ])
      await expect(
        openGitHubAppMaterial(context, changed),
      ).rejects.toMatchObject({ code: "github_app_material_unavailable" });
    await expect(
      sealGitHubAppMaterial({ ...context, env: {} }, bytes),
    ).rejects.toMatchObject({ code: "github_app_material_unavailable" });
  });
});
