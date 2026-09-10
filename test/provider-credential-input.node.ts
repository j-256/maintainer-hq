import assert from "node:assert/strict";
import { test } from "node:test";
import { supplyProviderCredential } from "../shared/provider-credential-input";
import {
  PROVIDER_CREDENTIAL_LIMITS,
  type ProviderCredentialReview,
} from "../shared/provider-credentials";
import {
  supplyProviderCredentialInput,
  providerCredentialEnvironmentInput,
} from "../cli/provider-credential-input";
import { clientConfiguration } from "../cli/client";
import { supplyBrowserCredential } from "../src/lib/provider-credential-input";

const PRIVATE = "synthetic-private-credential-input-canary";
const selected = {
  workspaceId: "alpha",
  planId: "review",
  fingerprint: "sha256:" + "a".repeat(64),
};
function review(
  extra: Partial<ProviderCredentialReview> = {},
): ProviderCredentialReview {
  return {
    id: "review",
    credentialId: "managed-actions",
    revision: 0,
    change: {
      kind: "save",
      replaceToken: true,
      settings: {
        providerKind: "github-actions",
        name: "Synthetic credential",
        writable: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        scope: { repositoryNames: ["example/repo"] },
      },
    },
    fingerprint: selected.fingerprint,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    appliedAt: null,
    actorMatches: true,
    connections: [],
    pendingReviews: 0,
    unsettledDestinations: 0,
    ...extra,
  };
}
test("private credential clients check exact review authority before reading or submitting input", async () => {
  for (const changed of [
    review({ id: "other" }),
    review({ actorMatches: false }),
    review({ fingerprint: "sha256:" + "b".repeat(64) }),
    review({ expiresAt: "2000-01-01T00:00:00.000Z" }),
    review({ change: { kind: "retire" } }),
  ]) {
    let reads = 0;
    let sends = 0;
    await assert.rejects(
      supplyProviderCredential({
        selection: selected,
        review: async () => changed,
        read: async () => {
          reads++;
          return new TextEncoder().encode(PRIVATE);
        },
        send: async () => {
          sends++;
          return Response.json({});
        },
      }),
    );
    assert.equal(reads, 0);
    assert.equal(sends, 0);
  }
});
test("applied credential reviews never read or compare replacement tokens, even after review expiry", async () => {
  const saved = review({
    appliedAt: new Date().toISOString(),
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const result = await supplyProviderCredential({
    selection: selected,
    review: async () => saved,
    read: async () => {
      throw new Error("Must not read input");
    },
    send: async () => {
      throw new Error("Must not submit input");
    },
  });
  assert.deepEqual(result, { submitted: false, review: saved });
});
test("shared credential input preserves exact token bytes and clears owned buffers after acceptance", async () => {
  const value = new TextEncoder().encode(PRIVATE);
  const expected = review();
  const result = await supplyProviderCredential({
    selection: selected,
    review: async () => expected,
    read: async () => value,
    send: async (path, init) => {
      assert.equal(
        path,
        "/api/provider-credentials/input?workspaceId=alpha&planId=review",
      );
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("If-Match"),
        selected.fingerprint,
      );
      assert.deepEqual(JSON.parse(String(init.body)), {
        version: 1,
        token: PRIVATE,
      });
      return Response.json({
        submitted: true,
        review: { ...expected, appliedAt: new Date().toISOString() },
      });
    },
  });
  assert.equal(result.submitted, true);
  assert.ok(value.every((byte) => byte === 0));
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});
test("token validation rejects whitespace, non-ASCII and oversize instead of silently trimming", async () => {
  for (const text of [
    "",
    "token\n",
    "token with spaces",
    "token-\u03bb",
    "x".repeat(PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES + 1),
  ]) {
    const value = new TextEncoder().encode(text);
    await assert.rejects(
      supplyProviderCredential({
        selection: selected,
        review: async () => review(),
        read: async () => value,
        send: async () => {
          assert.fail("No token should be sent");
        },
      }),
      /Nothing was submitted/,
    );
    assert.ok(value.every((byte) => byte === 0));
  }
});
test("lost, altered, oversized and non-JSON receipts produce safe uncertainty and clear input without retry", async () => {
  for (const failure of ["lost", "identity", "oversize", "proxy", "shape"]) {
    const value = new TextEncoder().encode(PRIVATE);
    let calls = 0;
    await assert.rejects(
      supplyProviderCredential({
        selection: selected,
        review: async () => review(),
        read: async () => value,
        send: async () => {
          calls++;
          if (failure === "lost") throw new Error(PRIVATE);
          if (failure === "proxy")
            return new Response(PRIVATE, { status: 502 });
          if (failure === "oversize")
            return new Response(
              "x".repeat(PROVIDER_CREDENTIAL_LIMITS.RESPONSE_BYTES + 1),
              { headers: { "Content-Type": "application/json" } },
            );
          if (failure === "shape") return Response.json({ token: PRIVATE });
          return Response.json({
            submitted: true,
            review: review({
              id: "wrong",
              appliedAt: new Date().toISOString(),
            }),
          });
        },
      }),
      (error: Error) =>
        error.message.includes("uncertain") && !error.message.includes(PRIVATE),
    );
    assert.equal(calls, 1);
    assert.ok(value.every((byte) => byte === 0));
  }
});
test("a stalled receipt is deadline-bounded even when its body ignores the abort signal", async (context) => {
  let timeout: (() => void) | undefined;
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    timeout = callback;
    return 0;
  });
  const value = new TextEncoder().encode(PRIVATE);
  let cancelled = false;
  await assert.rejects(
    supplyProviderCredential({
      selection: selected,
      review: async () => review(),
      read: async () => value,
      send: async () =>
        new Response(
          new ReadableStream({
            pull: () => {
              timeout?.();
            },
            cancel: () => {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    }),
    /uncertain/,
  );
  assert.equal(cancelled, true);
  assert.ok(value.every((byte) => byte === 0));
});
test("CLI and browser wrappers preserve their intended authentication and never send token values to ordinary commands", async (context) => {
  const expected = review();
  const observed: {
    url: string;
    headers: Headers;
    credentials?: RequestCredentials;
  }[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init: RequestInit) => {
      const path = new URL(String(url), "https://hq.example").pathname;
      observed.push({
        url: String(url),
        headers: new Headers(init.headers),
        credentials: init.credentials,
      });
      if (path === "/api/commands/provider_credential_review") {
        assert.ok(!String(init.body).includes(PRIVATE));
        return Response.json(expected);
      }
      assert.equal(path, "/api/provider-credentials/input");
      return Response.json({
        submitted: true,
        review: { ...expected, appliedAt: new Date().toISOString() },
      });
    },
  );
  await supplyProviderCredentialInput(
    clientConfiguration(
      "https://hq.example",
      false,
      "synthetic-hq-auth",
      undefined,
      undefined,
      undefined,
    ),
    selected,
    async () => new TextEncoder().encode(PRIVATE),
  );
  await supplyBrowserCredential("alpha", expected, async () =>
    new TextEncoder().encode(PRIVATE),
  );
  assert.equal(
    observed[1]!.headers.get("Authorization"),
    "Bearer synthetic-hq-auth",
  );
  assert.equal(observed[3]!.headers.get("Authorization"), null);
  assert.equal(observed[3]!.credentials, "same-origin");
  assert.equal(
    providerCredentialEnvironmentInput.safeParse({
      ...selected,
      environmentVariable: "VALUE",
      token: PRIVATE,
    }).success,
    false,
  );
});
