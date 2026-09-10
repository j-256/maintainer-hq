import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sealGitHubSecret,
  SECRET_CRYPTO_LIMITS,
} from "../shared/github-secret-crypto";

test("client sealing preserves UTF-8 bytes and trailing newlines", async () => {
  const { default: sodium } = await import("libsodium-wrappers");
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const key = Buffer.from(pair.publicKey).toString("base64");
  const value = new TextEncoder().encode("synthetic-only\n\u2603\r\n");
  try {
    const first = await sealGitHubSecret(value, key);
    const second = await sealGitHubSecret(value, key);
    assert.notEqual(first, second);
    assert.deepEqual(
      sodium.crypto_box_seal_open(
        Buffer.from(first, "base64"),
        pair.publicKey,
        pair.privateKey,
      ),
      value,
    );
    assert.deepEqual(
      value,
      new TextEncoder().encode("synthetic-only\n\u2603\r\n"),
    );
    assert.equal(
      Buffer.from(first, "base64").length,
      value.byteLength + SECRET_CRYPTO_LIMITS.SEAL_BYTES,
    );
  } finally {
    sodium.memzero(pair.privateKey);
  }
});

test("client sealing bounds input and reports fixed errors", async () => {
  const value = new TextEncoder().encode("synthetic-private-canary");
  for (const key of ["not-a-public-key", "A".repeat(48), " A".repeat(20)])
    await assert.rejects(sealGitHubSecret(value, key), {
      code: "secret_public_key_invalid",
    });
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(SECRET_CRYPTO_LIMITS.VALUE_BYTES + 1),
  ])
    await assert.rejects(sealGitHubSecret(bytes, ""), {
      code: "secret_input_invalid",
    });
});
