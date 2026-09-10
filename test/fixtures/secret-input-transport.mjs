// Isolated client-sealing fixture with synthetic material and no provider traffic
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers";

await sodium.ready;
const pair = sodium.crypto_box_keypair();
const mode = process.env.HQ_SECRET_INPUT_MODE;
let accepted = mode === "accepted";
const value = "synthetic-sealed-input-\u03bb\r\nlast line\n";
const draftFingerprint = "sha256:" + "a".repeat(64);
const review = () => ({
  id: "review",
  stage: accepted ? "reviewed" : "awaiting-input",
  draftFingerprint,
  fingerprint: accepted ? "sha256:" + "b".repeat(64) : null,
  actorMatches: true,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(
    Date.now() + (mode === "expired" ? -1000 : 60000),
  ).toISOString(),
  inputExpiresAt: new Date(Date.now() + 60000).toISOString(),
  inputPresent: accepted,
  destinations: [
    {
      destination: {
        connectionId: "secrets",
        connectionRevision: 1,
        target: { resourceId: "repo", scope: { kind: "repository" } },
        name: "SYNTHETIC",
      },
      providerKind: "github-actions",
      connectionName: "Synthetic secrets",
      resource: { id: "repo", label: "example/repo", repositoryIds: ["repo"] },
      snapshot: {
        name: "SYNTHETIC",
        scope: { kind: "repository" },
        resourceIdentity: "42",
        scopeIdentity: null,
        resourceRevision: "1",
        before: null,
        input: {
          kind: "provider-sealed",
          algorithm: "libsodium-sealed-box",
          keyId: "key",
          publicKey: sodium.to_base64(
            pair.publicKey,
            sodium.base64_variants.ORIGINAL,
          ),
          maxValueBytes: 49152,
        },
        activation: "secret-update",
      },
    },
  ],
  source: null,
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "http://127.0.0.1:5178");
  assert.equal(init.redirect, "error");
  assert.equal(new Headers(init.headers).get("Authorization"), null);
  assert.ok(!String(init.body).includes(value));
  if (url.pathname === "/api/commands/secrets_review") {
    assert.deepEqual(JSON.parse(init.body), {
      workspaceId: "alpha",
      reviewId: "review",
    });
    return Response.json(review());
  }
  assert.equal(url.pathname, "/api/secrets/input");
  assert.equal(url.searchParams.get("workspaceId"), "alpha");
  assert.equal(url.searchParams.get("reviewId"), "review");
  assert.equal(new Headers(init.headers).get("If-Match"), draftFingerprint);
  const body = JSON.parse(init.body);
  assert.equal(body.version, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].destinationIndex, 0);
  const decrypted = sodium.crypto_box_seal_open(
    sodium.from_base64(
      body.items[0].ciphertext,
      sodium.base64_variants.ORIGINAL,
    ),
    pair.publicKey,
    pair.privateKey,
  );
  assert.equal(new TextDecoder().decode(decrypted), value);
  decrypted.fill(0);
  accepted = true;
  if (mode === "lost") throw new Error("Synthetic lost upload response");
  return Response.json(review());
};
