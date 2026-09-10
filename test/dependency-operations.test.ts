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
import { type DependencyChangeReview } from "../shared/dependency-changes";
import { dependencyFileChanges } from "../shared/dependency-edits";
import { DEPENDENCY_POLICY_PATH } from "../shared/dependency-policy";
import {
  dependencyOperationSchema,
  DEPENDENCY_OPERATION_LIMITS,
} from "../shared/dependency-operations";
import { ProviderCredentials } from "../worker/provider-credentials";
import { WorkspaceService } from "../worker/service";
import { githubCredential } from "../worker/provider-github-credential";
import { DependencyGitHub } from "../worker/dependency-github";
import type { Env } from "../worker/types";
import { dependencyFixture } from "./fixtures/dependencies";
import { countD1Statements } from "./helpers/d1-count";
import {
  DEPENDENCY_PROVIDER as F,
  dependencyProviderFixture,
} from "./fixtures/dependency-provider";

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
let provider: Awaited<ReturnType<typeof dependencyProviderFixture>>;
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
  const f = dependencyFixture();
  f.rule.reviewedAt = new Date(now - 86400000).toISOString();
  f.rule.reviewBy = new Date(now + 7 * 86400000).toISOString();
  provider = await dependencyProviderFixture(f);
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
        "SELECT result_json FROM operations WHERE kind='dependency.change'",
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
        expect(body.base_tree).toBe(F.tree);
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
async function review(kind: "renew" | "remove" = "renew", pullNumber?: number) {
  const result = await service().repositoryDependencies({
    ...scope(),
    refresh: true,
    ...(pullNumber ? { pullNumber } : {}),
  });
  return service().dependencyChangePlan({
    ...scope(),
    credentialId: CREDENTIAL,
    ...(pullNumber ? { pullNumber } : {}),
    headSha: F.head,
    policyDigest: result.evidence!.report!.policyDigest,
    overrideId: "decoder-advisory",
    change:
      kind === "remove"
        ? { kind, reason: "All installed parents adopted the patched decoder" }
        : {
            kind,
            reason: "Both installed runners still need the decoder mitigation",
            owner: "Project maintainers",
            reviewDays: 7,
          },
  });
}
const apply = (r: DependencyChangeReview, actor = service()) =>
  actor.dependencyChangeApply({
    workspaceId: "alpha",
    planId: r.planId,
    fingerprint: r.fingerprint,
  });
describe("Dependency write custody and exact outcomes", () => {
  it("separates write credentials from Secrets and read-only source authority", async () => {
    expect(
      (await service().providerCredentialsList({ workspaceId: "alpha" })).items,
    ).toEqual([]);
    expect(
      (
        await service().providerCredentialsList({
          workspaceId: "alpha",
          purpose: "repositories",
        })
      ).items[0].settings.providerKind,
    ).toBe("github-repositories");
    await expect(
      githubCredential(service(), "alpha", CREDENTIAL),
    ).rejects.toThrow();
    await expect(
      service("viewer").dependencyWriteAccess({
        workspaceId: "alpha",
        repositoryId,
      }),
    ).rejects.toThrow();
    const selected = await service("operator").dependencyWriteAccess({
      workspaceId: "alpha",
      repositoryId,
    });
    expect(selected.credentials[0]).toMatchObject({
      id: CREDENTIAL,
      status: "available",
    });
    expect(JSON.stringify(selected)).not.toContain(WRITE_TOKEN);
    await service().providerCredentialVerify({
      workspaceId: "alpha",
      credentialId: CREDENTIAL,
      revision: 1,
      resourceName: F.repository,
    });
    expect(writes).toEqual([]);
  });
  it("journals every phase and creates only the reviewed policy edit on a new branch", async () => {
    const r = await review();
    const result = await apply(r);
    expect(dependencyOperationSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "succeeded",
      phase: "finished",
      commitSha: NEW_COMMIT,
      pullRequest: { number: 17, merged: false },
    });
    expect(writes.map((item) => item.path)).toEqual([
      "/git/trees",
      "/git/commits",
      "/git/refs",
      "/pulls",
    ]);
    expect(treeFiles.map((file) => file.path)).toEqual([
      DEPENDENCY_POLICY_PATH,
    ]);
    expect(JSON.parse(treeFiles[0].content).manifests[0].overrides[0]).toEqual(
      r.after,
    );
    expect(branch).toBe("hq/dependencies/" + r.planId);
    expect(writes[3].body.base).toBe("main");
    expect(JSON.stringify(result)).not.toContain(WRITE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(F.privateValue);
    expect(await apply(r)).toEqual(result);
    expect(writes).toHaveLength(4);
  });
  it("removes only an unused selector, preserving formatting, unrelated metadata, and the advisory guard", async () => {
    provider.fixture.lock.packages["node_modules/runner"].dependencies = {
      decoder: "1.0.1",
    };
    provider.fixture.lock.packages[
      "node_modules/harness/node_modules/runner"
    ].dependencies = { decoder: "1.0.1" };
    provider = await dependencyProviderFixture(provider.fixture);
    const r = await review("remove");
    const edits = dependencyFileChanges(r, provider.files, now);
    expect(edits).toHaveLength(2);
    const manifest = edits.find((item) => item.path === "package.json")!;
    expect(JSON.parse(manifest.content).overrides).toBeUndefined();
    expect(manifest.content).toContain(
      '  "privateNote": "' + F.privateValue + '"',
    );
    const policy = JSON.parse(edits[0].content);
    expect(policy.manifests[0].overrides[0]).toMatchObject({
      lifecycle: "removed",
      advisory: r.before.advisory,
      vulnerable: r.before.vulnerable,
    });
    expect((await apply(r))?.status).toBe("succeeded");
    expect(treeFiles.every((file) => !file.path.includes("lock"))).toBe(true);
  });
  it.each([
    "workspace",
    "viewer",
    "source",
    "reporter",
    "other-actor",
    "expired",
    "credential",
  ])("rejects %s before provider writes", async (kind) => {
    const r = await review();
    let actor = service();
    if (kind === "viewer") actor = service("viewer");
    if (kind === "other-actor") actor = service("second");
    if (kind === "source") actor = service("owner", { sourceId: "github" });
    if (kind === "reporter") actor = service("owner", { reporterId: "agent" });
    if (kind === "expired") now += 300001;
    if (kind === "credential")
      await bindings.HQ_DB.prepare(
        "UPDATE provider_credentials SET revision=revision+1,identity=? WHERE id=?",
      )
        .bind("f".repeat(64), CREDENTIAL)
        .run();
    await expect(
      kind === "workspace"
        ? actor.dependencyChangeApply({
            workspaceId: "beta",
            planId: r.planId,
            fingerprint: r.fingerprint,
          })
        : apply(r, actor),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  });
  it("rejects a moved default branch before any write", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((target, init) =>
      new URL(String(target)).pathname.endsWith("/branches/main")
        ? Promise.resolve(
            Response.json({
              name: "main",
              commit: {
                sha: "e".repeat(40),
                commit: { tree: { sha: F.tree } },
              },
            }),
          )
        : original(target, init),
    );
    expect(await apply(r)).toMatchObject({
      status: "failed",
      reason: "evidence_changed",
    });
    expect(writes).toEqual([]);
  });
  it("does not duplicate an accepted PR after its response is lost; reconciliation reads the original identity", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      if (
        init?.method === "POST" &&
        new URL(String(target)).pathname.endsWith("/pulls")
      )
        throw new Error("Simulated response loss");
      return response;
    });
    expect(await apply(r)).toMatchObject({
      status: "indeterminate",
      phase: "pull_request",
      reason: "outcome_unknown",
    });
    expect(await apply(r)).toMatchObject({ status: "indeterminate" });
    expect(writes).toHaveLength(4);
    expect(
      await service().dependencyOperationReconcile({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).toMatchObject({ status: "succeeded", pullRequest: { number: 17 } });
    expect(writes).toHaveLength(4);
    const calls = fetcher.mock.calls.length;
    await service().dependencyOperationReconcile({
      workspaceId: "alpha",
      planId: r.planId,
    });
    expect(fetcher.mock.calls).toHaveLength(calls);
  });
  it("stops on credential revocation between effects and retains the completed phase", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      if (init?.method === "POST")
        await bindings.HQ_DB.prepare(
          "UPDATE provider_credentials SET identity=? WHERE id=?",
        )
          .bind("f".repeat(64), CREDENTIAL)
          .run();
      return response;
    });
    expect(await apply(r)).toMatchObject({
      status: "partial",
      reason: "access_changed",
      treeSha: NEW_TREE,
      commitSha: null,
    });
    expect(writes).toHaveLength(1);
  });
  it("preserves unknown writes when a transport stalls despite abort", async () => {
    const client = new DependencyGitHub(
      F.repository,
      WRITE_TOKEN,
      async () => new Promise<Response>(() => {}),
      10,
    );
    await expect(client.branch("hq/test", F.head)).rejects.toMatchObject({
      reason: "outcome_unknown",
    });
    expect(client.requests).toBe(1);
    expect(DEPENDENCY_OPERATION_LIMITS.REQUESTS).toBeLessThan(10);
  });
  it("creates cleanup against an upstream PR branch without replacing default-branch evidence", async () => {
    const original = await service().repositoryDependencies({
      ...scope(),
      refresh: true,
    });
    provider.fixture.lock.packages["node_modules/runner"].dependencies = {
      decoder: "1.0.1",
    };
    provider.fixture.lock.packages[
      "node_modules/harness/node_modules/runner"
    ].dependencies = { decoder: "1.0.1" };
    provider = await dependencyProviderFixture(provider.fixture, {
      number: 42,
      branch: "dependabot/runner",
    });
    const r = await review("remove", 42);
    expect(r.basis).toMatchObject({
      pullNumber: 42,
      branch: "dependabot/runner",
    });
    expect((await service().repositoryDependencies(scope())).evidence).toEqual(
      original.evidence,
    );
    expect((await apply(r))?.status).toBe("succeeded");
    expect(writes.at(-1)!.body.base).toBe("dependabot/runner");
    expect(
      (await service().repositoryDependencies(scope())).evidence!.pullNumber,
    ).toBeNull();
  });
  it.each(["fork", "closed", "moved"])(
    "rejects an upstream PR that is %s before any effect",
    async (kind) => {
      provider = await dependencyProviderFixture(provider.fixture, {
        number: 42,
        branch: "dependabot/runner",
      });
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (target, init) => {
        const response = await original(target, init);
        if (!String(target).endsWith("/pulls/42")) return response;
        const body = (await response.json()) as any;
        if (kind === "fork") body.head.repo.full_name = "outside/fork";
        if (kind === "closed") body.state = "closed";
        if (kind === "moved") body.head.sha = "f".repeat(40);
        return Response.json(body);
      });
      const result = await service().repositoryDependencies({
        ...scope(),
        refresh: true,
        pullNumber: 42,
      });
      expect(result.evidence!.read.state).not.toBe("observed");
      expect(result.evidence!.report).toBeNull();
      expect(writes).toEqual([]);
    },
  );
  it("does not execute a duplicate review concurrently", async () => {
    const r = await review();
    const results = await Promise.all([apply(r), apply(r)]);
    expect(results.some((item) => item?.status === "succeeded")).toBe(true);
    expect(writes).toHaveLength(4);
    expect(new Set(results.map((item) => item!.id)).size).toBe(1);
  });
  it("measures the authenticated write path independently of elapsed time", async () => {
    const r = await review();
    const measured = countD1Statements(bindings.HQ_DB);
    const actor = new WorkspaceService(
      { ...runtime, HQ_DB: measured.db },
      { subject: "owner", displayName: "owner" },
      false,
      () => now,
    );
    expect((await apply(r, actor))?.status).toBe("succeeded");
    const freeD1QueryLimit = 50;
    const boundedSubmissionQueries = 100;
    expect(measured.count()).toBeGreaterThan(freeD1QueryLimit);
    expect(measured.count()).toBeLessThan(boundedSubmissionQueries);
    expect(measured.calls()).toBeLessThanOrEqual(freeD1QueryLimit);
  });
  it("stops a base-head change during submission before publishing a branch", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) =>
      String(target).endsWith("/git/ref/heads/main")
        ? Response.json({
            ref: "refs/heads/main",
            object: { type: "commit", sha: "e".repeat(40) },
          })
        : original(target, init),
    );
    expect(await apply(r)).toMatchObject({
      status: "partial",
      reason: "evidence_changed",
      commitSha: NEW_COMMIT,
    });
    expect(branch).toBeNull();
    expect(writes).toHaveLength(2);
  });
  it.each(["/git/trees", "/git/commits", "/git/refs", "/pulls"])(
    "records a rejected %s without replaying previous steps",
    async (path) => {
      const r = await review();
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (target, init) =>
        init?.method === "POST" &&
        new URL(String(target)).pathname === "/repos/" + F.repository + path
          ? new Response("PRIVATE_PROVIDER_BODY", { status: 422 })
          : original(target, init),
      );
      const result = await apply(r);
      expect(result).toMatchObject({
        status: "partial",
        reason: "provider_rejected",
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_BODY");
      const count = fetcher.mock.calls.length;
      expect(await apply(r)).toEqual(result);
      expect(fetcher.mock.calls).toHaveLength(count);
    },
  );
  it("reconciles merged and changed outcomes with reads only", async () => {
    const r = await review();
    await apply(r);
    pull!.merged = true;
    pull!.state = "closed";
    expect(
      await service().dependencyOperationReconcile({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).toMatchObject({ pullRequest: { merged: true, state: "closed" } });
    now += DEPENDENCY_OPERATION_LIMITS.RECONCILE_MS;
    pull!.head.sha = "e".repeat(40);
    expect(
      await service().dependencyOperationReconcile({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).toMatchObject({ reason: "identity_changed", status: "indeterminate" });
    expect(writes).toHaveLength(4);
  });
  it("verifies a branch-only outcome without retrying the rejected PR", async () => {
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) =>
      init?.method === "POST" && String(target).endsWith("/pulls")
        ? new Response(null, { status: 422 })
        : original(target, init),
    );
    expect(await apply(r)).toMatchObject({
      status: "partial",
      reason: "provider_rejected",
      commitSha: NEW_COMMIT,
      pullRequest: null,
    });
    const previousWrites = writes.length;
    expect(
      await service().dependencyOperationReconcile({
        workspaceId: "alpha",
        planId: r.planId,
      }),
    ).toMatchObject({ status: "partial", reason: "branch_only" });
    expect(writes).toHaveLength(previousWrites);
  });
  it("counts pending reviews and uncertain operations before retiring their credential", async () => {
    const pending = await review();
    const r = await review();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) => {
      const response = await original(target, init);
      if (init?.method === "POST") throw new Error("Lost response");
      return response;
    });
    await apply(r);
    const retirement = await service().providerCredentialPlan({
      workspaceId: "alpha",
      credentialId: CREDENTIAL,
      revision: 1,
      change: { kind: "retire" },
    });
    expect(retirement.pendingReviews).toBe(1);
    expect(retirement.unsettledDestinations).toBe(1);
    expect(pending.planId).not.toBe(r.planId);
  });
  it("paginates timestamp ties and bounds distinct accepted submissions", async () => {
    const r = await review();
    const receipt = (await apply(r))!;
    const rows = Array.from(
      { length: DEPENDENCY_OPERATION_LIMITS.HISTORY_PAGE + 2 },
      (_, index) => {
        const id = "synthetic-history-" + String(index).padStart(3, "0");
        return bindings.HQ_DB.prepare(
          "INSERT INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at) VALUES (?,'alpha',NULL,'owner','dependency.change','succeeded','Synthetic receipt',?,?,?)",
        ).bind(
          id,
          JSON.stringify({ ...receipt, id, planId: "synthetic-plan-" + index }),
          receipt.startedAt,
          receipt.updatedAt,
        );
      },
    );
    await bindings.HQ_DB.batch(rows);
    const first = await service().dependencyOperationsList({
      workspaceId: "alpha",
      repositoryId,
    });
    const second = await service().dependencyOperationsList({
      workspaceId: "alpha",
      repositoryId,
      before: first.nextBefore,
    });
    expect(first.items.length + second.items.length).toBe(rows.length + 1);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(rows.length + 1);
    const next = await review();
    const calls = fetcher.mock.calls.length;
    await expect(apply(next)).rejects.toThrow(/budget/);
    expect(fetcher.mock.calls).toHaveLength(calls);
    await expect(
      service().dependencyOperationsList({
        workspaceId: "alpha",
        repositoryId,
        before: "invalid",
      }),
    ).rejects.toThrow(/valid dependency history/);
  });
});
