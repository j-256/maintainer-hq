import { test } from "node:test";
import assert from "node:assert/strict";
import { supplyLifecycleInput } from "../shared/hook-lifecycle-input.ts";
const id = "00000000-0000-4000-8000-000000000001";
const selection = { workspaceId: "alpha", planId: id, fingerprint: "b".repeat(64) };
const review = { id, workspaceId: "alpha", connectionId: "hooks", connectionName: "Synthetic", actorMatches: true, canSupplyPrivate: true, createdAt: new Date().toISOString(), operation: null, authorityId: "a".repeat(32), revision: 1, fingerprint: selection.fingerprint, state: "ready", change: { kind: "destination-create", name: "Synthetic", type: "ntfy" }, before: null, after: { resourceId: id, name: "Synthetic", type: "ntfy" }, affectedSubscriptions: [], privateInputRequired: true, privateInputReceived: false, expiresAt: new Date(Date.now() + 300000).toISOString(), outcome: null, observedAt: new Date().toISOString() };
test("checks exact live actor, workspace, state, private permission and fingerprint before reading material", async () => {
  for (const patch of [{ actorMatches: false }, { workspaceId: "beta" }, { canSupplyPrivate: false }, { fingerprint: "c".repeat(64) }, { state: "expired" }, { expiresAt: "2020-01-01T00:00:00.000Z" }]) {
    let read = false;
    await assert.rejects(supplyLifecycleInput({ selection, review: async () => ({ ...review, ...patch }), read: async () => { read = true; return new Uint8Array(); }, send: async () => { throw new Error(); } }));
    assert.equal(read, false);
  }
});
test("sends only through the fixed private route, returns safe metadata and wipes the input", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }));
  const result = await supplyLifecycleInput({ selection, review: async () => review, read: async () => bytes, send: async (path, init) => {
    assert.equal(path, "/api/hooks/lifecycle-input/" + id);
    assert.equal(new Headers(init.headers).get("x-workspace-id"), "alpha");
    assert.equal(new Headers(init.headers).get("if-match"), selection.fingerprint);
    assert.equal(init.redirect, "error");
    return Response.json({ planId: id, state: "ready", privateInputReceived: true, submitted: true }, { headers: { "cache-control": "no-store" } });
  } });
  assert.equal(result.submitted, true); assert.ok(bytes.every(value => value === 0));
  assert.ok(!JSON.stringify(result).includes("synthetic-private"));
});
test("never reads a new value for consumed input or an existing operation", async () => {
  let read = false;
  const result = await supplyLifecycleInput({ selection, review: async () => ({ ...review, privateInputReceived: true }), read: async () => { read = true; throw new Error(); }, send: async () => { throw new Error(); } });
  assert.equal(result.submitted, false); assert.equal(read, false);
});
