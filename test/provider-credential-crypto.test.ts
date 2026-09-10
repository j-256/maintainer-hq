import { describe, expect, it } from "vitest";
import {
  providerCredentialFieldsSchema,
  providerCredentialPlanInput,
} from "../shared/provider-credentials";
import {
  openProviderCredential,
  providerCredentialKeyStatus,
  sealProviderCredential,
  type CredentialBinding,
} from "../worker/provider-credential-crypto";

const TOKEN = "synthetic-provider-credential-plaintext-canary";
const keys = {
  version: 1,
  activeKeyId: "first",
  keys: [{ id: "first", key: btoa("a".repeat(32)) }],
};
const env = { PROVIDER_CREDENTIAL_KEYS: JSON.stringify(keys) };
const binding: CredentialBinding = {
  workspaceId: "alpha",
  credentialId: "managed-example",
  revision: 1,
  identity: "c".repeat(64),
  settings: {
    providerKind: "github-actions",
    name: "Selected repositories",
    expiresAt: "2099-01-01T00:00:00.000Z",
    writable: true,
    scope: { repositoryNames: ["example/first", "example/second"] },
  },
};

describe("provider credential custody", () => {
  it("round trips in the actual Worker runtime with independent nonces and no plaintext serialization", async () => {
    const first = await sealProviderCredential(env, binding, TOKEN);
    const second = await sealProviderCredential(env, binding, TOKEN);
    expect(first).not.toEqual(second);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain(TOKEN);
    expect(await openProviderCredential(env, binding, first)).toBe(TOKEN);
    expect(await openProviderCredential(env, binding, second)).toBe(TOKEN);
  });

  it("authenticates identity, authority metadata, revision and provider kind", async () => {
    const encrypted = await sealProviderCredential(env, binding, TOKEN);
    const changes: CredentialBinding[] = [
      { ...binding, workspaceId: "beta" },
      { ...binding, credentialId: "managed-other" },
      { ...binding, revision: 2 },
      { ...binding, identity: "d".repeat(64) },
      { ...binding, settings: { ...binding.settings, name: "Changed" } },
      { ...binding, settings: { ...binding.settings, writable: false } },
      {
        ...binding,
        settings: {
          ...binding.settings,
          expiresAt: "2098-01-01T00:00:00.000Z",
        },
      },
      {
        ...binding,
        settings: {
          ...binding.settings,
          providerKind: "github-actions",
          scope: { repositoryNames: ["example/unreviewed"] },
        },
      },
      {
        ...binding,
        settings: {
          ...binding.settings,
          providerKind: "cloudflare-workers",
          scope: { accountId: "a".repeat(32), workerNames: ["first"] },
        },
      },
    ];
    for (const changed of changes) {
      await expect(
        openProviderCredential(env, changed, encrypted),
      ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    }
  });

  it("retains old-key readability during explicit keyring rotation without allowing key substitution", async () => {
    const encrypted = await sealProviderCredential(env, binding, TOKEN);
    const rotated = {
      PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
        ...keys,
        activeKeyId: "second",
        keys: [...keys.keys, { id: "second", key: btoa("b".repeat(32)) }],
      }),
    };
    expect((await sealProviderCredential(rotated, binding, TOKEN)).keyId).toBe(
      "second",
    );
    expect(await openProviderCredential(rotated, binding, encrypted)).toBe(
      TOKEN,
    );
    await expect(
      openProviderCredential(rotated, binding, {
        ...encrypted,
        keyId: "second",
      }),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await expect(
      openProviderCredential(
        {
          PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
            ...keys,
            keys: [{ id: "first", key: btoa("b".repeat(32)) }],
          }),
        },
        binding,
        encrypted,
      ),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
  });

  it("fails closed for missing, malformed, ambiguous, and oversized keyrings and ciphertext", async () => {
    const encrypted = await sealProviderCredential(env, binding, TOKEN);
    for (const value of [
      undefined,
      "not-json",
      "x".repeat(4097),
      JSON.stringify({ ...keys, activeKeyId: "missing" }),
      JSON.stringify({ ...keys, keys: [...keys.keys, ...keys.keys] }),
    ]) {
      const unavailable = { PROVIDER_CREDENTIAL_KEYS: value };
      expect(providerCredentialKeyStatus(unavailable)).toBe(false);
      await expect(
        openProviderCredential(unavailable, binding, encrypted),
      ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    }
    for (const changed of [
      { ...encrypted, nonce: "invalid" },
      { ...encrypted, ciphertext: "x".repeat(6000) },
      { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) },
    ]) {
      await expect(
        openProviderCredential(env, binding, changed),
      ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    }
    expect(providerCredentialKeyStatus(env, "missing")).toBe(false);
    expect(providerCredentialKeyStatus(env, "first")).toBe(true);
  });

  it("rejects unsafe bearer syntax and never admits a token to ordinary metadata commands", async () => {
    for (const token of [
      "",
      "contains whitespace",
      "new\nline",
      "x".repeat(2049),
    ]) {
      await expect(
        sealProviderCredential(env, binding, token),
      ).rejects.toMatchObject({ code: "provider_credential_input_invalid" });
    }
    const request = {
      workspaceId: "alpha",
      credentialId: binding.credentialId,
      revision: 0,
      change: { kind: "save", settings: binding.settings, replaceToken: true },
    };
    expect(providerCredentialPlanInput.safeParse(request).success).toBe(true);
    expect(
      providerCredentialPlanInput.safeParse({ ...request, token: TOKEN })
        .success,
    ).toBe(false);
    expect(
      providerCredentialFieldsSchema.safeParse({
        ...binding.settings,
        token: TOKEN,
      }).success,
    ).toBe(false);
    expect(
      providerCredentialFieldsSchema.safeParse({
        ...binding.settings,
        scope: { repositoryNames: ["example/repo", "Example/Repo"] },
      }).success,
    ).toBe(false);
  });
});
