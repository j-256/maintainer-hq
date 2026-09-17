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
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import {
  SECRET_PROVIDER_KIND,
  secretDraftInput,
  secretDestinationSchema,
  secretInventoryItemSchema,
  secretMetadataSchema,
} from "../shared/secrets";
import {
  GITHUB_SECRET_LIMITS as SECRET_LIMITS,
  secretEnvironmentSchema,
  secretNameSchema,
} from "../shared/github-secrets";
import {
  SecretGitHubClient,
  secretProvider,
  secretProviderReferences,
} from "../worker/secret-github-client";
import { secretResourceBindingSchema } from "../worker/secret-adapters";
import { secretAdapter } from "../worker/secret-adapter-registry";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { authorizeHooks, hookActorGuard } from "../worker/hook-authority";
import type { Env } from "../worker/types";
import { SecretReviews } from "../worker/secret-reviews";
import {
  captureSecretCleanupEvidence,
  secretCleanupPathGuard,
} from "../worker/secret-cleanup-evidence";
import {
  readSecretInput,
  reapSecretInputs,
} from "../worker/secret-private-input";
import {
  SECRET_LIMITS as REVIEW_LIMITS,
  type SecretReview,
} from "../shared/secrets";
import { D1_VOLUME_TEST_TIMEOUT_MS } from "./helpers/timeouts";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const connection = { ...workspace, connectionId: "secrets" };
const inventory = {
  ...connection,
  target: { resourceId: "repo-a", scope: { kind: "repository" } },
  page: 1,
};
const PRIVATE = "synthetic-secret-provider-private-canary";
const descriptor = {
  workspaceId: "alpha",
  name: "Selected repository secrets",
  revision: 1,
  token: PRIVATE,
  expiresAt: "2099-01-01T00:00:00.000Z",
  repositoryNames: ["example/repo-a", "example/repo-b"],
  writable: true,
};
const metadata = {
  name: "DEPLOY_TOKEN",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const normalizedMetadata = {
  name: metadata.name,
  createdAt: metadata.created_at,
  updatedAt: metadata.updated_at,
  version: JSON.stringify([metadata.created_at, metadata.updated_at]),
};
const normalizedInventorySecret = {
  ...normalizedMetadata,
  kind: "secret",
  management: "unmanaged",
  managedConfigurationId: null,
  value: null,
  valueFormat: null,
};
const publicKey = { key_id: "public-key", key: "A".repeat(43) + "=" };
let runtime: Env;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let now: number;
function as(subject = "owner", extra: Partial<Principal> = {}) {
  return new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
}
function save(revision = 0, extra = {}, service = as()) {
  return service.secretsConnectionSave({
    ...connection,
    revision,
    connection: {
      name: "Actions secrets",
      providerKind: SECRET_PROVIDER_KIND.GITHUB,
      providerRef: "selected",
      resourceIds: ["repo-a"],
      enabled: true,
      ...extra,
    },
  });
}
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    GITHUB_SECRET_CREDENTIALS: JSON.stringify({ selected: descriptor }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
    ...["repo-a", "repo-b", "repo-c"].map((id) =>
      bindings.HQ_DB.prepare(
        `INSERT INTO repositories
      (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES (?,'alpha',?,'','project','maintained','active',?,?,?)`,
      ).bind(
        id,
        "example/" + id,
        JSON.stringify(DEFAULT_EXPECTATIONS),
        new Date(now).toISOString(),
        id,
      ),
    ),
  ]);
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + PRIVATE,
    );
    expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe(
      "2022-11-28",
    );
    if (url.pathname === "/repos/example/repo-a")
      return Response.json({
        id: 42,
        full_name: "example/repo-a",
        archived: false,
        disabled: false,
        owner: { id: 7, login: "example", type: "Organization" },
        private: true,
      });
    if (url.pathname.endsWith("/environments") && url.search)
      return Response.json({
        total_count: 1,
        environments: [{ id: 8, name: "prod/blue %" }],
      });
    if (url.pathname === "/repos/example/repo-a/environments/prod%2Fblue%20%25")
      return Response.json({ id: 8, name: "prod/blue %" });
    if (url.pathname.endsWith("/public-key")) return Response.json(publicKey);
    if (url.pathname.endsWith("/DEPLOY_TOKEN")) return Response.json(metadata);
    if (
      (url.pathname.endsWith("/secrets") ||
        url.pathname.endsWith("/organization-secrets")) &&
      url.search
    )
      return Response.json({
        total_count: 1,
        secrets: [{ ...metadata, encrypted_value: PRIVATE, unknown: PRIVATE }],
      });
    if (
      (url.pathname.endsWith("/variables") ||
        url.pathname.endsWith("/organization-variables")) &&
      url.search
    )
      return Response.json({
        total_count: 1,
        variables: [
          {
            ...metadata,
            name: "DEPLOY_REGION",
            value: "us-central1",
            unknown: PRIVATE,
          },
        ],
      });
    return Response.json({ message: PRIVATE }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Durable Secrets execution", () => {
  const SEALED = btoa("u".repeat(80));
  const destination = {
    connectionId: "secrets",
    connectionRevision: 1,
    target: inventory.target,
    name: "DEPLOY_TOKEN",
  };
  async function prepared(
    destinations: unknown[] = [destination],
    reviewId = "execution",
    enroll = true,
    source: unknown = null,
  ) {
    if (enroll) await save();
    const review = await as().secretsDraft({
      ...workspace,
      reviewId,
      destinations,
      source,
    });
    const finalized = await new SecretReviews(as()).upload(
      new Request("https://hq.example/api/secrets/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": review.draftFingerprint,
        },
        body: JSON.stringify({
          version: 1,
          items: destinations.map((_item, destinationIndex) => ({
            destinationIndex,
            ciphertext: SEALED,
          })),
        }),
      }),
      { ...workspace, reviewId: review.id },
    );
    return {
      ...workspace,
      reviewId: review.id,
      fingerprint: finalized.fingerprint!,
    };
  }
  function withWrites(status = 204) {
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, init) =>
      init?.method === "PUT"
        ? Promise.resolve(new Response(null, { status }))
        : read(input, init),
    );
  }
  const writes = () =>
    fetcher.mock.calls.filter(
      ([, init]) => init?.method === "PUT" || init?.method === "DELETE",
    );
  describe("Separately reviewed source removal", () => {
    const sourcePath = "/repos/example/repo-a/actions/secrets/DEPLOY_TOKEN";
    const cleanupInput = { ...workspace, cleanupId: "remove-source" };
    async function distributed() {
      const target = {
        ...destination,
        target: {
          resourceId: "repo-a",
          scope: { kind: "environment", name: "prod/blue %" },
        },
      };
      const input = await prepared([target], "scope-change", true, destination);
      await as().secretsApply(input);
      withWrites();
      await as().secretsRun({ ...input, destinationIndex: 0 });
      return {
        ...input,
        cleanupId: cleanupInput.cleanupId,
        acknowledgeNonAtomicMove: true,
      };
    }
    function withRemoval(status = 204) {
      const read = fetcher.getMockImplementation()!;
      let removed = false;
      fetcher.mockImplementation((request, init) => {
        if (init?.method === "DELETE") {
          expect(new URL(String(request)).pathname).toBe(sourcePath);
          expect(init.body).toBeUndefined();
          removed = true;
          return Promise.resolve(new Response(null, { status }));
        }
        return removed && new URL(String(request)).pathname === sourcePath
          ? Promise.resolve(new Response(null, { status: 404 }))
          : read(request, init);
      });
    }
    it("reviews before deletion, preserves independent receipts, and never repeats a submitted removal", async () => {
      const input = await distributed();
      const root = await as().secretsReview({
        ...workspace,
        reviewId: input.reviewId,
      });
      const review = await as().secretsCleanupPlan(input);
      expect(review).toMatchObject({
        actorMatches: true,
        source: { destination: { name: "DEPLOY_TOKEN" } },
        receipt: { phase: "reviewed", writeStatus: "not-sent" },
      });
      expect(await as().secretsCleanupPlan(input)).toEqual(review);
      expect(writes()).toHaveLength(1);
      withRemoval();
      const apply = { ...cleanupInput, fingerprint: review.fingerprint };
      const result = await as().secretsCleanupApply(apply);
      expect(result.receipt).toMatchObject({
        phase: "finished",
        writeStatus: "accepted",
        observationStatus: "absent",
        metadata: null,
        leaseExpiresAt: null,
      });
      expect(await as().secretsCleanupApply(apply)).toEqual(result);
      expect(
        (await as().secretsReview({ ...workspace, reviewId: input.reviewId }))
          .operation?.receipts,
      ).toEqual(root.operation?.receipts);
      expect(writes()).toHaveLength(2);
      expect(
        await as("viewer").secretsCleanupHistory({
          ...workspace,
          reviewId: input.reviewId,
        }),
      ).toMatchObject({
        items: [{ id: review.id, phase: "finished" }],
        nextCursor: null,
      });
      expect(
        (await as("viewer").secretsCleanupReview(cleanupInput)).actorMatches,
      ).toBe(false);
      const events = await bindings.HQ_DB.prepare(
        "SELECT a.id FROM activity a JOIN activity_repository_links l ON l.workspace_id=a.workspace_id AND l.event_id=a.id WHERE a.type LIKE 'secrets.cleanup.%' AND l.repository_id='repo-a'",
      ).all();
      expect(events.results.length).toBeGreaterThan(0);
      for (const table of [
        "secret_cleanup_reviews",
        "activity",
        "workspace_push_outbox",
      ]) {
        const content = JSON.stringify(
          (await bindings.HQ_DB.prepare("SELECT * FROM " + table).all())
            .results,
        );
        expect(content).not.toContain(SEALED);
        expect(content).not.toContain(PRIVATE);
      }
    });
    it("requires comparable versions even when unknown metadata otherwise matches", async () => {
      const input = await distributed();
      const reviews = new SecretReviews(as());
      const root = await reviews.row(workspace.workspaceId, input.reviewId);
      const captured = reviews.captured(root);
      captured.source!.snapshot.before!.version = null;
      const originalCapture = SecretReviews.prototype.capture;
      const capture = vi
        .spyOn(SecretReviews.prototype, "capture")
        .mockImplementation(async (...args) => {
          const result = await originalCapture.apply(reviews, args);
          result.snapshot.before!.version = null;
          return result;
        });
      try {
        await expect(
          captureSecretCleanupEvidence(as(), {
            ...root,
            captured_json: JSON.stringify(captured),
          }),
        ).rejects.toMatchObject({ code: "secret_cleanup_source_changed" });
      } finally {
        capture.mockRestore();
      }
      await bindings.HQ_DB.prepare(
        "UPDATE secret_receipts SET metadata_json=json_set(metadata_json,'$.version',NULL) WHERE workspace_id=? AND review_id=?",
      )
        .bind(workspace.workspaceId, input.reviewId)
        .run();
      await expect(as().secretsCleanupPlan(input)).rejects.toMatchObject({
        code: "secret_cleanup_destination_unconfirmed",
      });
      expect(writes()).toHaveLength(1);
    });
    it("bounds active reviews and paginates retained history without dropping tied timestamps", async () => {
      const input = await distributed();
      for (let index = 0; index < REVIEW_LIMITS.CLEANUP_REVIEWS; index++)
        await as().secretsCleanupPlan({
          ...input,
          cleanupId: "page-" + String(index).padStart(3, "0"),
        });
      await expect(as().secretsCleanupPlan(input)).rejects.toMatchObject({
        code: "secret_review_conflict",
      });
      await bindings.HQ_DB.prepare(
        "UPDATE secret_cleanup_reviews SET phase='finished' WHERE workspace_id='alpha'",
      ).run();
      for (
        let index = REVIEW_LIMITS.CLEANUP_REVIEWS;
        index <= REVIEW_LIMITS.HISTORY_PAGE;
        index++
      )
        await as().secretsCleanupPlan({
          ...input,
          cleanupId: "page-" + String(index).padStart(3, "0"),
        });
      const first = await as().secretsCleanupHistory({
        ...workspace,
        reviewId: input.reviewId,
      });
      expect(first.items).toHaveLength(REVIEW_LIMITS.HISTORY_PAGE);
      const second = await as().secretsCleanupHistory({
        ...workspace,
        reviewId: input.reviewId,
        before: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBe(null);
      expect(
        new Set([...first.items, ...second.items].map((item) => item.id)).size,
      ).toBe(REVIEW_LIMITS.HISTORY_PAGE + 1);
      await expect(
        as().secretsCleanupHistory({
          ...workspace,
          reviewId: input.reviewId,
          before: "invalid",
        }),
      ).rejects.toMatchObject({ code: "validation" });
      expect(writes()).toHaveLength(1);
    }, D1_VOLUME_TEST_TIMEOUT_MS);
    it("requires explicit acknowledgement and exact live review authority before provider reads", async () => {
      const input = await distributed();
      await expect(
        as().secretsCleanupPlan({ ...input, acknowledgeNonAtomicMove: false }),
      ).rejects.toBeDefined();
      const review = await as().secretsCleanupPlan(input);
      const apply = { ...cleanupInput, fingerprint: review.fingerprint };
      fetcher.mockClear();
      for (const subject of ["viewer", "operator", "outside"])
        await expect(
          as(subject).secretsCleanupApply(apply),
        ).rejects.toBeDefined();
      await expect(
        as("owner", { tokenId: "another-credential" }).secretsCleanupApply(
          apply,
        ),
      ).rejects.toBeDefined();
      await expect(
        as().secretsCleanupApply({
          ...apply,
          fingerprint: "sha256:" + "0".repeat(64),
        }),
      ).rejects.toBeDefined();
      await expect(
        as().secretsCleanupReview({ ...cleanupInput, workspaceId: "beta" }),
      ).rejects.toBeDefined();
      now += REVIEW_LIMITS.REVIEW_MS;
      await expect(as().secretsCleanupApply(apply)).rejects.toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(["membership", "connection", "receipt"])(
      "rejects a changed %s revision before deletion",
      async (changed) => {
        const input = await distributed();
        const review = await as().secretsCleanupPlan(input);
        if (changed === "membership")
          await bindings.HQ_DB.prepare(
            "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
          ).run();
        if (changed === "connection") await save(1);
        if (changed === "receipt")
          await as().secretsReconcile({
            ...workspace,
            reviewId: input.reviewId,
            destinationIndex: 0,
          });
        fetcher.mockClear();
        await expect(
          as().secretsCleanupApply({
            ...cleanupInput,
            fingerprint: review.fingerprint,
          }),
        ).rejects.toMatchObject({ code: "secret_review_conflict" });
        expect(fetcher).not.toHaveBeenCalled();
      },
    );
    it.each([
      sourcePath,
      "/repos/example/repo-a/environments/prod%2Fblue%20%25/secrets/DEPLOY_TOKEN",
    ])("records not sent when fresh metadata changed at %s", async (path) => {
      const input = await distributed();
      const review = await as().secretsCleanupPlan(input);
      const read = fetcher.getMockImplementation()!;
      fetcher.mockImplementation((request, init) =>
        new URL(String(request)).pathname === path
          ? Promise.resolve(
              Response.json({
                ...metadata,
                updated_at: "2026-02-01T00:00:00Z",
              }),
            )
          : read(request, init),
      );
      const apply = { ...cleanupInput, fingerprint: review.fingerprint };
      const result = await as().secretsCleanupApply(apply);
      expect(result.receipt).toMatchObject({
        phase: "finished",
        writeStatus: "not-sent",
        reason: "preflight_changed",
        leaseExpiresAt: null,
      });
      fetcher.mockImplementation(read);
      expect(await as().secretsCleanupApply(apply)).toEqual(result);
      expect(writes()).toHaveLength(1);
    });
    it("persists submission before DELETE and fences competing cleanup and distribution requests", async () => {
      const input = await distributed();
      const firstReview = await as().secretsCleanupPlan(input);
      const otherReview = await as().secretsCleanupPlan({
        ...input,
        cleanupId: "other-removal",
      });
      const another = await prepared([destination], "another-write", false);
      await as().secretsApply(another);
      const read = fetcher.getMockImplementation()!;
      let entered!: () => void;
      let resume!: () => void;
      const sending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      fetcher.mockImplementation(async (request, init) => {
        if (init?.method === "DELETE") {
          entered();
          await gate;
          return new Response(null, { status: 204 });
        }
        return read(request, init);
      });
      const apply = { ...cleanupInput, fingerprint: firstReview.fingerprint };
      const first = as().secretsCleanupApply(apply);
      await sending;
      try {
        expect(
          (await as().secretsCleanupReview(cleanupInput)).receipt.phase,
        ).toBe("submitted");
        expect((await as().secretsCleanupApply(apply)).receipt.phase).toBe(
          "submitted",
        );
        await expect(
          as().secretsCleanupApply({
            ...workspace,
            cleanupId: otherReview.id,
            fingerprint: otherReview.fingerprint,
          }),
        ).rejects.toMatchObject({ code: "secret_review_conflict" });
        expect(
          (await as().secretsRun({ ...another, destinationIndex: 0 })).operation
            ?.receipts[0]?.phase,
        ).toBe("pending");
      } finally {
        resume();
      }
      expect((await first).receipt.writeStatus).toBe("accepted");
      expect(writes()).toHaveLength(2);
    });
    it.each([
      [500, "indeterminate"],
      [403, "rejected"],
    ] as const)(
      "keeps deletion outcome %s independent of later absence",
      async (status, expected) => {
        const review = await as().secretsCleanupPlan(await distributed());
        withRemoval(status);
        const apply = { ...cleanupInput, fingerprint: review.fingerprint };
        expect((await as().secretsCleanupApply(apply)).receipt).toMatchObject({
          phase: "finished",
          writeStatus: expected,
          observationStatus: "unknown",
        });
        expect(
          (await as().secretsCleanupReconcile(cleanupInput)).receipt,
        ).toMatchObject({ writeStatus: expected, observationStatus: "absent" });
        await as().secretsCleanupApply(apply);
        expect(writes()).toHaveLength(2);
      },
      D1_VOLUME_TEST_TIMEOUT_MS,
    );
    it("preserves accepted removal when follow-up access fails and never calls hidden scope access absent", async () => {
      const review = await as().secretsCleanupPlan(await distributed());
      const read = fetcher.getMockImplementation()!;
      let sent = false;
      fetcher.mockImplementation((request, init) => {
        if (init?.method === "DELETE") {
          sent = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return sent && String(request).includes("/actions/secrets/")
          ? Promise.resolve(new Response(null, { status: 404 }))
          : read(request, init);
      });
      expect(
        (
          await as().secretsCleanupApply({
            ...cleanupInput,
            fingerprint: review.fingerprint,
          })
        ).receipt,
      ).toMatchObject({
        writeStatus: "accepted",
        observationStatus: "unavailable",
      });
      expect(
        (await as().secretsCleanupReconcile(cleanupInput)).receipt
          .observationStatus,
      ).toBe("unavailable");
      expect(writes()).toHaveLength(2);
    });
    it("records acceptance despite authority revocation after provider submission", async () => {
      const review = await as().secretsCleanupPlan(await distributed());
      const read = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (request, init) => {
        if (init?.method === "DELETE") {
          await bindings.HQ_DB.prepare(
            "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
          ).run();
          return new Response(null, { status: 204 });
        }
        return read(request, init);
      });
      expect(
        (
          await as().secretsCleanupApply({
            ...cleanupInput,
            fingerprint: review.fingerprint,
          })
        ).receipt,
      ).toMatchObject({
        phase: "finished",
        writeStatus: "accepted",
        observationStatus: "unknown",
        leaseExpiresAt: null,
      });
      expect(writes()).toHaveLength(2);
    });
    it.each(["database", "lease"])(
      "preserves interrupted submission after %s failure without retrying deletion",
      async (failure) => {
        const review = await as().secretsCleanupPlan(await distributed());
        const read = fetcher.getMockImplementation()!;
        fetcher.mockImplementation(async (request, init) => {
          if (init?.method === "DELETE") {
            if (failure === "lease") now += REVIEW_LIMITS.LEASE_MS + 1;
            return new Response(null, { status: 204 });
          }
          return read(request, init);
        });
        const goodDatabase = runtime.HQ_DB;
        if (failure === "database")
          runtime.HQ_DB = new Proxy(goodDatabase, {
            get(target, key) {
              if (key === "prepare")
                return (sql: string) => {
                  if (sql.includes("SET phase='finished',write_status=?"))
                    throw new Error(PRIVATE);
                  return target.prepare(sql);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        const apply = { ...cleanupInput, fingerprint: review.fingerprint };
        if (failure === "database")
          await expect(as().secretsCleanupApply(apply)).rejects.toBeDefined();
        else
          expect((await as().secretsCleanupApply(apply)).receipt.phase).toBe(
            "submitted",
          );
        runtime.HQ_DB = goodDatabase;
        const interrupted = await as().secretsCleanupReview(cleanupInput);
        expect(interrupted.receipt.phase).toBe("submitted");
        now += REVIEW_LIMITS.LEASE_MS + 1;
        expect(
          (await as().secretsCleanupReconcile(cleanupInput)).receipt,
        ).toMatchObject({
          phase: "finished",
          writeStatus: "indeterminate",
          observationStatus: "present",
          reason: "execution_interrupted",
          leaseExpiresAt: null,
        });
        await as().secretsCleanupApply(apply);
        expect(writes()).toHaveLength(2);
      },
    );
    it("shares safe review receipts through HTTP and MCP and marks deletion explicitly destructive", async () => {
      const review = await as().secretsCleanupPlan(await distributed());
      const app = createApplication(async () => ({
        subject: "viewer",
        displayName: "Viewer",
      }));
      const request = (path: string, body: object) =>
        new Request("https://hq.example" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://hq.example",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        });
      const http = await app.fetch(
        request("/api/commands/secrets_cleanup_review", cleanupInput),
        runtime,
      );
      expect(http.status).toBe(200);
      const mcp = await app.fetch(
        request("/mcp", {
          jsonrpc: "2.0",
          id: "cleanup",
          method: "tools/call",
          params: { name: "secrets_cleanup_review", arguments: cleanupInput },
        }),
        runtime,
      );
      const envelope = (await mcp.json()) as {
        result: { content: { text: string }[] };
      };
      expect(JSON.parse(envelope.result.content[0]!.text)).toEqual({
        ...review,
        actorMatches: false,
      });
      expect(commandAnnotations("secrets_cleanup_apply", false)).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      });
      expect(
        commands.secrets_cleanup_apply.schema.safeParse({
          ...cleanupInput,
          fingerprint: review.fingerprint,
          value: PRIVATE,
        }).success,
      ).toBe(false);
      const denied = await app.fetch(
        request("/api/commands/secrets_cleanup_apply", {
          ...cleanupInput,
          fingerprint: review.fingerprint,
        }),
        runtime,
      );
      expect(denied.status).toBe(403);
      expect(writes()).toHaveLength(1);
    });
  });
  it("requires verified destination writes for source cleanup and follows retained-input recovery without rewriting uncertainty", async () => {
    const target = {
      ...destination,
      target: {
        resourceId: "repo-a",
        scope: { kind: "environment", name: "prod/blue %" },
      },
    };
    const input = await prepared([target], "scope-change", true, destination);
    await as().secretsApply(input);
    withWrites(500);
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const root = await new SecretReviews(as()).row(
      workspace.workspaceId,
      input.reviewId,
    );
    await expect(
      captureSecretCleanupEvidence(as(), root),
    ).rejects.toMatchObject({ code: "secret_cleanup_destination_unconfirmed" });
    const retry = await as().secretsRecoveryPlan({
      ...input,
      destinationIndex: 0,
      newReviewId: "scope-retry",
      acknowledgePossibleOverwrite: true,
    });
    const retryInput = {
      ...workspace,
      reviewId: retry.id,
      fingerprint: retry.fingerprint!,
    };
    await as().secretsApply(retryInput);
    withWrites();
    await as().secretsRun({ ...retryInput, destinationIndex: 0 });
    const evidence = await captureSecretCleanupEvidence(as(), root);
    expect(evidence.source.snapshot.scope.kind).toBe("repository");
    expect(
      evidence.destinations[0]!.path.map((entry) => entry.reviewId),
    ).toEqual([input.reviewId, retry.id]);
    const guard = secretCleanupPathGuard(
      workspace.workspaceId,
      evidence,
      new Date(now).toISOString(),
    );
    expect(
      await bindings.HQ_DB.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first(),
    ).toEqual({ allowed: 1 });
    await bindings.HQ_DB.prepare(
      "UPDATE secret_receipts SET revision=revision+1 WHERE review_id=?",
    )
      .bind(retry.id)
      .run();
    expect(
      await bindings.HQ_DB.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first(),
    ).toBe(null);
    expect(
      (await as().secretsReview({ ...workspace, reviewId: input.reviewId }))
        .operation?.receipts[0]?.writeStatus,
    ).toBe("indeterminate");
    expect(writes()).toHaveLength(2);
    expect(writes().every(([, init]) => init?.method === "PUT")).toBe(true);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("rejects changed source metadata or destination metadata before offering source removal", async () => {
    const target = {
      ...destination,
      target: {
        resourceId: "repo-a",
        scope: { kind: "environment", name: "prod/blue %" },
      },
    };
    const input = await prepared([target], "scope-change", true, destination);
    await as().secretsApply(input);
    withWrites();
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const root = await new SecretReviews(as()).row(
      workspace.workspaceId,
      input.reviewId,
    );
    const read = fetcher.getMockImplementation()!;
    for (const [path, code] of [
      ["/actions/secrets/DEPLOY_TOKEN", "secret_cleanup_source_changed"],
      [
        "/environments/prod%2Fblue%20%25/secrets/DEPLOY_TOKEN",
        "secret_cleanup_destination_changed",
      ],
    ]) {
      fetcher.mockImplementation((request, init) =>
        String(request).endsWith(path!)
          ? Promise.resolve(
              Response.json({
                ...metadata,
                updated_at: "2026-02-01T00:00:00Z",
              }),
            )
          : read(request, init),
      );
      await expect(
        captureSecretCleanupEvidence(as(), root),
      ).rejects.toMatchObject({ code });
    }
    expect(writes()).toHaveLength(1);
  });
  it("stops source-removal preparation when its read window expires", async () => {
    const target = {
      ...destination,
      target: {
        resourceId: "repo-a",
        scope: { kind: "environment", name: "prod/blue %" },
      },
    };
    const input = await prepared([target], "scope-change", true, destination);
    await as().secretsApply(input);
    withWrites();
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const root = await new SecretReviews(as()).row(
      workspace.workspaceId,
      input.reviewId,
    );
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (request, init) => {
      const result = await read(request, init);
      if (String(request).endsWith("/public-key"))
        now += REVIEW_LIMITS.CLEANUP_PREPARE_MS;
      return result;
    });
    await expect(
      captureSecretCleanupEvidence(as(), root),
    ).rejects.toMatchObject({ code: "secret_cleanup_deadline" });
    expect(writes()).toHaveLength(1);
  });
  it("does not interpret hidden scope access as an absent secret during reconciliation", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites();
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((request, init) =>
      String(request).includes("/actions/secrets/")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : read(request, init),
    );
    const inaccessible = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(inaccessible.operation?.receipts[0]).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "unavailable",
    });
    fetcher.mockImplementation((request, init) =>
      String(request).endsWith("/DEPLOY_TOKEN")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : read(request, init),
    );
    const absent = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(absent.operation?.receipts[0]).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "absent",
    });
    expect(writes()).toHaveLength(1);
  });
  it("prepares a fresh retained-input recovery without changing the original receipt or extending custody", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites(500);
    const uncertain = await as().secretsRun({ ...input, destinationIndex: 0 });
    now += 10 * 60 * 1000;
    const selection = {
      ...input,
      destinationIndex: 0,
      newReviewId: "retry",
      acknowledgePossibleOverwrite: true,
    };
    const [recovery] = await Promise.all([
      as().secretsRecoveryPlan(selection),
      as().secretsRecoveryPlan(selection),
    ]);
    expect(recovery).toMatchObject({
      id: "retry",
      stage: "reviewed",
      inputPresent: true,
      inputExpiresAt: uncertain.inputExpiresAt,
      recovery: { reviewId: input.reviewId, destinationIndex: 0, depth: 1 },
    });
    expect(writes()).toHaveLength(1);
    expect(await as().secretsRecoveryPlan(selection)).toEqual(recovery);
    const original = await as().secretsReview({
      ...workspace,
      reviewId: input.reviewId,
    });
    expect(original.operation?.receipts[0]).toMatchObject({
      writeStatus: "indeterminate",
      recoveryReviewId: recovery.id,
    });
    const replacement = new Request("https://hq.example/api/secrets/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": recovery.draftFingerprint,
      },
      body: JSON.stringify({
        version: 1,
        items: [{ destinationIndex: 0, ciphertext: btoa("v".repeat(80)) }],
      }),
    });
    await expect(
      new SecretReviews(as()).upload(replacement, {
        ...workspace,
        reviewId: recovery.id,
      }),
    ).rejects.toMatchObject({ code: "secret_recovery_input" });
    expect(replacement.bodyUsed).toBe(false);
    const accepted = {
      ...workspace,
      reviewId: recovery.id,
      fingerprint: recovery.fingerprint!,
    };
    await as().secretsApply(accepted);
    withWrites();
    const delivered = await as().secretsRun({
      ...accepted,
      destinationIndex: 0,
    });
    expect(delivered.operation?.receipts[0]).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "present",
    });
    expect(JSON.parse(String(writes()[1]![1]?.body)).encrypted_value).toBe(
      SEALED,
    );
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(2);
    expect(
      (await as().secretsReview({ ...workspace, reviewId: input.reviewId }))
        .operation?.receipts[0]?.writeStatus,
    ).toBe("indeterminate");
    expect(JSON.stringify([recovery, delivered])).not.toContain(SEALED);
  });
  it("reserves one recovery per destination and releases an unaccepted reservation on cancellation", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites(422);
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const selection = {
      ...input,
      destinationIndex: 0,
      acknowledgePossibleOverwrite: true,
    };
    const results = await Promise.allSettled([
      as().secretsRecoveryPlan({ ...selection, newReviewId: "first" }),
      as().secretsRecoveryPlan({ ...selection, newReviewId: "second" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const links = (
      await bindings.HQ_DB.prepare(
        "SELECT child_review_id FROM secret_recovery_links",
      ).all<{ child_review_id: string }>()
    ).results;
    expect(links).toHaveLength(1);
    await as().secretsCancel({
      ...workspace,
      reviewId: links[0]!.child_review_id,
    });
    expect(
      (await as().secretsReview({ ...workspace, reviewId: input.reviewId }))
        .operation?.receipts[0]?.recoveryReviewId,
    ).toBe(null);
    const fresh = await as().secretsRecoveryPlan({
      ...selection,
      newReviewId: "third",
    });
    expect(fresh.stage).toBe("reviewed");
    expect(writes()).toHaveLength(1);
  });
  it("refuses a recovery whose original receipt changed after review", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites(500);
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const recovery = await as().secretsRecoveryPlan({
      ...input,
      destinationIndex: 0,
      newReviewId: "retry",
      acknowledgePossibleOverwrite: true,
    });
    await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    await expect(
      as().secretsApply({
        ...workspace,
        reviewId: recovery.id,
        fingerprint: recovery.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    expect(writes()).toHaveLength(1);
  });
  it("requires new input after key rotation or original expiry and never silently reseals or extends it", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites(422);
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const selection = {
      ...input,
      destinationIndex: 0,
      newReviewId: "retry",
      acknowledgePossibleOverwrite: true,
    };
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((request, init) =>
      String(request).endsWith("/public-key")
        ? Promise.resolve(Response.json({ ...publicKey, key_id: "rotated" }))
        : read(request, init),
    );
    await expect(as().secretsRecoveryPlan(selection)).rejects.toMatchObject({
      code: "secret_recovery_input_unavailable",
    });
    expect(
      (await as().secretsReview({ ...workspace, reviewId: "retry" })).stage,
    ).toBe("cancelled");
    now += REVIEW_LIMITS.INPUT_RETENTION_MS;
    await expect(
      as().secretsRecoveryPlan({ ...selection, newReviewId: "expired" }),
    ).rejects.toMatchObject({ code: "secret_recovery_input_unavailable" });
    expect(writes()).toHaveLength(1);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT * FROM secret_recovery_links",
        ).all()
      ).results,
    ).toEqual([]);
  });
  it("bounds retained-input recovery chains and requires explicit overwrite acknowledgement", async () => {
    let input = await prepared();
    await expect(
      as().secretsRecoveryPlan({
        ...input,
        destinationIndex: 0,
        newReviewId: "unacknowledged",
      }),
    ).rejects.toBeDefined();
    withWrites(422);
    for (let depth = 0; depth <= REVIEW_LIMITS.RECOVERY_DEPTH; depth++) {
      await as().secretsApply(input);
      await as().secretsRun({ ...input, destinationIndex: 0 });
      const request = {
        ...input,
        destinationIndex: 0,
        newReviewId: "retry-" + depth,
        acknowledgePossibleOverwrite: true,
      };
      if (depth === REVIEW_LIMITS.RECOVERY_DEPTH) {
        await expect(as().secretsRecoveryPlan(request)).rejects.toMatchObject({
          code: "secret_recovery_limit",
        });
      } else {
        const next = await as().secretsRecoveryPlan(request);
        expect(next.recovery?.depth).toBe(depth + 1);
        input = {
          ...workspace,
          reviewId: next.id,
          fingerprint: next.fingerprint!,
        };
      }
    }
    expect(writes()).toHaveLength(REVIEW_LIMITS.RECOVERY_DEPTH + 1);
  });
  it("accepts durable intent without effects and executes each indexed destination at most once", async () => {
    const input = await prepared([
      destination,
      {
        ...destination,
        target: {
          resourceId: "repo-a",
          scope: { kind: "environment", name: "prod/blue %" },
        },
      },
    ]);
    const accepted = await as().secretsApply(input);
    expect(
      accepted.operation?.receipts.map((receipt) => receipt.phase),
    ).toEqual(["pending", "pending"]);
    expect(writes()).toHaveLength(0);
    expect(await as().secretsApply(input)).toEqual(accepted);
    withWrites();
    await Promise.all([
      as().secretsRun({ ...input, destinationIndex: 0 }),
      as().secretsRun({ ...input, destinationIndex: 0 }),
    ]);
    const partial = await as().secretsReview({
      ...workspace,
      reviewId: input.reviewId,
    });
    expect(partial.operation?.receipts[0]).toMatchObject({
      phase: "finished",
      writeStatus: "accepted",
      observationStatus: "present",
      metadata: normalizedMetadata,
    });
    expect(partial.operation?.receipts[1]?.phase).toBe("pending");
    expect(writes()).toHaveLength(1);
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(1);
    const complete = await as().secretsRun({ ...input, destinationIndex: 1 });
    expect(
      complete.operation?.receipts.every(
        (receipt) => receipt.writeStatus === "accepted",
      ),
    ).toBe(true);
    expect(writes()).toHaveLength(2);
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    expect(JSON.stringify(complete)).not.toContain(SEALED);
    expect(JSON.stringify(complete)).not.toContain(PRIVATE);
    const requestBody = JSON.parse(String(writes()[0]![1]?.body));
    expect(requestBody).toEqual({
      key_id: publicKey.key_id,
      encrypted_value: SEALED,
    });
    expect(complete.operation?.leaseExpiresAt).toBe(null);
    await expect(
      as().secretsCancel({ ...workspace, reviewId: input.reviewId }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
  });
  it("retains provider acceptance when metadata fails and reconciles using reads only", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    const read = fetcher.getMockImplementation()!;
    let sent = false;
    fetcher.mockImplementation(async (request, init) => {
      if (init?.method === "PUT") {
        sent = true;
        return new Response(null, { status: 204 });
      }
      if (sent) throw new Error(PRIVATE);
      return read(request, init);
    });
    const result = await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(result.operation?.receipts[0]).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "unavailable",
    });
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT destination_index FROM secret_payloads",
        ).all()
      ).results,
    ).toHaveLength(1);
    fetcher.mockImplementation(read);
    now += REVIEW_LIMITS.REVIEW_MS;
    const reconciled = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(reconciled.operation?.receipts[0]).toMatchObject({
      writeStatus: "accepted",
      observationStatus: "present",
    });
    expect(writes()).toHaveLength(1);
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
  });
  it("never infers acceptance from name presence after a lost provider response", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((request, init) =>
      init?.method === "PUT"
        ? Promise.reject(new Error(PRIVATE))
        : read(request, init),
    );
    const result = await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(result.operation?.receipts[0]).toMatchObject({
      phase: "finished",
      writeStatus: "indeterminate",
      observationStatus: "unknown",
    });
    await as().secretsRun({ ...input, destinationIndex: 0 });
    const reconciled = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(reconciled.operation?.receipts[0]).toMatchObject({
      writeStatus: "indeterminate",
      observationStatus: "present",
    });
    expect(writes()).toHaveLength(1);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT destination_index FROM secret_payloads",
        ).all()
      ).results,
    ).toHaveLength(1);
  });
  it("refuses changed keys, scope identity, or metadata before sending", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((request, init) =>
      String(request).endsWith("/public-key")
        ? Promise.resolve(
            Response.json({ ...publicKey, key_id: "rotated-key" }),
          )
        : read(request, init),
    );
    const result = await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(result.operation?.receipts[0]).toMatchObject({
      writeStatus: "not-sent",
      phase: "finished",
      reason: "preflight_changed",
    });
    expect(writes()).toHaveLength(0);
  });
  it("serializes active destination requests across reviews within a workspace", async () => {
    const input = await prepared();
    const secondInput = await prepared(
      [
        {
          ...destination,
          target: {
            resourceId: "repo-a",
            scope: { kind: "environment", name: "prod/blue %" },
          },
        },
      ],
      "another-execution",
      false,
    );
    await as().secretsApply(input);
    await as().secretsApply(secondInput);
    const read = fetcher.getMockImplementation()!;
    let entered!: () => void;
    let resume!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    fetcher.mockImplementation(async (request, init) => {
      if (init?.method === "PUT") {
        entered();
        await gate;
        return new Response(null, { status: 204 });
      }
      return read(request, init);
    });
    const first = as().secretsRun({ ...input, destinationIndex: 0 });
    await sending;
    try {
      const busy = await as().secretsRun({
        ...secondInput,
        destinationIndex: 0,
      });
      expect(busy.operation?.receipts[0]?.phase).toBe("pending");
      expect(writes()).toHaveLength(1);
    } finally {
      resume();
    }
    await first;
    await as().secretsRun({ ...secondInput, destinationIndex: 0 });
    expect(writes()).toHaveLength(2);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("leaves a recoverable submitted marker when receipt persistence fails after the provider write", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites();
    const goodDatabase = runtime.HQ_DB;
    runtime.HQ_DB = new Proxy(goodDatabase, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("SET phase='finished',write_status=?"))
              throw new Error(PRIVATE);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      as().secretsRun({ ...input, destinationIndex: 0 }),
    ).rejects.toBeDefined();
    runtime.HQ_DB = goodDatabase;
    expect(
      (await as().secretsReview({ ...workspace, reviewId: input.reviewId }))
        .operation?.receipts[0]?.phase,
    ).toBe("submitted");
    now += REVIEW_LIMITS.LEASE_MS + 1;
    const result = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(result.operation?.receipts[0]).toMatchObject({
      writeStatus: "indeterminate",
      observationStatus: "present",
    });
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(1);
    for (const table of [
      "secret_reviews",
      "secret_operations",
      "secret_receipts",
      "activity",
      "workspace_push_outbox",
    ]) {
      const contents = JSON.stringify(
        (await bindings.HQ_DB.prepare("SELECT * FROM " + table).all()).results,
      );
      expect(contents).not.toContain(SEALED);
      expect(contents).not.toContain(PRIVATE);
    }
  });
  it("records a rejected destination without retrying or treating it as an accepted write", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    withWrites(422);
    const result = await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(result.operation?.receipts[0]).toMatchObject({
      writeStatus: "rejected",
      reason: "provider_rejected",
      observationStatus: "unknown",
    });
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(1);
  });
  it("checks authorization again after slow preflight and fences a stale execution before sending", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (request, init) => {
      const response = await read(request, init);
      if (String(request).endsWith("/public-key"))
        now += REVIEW_LIMITS.LEASE_MS + 1;
      return response;
    });
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(0);
    fetcher.mockImplementation(read);
    const reconciled = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(reconciled.operation?.receipts[0]).toMatchObject({
      phase: "finished",
      writeStatus: "not-sent",
      reason: "execution_interrupted",
    });
    expect(reconciled.operation?.leaseExpiresAt).toBe(null);
  });
  it("retains indeterminate receipts if the lease expires after submission and never resends", async () => {
    const input = await prepared();
    await as().secretsApply(input);
    const read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (request, init) => {
      if (init?.method === "PUT") {
        now += REVIEW_LIMITS.LEASE_MS + 1;
        return new Response(null, { status: 204 });
      }
      return read(request, init);
    });
    const interrupted = await as().secretsRun({
      ...input,
      destinationIndex: 0,
    });
    expect(interrupted.operation?.receipts[0]?.phase).toBe("submitted");
    expect(interrupted.operation?.leaseExpired).toBe(true);
    const reconciled = await as().secretsReconcile({
      ...workspace,
      reviewId: input.reviewId,
      destinationIndex: 0,
    });
    expect(reconciled.operation?.receipts[0]).toMatchObject({
      phase: "finished",
      writeStatus: "indeterminate",
      observationStatus: "present",
    });
    await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(writes()).toHaveLength(1);
  });
  it("rejects nonowners, changed fingerprints, expired authority, and deleted input before effects", async () => {
    const input = await prepared();
    for (const subject of ["viewer", "operator", "outside"])
      await expect(as(subject).secretsApply(input)).rejects.toBeDefined();
    await expect(
      as().secretsApply({ ...input, fingerprint: "sha256:" + "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    await as().secretsApply(input);
    await bindings.HQ_DB.prepare("DELETE FROM secret_payloads").run();
    const result = await as().secretsRun({ ...input, destinationIndex: 0 });
    expect(result.operation?.receipts[0]).toMatchObject({
      writeStatus: "not-sent",
      reason: "input_expired",
    });
    expect(writes()).toHaveLength(0);
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='viewer',revision=revision+1 WHERE subject='owner' AND workspace_id='alpha'",
    ).run();
    await expect(
      as().secretsReconcile({
        ...workspace,
        reviewId: input.reviewId,
        destinationIndex: 0,
      }),
    ).rejects.toBeDefined();
  });
});

describe("Private secret review input", () => {
  const SEALED = btoa("s".repeat(80));
  const destination = {
    connectionId: "secrets",
    connectionRevision: 1,
    target: inventory.target,
    name: "DEPLOY_TOKEN",
  };
  const draftInput = {
    workspaceId: "alpha",
    reviewId: "review",
    destinations: [destination],
  };
  it("stops slow destination preparation before reading another target or persisting a partial review", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (request, init) => {
      const response = await original(request, init);
      if (String(request).endsWith("/DEPLOY_TOKEN"))
        now += REVIEW_LIMITS.DRAFT_PREPARE_MS;
      return response;
    });
    await expect(
      reviews.draft({
        ...draftInput,
        destinations: [destination, { ...destination, name: "SECOND_TOKEN" }],
      }),
    ).rejects.toMatchObject({ code: "secret_preparation_deadline" });
    expect(
      fetcher.mock.calls.some(([request]) =>
        String(request).includes("SECOND_TOKEN"),
      ),
    ).toBe(false);
    expect((await reviews.history(workspace)).items).toEqual([]);
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
    fetcher.mockImplementation(original);
    expect((await reviews.draft(draftInput)).stage).toBe("awaiting-input");
  });
  function upload(
    review: SecretReview,
    items = [{ destinationIndex: 0, ciphertext: SEALED }],
  ) {
    return new Request(
      "https://hq.example/api/secrets/input?workspaceId=alpha&reviewId=" +
        review.id,
      {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
          "If-Match": review.draftFingerprint,
        },
        body: JSON.stringify({ version: 1, items }),
      },
    );
  }
  it("keeps exactly one accepted input when different uploads race", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    const attempts = await Promise.allSettled([
      reviews.upload(upload(draft), { ...workspace, reviewId: draft.id }),
      reviews.upload(
        upload(draft, [
          { destinationIndex: 0, ciphertext: btoa("t".repeat(80)) },
        ]),
        { ...workspace, reviewId: draft.id },
      ),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT destination_index FROM secret_payloads",
        ).all()
      ).results,
    ).toEqual([{ destination_index: 0 }]);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT id FROM activity WHERE type='secrets.input.accepted'",
        ).all()
      ).results,
    ).toHaveLength(1);
  });
  it("rejects a repository revision change after consuming input but before staging", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    let step = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (step++ === 0)
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  version: 1,
                  items: [{ destinationIndex: 0, ciphertext: SEALED }],
                }),
              ),
            );
          else {
            await bindings.HQ_DB.prepare(
              "UPDATE repositories SET revision=revision+1 WHERE id='repo-a'",
            ).run();
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(upload(draft), { body: stream });
    await expect(
      reviews.upload(request, { ...workspace, reviewId: draft.id }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(request.bodyUsed).toBe(true);
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    expect(
      (await reviews.get({ ...workspace, reviewId: draft.id })).stage,
    ).toBe("awaiting-input");
  });
  it("bounds unexpired staged reviews and frees capacity through cancellation", async () => {
    await save();
    const reviews = new SecretReviews(as());
    for (let index = 0; index < REVIEW_LIMITS.STAGED_WORKSPACE; index++)
      await reviews.draft({ ...draftInput, reviewId: "capacity-" + index });
    await expect(reviews.draft(draftInput)).rejects.toMatchObject({
      code: "secret_review_capacity",
    });
    await reviews.cancel({ ...workspace, reviewId: "capacity-0" });
    expect((await reviews.draft(draftInput)).stage).toBe("awaiting-input");
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("reports failed cleanup without preventing the independent collection attempt or logging private errors", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badDatabase = new Proxy(runtime.HQ_DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.startsWith("DELETE FROM secret_payloads"))
              throw new Error(PRIVATE);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        createApplication(async () => ({
          subject: "owner",
          displayName: "Owner",
        })).scheduled({} as ScheduledController, {
          ...runtime,
          HQ_DB: badDatabase,
        }),
      ).rejects.toThrow("Scheduled maintenance interrupted");
      expect(
        info.mock.calls.some(
          ([entry]) =>
            (entry as { event?: string }).event === "hq.github.batch.completed",
        ),
      ).toBe(true);
      expect(
        warn.mock.calls.some(
          ([entry]) =>
            (entry as { event?: string }).event ===
            "hq.secrets.cleanup.interrupted",
        ),
      ).toBe(true);
      expect(JSON.stringify([info.mock.calls, warn.mock.calls])).not.toContain(
        PRIVATE,
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
  it("binds exact input idempotently, audits it without material, and cancels only staged work", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    expect(draft).toMatchObject({
      stage: "awaiting-input",
      fingerprint: null,
      inputPresent: false,
      actorMatches: true,
    });
    expect(draft.destinations[0]!.snapshot.input).toMatchObject({
      kind: "provider-sealed",
      publicKey: publicKey.key,
    });
    expect(await reviews.draft(draftInput)).toEqual(draft);
    const finalized = await reviews.upload(upload(draft), {
      ...workspace,
      reviewId: draft.id,
    });
    expect(finalized).toMatchObject({
      stage: "reviewed",
      inputPresent: true,
      fingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(finalized.fingerprint).not.toBe(draft.draftFingerprint);
    expect(
      await reviews.upload(upload(draft), { ...workspace, reviewId: draft.id }),
    ).toEqual(finalized);
    await expect(
      reviews.upload(
        upload(draft, [
          { destinationIndex: 0, ciphertext: btoa("t".repeat(80)) },
        ]),
        { ...workspace, reviewId: draft.id },
      ),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    const history = await reviews.history(workspace);
    const activity = (
      await bindings.HQ_DB.prepare(
        "SELECT title,summary,type FROM activity WHERE workspace_id='alpha'",
      ).all()
    ).results;
    expect(
      activity.filter((row) => row.type === "secrets.input.accepted"),
    ).toHaveLength(1);
    expect(JSON.stringify([draft, finalized, history, activity])).not.toContain(
      SEALED,
    );
    expect(JSON.stringify([draft, finalized, history, activity])).not.toContain(
      PRIVATE,
    );
    expect(
      (await reviews.history({ ...workspace, repositoryId: "repo-a" })).items,
    ).toHaveLength(1);
    expect(
      (await reviews.history({ ...workspace, repositoryId: "repo-b" })).items,
    ).toHaveLength(0);
    const cancelled = await reviews.cancel({
      ...workspace,
      reviewId: draft.id,
    });
    expect(cancelled).toMatchObject({
      stage: "cancelled",
      inputPresent: false,
    });
    expect(await reviews.cancel({ ...workspace, reviewId: draft.id })).toEqual(
      cancelled,
    );
    expect(
      (await bindings.HQ_DB.prepare("SELECT * FROM secret_payloads").all())
        .results,
    ).toEqual([]);
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });
  it("rejects unauthorized, wrong-workspace, expired, and stale review uploads before consuming input", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    for (const service of [
      as("viewer"),
      as("operator"),
      as("outside"),
      as("owner", { reporterId: "reporter" }),
    ]) {
      const request = upload(draft);
      await expect(
        new SecretReviews(service).upload(request, {
          ...workspace,
          reviewId: draft.id,
        }),
      ).rejects.toBeDefined();
      expect(request.bodyUsed).toBe(false);
    }
    const stale = upload(draft);
    stale.headers.set("If-Match", "sha256:" + "0".repeat(64));
    await expect(
      reviews.upload(stale, { ...workspace, reviewId: draft.id }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    expect(stale.bodyUsed).toBe(false);
    now += REVIEW_LIMITS.REVIEW_MS + 1;
    const expired = upload(draft);
    await expect(
      reviews.upload(expired, { ...workspace, reviewId: draft.id }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    expect(expired.bodyUsed).toBe(false);
  });
  it("rechecks connection and actor revisions, refuses alias duplicates, and keeps source cleanup separate", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    await save(1, { name: "Changed" });
    const changed = upload(draft);
    await expect(
      reviews.upload(changed, { ...workspace, reviewId: draft.id }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    expect(changed.bodyUsed).toBe(false);
    await expect(
      reviews.draft({
        ...draftInput,
        reviewId: "duplicates",
        destinations: [
          { ...destination, connectionRevision: 2 },
          { ...destination, connectionRevision: 2, name: "deploy_token" },
        ],
      }),
    ).rejects.toMatchObject({ code: "secret_duplicate_destination" });
    const scopeMove = await reviews.draft({
      ...draftInput,
      reviewId: "move",
      destinations: [
        {
          ...destination,
          connectionRevision: 2,
          target: {
            resourceId: "repo-a",
            scope: { kind: "environment", name: "prod/blue %" },
          },
        },
      ],
      source: { ...destination, connectionRevision: 2 },
    });
    expect(scopeMove.source?.snapshot.scope).toEqual({ kind: "repository" });
    expect(scopeMove.destinations[0]!.snapshot.scope).toEqual({
      kind: "environment",
      name: "prod/blue %",
    });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    const request = upload(scopeMove);
    await expect(
      reviews.upload(request, { ...workspace, reviewId: scopeMove.id }),
    ).rejects.toMatchObject({ code: "secret_review_conflict" });
    expect(request.bodyUsed).toBe(false);
  });
  it("rejects malformed material without leaking canaries and expires private ciphertext independently of review history", async () => {
    await save();
    const reviews = new SecretReviews(as());
    const draft = await reviews.draft(draftInput);
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    const request = upload(draft, [
      { destinationIndex: 0, ciphertext: PRIVATE },
    ]);
    const response = await app.fetch(request, runtime);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(PRIVATE);
    const valid = await app.fetch(upload(draft), runtime);
    expect(valid.status).toBe(200);
    expect(await valid.text()).not.toContain(SEALED);
    await reapSecretInputs(runtime, now);
    expect(
      (await reviews.get({ ...workspace, reviewId: draft.id })).inputPresent,
    ).toBe(true);
    now += REVIEW_LIMITS.INPUT_RETENTION_MS + 1;
    await reapSecretInputs(runtime, now);
    expect(
      (await reviews.get({ ...workspace, reviewId: draft.id })).inputPresent,
    ).toBe(false);
    expect((await reviews.history(workspace)).items).toHaveLength(1);
    for (const table of [
      "secret_reviews",
      "secret_review_repositories",
      "activity",
      "workspace_push_outbox",
    ]) {
      const contents = await bindings.HQ_DB.prepare(
        "SELECT * FROM " + table,
      ).all();
      expect(JSON.stringify(contents)).not.toContain(SEALED);
      expect(JSON.stringify(contents)).not.toContain(PRIVATE);
    }
  });
  it("bounds body bytes, UTF-8 parsing, and stalled input deadlines", async () => {
    const tooLarge = new Request("https://hq.example", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(REVIEW_LIMITS.UPLOAD_BYTES + 1),
      },
      body: "{}",
    });
    await expect(readSecretInput(tooLarge)).rejects.toMatchObject({
      code: "secret_input_invalid",
    });
    expect(tooLarge.bodyUsed).toBe(false);
    const badUtf8 = new Request("https://hq.example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([255]),
    });
    await expect(readSecretInput(badUtf8)).rejects.toMatchObject({
      code: "secret_input_invalid",
    });
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stalled = new Request("https://hq.example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({ cancel }),
    });
    const failure = expect(readSecretInput(stalled)).rejects.toMatchObject({
      code: "secret_input_invalid",
    });
    await vi.advanceTimersByTimeAsync(REVIEW_LIMITS.INPUT_READ_MS);
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Secrets metadata enrollment and authority", () => {
  it("records enrollment notifications in the same write without rejecting trigger-inclusive counts", async () => {
    await bindings.HQ_DB.prepare(
      "UPDATE workspace_push_outbox SET pending_topics=0 WHERE workspace_id='alpha'",
    ).run();
    const before = await bindings.HQ_DB.prepare(
      "SELECT revision FROM workspace_push_outbox WHERE workspace_id='alpha'",
    ).first<{ revision: number }>();
    await save();
    const after = await bindings.HQ_DB.prepare(
      "SELECT revision,pending_topics FROM workspace_push_outbox WHERE workspace_id='alpha'",
    ).first<{ revision: number; pending_topics: number }>();
    expect(after!.revision).toBeGreaterThan(before!.revision);
    expect(after!.pending_topics & 1).toBe(1);
    expect(after!.pending_topics & 2).toBe(2);
    expect((await save(1)).revision).toBe(2);
  });
  it("saves only explicit enrolled repositories, with immutable Activity attribution and no provider writes", async () => {
    const result = await save();
    expect(result).toMatchObject({
      id: "secrets",
      revision: 1,
      resourceIds: ["repo-a"],
      available: true,
      writable: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    const links = await bindings.HQ_DB.prepare(
      "SELECT repository_id FROM activity_repository_links WHERE workspace_id='alpha'",
    ).all();
    expect(links.results).toEqual([{ repository_id: "repo-a" }]);
    expect(await as("viewer").secretsConnections(workspace)).toHaveLength(1);
    await expect(save()).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(save(1, { resourceIds: ["repo-c"] })).rejects.toMatchObject({
      code: "secret_repository_denied",
    });
    await expect(save(1, { resourceIds: ["missing"] })).rejects.toMatchObject({
      code: "secret_repository_denied",
    });
    await expect(
      save(1, { resourceIds: ["repo-a", "repo-a"] }),
    ).rejects.toThrow();
  });
  it("does not borrow the existing read-only evidence credential", async () => {
    runtime.GITHUB_CREDENTIALS = JSON.stringify({ selected: descriptor });
    delete runtime.GITHUB_SECRET_CREDENTIALS;
    expect(await as().secretsProviders(workspace)).toEqual([]);
    await expect(save()).rejects.toMatchObject({
      code: "secret_provider_unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds role, workspace, publisher, Reporter, and provider-reference visibility", async () => {
    await save();
    for (const subject of ["operator", "viewer"]) {
      await expect(save(1, {}, as(subject))).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        as(subject).secretsProviders(workspace),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        authorizeHooks(as(subject), "alpha", CAPABILITY.SECRETS),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    const guard = hookActorGuard(as("operator"), "alpha", CAPABILITY.SECRETS);
    expect(
      await bindings.HQ_DB.prepare("SELECT 1 AS allowed WHERE " + guard.sql)
        .bind(...guard.values)
        .first(),
    ).toBeNull();
    await expect(
      as("outside").secretsConnections(workspace),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      as("owner", { workspaceId: "beta" }).secretsConnections(workspace),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const extra of [
      { reporterId: "reporter" },
      { sourceId: "publisher" },
      { scopes: [CAPABILITY.ACTIVITY] },
    ])
      await expect(
        as("owner", extra).secretsInventory(inventory),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects stale or out-of-scope enrollment on subsequent reads", async () => {
    await save();
    await expect(
      as().secretsInventory({
        ...inventory,
        target: { ...inventory.target, resourceId: "repo-b" },
      }),
    ).rejects.toMatchObject({ code: "secret_resource_denied" });
    await save(1, { enabled: false });
    await expect(as().secretsInventory(inventory)).rejects.toMatchObject({
      code: "secret_connection_disabled",
    });
    await save(2);
    await bindings.HQ_DB.prepare(
      "UPDATE repositories SET full_name='example/renamed',revision=revision+1 WHERE id='repo-a'",
    ).run();
    await expect(as().secretsInventory(inventory)).rejects.toMatchObject({
      code: "secret_identity_changed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks membership and connection changes after provider reads", async () => {
    await save();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes("/secrets?"))
        await bindings.HQ_DB.prepare(
          "UPDATE secret_connections SET revision=revision+1 WHERE id='secrets'",
        ).run();
      return response;
    });
    await expect(as().secretsInventory(inventory)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    fetcher.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes("/secrets?"))
        await bindings.HQ_DB.prepare(
          "DELETE FROM members WHERE subject='owner'",
        ).run();
      return response;
    });
    await expect(as().secretsInventory(inventory)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("bounded GitHub Secrets transport", () => {
  it("reads names and timestamps without values, pins identity, and encodes opaque environment names once", async () => {
    await save();
    expect(await as("viewer").secretsInventory(inventory)).toMatchObject({
      items: [normalizedInventorySecret],
      total: 1,
      nextPage: null,
      truncated: false,
      resourceIdentity: "42",
    });
    expect(
      await as().secretsScopes({ ...connection, resourceId: "repo-a" }),
    ).toMatchObject({
      fixedScopes: [
        {
          identity: "7",
          scope: { kind: "organization", name: "example" },
        },
      ],
      items: [
        { identity: "8", scope: { kind: "environment", name: "prod/blue %" } },
      ],
    });
    const result = await as().secretsInventory({
      ...inventory,
      target: {
        resourceId: "repo-a",
        scope: { kind: "environment", name: "prod/blue %" },
      },
    });
    expect(result.scopeIdentity).toBe("8");
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    const paths = fetcher.mock.calls.map(([url]) => String(url));
    expect(paths).toContain(
      "https://api.github.com/repos/example/repo-a/environments/prod%2Fblue%20%25/secrets?per_page=30&page=1",
    );
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
  });
  it("reads provider-declared variables and repository-effective organization entries", async () => {
    await save();
    const repositoryVariables = await as().secretsInventory({
      ...inventory,
      entryKind: "variable",
    });
    expect(repositoryVariables).toMatchObject({
      entryKind: "variable",
      scopeIdentity: null,
      items: [
        {
          name: "DEPLOY_REGION",
          kind: "variable",
          management: "unmanaged",
          value: "us-central1",
          valueFormat: "text",
        },
      ],
    });
    for (const entryKind of ["secret", "variable"] as const) {
      const result = await as().secretsInventory({
        ...inventory,
        entryKind,
        target: {
          resourceId: "repo-a",
          scope: { kind: "organization", name: "example" },
        },
      });
      expect(result).toMatchObject({
        entryKind,
        scopeIdentity: "7",
        target: {
          scope: { kind: "organization", name: "example" },
        },
      });
    }
    const paths = fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toContain("/repos/example/repo-a/actions/variables");
    expect(paths).toContain(
      "/repos/example/repo-a/actions/organization-secrets",
    );
    expect(paths).toContain(
      "/repos/example/repo-a/actions/organization-variables",
    );
    expect(JSON.stringify(repositoryVariables)).not.toContain(PRIVATE);
  });
  it("keeps organization configuration outside the reviewed secret-write workflow", async () => {
    await save();
    await expect(
      as().secretsDraft({
        ...workspace,
        reviewId: "organization-write",
        destinations: [
          {
            connectionId: "secrets",
            connectionRevision: 1,
            target: {
              resourceId: "repo-a",
              scope: { kind: "organization", name: "example" },
            },
            name: "DEPLOY_TOKEN",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "secret_scope_read_only" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not fabricate organization scope for a user-owned repository", async () => {
    await save();
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/repos/example/repo-a")
        return Response.json({
          id: 42,
          full_name: "example/repo-a",
          archived: false,
          disabled: false,
          owner: { id: 7, login: "example", type: "User" },
        });
      if (path.endsWith("/environments"))
        return Response.json({ total_count: 0, environments: [] });
      throw new Error("Unexpected provider request");
    });
    expect(
      await as().secretsScopes({ ...connection, resourceId: "repo-a" }),
    ).toMatchObject({ fixedScopes: [] });
    await expect(
      as().secretsInventory({
        ...inventory,
        target: {
          resourceId: "repo-a",
          scope: { kind: "organization", name: "example" },
        },
      }),
    ).rejects.toMatchObject({ code: "secret_scope_invalid" });
  });
  it("returns bounded pagination and cannot turn incomplete or denied reads into empty inventories", async () => {
    const client = (await secretProvider(runtime, "alpha", "selected")).client;
    fetcher.mockResolvedValue(
      Response.json({
        total_count: 31,
        secrets: Array.from({ length: 30 }, (_, index) => ({
          ...metadata,
          name: "SECRET_" + index,
        })),
      }),
    );
    expect(await client.inventory("example/repo-a", null, 1)).toMatchObject({
      nextPage: 2,
      truncated: false,
    });
    fetcher.mockResolvedValue(
      Response.json({
        total_count: 3001,
        secrets: Array.from({ length: 30 }, (_, index) => ({
          ...metadata,
          name: "SECRET_" + index,
        })),
      }),
    );
    expect(
      await client.inventory("example/repo-a", null, SECRET_LIMITS.MAX_PAGE),
    ).toMatchObject({ nextPage: null, truncated: true });
    fetcher.mockImplementation(async () =>
      Response.json({ total_count: 31, secrets: [] }),
    );
    await expect(
      client.inventory("example/repo-a", null, 1),
    ).rejects.toMatchObject({ code: "secret_provider_invalid" });
    for (const [status, code] of [
      [403, "secret_permission_denied"],
      [404, "secret_resource_unavailable"],
      [429, "secret_rate_limited"],
      [502, "secret_provider_failed"],
    ] as const) {
      fetcher.mockImplementation(async () =>
        Response.json({ message: PRIVATE }, { status }),
      );
      await expect(
        client.inventory("example/repo-a", null, 1),
      ).rejects.toMatchObject({ code });
    }
    fetcher.mockImplementation(async () =>
      Response.json(
        { message: PRIVATE },
        { status: 403, headers: { "X-RateLimit-Remaining": "0" } },
      ),
    );
    await expect(
      client.inventory("example/repo-a", null, 1),
    ).rejects.toMatchObject({ code: "secret_rate_limited" });
  });
  it("rejects redirects, changed identities, invalid public keys, and oversized provider bodies", async () => {
    const client = (await secretProvider(runtime, "alpha", "selected")).client;
    fetcher.mockImplementation(
      async () =>
        new Response(null, {
          status: 301,
          headers: { Location: "https://elsewhere.example" },
        }),
    );
    await expect(client.repository("example/repo-a")).rejects.toMatchObject({
      code: "secret_provider_failed",
    });
    fetcher.mockImplementation(async () =>
      Response.json({
        id: 42,
        full_name: "example/repo-b",
        archived: false,
        disabled: false,
        owner: { id: 7, login: "example", type: "Organization" },
      }),
    );
    await expect(client.repository("example/repo-a")).rejects.toMatchObject({
      code: "secret_identity_changed",
    });
    fetcher.mockImplementation(async () =>
      Response.json({ key_id: "public-key", key: "B".repeat(43) + "=" }),
    );
    await expect(
      client.publicKey("example/repo-a", null),
    ).rejects.toMatchObject({ code: "secret_provider_invalid" });
    fetcher.mockImplementation(
      async () => new Response("A".repeat(SECRET_LIMITS.RESPONSE_BYTES + 1)),
    );
    await expect(client.repository("example/repo-a")).rejects.toMatchObject({
      code: "secret_provider_interrupted",
    });
    const before = fetcher.mock.calls.length;
    for (const name of ["example/..", "../repo-a", "example/repo-c"])
      await expect(client.repository(name)).rejects.toThrow();
    await expect(client.environment("example/repo-a", "..")).rejects.toThrow();
    expect(() => client.remove("example/repo-a", null, "..")).toThrow();
    await expect(
      client.inventory("example/repo-a", null, SECRET_LIMITS.MAX_PAGE + 1),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBe(before);
  });
  it("keeps credential identities sensitive to scope, expiry, and rotation while descriptors never return the token", async () => {
    const original = (await secretProvider(runtime, "alpha", "selected"))
      .identity;
    for (const change of [
      { token: "rotated" },
      { revision: 2 },
      { writable: false },
      { repositoryNames: ["example/repo-b"] },
    ]) {
      runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
        selected: { ...descriptor, ...change },
      });
      expect(
        (await secretProvider(runtime, "alpha", "selected")).identity,
      ).not.toBe(original);
      expect(
        JSON.stringify(secretProviderReferences(runtime, "alpha")),
      ).not.toContain(PRIVATE);
    }
    runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
      selected: { ...descriptor, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(secretProviderReferences(runtime, "alpha")[0]?.available).toBe(
      false,
    );
    await expect(
      secretProvider(runtime, "alpha", "selected"),
    ).rejects.toMatchObject({ code: "secret_provider_unavailable" });
    expect(secretProviderReferences(runtime, "beta")).toEqual([]);
  });
  it("classifies write acceptance and uncertainty without returning provider payloads or retrying", async () => {
    const client = (await secretProvider(runtime, "alpha", "selected")).client;
    for (const [status, expected] of [
      [201, "accepted"],
      [204, "accepted"],
      [422, "rejected"],
      [408, "indeterminate"],
      [500, "indeterminate"],
      [307, "indeterminate"],
    ] as const) {
      fetcher.mockImplementation(async () => new Response(null, { status }));
      const before = fetcher.mock.calls.length;
      const result = await client.put(
        "example/repo-a",
        null,
        "DEPLOY_TOKEN",
        publicKey.key_id,
        "synthetic-ciphertext",
      );
      expect(result.status).toBe(expected);
      expect(fetcher.mock.calls.length).toBe(before + 1);
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
    }
    fetcher.mockRejectedValue(new Error(PRIVATE));
    expect(
      (await client.remove("example/repo-a", null, "DEPLOY_TOKEN")).status,
    ).toBe("indeterminate");
    const readonly = new SecretGitHubClient(
      { ...descriptor, writable: false },
      fetcher,
    );
    const before = fetcher.mock.calls.length;
    expect(
      await readonly.put(
        "example/repo-a",
        null,
        "DEPLOY_TOKEN",
        "key",
        "sealed",
      ),
    ).toEqual({ status: "rejected", reason: "credential_read_only" });
    expect(fetcher.mock.calls.length).toBe(before);
  });
  it("bounds stalled headers and streaming bodies with one total deadline", async () => {
    vi.useFakeTimers();
    const client = (await secretProvider(runtime, "alpha", "selected")).client;
    fetcher.mockImplementation(() => new Promise(() => {}));
    const headers = expect(
      client.repository("example/repo-a"),
    ).rejects.toMatchObject({ code: "secret_provider_interrupted" });
    await vi.advanceTimersByTimeAsync(SECRET_LIMITS.REQUEST_MS + 1);
    await headers;
    fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        ),
    );
    const body = expect(
      client.repository("example/repo-a"),
    ).rejects.toMatchObject({ code: "secret_provider_interrupted" });
    await vi.advanceTimersByTimeAsync(SECRET_LIMITS.REQUEST_MS + 1);
    await body;
  });
  it("does not await an untrusted cancellation handler on errors or accepted writes", async () => {
    const client = (await secretProvider(runtime, "alpha", "selected")).client;
    fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({ cancel: () => new Promise(() => {}) }),
          { status: 403 },
        ),
    );
    await expect(
      client.inventory("example/repo-a", null, 1),
    ).rejects.toMatchObject({ code: "secret_permission_denied" });
    fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({ cancel: () => new Promise(() => {}) }),
          { status: 201 },
        ),
    );
    expect(
      (await client.put("example/repo-a", null, "TOKEN", "key", "ciphertext"))
        .status,
    ).toBe("accepted");
  });
});

describe("Secrets command boundaries", () => {
  it("models standalone provider resources, case-sensitive names, unknown versions, and cross-connection delivery without GitHub assumptions", async () => {
    const resource = secretResourceBindingSchema.parse({
      id: "worker-live",
      label: "Live Worker",
      identity: "account/worker-live",
      repositories: [],
    });
    expect(resource.repositories).toEqual([]);
    const cloudflare = secretDestinationSchema.parse({
      connectionId: "cloudflare",
      connectionRevision: 1,
      target: { resourceId: resource.id, scope: { kind: "worker" } },
      name: "MixedCaseToken",
    });
    expect(cloudflare.name).toBe("MixedCaseToken");
    const github = secretDestinationSchema.parse({
      connectionId: "github",
      connectionRevision: 2,
      target: inventory.target,
      name: "MIXEDCASETOKEN",
    });
    expect(
      secretDraftInput.parse({
        ...workspace,
        reviewId: "distribution",
        destinations: [cloudflare, github],
      }).destinations,
    ).toEqual([cloudflare, github]);
    expect(
      secretMetadataSchema.parse({
        name: "MixedCaseToken",
        createdAt: null,
        updatedAt: null,
        version: null,
        value: PRIVATE,
      }),
    ).toEqual({
      name: "MixedCaseToken",
      createdAt: null,
      updatedAt: null,
      version: null,
    });
    expect(
      secretAdapter(SECRET_PROVIDER_KIND.CLOUDFLARE).capabilities,
    ).toMatchObject({
      entryKinds: ["secret", "variable"],
      input: "private-transient",
      activation: "worker-deployment",
      scopeKinds: ["worker"],
      secretMutationScopeKinds: ["worker"],
      variableMutationScopeKinds: [],
      valueReadableKinds: ["variable"],
    });
    await expect(
      save(0, {
        providerKind: SECRET_PROVIDER_KIND.CLOUDFLARE,
        resourceIds: [resource.id],
      }),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps provider-specific capabilities explicit and does not allow a connection to change provider kind", async () => {
    expect(await save()).toMatchObject({
      providerKind: SECRET_PROVIDER_KIND.GITHUB,
      resources: [
        { id: "repo-a", label: "example/repo-a", repositoryIds: ["repo-a"] },
      ],
      capabilities: {
        entryKinds: ["secret", "variable"],
        input: "provider-sealed",
        nameRule: "github-actions",
        scopeKinds: ["organization", "repository", "environment"],
        secretMutationScopeKinds: ["repository", "environment"],
        variableMutationScopeKinds: ["repository", "environment"],
        valueReadableKinds: ["variable"],
        metadataVersion: "timestamps",
        activation: "secret-update",
        storedValueReadable: false,
      },
    });
    await expect(
      save(1, { providerKind: SECRET_PROVIDER_KIND.CLOUDFLARE }),
    ).rejects.toMatchObject({ code: "secret_provider_conflict" });
    await expect(
      as().secretsInventory({
        ...inventory,
        target: { resourceId: "repo-a", scope: { kind: "worker" } },
      }),
    ).rejects.toMatchObject({ code: "secret_scope_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("attributes enrollment removals to both old and new repository contexts", async () => {
    await save();
    await save(1, { resourceIds: ["repo-b"] });
    const rows = await bindings.HQ_DB.prepare(
      "SELECT event_id,repository_id FROM activity_repository_links WHERE workspace_id='alpha' ORDER BY event_id,repository_id",
    ).all<{ event_id: string; repository_id: string }>();
    const byEvent = new Map<string, string[]>();
    for (const row of rows.results)
      byEvent.set(row.event_id, [
        ...(byEvent.get(row.event_id) ?? []),
        row.repository_id,
      ]);
    expect([...byEvent.values()]).toContainEqual(["repo-a", "repo-b"]);
  });
  it("uses the same safe result and permissions through HTTP commands and HTTP MCP", async () => {
    await save();
    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const request = (path: string, body: object) =>
      new Request("https://hq.example" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const http = await app.fetch(
      request("/api/commands/secrets_inventory", inventory),
      runtime,
    );
    expect(http.status).toBe(200);
    const result = await http.json();
    const mcp = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: "inventory",
        method: "tools/call",
        params: { name: "secrets_inventory", arguments: inventory },
      }),
      runtime,
    );
    expect(mcp.status).toBe(200);
    const envelope = (await mcp.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(envelope.result.isError).not.toBe(true);
    expect(JSON.parse(envelope.result.content[0]!.text)).toMatchObject({
      items: [normalizedInventorySecret],
      total: 1,
    });
    expect(JSON.stringify([result, envelope])).not.toContain(PRIVATE);
    const denied = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: "provider",
        method: "tools/call",
        params: { name: "secrets_providers", arguments: workspace },
      }),
      runtime,
    );
    expect(await denied.json()).toMatchObject({ result: { isError: true } });
    await expect(
      as("owner", {
        tokenId: "revoked",
        scopes: [CAPABILITY.READ],
      }).secretsInventory(inventory),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("shares strict metadata schemas without any plaintext or provider URL passthrough", () => {
    for (const name of [
      "secrets_connections",
      "secrets_providers",
      "secrets_connection_save",
      "secrets_scopes",
      "secrets_inventory",
    ] as const)
      expect(commands[name]).toBeDefined();
    for (const extra of [
      { value: PRIVATE },
      { encryptedValue: PRIVATE },
      { token: PRIVATE },
      { url: "https://example.com" },
    ])
      expect(
        commands.secrets_inventory.schema.safeParse({ ...inventory, ...extra })
          .success,
      ).toBe(false);
    expect(commands.secrets_inventory.schema.parse(inventory).entryKind).toBe(
      "secret",
    );
    expect(
      commands.secrets_inventory.schema.parse({
        ...inventory,
        entryKind: "variable",
      }).entryKind,
    ).toBe("variable");
    expect(
      commands.secrets_inventory.schema.safeParse({
        ...inventory,
        entryKind: "credential",
      }).success,
    ).toBe(false);
    expect(
      secretInventoryItemSchema.safeParse({
        ...normalizedInventorySecret,
        value: PRIVATE,
        valueFormat: "text",
      }).success,
    ).toBe(false);
    expect(
      secretInventoryItemSchema.safeParse({
        ...normalizedInventorySecret,
        kind: "variable",
      }).success,
    ).toBe(false);
    expect(
      secretInventoryItemSchema.safeParse({
        ...normalizedInventorySecret,
        kind: "variable",
        value: "\u03bb".repeat(REVIEW_LIMITS.INVENTORY_VALUE_BYTES),
        valueFormat: "text",
      }).success,
    ).toBe(false);
    expect(secretNameSchema.parse("deploy_token")).toBe("DEPLOY_TOKEN");
    for (const name of ["GITHUB_TOKEN", "2TOKEN", "A/B"])
      expect(secretNameSchema.safeParse(name).success).toBe(false);
    for (const name of [".", "..", "bad\nname"])
      expect(secretEnvironmentSchema.safeParse(name).success).toBe(false);
    expect(secretEnvironmentSchema.parse(" space ")).toBe(" space ");
    const destination = {
      connectionId: "secrets",
      connectionRevision: 1,
      target: inventory.target,
      name: "TOKEN",
    };
    expect(
      secretDraftInput.safeParse({
        ...workspace,
        reviewId: "review",
        destinations: [destination, destination],
      }).success,
    ).toBe(false);
  });
});
