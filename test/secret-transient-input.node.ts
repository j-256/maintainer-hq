import assert from "node:assert/strict";
import { test } from "node:test";
import { supplyTransientSecret } from "../shared/secret-transient-input";
import { supplyBrowserTransientSecret } from "../src/lib/secret-input";
import {
  supplyTransientSecretInput,
  secretTransientEnvironmentInput,
} from "../cli/secret-transient-input";
import { clientConfiguration } from "../cli/client";
import { SECRET_CLIENT_TIMEOUTS } from "../shared/secret-command-timeouts";
import {
  TRANSIENT_VALUE,
  TRANSIENT_FINGERPRINT,
  transientReview,
  transientCompleted,
} from "./fixtures/secret-transient-review";
import { SECRET_LIMITS } from "../shared/secrets";

const selected = {
  workspaceId: "alpha",
  reviewId: "review",
  fingerprint: TRANSIENT_FINGERPRINT,
  destinationIndex: 0,
};
test("private execution rejects oversized or mismatched receipts without exposing input or replaying effects", async () => {
  for (const response of [
    Response.json({
      inputConsumed: true,
      review: { ...transientCompleted(), id: "another-review" },
    }),
    Response.json({
      inputConsumed: true,
      review: { ...transientCompleted(), actorMatches: false },
    }),
    new Response("x".repeat(SECRET_LIMITS.REVIEW_RESPONSE_BYTES + 1), {
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    const bytes = new TextEncoder().encode(TRANSIENT_VALUE);
    let sends = 0;
    await assert.rejects(
      supplyTransientSecret({
        selection: selected,
        review: async () => transientReview(),
        read: async () => bytes,
        send: async () => {
          sends++;
          return response;
        },
      }),
      (error: Error & { uncertain?: boolean }) =>
        error.uncertain === true && !error.message.includes(TRANSIENT_VALUE),
    );
    assert.equal(sends, 1);
    assert.ok(bytes.every((value) => value === 0));
  }
});
test("transient input verifies exact accepted review and original actor before reading private input", async () => {
  for (const changed of [
    transientReview({ id: "other" }),
    transientReview({ fingerprint: "sha256:" + "b".repeat(64) }),
    transientReview({ actorMatches: false }),
    transientReview({ stage: "reviewed" }),
    transientReview({ expiresAt: "2000-01-01T00:00:00.000Z" }),
    transientReview({ operation: null }),
  ]) {
    let reads = 0;
    let sends = 0;
    await assert.rejects(
      supplyTransientSecret({
        selection: selected,
        review: async () => changed,
        read: async () => {
          reads++;
          return new Uint8Array();
        },
        send: async () => {
          sends++;
          return new Response();
        },
      }),
    );
    assert.equal(reads, 0);
    assert.equal(sends, 0);
  }
  let reads = 0;
  const completed = await supplyTransientSecret({
    selection: selected,
    review: async () => transientCompleted(),
    read: async () => {
      reads++;
      return new Uint8Array();
    },
    send: async () => {
      throw Error("No private input expected");
    },
  });
  assert.equal(completed.inputConsumed, false);
  assert.equal(reads, 0);
  assert.equal(
    secretTransientEnvironmentInput.safeParse({
      ...selected,
      environmentVariable: "HQ_TEST_VALUE",
      value: TRANSIENT_VALUE,
    }).success,
    false,
  );
});
test("transient input preserves BOM, CRLF, Unicode and trailing bytes and clears owned input on every outcome", async () => {
  for (const invalid of [false, true]) {
    const bytes = new TextEncoder().encode(TRANSIENT_VALUE);
    let sends = 0;
    const result = supplyTransientSecret({
      selection: selected,
      review: async () => transientReview(),
      read: async () => bytes,
      send: async (path, init) => {
        sends++;
        assert.equal(
          path,
          "/api/secrets/transient-input?workspaceId=alpha&reviewId=review&destinationIndex=0",
        );
        assert.equal(init.redirect, "error");
        assert.deepEqual(JSON.parse(String(init.body)), {
          version: 1,
          value: TRANSIENT_VALUE,
        });
        if (invalid) throw Error(TRANSIENT_VALUE);
        return Response.json({
          inputConsumed: true,
          review: transientCompleted(),
        });
      },
    });
    if (invalid)
      await assert.rejects(
        result,
        (error: Error) =>
          !error.message.includes(TRANSIENT_VALUE) &&
          /interrupted or refused/.test(error.message),
      );
    else
      assert.equal(
        (await result).review.operation?.receipts[0]?.writeStatus,
        "accepted",
      );
    assert.equal(sends, 1);
    assert.ok(bytes.every((value) => value === 0));
  }
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([0xff]),
    new Uint8Array(5121),
  ]) {
    await assert.rejects(
      supplyTransientSecret({
        selection: selected,
        review: async () => transientReview(),
        read: async () => bytes,
        send: async () => {
          throw Error("No private request expected");
        },
      }),
    );
    assert.ok(bytes.every((value) => value === 0));
  }
});
test("browser and CLI clients share the private protocol, preserve safe headers and return no values", async () => {
  const original = globalThis.fetch;
  try {
    for (const browser of [false, true]) {
      const value = new TextEncoder().encode(TRANSIENT_VALUE);
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "http://127.0.0.1:5178");
        if (url.pathname.startsWith("/api/commands/"))
          return Response.json(transientReview());
        assert.equal(url.pathname, "/api/secrets/transient-input");
        assert.equal(
          new Headers(init?.headers).get("If-Match"),
          TRANSIENT_FINGERPRINT,
        );
        if (browser) assert.equal(init?.credentials, "same-origin");
        else assert.equal(new Headers(init?.headers).get("X-HQ-Client"), "cli");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          version: 1,
          value: TRANSIENT_VALUE,
        });
        return Response.json({
          inputConsumed: true,
          review: transientCompleted(),
        });
      };
      const result = browser
        ? await supplyBrowserTransientSecret(
            "alpha",
            transientReview(),
            0,
            () => value,
          )
        : await supplyTransientSecretInput(
            clientConfiguration("http://127.0.0.1:5178", true),
            selected,
            async () => value,
          );
      assert.ok(!JSON.stringify(result).includes(TRANSIENT_VALUE));
      assert.ok(value.every((byte) => byte === 0));
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("private execution bounds both response headers and stalled bodies even if fetch ignores abort", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const body of [false, true]) {
    const value = new TextEncoder().encode(TRANSIENT_VALUE);
    let sending!: () => void;
    const started = new Promise<void>((resolve) => {
      sending = resolve;
    });
    const result = supplyTransientSecret({
      selection: selected,
      review: async () => transientReview(),
      read: async () => value,
      send: async () => {
        sending();
        return body
          ? new Response(new ReadableStream(), {
              headers: { "Content-Type": "application/json" },
            })
          : new Promise<Response>(() => {});
      },
    });
    const rejected = assert.rejects(result, /interrupted or refused/);
    await started;
    context.mock.timers.tick(SECRET_CLIENT_TIMEOUTS.EXECUTION_MS + 1);
    await rejected;
    assert.ok(value.every((byte) => byte === 0));
  }
});
