import assert from "node:assert/strict";
import { test } from "node:test";
import { command, request, RequestError } from "../src/lib/api";
import { callCommand, clientConfiguration } from "../cli/client";

const PRIVATE = "synthetic-private-response-canary";
const input = {
  workspaceId: "alpha",
  eventId: "stable-note",
  kind: "note",
  title: "An exact retry",
  summary: "Synthetic transport verification",
  resourceId: null,
  goalId: null,
};

test("ordinary browser and CLI writes keep malformed receipts private without retrying", async (context) => {
  const fetcher = context.mock.method(globalThis, "fetch", async () => new Response(PRIVATE, {
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(command("activity_add", input), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, "response_interrupted");
    assert.equal(error.status, 0);
    assert.match(error.message, /may have succeeded/i);
    assert.doesNotMatch(error.message, new RegExp(PRIVATE));
    return true;
  });
  await assert.rejects(callCommand(clientConfiguration("http://127.0.0.1:5179", true),
    "activity_add", input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Inspect the workspace/);
    assert.doesNotMatch(error.message, new RegExp(PRIVATE));
    return true;
  });
  assert.equal(fetcher.mock.callCount(), 2);
});

test("a body interrupted after successful headers becomes safe recovery guidance", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(PRIVATE)); },
  }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(request("/api/session"), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, "response_interrupted");
    assert.doesNotMatch(error.message, new RegExp(PRIVATE));
    return true;
  });
});

test("caller cancellation during body reading stays a cancellation", async (context) => {
  const caller = new AbortController();
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      caller.abort(new DOMException("Cancelled", "AbortError"));
      controller.error(caller.signal.reason);
    },
  }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(request("/api/session", { signal: caller.signal }), { name: "AbortError" });
});
