import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export async function githubAppTestKey(modulusLength = 2048) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const key = createPrivateKey({
    key: Buffer.from(der),
    format: "der",
    type: "pkcs8",
  });
  return {
    pkcs8: key.export({ format: "pem", type: "pkcs8" }).toString(),
    pkcs1: key.export({ format: "pem", type: "pkcs1" }).toString(),
    publicKey: pair.publicKey,
    fingerprint: createHash("sha256")
      .update(createPublicKey(key).export({ format: "der", type: "spki" }))
      .digest("hex"),
  };
}
