import assert from "node:assert/strict";
import { test } from "node:test";
import { callCommand, clientConfiguration } from "../cli/client";
import { command, RequestError } from "../src/lib/api";
import {
  secretCommandTimeout,
  SECRET_CLIENT_TIMEOUTS,
  SECRET_REQUEST_INTERRUPTED,
} from "../shared/secret-command-timeouts";

const configuration = clientConfiguration("http://127.0.0.1:5179", true);
const input = {
  workspaceId: "alpha",
  reviewId: "review",
  fingerprint: "sha256:" + "a".repeat(64),
  destinationIndex: 0,
};
test("Secrets budgets distinguish provider reads, preparation, execution, and ordinary metadata", () => {
  assert.equal(
    secretCommandTimeout("secrets_review"),
    SECRET_CLIENT_TIMEOUTS.METADATA_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_scopes"),
    SECRET_CLIENT_TIMEOUTS.PROVIDER_READ_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_reconcile"),
    SECRET_CLIENT_TIMEOUTS.PROVIDER_READ_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_draft"),
    SECRET_CLIENT_TIMEOUTS.PREPARATION_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_recovery_plan"),
    SECRET_CLIENT_TIMEOUTS.PREPARATION_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_cleanup_plan"),
    SECRET_CLIENT_TIMEOUTS.PREPARATION_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_run"),
    SECRET_CLIENT_TIMEOUTS.EXECUTION_MS,
  );
  assert.equal(
    secretCommandTimeout("secrets_cleanup_apply"),
    SECRET_CLIENT_TIMEOUTS.EXECUTION_MS,
  );
  assert.equal(secretCommandTimeout("workspace_snapshot"), undefined);
});
test("browser and CLI share the execution budget and do not retry incomplete receipts", async (context) => {
  const budgets: number[] = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    budgets.push(milliseconds);
    return new AbortController().signal;
  });
  const fetcher = context.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, "error");
      return new Response("synthetic-private-proxy-canary", {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  await assert.rejects(callCommand(configuration, "secrets_run", input), {
    message: SECRET_REQUEST_INTERRUPTED,
  });
  await assert.rejects(command("secrets_run", input), {
    message: SECRET_REQUEST_INTERRUPTED,
    code: "secret_request_interrupted",
  });
  assert.equal(fetcher.mock.callCount(), 2);
  assert.deepEqual(budgets, [
    SECRET_CLIENT_TIMEOUTS.EXECUTION_MS,
    SECRET_CLIENT_TIMEOUTS.EXECUTION_MS,
  ]);
});
test("browser read cancellation is preserved while its own timeout has actionable safe guidance", async (context) => {
  const deadline = new AbortController();
  const caller = new AbortController();
  let cancelCaller = false;
  const fresh = new AbortController();
  context.mock.method(AbortSignal, "timeout", () =>
    cancelCaller ? fresh.signal : deadline.signal,
  );
  context.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      if (cancelCaller)
        caller.abort(new DOMException("Cancelled by caller", "AbortError"));
      else
        deadline.abort(
          new DOMException("synthetic-private-canary", "TimeoutError"),
        );
      init.signal!.throwIfAborted();
    },
  );
  await assert.rejects(
    command("secrets_review", { workspaceId: "alpha", reviewId: "review" }),
    { message: SECRET_REQUEST_INTERRUPTED },
  );
  cancelCaller = true;
  await assert.rejects(command("secrets_review", {}, caller.signal), {
    name: "AbortError",
  });
});
test("provider refusal and unrelated browser requests retain their existing semantics", async (context) => {
  let unrelated = false;
  context.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      if (unrelated) {
        assert.equal(init.signal, undefined);
        return Response.json({ okay: true });
      }
      return Response.json(
        {
          error: { code: "revision_conflict", message: "The review changed." },
        },
        { status: 409 },
      );
    },
  );
  await assert.rejects(
    command("secrets_apply", input),
    (error: unknown) =>
      error instanceof RequestError &&
      error.status === 409 &&
      error.message === "The review changed.",
  );
  unrelated = true;
  assert.deepEqual(
    await command("workspace_snapshot", { workspaceId: "alpha" }),
    { okay: true },
  );
});
