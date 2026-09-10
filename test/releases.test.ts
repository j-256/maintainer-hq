import { env, applyD1Migrations } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import { RELEASE_LIMITS, releaseResultSchema } from "../shared/releases";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";
import {
  RELEASE_FIXTURE as F,
  comparisonFixture,
  releaseFixture,
} from "./fixtures/releases";
import { callCommand, clientConfiguration } from "../cli/client";

import { workResultSchema } from "../shared/repository-work";
import { WORK_QUERY, WORK_SIGNALS_QUERY } from "../worker/work-client";
import { workFixture, workSignalsFixture } from "./fixtures/repository-work";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
const VIEWER: Principal = { subject: "viewer", displayName: "Viewer" };
let now: number;
let runtime: Env;
let owner: WorkspaceService;
let viewer: WorkspaceService;
let repositoryId: string;
const input = () => ({
  workspaceId: "alpha",
  sourceId: "github",
  repositoryId,
});
const fields = () => ({
  name: "Read-only GitHub",
  enabled: true,
  freshnessMinutes: 30,
  repositoryIds: [repositoryId],
  credentialRef: "personal",
  refreshIntervalMinutes: 15,
});
const catalog = () =>
  JSON.stringify({
    personal: {
      workspaceId: "alpha",
      name: "Read-only GitHub",
      token: F.token,
    },
  });
function provider(
  intercept?: (url: URL) => Promise<Response | void> | Response | void,
) {
  let fullName = String(F.repository);
  const fetcher = vi.fn(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target));
      expect(url.origin).toBe("https://api.github.com");
      const override = await intercept?.(url);
      if (override) return override;
      if (url.pathname === "/graphql") {
        const body = JSON.parse(String(init?.body));
        if (body.query === WORK_SIGNALS_QUERY)
          return Response.json(
            workSignalsFixture(fullName, body.variables.ids),
          );
        const { owner, name } = body.variables;
        fullName = owner + "/" + name;
        return Response.json(
          body.query === WORK_QUERY
            ? workFixture(fullName)
            : releaseFixture(fullName),
        );
      }
      return Response.json(comparisonFixture());
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: catalog(),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM github_context_budgets"),
    bindings.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('alpha', 'Alpha', '2026-01-01'), ('beta', 'Beta', '2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id, subject, display_name, role) VALUES ('alpha', 'owner', 'Owner', 'owner'), ('alpha', 'viewer', 'Viewer', 'viewer'), ('beta', 'other', 'Other', 'owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  owner = new WorkspaceService(runtime, OWNER, false, () => now);
  viewer = new WorkspaceService(runtime, VIEWER, false, () => now);
  repositoryId = (
    await owner.createRepository({
      workspaceId: "alpha",
      repository: {
        fullName: F.repository,
        description: "Synthetic release fixture",
        projectId: "project",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    })
  ).id;
  await owner.githubSourceEnroll({
    workspaceId: "alpha",
    sourceId: "github",
    source: fields(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["releases", "work"] as const)(
  "Workspace-scoped %s cache",
  (kind) => {
    const method = kind === "work" ? "repositoryWork" : "repositoryReleases";
    const cacheTable =
      kind === "work" ? "github_work_cache" : "github_release_cache";
    const commandName =
      kind === "work" ? "repository_work" : "repository_releases";
    const resultSchema =
      kind === "work" ? workResultSchema : releaseResultSchema;
    it("shares the credential budget across release and work caches", async () => {
      const hash = await credentialHash(F.token);
      await bindings.HQ_DB.prepare(
        "INSERT INTO github_context_budgets (credential_hash, window_start, reads) VALUES (?, ?, ?)",
      )
        .bind(
          hash,
          Math.floor(now / RELEASE_LIMITS.BUDGET_WINDOW_MS) *
            RELEASE_LIMITS.BUDGET_WINDOW_MS,
          RELEASE_LIMITS.READS_PER_WINDOW - 1,
        )
        .run();
      const fetcher = provider();
      const results = await Promise.all([
        viewer.repositoryReleases(input()),
        viewer.repositoryWork(input()),
      ]);
      expect(results.map((result) => result.state).sort()).toEqual([
        "ready",
        "waiting",
      ]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("allows viewers without operation permissions and reuses fresh evidence without advancing its timestamp", async () => {
      const fetcher = provider();
      const first = await viewer[method](input());
      now += 1000;
      const second = await viewer[method](input());
      expect(first.state).toBe("ready");
      expect(second).toEqual(first);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(resultSchema.safeParse(first).success).toBe(true);
      const row = await bindings.HQ_DB.prepare(
        `SELECT * FROM ${cacheTable}`,
      ).first();
      expect(JSON.stringify(row)).not.toContain(F.token);
      expect(JSON.stringify(row)).not.toContain(F.privateValue);
    });
    it("refreshes only after the read window and publishes a source-only invalidation", async () => {
      const fetcher = provider();
      const first = await viewer[method](input());
      now += RELEASE_LIMITS.CACHE_MS;
      await bindings.HQ_DB.prepare(
        "UPDATE workspace_push_outbox SET pending_topics = 0",
      ).run();
      const second = await viewer[method](input());
      expect(second.evidence?.observedAt).not.toBe(first.evidence?.observedAt);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id = 'alpha'",
        ).first("pending_topics"),
      ).toBe(4);
    });
    it("deduplicates concurrent reads with a durable lease", async () => {
      let resolve: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const waiting = new Promise<void>((done) => {
        resolve = done;
      });
      const started = new Promise<void>((done) => {
        entered = done;
      });
      const fetcher = provider(async (url) => {
        if (url.pathname === "/graphql") {
          entered();
          await waiting;
        }
      });
      const first = viewer[method](input());
      await started;
      const second = await viewer[method](input());
      expect(second).toMatchObject({ state: "collecting", evidence: null });
      resolve();
      expect((await first).state).toBe("ready");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("honors shared credential cooldown before provider work and persists a new provider cooldown", async () => {
      const hash = await credentialHash(F.token);
      const retryAt = new Date(now + 600000).toISOString();
      const fetcher = provider(
        () =>
          new Response(F.privateValue, {
            status: 429,
            headers: { "Retry-After": "600" },
          }),
      );
      await bindings.HQ_DB.prepare(
        "INSERT INTO github_cooldowns (credential_hash, retry_at) VALUES (?, ?)",
      )
        .bind(hash, retryAt)
        .run();
      expect(await viewer[method](input())).toMatchObject({
        state: "waiting",
        nextReadAt: retryAt,
        evidence: null,
      });
      expect(fetcher).not.toHaveBeenCalled();
      now += 600000;
      const result = await viewer[method](input());
      expect(result.evidence).toMatchObject(
        kind === "work"
          ? { pulls: { state: "rate_limited" } }
          : { release: { state: "rate_limited" } },
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT retry_at FROM github_cooldowns WHERE credential_hash = ?",
        )
          .bind(hash)
          .first("retry_at"),
      ).toBe(result.evidence?.retryAt);
    });
    it("caps aggregate provider work independently of repository and source selection", async () => {
      const hash = await credentialHash(F.token);
      await bindings.HQ_DB.prepare(
        "INSERT INTO github_context_budgets (credential_hash, window_start, reads) VALUES (?, ?, ?)",
      )
        .bind(
          hash,
          Math.floor(now / RELEASE_LIMITS.BUDGET_WINDOW_MS) *
            RELEASE_LIMITS.BUDGET_WINDOW_MS,
          RELEASE_LIMITS.READS_PER_WINDOW,
        )
        .run();
      const fetcher = provider();
      expect((await viewer[method](input())).state).toBe("waiting");
      expect(fetcher).not.toHaveBeenCalled();
      now += RELEASE_LIMITS.BUDGET_WINDOW_MS;
      expect((await viewer[method](input())).state).toBe("ready");
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("serializes a shared budget across concurrent source aliases", async () => {
      await owner.githubSourceEnroll({
        workspaceId: "alpha",
        sourceId: "alias",
        source: { ...fields(), name: "Same grant alias" },
      });
      const hash = await credentialHash(F.token);
      await bindings.HQ_DB.prepare(
        "INSERT INTO github_context_budgets (credential_hash, window_start, reads) VALUES (?, ?, ?)",
      )
        .bind(
          hash,
          Math.floor(now / RELEASE_LIMITS.BUDGET_WINDOW_MS) *
            RELEASE_LIMITS.BUDGET_WINDOW_MS,
          RELEASE_LIMITS.READS_PER_WINDOW - 1,
        )
        .run();
      const fetcher = provider();
      const results = await Promise.all([
        viewer[method](input()),
        viewer[method]({ ...input(), sourceId: "alias" }),
      ]);
      expect(results.map((result) => result.state).sort()).toEqual([
        "ready",
        "waiting",
      ]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT reads FROM github_context_budgets WHERE credential_hash = ?",
        )
          .bind(hash)
          .first("reads"),
      ).toBe(RELEASE_LIMITS.READS_PER_WINDOW);
    });
    it("checks human-session expiry before and after collection", async () => {
      const principal = { ...VIEWER, expiresAt: now + 1000 };
      const timed = new WorkspaceService(runtime, principal, false, () => now);
      const fetcher = provider(async (url) => {
        if (url.pathname === "/graphql") now += 2000;
      });
      await expect(timed[method](input())).rejects.toMatchObject({
        status: 401,
      });
      expect(
        await bindings.HQ_DB.prepare(
          `SELECT result_json FROM ${cacheTable}`,
        ).first("result_json"),
      ).toBeNull();
      fetcher.mockClear();
      await expect(timed[method](input())).rejects.toMatchObject({
        status: 401,
      });
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("does not accept a result after its durable lease expires", async () => {
      provider(async (url) => {
        if (url.pathname === "/graphql") now += RELEASE_LIMITS.LEASE_MS + 1;
      });
      await expect(viewer[method](input())).rejects.toMatchObject({
        status: 409,
      });
      expect(
        await bindings.HQ_DB.prepare(
          `SELECT result_json FROM ${cacheTable}`,
        ).first("result_json"),
      ).toBeNull();
    });
    it.each(["source", "repository", "credential"])(
      "never revives cache across %s identity changes",
      async (variant) => {
        const fetcher = provider();
        await viewer[method](input());
        if (variant === "source")
          await bindings.HQ_DB.prepare(
            "UPDATE connections SET revision = revision + 1 WHERE workspace_id = 'alpha' AND id = 'github'",
          ).run();
        if (variant === "repository")
          await bindings.HQ_DB.prepare(
            "UPDATE repositories SET full_name = 'example/renamed', revision = revision + 1 WHERE id = ?",
          )
            .bind(repositoryId)
            .run();
        if (variant === "credential")
          runtime.GITHUB_CREDENTIALS = JSON.stringify({
            personal: {
              workspaceId: "alpha",
              name: "Rotated",
              token: "synthetic-rotated-read-token",
            },
          });
        const result = await viewer[method](input());
        expect(result).toMatchObject({ state: "waiting", evidence: null });
        expect(fetcher).toHaveBeenCalledTimes(2);
        now += RELEASE_LIMITS.CACHE_MS;
        expect((await viewer[method](input())).state).toBe("ready");
        expect(fetcher).toHaveBeenCalledTimes(4);
      },
    );
    it.each(["disabled", "credential", "configuration"])(
      "does not read or return old evidence for %s settings",
      async (variant) => {
        const fetcher = provider();
        await viewer[method](input());
        if (variant === "disabled")
          await bindings.HQ_DB.prepare(
            "UPDATE connections SET enabled = 0, revision = revision + 1 WHERE id = 'github'",
          ).run();
        if (variant === "configuration")
          await bindings.HQ_DB.prepare(
            "UPDATE connections SET configuration_json = '{}' WHERE id = 'github'",
          ).run();
        if (variant === "credential") runtime.GITHUB_CREDENTIALS = "{}";
        expect(await viewer[method](input())).toMatchObject({
          state: variant === "disabled" ? "disabled" : "not_configured",
          evidence: null,
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );
    it.each(["membership", "source", "repository", "credential"])(
      "discards in-flight evidence when %s changes",
      async (variant) => {
        provider(async (url) => {
          if (url.pathname !== "/graphql") return;
          if (variant === "membership")
            await bindings.HQ_DB.prepare(
              "DELETE FROM members WHERE workspace_id = 'alpha' AND subject = 'viewer'",
            ).run();
          if (variant === "source")
            await bindings.HQ_DB.prepare(
              "UPDATE connections SET enabled = 0, revision = revision + 1 WHERE id = 'github'",
            ).run();
          if (variant === "repository")
            await bindings.HQ_DB.prepare(
              "UPDATE repositories SET revision = revision + 1 WHERE id = ?",
            )
              .bind(repositoryId)
              .run();
          if (variant === "credential") runtime.GITHUB_CREDENTIALS = "{}";
        });
        await expect(viewer[method](input())).rejects.toMatchObject({
          status: variant === "membership" ? 404 : 409,
        });
        expect(
          await bindings.HQ_DB.prepare(
            `SELECT result_json FROM ${cacheTable}`,
          ).first("result_json"),
        ).toBeNull();
      },
    );
    it("rejects workspace, source, publisher, reporter and arbitrary-path input before provider work", async () => {
      const fetcher = provider();
      await expect(
        viewer[method]({ ...input(), workspaceId: "beta" }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        viewer[method]({ ...input(), sourceId: "other" }),
      ).rejects.toMatchObject({ status: 404 });
      for (const scoped of [{ sourceId: "github" }, { reporterId: "reporter" }])
        await expect(
          new WorkspaceService(
            runtime,
            { ...OWNER, ...scoped },
            false,
            () => now,
          )[method](input()),
        ).rejects.toBeDefined();
      await expect(
        viewer[method]({ ...input(), query: "mutation { anything }" }),
      ).rejects.toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
    });
    it("recovers a lost lease only after its existing read budget and cascades removed enrollment", async () => {
      provider();
      await viewer[method](input());
      await bindings.HQ_DB.prepare(
        `UPDATE ${cacheTable} SET result_json = NULL, lease_id = 'lost', lease_until = ?, next_read_at = ?`,
      )
        .bind(
          new Date(now + RELEASE_LIMITS.LEASE_MS).toISOString(),
          new Date(now + RELEASE_LIMITS.CACHE_MS).toISOString(),
        )
        .run();
      expect((await viewer[method](input())).state).toBe("collecting");
      now += RELEASE_LIMITS.LEASE_MS;
      expect((await viewer[method](input())).state).toBe("waiting");
      now += RELEASE_LIMITS.CACHE_MS;
      expect((await viewer[method](input())).state).toBe("ready");
      await bindings.HQ_DB.prepare(
        "DELETE FROM source_repositories WHERE workspace_id = 'alpha' AND source_id = 'github'",
      ).run();
      expect(
        await bindings.HQ_DB.prepare(
          `SELECT count(*) AS total FROM ${cacheTable}`,
        ).first("total"),
      ).toBe(0);
    });
    it("rejects corrupted stored evidence without exposing raw data or repeating provider reads", async () => {
      const fetcher = provider();
      await viewer[method](input());
      await bindings.HQ_DB.prepare(`UPDATE ${cacheTable} SET result_json = ?`)
        .bind(JSON.stringify({ private: F.privateValue }))
        .run();
      await expect(viewer[method](input())).rejects.toMatchObject({
        status: 503,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it("shares the bounded read-only contract across HTTP, CLI and MCP", async () => {
      const upstream = provider();
      const app = createApplication(async () => VIEWER);
      const localFetch = vi.fn(
        async (target: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(target));
          return url.origin === "https://hq.example"
            ? app.fetch(
                new Request(String(target), { ...init, redirect: "manual" }),
                runtime,
              )
            : upstream(target, init);
        },
      );
      vi.stubGlobal("fetch", localFetch);
      const config = clientConfiguration(
        "https://hq.example",
        false,
        "synthetic-hq-token",
        undefined,
        undefined,
        undefined,
      );
      const result = await callCommand(config, commandName, input());
      expect(resultSchema.safeParse(result).success).toBe(true);
      expect(
        commandAnnotations(commandName, commands[commandName].readOnly),
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      const response = await app.fetch(
        new Request("https://hq.example/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: "Bearer synthetic-hq-token",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: commandName, arguments: input() },
          }),
        }),
        runtime,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(
        kind === "work" ? "Review dependency update" : "v1.0.0",
      );
      expect(text).not.toContain(F.privateValue);
      expect(text).not.toContain(F.token);
      expect(upstream).toHaveBeenCalledTimes(2);
    });
  },
);
