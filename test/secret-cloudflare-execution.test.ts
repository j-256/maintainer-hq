import { applyD1Migrations, env } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Env } from "../worker/types";
import { SecretOperations } from "../worker/secret-operations";
import { SecretReviews } from "../worker/secret-reviews";
import { createApplication } from "../worker/app";
import {
  secretStagedInputReady,
  type SecretDestination,
  type SecretReview,
} from "../shared/secrets";
import { CAPABILITY, DEFAULT_EXPECTATIONS } from "../shared/domain";
import {
  CF_VALUE,
  CF_TOKEN,
  cfSettings,
  cloudflareSecretsFixture,
} from "./fixtures/cloudflare-secrets";
import { D1_VOLUME_TEST_TIMEOUT_MS } from "./helpers/timeouts";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
let fixture: Awaited<ReturnType<typeof cloudflareSecretsFixture>>;
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  fixture = await cloudflareSecretsFixture(bindings);
  await fixture.install();
  await fixture.saved();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function destination(
  extra: Partial<SecretDestination> = {},
): SecretDestination {
  return {
    connectionId: "workers",
    connectionRevision: 1,
    target: fixture.target,
    name: "NewToken",
    ...extra,
  };
}
const secondTarget = {
  resourceId: "worker-second-worker",
  scope: { kind: "worker" as const },
};
async function draft(
  destinations = [destination()],
  source: SecretDestination | null = null,
) {
  return fixture.as().secretsDraft({
    ...workspace,
    reviewId: crypto.randomUUID(),
    destinations,
    source,
  });
}
const selection = (review: SecretReview, destinationIndex = 0) => ({
  ...workspace,
  reviewId: review.id,
  fingerprint: review.fingerprint!,
  destinationIndex,
});
async function accept(review = draft()) {
  const prepared = await review;
  return fixture
    .as()
    .secretsApply({
      ...workspace,
      reviewId: prepared.id,
      fingerprint: prepared.fingerprint!,
    });
}
function privateRequest(
  review: SecretReview,
  value = CF_VALUE,
  destinationIndex = 0,
) {
  return new Request(
    "https://hq.example/api/secrets/transient-input?" +
      new URLSearchParams({
        ...workspace,
        reviewId: review.id,
        destinationIndex: String(destinationIndex),
      }),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": review.fingerprint!,
        Origin: "https://hq.example",
      },
      body: JSON.stringify({ version: 1, value }),
    },
  );
}
function supply(
  review: SecretReview,
  value = CF_VALUE,
  destinationIndex = 0,
  request = privateRequest(review, value, destinationIndex),
) {
  return new SecretOperations(fixture.as()).supply(request, {
    ...workspace,
    reviewId: review.id,
    destinationIndex: String(destinationIndex),
  });
}
const writes = () =>
  fixture.request.mock.calls.filter((call) => call[1]?.method !== "GET");
async function artifacts() {
  const names = [
    "secret_reviews",
    "secret_payloads",
    "secret_operations",
    "secret_receipts",
    "secret_cleanup_reviews",
    "action_plans",
    "activity",
  ];
  return JSON.stringify(
    await Promise.all(
      names.map((name) =>
        bindings.HQ_DB.prepare("SELECT * FROM " + name).all(),
      ),
    ),
  );
}
function unread(request: Request) {
  const read = vi.fn(() => {
    throw new Error("Private body must not be read");
  });
  Object.defineProperty(request, "body", { get: read });
  return read;
}
describe("reviewed transient Cloudflare execution", () => {
  it("stages only sealed destination indexes in a mixed distribution and executes each input kind through its own boundary", async () => {
    fixture.runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
      selected: {
        workspaceId: "alpha",
        name: "Actions",
        revision: 1,
        token: CF_TOKEN,
        expiresAt: "2099-01-01T00:00:00.000Z",
        repositoryNames: ["example/repo"],
        writable: true,
      },
    });
    await bindings.HQ_DB.prepare(
      "INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('repo','alpha','example/repo','','project','maintained','active',?,?,'initial')",
    )
      .bind(
        JSON.stringify(DEFAULT_EXPECTATIONS),
        new Date(fixture.state.now).toISOString(),
      )
      .run();
    await fixture.as().secretsConnectionSave({
      ...workspace,
      connectionId: "actions",
      revision: 0,
      connection: {
        name: "Actions",
        providerKind: "github-actions",
        providerRef: "selected",
        resourceIds: ["repo"],
        enabled: true,
      },
    });
    const cloudflare = fixture.request.getMockImplementation()!;
    let githubWritten = false;
    const ciphertext = btoa("a".repeat(80));
    fixture.request.mockImplementation(async (url, init) => {
      if (new URL(String(url)).origin !== "https://api.github.com")
        return cloudflare(url, init);
      const path = new URL(String(url)).pathname;
      if (path === "/repos/example/repo")
        return Response.json({
          id: 42,
          full_name: "example/repo",
          archived: false,
          disabled: false,
          owner: { id: 7, login: "example", type: "Organization" },
        });
      if (path.endsWith("/public-key"))
        return Response.json({ key_id: "key", key: "A".repeat(43) + "=" });
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({
          key_id: "key",
          encrypted_value: ciphertext,
        });
        githubWritten = true;
        return new Response(null, { status: 204 });
      }
      return githubWritten
        ? Response.json({
            name: "GH_TOKEN",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          })
        : new Response(null, { status: 404 });
    });
    const review = await draft([
      destination(),
      destination({
        connectionId: "actions",
        target: { resourceId: "repo", scope: { kind: "repository" } },
        name: "GH_TOKEN",
      }),
      destination({ target: secondTarget }),
    ]);
    expect(review.stage).toBe("awaiting-input");
    expect(secretStagedInputReady(review)).toBe(false);
    const reviews = new SecretReviews(fixture.as());
    function sealed(items: { destinationIndex: number; ciphertext: string }[]) {
      return reviews.upload(
        new Request("https://hq.example/api/secrets/input", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "If-Match": review.draftFingerprint,
          },
          body: JSON.stringify({ version: 1, items }),
        }),
        { ...workspace, reviewId: review.id },
      );
    }
    await expect(
      sealed([{ destinationIndex: 0, ciphertext }]),
    ).rejects.toMatchObject({ code: "secret_input_invalid" });
    const uploaded = await sealed([{ destinationIndex: 1, ciphertext }]);
    expect(uploaded.inputPresent).toBe(true);
    expect(uploaded.stage).toBe("reviewed");
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT destination_index FROM secret_payloads",
        ).all()
      ).results,
    ).toEqual([{ destination_index: 1 }]);
    const accepted = await accept(Promise.resolve(uploaded));
    expect(
      (await supply(accepted)).review.operation?.receipts[0]?.writeStatus,
    ).toBe("accepted");
    expect(
      (await fixture.as().secretsRun(selection(accepted, 1))).operation
        ?.receipts[1]?.writeStatus,
    ).toBe("accepted");
    const final = await supply(accepted, CF_VALUE, 2);
    expect(
      final.review.operation?.receipts.map((receipt) => receipt.writeStatus),
    ).toEqual(["accepted", "accepted", "accepted"]);
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    expect(await artifacts()).not.toContain(CF_VALUE);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("prepares metadata-only intent without pretending a supplied value was stored", async () => {
    const review = await draft();
    expect(review.stage).toBe("reviewed");
    expect(review.fingerprint).toBe(review.draftFingerprint);
    expect(review.inputPresent).toBe(false);
    expect(secretStagedInputReady(review)).toBe(true);
    const row = await new SecretReviews(fixture.as()).row("alpha", review.id);
    expect(row.input_hash).toBeNull();
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    const request = privateRequest(review);
    const read = unread(request);
    await expect(
      new SecretReviews(fixture.as()).upload(request, {
        ...workspace,
        reviewId: review.id,
      }),
    ).rejects.toMatchObject({ code: "secret_input_unsupported" });
    expect(read).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it("persists submission before the native write and never retains private transient input", async () => {
    const review = await accept();
    await expect(
      fixture.as().secretsRun(selection(review)),
    ).rejects.toMatchObject({ code: "secret_transient_input_required" });
    expect(
      (await fixture.as().secretsReview({ ...workspace, reviewId: review.id }))
        .operation?.receipts[0]?.phase,
    ).toBe("pending");
    expect(writes()).toEqual([]);
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (url, init) => {
      if (init?.method === "PUT") {
        expect(
          await bindings.HQ_DB.prepare(
            "SELECT phase,submitted_at FROM secret_receipts WHERE review_id=?",
          )
            .bind(review.id)
            .first(),
        ).toMatchObject({
          phase: "submitted",
          submitted_at: expect.any(String),
        });
      }
      return original(url, init);
    });
    const value = CF_VALUE + "\n\u03bb\u0000";
    const supplied = await supply(review, value);
    expect(supplied.inputConsumed).toBe(true);
    expect(supplied.review.operation?.receipts[0]).toMatchObject({
      phase: "finished",
      writeStatus: "accepted",
      observationStatus: "present",
      metadata: { name: "NewToken", updatedAt: null, createdAt: null },
    });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0]![1]!.body)).text).toBe(value);
    const stored = await artifacts();
    for (const canary of [CF_TOKEN, CF_VALUE]) {
      expect(stored).not.toContain(canary);
      expect(JSON.stringify(supplied)).not.toContain(canary);
    }
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    const repeated = privateRequest(review, "a different value");
    const read = unread(repeated);
    expect(await supply(review, "ignored", 0, repeated)).toMatchObject({
      inputConsumed: false,
      review: {
        operation: {
          receipts: [expect.objectContaining({ writeStatus: "accepted" })],
        },
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
  it("rejects wrong actors, workspace, credentials, fingerprints and unaccepted reviews before reading input", async () => {
    const prepared = await draft();
    const before = privateRequest(prepared);
    const beforeRead = unread(before);
    await expect(supply(prepared, CF_VALUE, 0, before)).rejects.toMatchObject({
      code: "secret_review_conflict",
    });
    expect(beforeRead).not.toHaveBeenCalled();
    const review = await accept(Promise.resolve(prepared));
    for (const service of [
      fixture.as("second"),
      fixture.as("viewer"),
      fixture.as("outside"),
      fixture.as("owner", { sourceId: "publisher" }),
      fixture.as("owner", { scopes: [CAPABILITY.READ] }),
    ]) {
      const request = privateRequest(review);
      const read = unread(request);
      await expect(
        new SecretOperations(service).supply(request, {
          ...workspace,
          reviewId: review.id,
          destinationIndex: "0",
        }),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    }
    const request = privateRequest(review);
    request.headers.set("If-Match", "sha256:" + "a".repeat(64));
    const read = unread(request);
    await expect(supply(review, CF_VALUE, 0, request)).rejects.toMatchObject({
      code: "secret_review_conflict",
    });
    expect(read).not.toHaveBeenCalled();
    await fixture.install(cfSettings, 1);
    const changed = privateRequest(review);
    const changedRead = unread(changed);
    await expect(supply(review, CF_VALUE, 0, changed)).rejects.toMatchObject({
      code: "secret_review_conflict",
    });
    expect(changedRead).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it("bounds transient bytes, rejects malformed envelopes and preserves pending receipts for bad input", async () => {
    const review = await accept();
    for (const body of [
      { version: 1, value: "" },
      { version: 1, value: "\ud800" },
      { version: 1, value: "\u03bb".repeat(2561) },
      { version: 1, value: CF_VALUE, ciphertext: CF_VALUE },
      { version: 1, token: CF_VALUE },
    ]) {
      const base = privateRequest(review);
      const request = new Request(base.url, {
        method: "POST",
        headers: base.headers,
        body: JSON.stringify(body),
      });
      await expect(supply(review, CF_VALUE, 0, request)).rejects.toMatchObject({
        code: "secret_input_invalid",
      });
    }
    expect(writes()).toEqual([]);
    expect(
      (await fixture.as().secretsReview({ ...workspace, reviewId: review.id }))
        .operation?.receipts[0]?.phase,
    ).toBe("pending");
    expect(
      (await supply(review, "\u0000".repeat(5120))).review.operation
        ?.receipts[0]?.writeStatus,
    ).toBe("accepted");
  });
  it("refuses changed serving deployment or identity before submission", async () => {
    for (const change of ["deploymentId", "workerId"] as const) {
      const review = await accept();
      fixture.state[change] =
        change === "workerId" ? "d".repeat(32) : crypto.randomUUID();
      const result = await supply(review);
      expect(result.review.operation?.receipts[0]).toMatchObject({
        phase: "finished",
        writeStatus: "not-sent",
        reason: "preflight_changed",
        submittedAt: null,
      });
    }
    expect(writes()).toEqual([]);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("rechecks authority after consuming input and never persists a value when authority changes", async () => {
    const review = await accept();
    const base = privateRequest(review);
    let emitted = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (emitted) return;
          emitted = true;
          await fixture.install(cfSettings, 1);
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ version: 1, value: CF_VALUE }),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(base.url, {
      method: "POST",
      headers: base.headers,
      body,
    });
    await expect(supply(review, CF_VALUE, 0, request)).rejects.toMatchObject({
      code: "secret_review_conflict",
    });
    expect(writes()).toEqual([]);
    expect(await artifacts()).not.toContain(CF_VALUE);
  });
  it("does not replay uncertain writes and never offers retained-input recovery for Cloudflare", async () => {
    const review = await accept();
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (init?.method === "PUT") throw new Error(CF_VALUE);
      return response;
    });
    const result = await supply(review);
    expect(result.review.operation?.receipts[0]).toMatchObject({
      writeStatus: "indeterminate",
      observationStatus: "unknown",
      reason: "provider_result_uncertain",
    });
    expect(writes()).toHaveLength(1);
    const reconciled = await fixture.as().secretsReconcile({
      ...workspace,
      reviewId: review.id,
      destinationIndex: 0,
    });
    expect(reconciled.operation?.receipts[0]).toMatchObject({
      writeStatus: "indeterminate",
      observationStatus: "present",
    });
    const repeated = privateRequest(review);
    const read = unread(repeated);
    expect((await supply(review, CF_VALUE, 0, repeated)).inputConsumed).toBe(
      false,
    );
    expect(read).not.toHaveBeenCalled();
    await expect(
      fixture.as().secretsRecoveryPlan({
        ...selection(review),
        newReviewId: "recovery",
        acknowledgePossibleOverwrite: true,
      }),
    ).rejects.toMatchObject({ code: "secret_recovery_input_unavailable" });
    expect(writes()).toHaveLength(1);
    expect(await artifacts()).not.toContain(CF_VALUE);
  });
  it("serializes competing private requests and settles interrupted submissions without consuming a retry", async () => {
    const review = await accept();
    const results = await Promise.allSettled([supply(review), supply(review)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(writes()).toHaveLength(1);
    const pending = await accept();
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "UPDATE secret_operations SET lease_id='lost',lease_expires_at=? WHERE review_id=?",
      ).bind(new Date(fixture.state.now - 1000).toISOString(), pending.id),
      bindings.HQ_DB.prepare(
        "UPDATE secret_receipts SET phase='submitted',submitted_at=? WHERE review_id=?",
      ).bind(new Date(fixture.state.now - 2000).toISOString(), pending.id),
    ]);
    const repeated = privateRequest(pending);
    const read = unread(repeated);
    const settled = await supply(pending, CF_VALUE, 0, repeated);
    expect(settled).toMatchObject({
      inputConsumed: false,
      review: {
        operation: {
          receipts: [
            expect.objectContaining({
              phase: "finished",
              writeStatus: "indeterminate",
              reason: "execution_interrupted",
            }),
          ],
        },
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });
  it("keeps distinct Worker steps independent and rejects self-invalidating same-Worker selections", async () => {
    const review = await accept(
      draft([destination(), destination({ target: secondTarget })]),
    );
    expect(
      (await supply(review)).review.operation?.receipts[0]?.writeStatus,
    ).toBe("accepted");
    const result = await supply(review, CF_VALUE, 1);
    expect(
      result.review.operation?.receipts.map((receipt) => receipt.writeStatus),
    ).toEqual(["accepted", "accepted"]);
    for (const args of [
      {
        destinations: [destination(), destination({ name: "AnotherToken" })],
        source: null,
      },
      { destinations: [destination()], source: destination({ name: "Token" }) },
    ])
      await expect(draft(args.destinations, args.source)).rejects.toMatchObject(
        { code: "secret_worker_distribution_conflict" },
      );
    expect(writes()).toHaveLength(2);
  });
  it("removes a separately reviewed source only after accepted destination evidence and rejects later deployment changes", async () => {
    const review = await accept(
      draft(
        [destination({ target: secondTarget })],
        destination({ name: "Token" }),
      ),
    );
    await supply(review);
    const cleanup = await fixture.as().secretsCleanupPlan({
      ...workspace,
      reviewId: review.id,
      fingerprint: review.fingerprint!,
      cleanupId: "cleanup",
      acknowledgeNonAtomicMove: true,
    });
    expect(cleanup.source.snapshot.activation).toBe("worker-deployment");
    const removed = await fixture.as().secretsCleanupApply({
      ...workspace,
      cleanupId: cleanup.id,
      fingerprint: cleanup.fingerprint,
    });
    expect(removed.receipt).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "absent",
    });
    expect(writes().map((call) => call[1]?.method)).toEqual(["PUT", "DELETE"]);
    await fixture.as().secretsCleanupApply({
      ...workspace,
      cleanupId: cleanup.id,
      fingerprint: cleanup.fingerprint,
    });
    expect(writes()).toHaveLength(2);
    fixture.state.secrets = [{ name: "Token", type: "secret_text" }];
    const changed = await accept(
      draft(
        [destination({ target: secondTarget })],
        destination({ name: "Token" }),
      ),
    );
    await supply(changed);
    fixture.state.deploymentId = crypto.randomUUID();
    await expect(
      fixture.as().secretsCleanupPlan({
        ...workspace,
        reviewId: changed.id,
        fingerprint: changed.fingerprint!,
        cleanupId: "changed",
        acknowledgeNonAtomicMove: true,
      }),
    ).rejects.toMatchObject({ code: "secret_cleanup_source_changed" });
    expect(
      writes().filter((call) => call[1]?.method === "DELETE"),
    ).toHaveLength(1);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("enforces same-origin and safe error logging at the HTTP private-input boundary", async () => {
    const review = await accept();
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrongOrigin = privateRequest(review);
    wrongOrigin.headers.set("Origin", "https://untrusted.example");
    const read = unread(wrongOrigin);
    expect((await app.fetch(wrongOrigin, fixture.runtime)).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    const invalid = privateRequest(review, "\ud800" + CF_VALUE);
    const rejected = await app.fetch(invalid, fixture.runtime);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(CF_VALUE);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(CF_VALUE);
    const response = await app.fetch(privateRequest(review), fixture.runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      inputConsumed: true,
      review: {
        operation: {
          receipts: [expect.objectContaining({ writeStatus: "accepted" })],
        },
      },
    });
  });
});
