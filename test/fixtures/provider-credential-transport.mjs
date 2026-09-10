// Isolated transport fixture with synthetic credentials and no external traffic
import assert from "node:assert/strict";

const token = "synthetic-private-provider-token";
const mode = process.env.HQ_CREDENTIAL_INPUT_MODE;
let accepted = mode === "accepted";
const fingerprint = "sha256:" + "a".repeat(64);
const review = () => ({
  id: "review",
  credentialId: "managed-provider",
  revision: 0,
  change: {
    kind: "save",
    replaceToken: true,
    settings: {
      providerKind: "github-actions",
      name: "Synthetic provider",
      writable: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: { repositoryNames: ["example/repo"] },
    },
  },
  fingerprint,
  expiresAt: new Date(
    Date.now() + (mode === "expired" ? -1000 : 60000),
  ).toISOString(),
  appliedAt: accepted ? new Date().toISOString() : null,
  actorMatches: true,
  connections: [],
  pendingReviews: 0,
  unsettledDestinations: 0,
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "http://127.0.0.1:5178");
  assert.equal(init.redirect, "error");
  assert.equal(new Headers(init.headers).get("Authorization"), null);
  if (url.pathname === "/api/commands/provider_credential_review") {
    assert.deepEqual(JSON.parse(init.body), {
      workspaceId: "alpha",
      planId: "review",
    });
    assert.ok(!String(init.body).includes(token));
    return Response.json(review());
  }
  assert.equal(url.pathname, "/api/provider-credentials/input");
  assert.equal(url.search, "?workspaceId=alpha&planId=review");
  assert.equal(new Headers(init.headers).get("If-Match"), fingerprint);
  assert.deepEqual(JSON.parse(init.body), { version: 1, token });
  accepted = true;
  if (mode === "lost") throw new Error(token);
  return Response.json({ submitted: true, review: review() });
};
