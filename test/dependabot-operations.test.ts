import { countD1Statements } from "./helpers/d1-count";
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
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import { ProviderCredentials } from "../worker/provider-credentials";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";
import { dependabotChangePlanInput } from "../shared/dependabot-changes";
import { dependabotOperationSchema } from "../shared/dependabot-operations";
import {
  DEPENDABOT_PROVIDER as F,
  DEPENDABOT_SOURCE,
  dependabotProviderFixture,
} from "./fixtures/dependabot-provider";
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const WRITE_TOKEN = "synthetic-dedicated-repository-write-token";
const CREDENTIAL = "managed-repositories";
const NEW_TREE = "c".repeat(40);
const NEW_COMMIT = "d".repeat(40);
let runtime: Env;
let now: number;
let repositoryId: string;
let provider: Awaited<ReturnType<typeof dependabotProviderFixture>>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let writes: { path: string; body: Record<string, any> }[];
let branch: string | null;
let pull: Record<string, any> | null;
let treeFiles: Record<string, any>[];
const service = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
const scope = () => ({
  workspaceId: "alpha",
  sourceId: "github",
  repositoryId,
});
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      read: { workspaceId: "alpha", name: "Read only", token: F.token },
    }),
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "test",
      keys: [{ id: "test", key: btoa("a".repeat(32)) }],
    }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM github_context_budgets"),
    bindings.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','second','Second','owner'),('alpha','viewer','Viewer','viewer'),('alpha','operator','Operator','operator')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  provider = await dependabotProviderFixture();
  writes = [];
  branch = null;
  pull = null;
  treeFiles = [];
  fetcher = vi.fn(async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname.startsWith("/repos/" + F.repository)).toBe(true);
    const path = url.pathname.slice(("/repos/" + F.repository).length);
    if (init?.method === "POST") {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer " + WRITE_TOKEN,
      );
      expect(init.redirect).toBe("error");
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      const recorded = await bindings.HQ_DB.prepare(
        "SELECT result_json FROM operations WHERE kind='dependabot.schedule'",
      ).first<string>("result_json");
      expect(recorded).not.toBeNull();
      expect(JSON.parse(recorded!).status).toBe("running");
      const phase =
        path === "/git/trees"
          ? "tree"
          : path === "/git/commits"
            ? "commit"
            : path === "/git/refs"
              ? "branch"
              : "pull_request";
      expect(JSON.parse(recorded!).phase).toBe(phase);
      if (path === "/git/trees") {
        treeFiles = body.tree;
        expect(body.base_tree).toBe(F.root);
        return Response.json({ sha: NEW_TREE }, { status: 201 });
      }
      if (path === "/git/commits")
        return Response.json(
          {
            sha: NEW_COMMIT,
            tree: { sha: body.tree },
            parents: body.parents.map((sha: string) => ({ sha })),
          },
          { status: 201 },
        );
      if (path === "/git/refs") {
        branch = body.ref.slice("refs/heads/".length);
        return Response.json(
          { ref: body.ref, object: { type: "commit", sha: body.sha } },
          { status: 201 },
        );
      }
      if (path === "/pulls") {
        pull = {
          number: 17,
          state: "open",
          merged: false,
          body: body.body,
          head: {
            ref: body.head,
            sha: NEW_COMMIT,
            repo: { full_name: F.repository },
          },
          base: { ref: body.base, repo: { full_name: F.repository } },
        };
        return Response.json(pull, { status: 201 });
      }
      throw new Error("Unexpected mutation");
    }
    if (path === "/pulls") return Response.json(pull ? [pull] : []);
    if (path === "/pulls/17") return Response.json(pull);
    if (
      path === "/git/ref/heads/main" ||
      path === "/git/ref/heads/dependabot%2Frunner"
    )
      return Response.json({
        ref:
          "refs/heads/" +
          decodeURIComponent(path.slice("/git/ref/heads/".length)),
        object: { type: "commit", sha: F.head },
      });
    if (path.startsWith("/git/ref/heads/"))
      return branch
        ? Response.json({
            ref: "refs/heads/" + branch,
            object: { type: "commit", sha: NEW_COMMIT },
          })
        : new Response(null, { status: 404 });
    return provider.response(url);
  });
  vi.stubGlobal("fetch", fetcher);
  repositoryId = (
    await service().createRepository({
      workspaceId: "alpha",
      repository: {
        fullName: F.repository,
        projectId: "project",
        description: "Synthetic write verification",
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    })
  ).id;
  await service().githubSourceEnroll({
    workspaceId: "alpha",
    sourceId: "github",
    source: {
      name: "Read-only source",
      enabled: true,
      freshnessMinutes: 30,
      repositoryIds: [repositoryId],
      credentialRef: "read",
      refreshIntervalMinutes: 15,
    },
  });
  const review = await service().providerCredentialPlan({
    workspaceId: "alpha",
    credentialId: CREDENTIAL,
    revision: 0,
    change: {
      kind: "save",
      replaceToken: true,
      settings: {
        name: "Repository maintenance",
        providerKind: "github-repositories",
        writable: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        scope: { repositoryNames: [F.repository] },
      },
    },
  });
  await new ProviderCredentials(service()).upload(
    new Request("https://hq.example/api/provider-credentials/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": review.fingerprint,
      },
      body: JSON.stringify({ version: 1, token: WRITE_TOKEN }),
    }),
    { workspaceId: "alpha", planId: review.id },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function review(writer = true) {
  const result = await service().repositoryDependabot({
    ...scope(),
    refresh: true,
  });
  const evidence = result.evidence!;
  return service().dependabotChangePlan({
    ...scope(),
    headSha: evidence.headSha!,
    fileDigest: evidence.file!.digest,
    ...(writer ? { credentialId: CREDENTIAL } : {}),
    edits: [
      {
        entryId: evidence.entries[0]!.id,
        schedule: { interval: "weekly", day: "tuesday", time: "09:30" },
      },
    ],
  });
}
const apply = (r: Awaited<ReturnType<typeof review>>) =>
  service().dependabotChangeApply({
    workspaceId: "alpha",
    planId: r.planId,
    fingerprint: r.fingerprint,
  });
describe("reviewed schedule pull requests", () => {
  it("creates a normalized review without raw YAML and allows review-only preparation", async () => {
    const r = await review(false);
    expect(r.state).toBe("ready");
    expect(r.writer).toBeNull();
    expect(r.changes[0]!.before.schedule?.day).toBe("monday");
    expect(r.changes[0]!.after.schedule?.day).toBe("tuesday");
    const stored = await bindings.HQ_DB.prepare(
      "SELECT input_json FROM action_plans WHERE id=?",
    )
      .bind(r.planId)
      .first<string>("input_json");
    expect(stored).not.toContain(F.privateValue);
    expect(stored).not.toContain("registries:");
    await expect(apply(r)).rejects.toHaveProperty("status", 409);
    expect(writes).toHaveLength(0);
  });
  it("creates one schedule-only PR with intent before every effect and deduplicates confirmation", async () => {
    const r = await review();
    const op = dependabotOperationSchema.parse(await apply(r));
    expect(op.status).toBe("succeeded");
    expect(writes.map((w) => w.path)).toEqual([
      "/git/trees",
      "/git/commits",
      "/git/refs",
      "/pulls",
    ]);
    expect(treeFiles).toHaveLength(1);
    expect(treeFiles[0]!.path).toBe(".github/dependabot.yml");
    expect(treeFiles[0]!.content).toContain(F.privateValue);
    expect(treeFiles[0]!.content).toContain("day: tuesday");
    expect(treeFiles[0]!.content.split("updates:")[0]).toBe(
      DEPENDABOT_SOURCE.split("updates:")[0],
    );
    expect(JSON.stringify(op)).not.toContain(F.privateValue);
    expect((await apply(r))!.id).toBe(op.id);
    expect(writes).toHaveLength(4);
    expect(
      (
        await service().dependabotOperationsList({
          workspaceId: "alpha",
          repositoryId,
        })
      ).items,
    ).toHaveLength(1);
    expect(
      await service().dependencyOperationGet({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).toBeNull();
    await expect(
      service().dependencyChangeReview({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).rejects.toHaveProperty("status", 404);
  });
  it.each(["head", "source", "member", "writer", "expiry"])(
    "stops before effects when %s changes",
    async (kind) => {
      const r = await review();
      if (kind === "head") {
        const original = fetcher.getMockImplementation()!;
        fetcher.mockImplementation(async (...args) =>
          new URL(String(args[0])).pathname.endsWith("/branches/main")
            ? Response.json({
                name: "main",
                commit: {
                  sha: "f".repeat(40),
                  commit: { tree: { sha: F.root } },
                },
              })
            : original(...args),
        );
      }
      if (kind === "source")
        await bindings.HQ_DB.prepare(
          "UPDATE connections SET revision=revision+1 WHERE id='github'",
        ).run();
      if (kind === "member")
        await bindings.HQ_DB.prepare(
          "UPDATE members SET revision=revision+1 WHERE subject='owner'",
        ).run();
      if (kind === "writer") runtime.PROVIDER_CREDENTIAL_KEYS = undefined;
      if (kind === "expiry") now += 6 * 60 * 1000;
      try {
        const op = await apply(r);
        expect(op?.status).not.toBe("succeeded");
      } catch (error) {
        expect(error).toHaveProperty("status");
      }
      expect(writes).toHaveLength(0);
    },
  );
  it("does not return a review after access is revoked while re-reading its pinned blob", async () => {
    await service().repositoryDependabot({ ...scope(), refresh: true });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname.includes("/git/blobs/"))
        await bindings.HQ_DB.prepare(
          "DELETE FROM members WHERE subject='owner'",
        ).run();
      return original(...args);
    });
    await expect(review()).rejects.toHaveProperty("status");
    expect(writes).toHaveLength(0);
  });
  it("rejects duplicate entries, arbitrary file paths and unsupported edited cron", async () => {
    const r = await review();
    const input = {
      ...scope(),
      headSha: r.basis.headSha,
      fileDigest: r.basis.file.digest,
      edits: r.edits,
    };
    expect(
      dependabotChangePlanInput.safeParse({ ...input, path: "package.json" })
        .success,
    ).toBe(false);
    expect(
      dependabotChangePlanInput.safeParse({
        ...input,
        edits: [...r.edits, ...r.edits],
      }).success,
    ).toBe(false);
    await expect(
      service().dependabotChangePlan({
        ...input,
        edits: [
          {
            ...r.edits[0],
            schedule: { interval: "cron", cronjob: "every day" },
          },
        ],
      }),
    ).rejects.toHaveProperty("status", 400);
  });
  it("retains an unknown PR response and reconciles only through reads", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (
        args[1]?.method === "POST" &&
        new URL(String(args[0])).pathname.endsWith("/pulls")
      )
        throw new Error("lost response");
      return response;
    });
    const op = await apply(r);
    expect(op?.status).toBe("indeterminate");
    expect((await apply(r))!.id).toBe(op!.id);
    expect(writes).toHaveLength(4);
    const recovered = await service().dependabotOperationReconcile({
      workspaceId: "alpha",
      planId: r.planId,
    });
    expect(recovered?.status).toBe("succeeded");
    expect(writes).toHaveLength(4);
  });
  it("records a rejected PR as partial and observes the retained branch without replay", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) =>
      args[1]?.method === "POST" &&
      new URL(String(args[0])).pathname.endsWith("/pulls")
        ? new Response(null, { status: 422 })
        : original(...args),
    );
    const op = await apply(r);
    expect(op).toMatchObject({
      status: "partial",
      phase: "pull_request",
      reason: "provider_rejected",
    });
    const recovered = await service().dependabotOperationReconcile({
      workspaceId: "alpha",
      planId: r.planId,
    });
    expect(recovered).toMatchObject({
      status: "partial",
      reason: "branch_only",
    });
    expect(writes).toHaveLength(3);
  });
  it("rejects stale retained evidence and an entry from another immutable digest", async () => {
    const r = await review();
    const input = {
      ...scope(),
      headSha: r.basis.headSha,
      fileDigest: r.basis.file.digest,
      edits: r.edits,
    };
    await expect(
      service().dependabotChangePlan({
        ...input,
        edits: [
          { ...r.edits[0], entryId: "sha256:" + "e".repeat(64) + ":update:0" },
        ],
      }),
    ).rejects.toHaveProperty("status", 409);
    now += 6 * 60 * 1000;
    await expect(service().dependabotChangePlan(input)).rejects.toHaveProperty(
      "status",
      409,
    );
    expect(writes).toHaveLength(0);
  });
  it("does not use another identity's review", async () => {
    const r = await review();
    await expect(
      service("second").dependabotChangeApply({
        workspaceId: "alpha",
        planId: r.planId,
        fingerprint: r.fingerprint,
      }),
    ).rejects.toHaveProperty("status", 404);
    await expect(
      service("viewer").dependabotChangeReview({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).rejects.toHaveProperty("status", 403);
    expect(writes).toHaveLength(0);
  });
  it("stops publication when the base moves after Git objects are created", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) =>
      new URL(String(args[0])).pathname.endsWith("/git/ref/heads/main")
        ? Response.json({
            ref: "refs/heads/main",
            object: { type: "commit", sha: "f".repeat(40) },
          })
        : original(...args),
    );
    const op = await apply(r);
    expect(op).toMatchObject({
      status: "partial",
      reason: "evidence_changed",
      phase: "commit",
    });
    expect(writes.map((w) => w.path)).toEqual(["/git/trees", "/git/commits"]);
  });
  it("stops further effects after source authority is revoked during a provider response", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1]?.method === "POST")
        await bindings.HQ_DB.prepare(
          "UPDATE connections SET revision=revision+1 WHERE id='github'",
        ).run();
      return result;
    });
    const op = await apply(r);
    expect(op).toMatchObject({
      status: "partial",
      reason: "access_changed",
      phase: "tree",
    });
    expect(writes).toHaveLength(1);
  });
  it("rechecks access after journal persistence and before sending an effect", async () => {
    const r = await review();
    const db = runtime.HQ_DB;
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    let recording = false;
    function wrap(
      statement: D1PreparedStatement,
      sql: string,
    ): D1PreparedStatement {
      const proxy = new Proxy(statement, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              if (
                sql.includes("UPDATE operations SET status=") &&
                String(values[2]).includes('"phase":"tree"')
              )
                recording = true;
              return wrap(target.bind(...values), sql);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      originals.set(proxy, statement);
      return proxy;
    }
    runtime.HQ_DB = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (recording) {
              recording = false;
              await db
                .prepare(
                  "UPDATE connections SET revision=revision+1 WHERE id='github'",
                )
                .run();
            }
            return target.batch(
              statements.map(
                (statement) => originals.get(statement) ?? statement,
              ),
            );
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const op = await apply(r);
    expect(op?.reason).toBe("access_changed");
    expect(writes).toHaveLength(0);
  });
  it("bounds the authenticated schedule submission database workload", async () => {
    const r = await review();
    const measured = countD1Statements(runtime.HQ_DB);
    runtime.HQ_DB = measured.db;
    expect((await apply(r))?.status).toBe("succeeded");
    expect(measured.count()).toBeGreaterThan(50);
    expect(measured.count()).toBeLessThan(100);
    expect(measured.calls()).toBeLessThanOrEqual(50);
  });
});
