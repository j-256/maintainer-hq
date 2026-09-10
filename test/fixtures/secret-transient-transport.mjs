import assert from "node:assert/strict";
import {
  TRANSIENT_VALUE,
  TRANSIENT_FINGERPRINT,
  transientCompleted,
  transientReview,
} from "./secret-transient-review.ts";

const mode = process.env.HQ_TRANSIENT_INPUT_MODE;
let completed = mode === "completed";
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "http://127.0.0.1:5178");
  assert.equal(init.redirect, "error");
  assert.equal(new Headers(init.headers).get("Authorization"), null);
  if (url.pathname === "/api/commands/secrets_review") {
    assert.deepEqual(JSON.parse(init.body), {
      workspaceId: "alpha",
      reviewId: "review",
    });
    return Response.json(
      completed
        ? transientCompleted()
        : transientReview(
            mode === "expired" ? { expiresAt: "2000-01-01T00:00:00.000Z" } : {},
          ),
    );
  }
  assert.equal(url.pathname, "/api/secrets/transient-input");
  assert.equal(url.searchParams.get("workspaceId"), "alpha");
  assert.equal(url.searchParams.get("reviewId"), "review");
  assert.equal(url.searchParams.get("destinationIndex"), "0");
  assert.equal(
    new Headers(init.headers).get("If-Match"),
    TRANSIENT_FINGERPRINT,
  );
  assert.deepEqual(JSON.parse(init.body), {
    version: 1,
    value: TRANSIENT_VALUE,
  });
  completed = true;
  if (mode === "lost") throw new Error("Synthetic lost private receipt");
  return Response.json({ inputConsumed: true, review: transientCompleted() });
};
