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
import {
  dependenciesPageSchema,
  dependencyResultSchema,
  DEPENDENCIES_LIMITS,
} from "../shared/dependencies";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";
import { DEPENDENCY_TEST_NOW } from "./fixtures/dependencies";
import {
  DEPENDENCY_PROVIDER as F,
  dependencyProviderFixture,
} from "./fixtures/dependency-provider";
import { countD1Statements } from "./helpers/d1-count";
import { dependencyChangeReviewSchema } from "../shared/dependency-changes";
import { credentialHash } from "../worker/credential-hash";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
let now: number;
let runtime: Env;
let owner: WorkspaceService;
let viewer: WorkspaceService;
let repositoryId: string;
let provider: Awaited<ReturnType<typeof dependencyProviderFixture>>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const input = () => ({
  workspaceId: "alpha",
  sourceId: "github",
  repositoryId,
});
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = DEPENDENCY_TEST_NOW;
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      read: { workspaceId: "alpha", name: "Read only", token: F.token },
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
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  owner = new WorkspaceService(runtime, OWNER, false, () => now);
  viewer = new WorkspaceService(
    runtime,
    { subject: "viewer", displayName: "Viewer" },
    false,
    () => now,
  );
  repositoryId = (
    await owner.createRepository({
      workspaceId: "alpha",
      repository: {
        fullName: F.repository,
        projectId: "project",
        description: "Synthetic dependency fixture",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    })
  ).id;
  await owner.githubSourceEnroll({
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
  provider = await dependencyProviderFixture();
  fetcher = vi.fn(async (target) => provider.response(new URL(String(target))));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Dependency operator reads", () => {
  async function proposal() {
    const result = await owner.repositoryDependencies({
      ...input(),
      refresh: true,
    });
    return {
      ...input(),
      headSha: result.evidence!.headSha!,
      policyDigest: result.evidence!.report!.policyDigest,
      overrideId: "decoder-advisory",
      change: {
        kind: "renew" as const,
        reason: "The repository still uses the older runner releases",
        owner: "Project maintainers",
        reviewDays: 14,
      },
    };
  }
  it("prepares and recovers exact actor-bound reviews without provider writes or invented CI success", async () => {
    const fields = await proposal();
    const review = await owner.dependencyChangePlan(fields);
    expect(dependencyChangeReviewSchema.safeParse(review).success).toBe(true);
    expect(review).toMatchObject({
      state: "ready",
      basis: { headSha: F.head },
      before: { lifecycle: "active" },
      after: {
        lifecycle: "active",
        reason: fields.change.reason,
        reviewBy: new Date(now + 14 * 86400000).toISOString(),
      },
    });
    expect(
      await owner.dependencyChangeReview({
        workspaceId: "alpha",
        planId: review.planId,
      }),
    ).toEqual(review);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(
      await bindings.HQ_DB.prepare("SELECT 1 FROM operations").first(),
    ).toBeNull();
    await expect(viewer.dependencyChangePlan(fields)).rejects.toThrow();
    await expect(
      viewer.dependencyChangeReview({
        workspaceId: "alpha",
        planId: review.planId,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(review)).not.toContain(F.privateValue);
    expect(JSON.stringify(review)).not.toContain(F.token);
  });
  it("does not turn an available upstream fix into permission to remove a needed override", async () => {
    const fields = await proposal();
    await expect(
      owner.dependencyChangePlan({
        ...fields,
        change: {
          kind: "remove",
          reason: "An upstream release is available but has not been adopted",
        },
      }),
    ).rejects.toThrow(/still needs/);
    await expect(
      owner.dependencyChangePlan({ ...fields, headSha: "c".repeat(40) }),
    ).rejects.toThrow(/changed/);
    await expect(
      owner.dependencyChangePlan({
        ...fields,
        change: { ...fields.change, reviewDays: 31 },
      }),
    ).rejects.toThrow();
    now += DEPENDENCIES_LIMITS.CACHE_MS;
    await expect(owner.dependencyChangePlan(fields)).rejects.toThrow(/expired/);
  });
  it("expires reviews and invalidates captured source or credential authority", async () => {
    const review = await owner.dependencyChangePlan(await proposal());
    runtime.GITHUB_CREDENTIALS = "{}";
    expect(
      (
        await owner.dependencyChangeReview({
          workspaceId: "alpha",
          planId: review.planId,
        })
      ).state,
    ).toBe("stale");
    now += 6 * 60000;
    expect(
      (
        await owner.dependencyChangeReview({
          workspaceId: "alpha",
          planId: review.planId,
        })
      ).state,
    ).toBe("expired");
    await expect(
      owner.dependencyChangeReview({
        workspaceId: "beta",
        planId: review.planId,
      }),
    ).rejects.toThrow();
  });
  it("does not call providers when opening a tab or the fleet list", async () => {
    expect(await viewer.repositoryDependencies(input())).toMatchObject({
      state: "waiting",
      evidence: null,
    });
    const list = await viewer.dependenciesList({ workspaceId: "alpha" });
    expect(list).toMatchObject({
      total: 1,
      rows: [
        { repository: { id: repositoryId }, summary: { state: "unread" } },
      ],
    });
    expect(dependenciesPageSchema.safeParse(list).success).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("allows watchlist reads, retains minimized evidence and reuses its exact timestamp", async () => {
    const first = await viewer.repositoryDependencies({
      ...input(),
      refresh: true,
    });
    expect(dependencyResultSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({
      state: "ready",
      evidence: {
        read: { state: "observed" },
        report: { analysis: { outcome: "passed" } },
      },
    });
    now += 1000;
    expect(
      await viewer.repositoryDependencies({ ...input(), refresh: true }),
    ).toEqual(first);
    const list = await viewer.dependenciesList({ workspaceId: "alpha" });
    expect(list.rows[0].summary).toMatchObject({
      state: "tracked",
      active: 1,
      stale: false,
      observedAt: first.evidence!.observedAt,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    const retained = await bindings.HQ_DB.prepare(
      "SELECT result_json FROM github_dependency_cache",
    ).first();
    expect(JSON.stringify(retained)).not.toContain(F.privateValue);
    expect(JSON.stringify(retained)).not.toContain(F.token);
  });
  it("keeps stale results visible without recollecting and evaluates deadlines at read time", async () => {
    await viewer.repositoryDependencies({ ...input(), refresh: true });
    now = Date.parse("2026-10-10T00:00:00.000Z");
    expect(
      (await viewer.dependenciesList({ workspaceId: "alpha" })).rows[0].summary,
    ).toMatchObject({ state: "attention", stale: true, attention: 1 });
    expect(
      (await viewer.repositoryDependencies(input())).evidence!.observedAt,
    ).toBe(new Date(DEPENDENCY_TEST_NOW).toISOString());
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("does not call npm unless explicitly requested and distinguishes release availability from adoption", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (target, init) => {
      if (new URL(String(target)).origin === "https://registry.npmjs.org") {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Response.json({
          name: "runner",
          version: "2.2.0",
          dependencies: { decoder: "1.0.1" },
        });
      }
      return original(target, init);
    });
    const result = await viewer.repositoryDependencies({
      ...input(),
      refresh: true,
      checkUpstream: true,
    });
    expect(result.evidence).toMatchObject({
      requests: 6,
      upstreamRequests: 1,
      report: {
        analysis: {
          findings: [
            { status: "mitigated", upstream: { state: "fix_available" } },
          ],
        },
      },
    });
  });
  it.each(["source", "repository", "credential", "member"])(
    "rejects results if %s authority changes during collection",
    async (kind) => {
      fetcher.mockImplementationOnce(async (target) => {
        if (kind === "source")
          await bindings.HQ_DB.prepare(
            "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha'",
          ).run();
        if (kind === "repository")
          await bindings.HQ_DB.prepare(
            "UPDATE repositories SET revision=revision+1 WHERE workspace_id='alpha'",
          ).run();
        if (kind === "credential") runtime.GITHUB_CREDENTIALS = "{}";
        if (kind === "member")
          await bindings.HQ_DB.prepare(
            "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
          ).run();
        return provider.response(new URL(String(target)));
      });
      await expect(
        viewer.repositoryDependencies({ ...input(), refresh: true }),
      ).rejects.toThrow();
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT result_json FROM github_dependency_cache WHERE result_json IS NOT NULL",
        ).first(),
      ).toBeNull();
    },
  );
  it("does not leak old reports after credential rotation, source disablement or repository revision changes", async () => {
    await owner.repositoryDependencies({ ...input(), refresh: true });
    runtime.GITHUB_CREDENTIALS = JSON.stringify({
      read: {
        workspaceId: "alpha",
        name: "Rotated",
        token: "synthetic-rotated",
      },
    });
    expect(
      (await owner.dependenciesList({ workspaceId: "alpha" })).rows[0].summary
        .state,
    ).toBe("unread");
    await bindings.HQ_DB.prepare(
      "UPDATE connections SET enabled=0, revision=revision+1 WHERE workspace_id='alpha'",
    ).run();
    expect(
      (await owner.dependenciesList({ workspaceId: "alpha" })).rows[0].summary
        .state,
    ).toBe("unavailable");
    expect((await owner.repositoryDependencies(input())).evidence).toBeNull();
  });
  it("rejects cross-workspace, unenrolled, source-publisher and reporter reads before provider I/O", async () => {
    await expect(
      viewer.repositoryDependencies({ ...input(), workspaceId: "beta" }),
    ).rejects.toThrow();
    await expect(
      viewer.repositoryDependencies({ ...input(), sourceId: "missing" }),
    ).rejects.toThrow();
    await expect(
      viewer.dependenciesList({ workspaceId: "alpha", projectId: "not-here" }),
    ).rejects.toThrow();
    for (const scoped of [{ sourceId: "github" }, { reporterId: "agent" }]) {
      const service = new WorkspaceService(
        runtime,
        { ...OWNER, ...scoped },
        false,
        () => now,
      );
      await expect(service.repositoryDependencies(input())).rejects.toThrow();
      await expect(
        service.dependenciesList({ workspaceId: "alpha" }),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("paginates and searches within a bounded D1 statement budget", async () => {
    await owner.repositoryDependencies({ ...input(), refresh: true });
    const evidence = await bindings.HQ_DB.prepare(
      "SELECT result_json FROM github_dependency_cache WHERE workspace_id='alpha'",
    ).first<string>("result_json");
    const identityHash = await credentialHash(F.token);
    for (let index = 1; index < DEPENDENCIES_LIMITS.PAGE_SIZE; index++) {
      const repository = await owner.createRepository({
        workspaceId: "alpha",
        repository: {
          fullName: "example/fixture-" + index,
          description: "Synthetic cached inventory fixture",
          projectId: "project",
          classification: "watchlist",
          lifecycle: "active",
          expectations: DEFAULT_EXPECTATIONS,
        },
      });
      await bindings.HQ_DB.batch([
        bindings.HQ_DB.prepare(
          "INSERT INTO source_repositories (workspace_id,source_id,repository_id) VALUES ('alpha','github',?)",
        ).bind(repository.id),
        bindings.HQ_DB.prepare(
          "INSERT INTO github_dependency_cache (workspace_id,source_id,repository_id,identity,next_read_at,result_json) VALUES ('alpha','github',?,?,?,?)",
        ).bind(
          repository.id,
          JSON.stringify([
            repository.fullName,
            repository.revision,
            1,
            identityHash,
          ]),
          new Date(now + DEPENDENCIES_LIMITS.CACHE_MS).toISOString(),
          evidence,
        ),
      ]);
    }
    const count = countD1Statements(bindings.HQ_DB);
    const service = new WorkspaceService(
      { ...runtime, HQ_DB: count.db },
      OWNER,
      false,
      () => now,
    );
    const first = await service.dependenciesList({
      workspaceId: "alpha",
      search: "dependency",
    });
    expect(first.total).toBe(1);
    expect(count.count()).toBeLessThan(15);
    count.reset();
    const complete = await service.dependenciesList({ workspaceId: "alpha" });
    expect(complete.rows).toHaveLength(DEPENDENCIES_LIMITS.PAGE_SIZE);
    expect(complete.rows.every((row) => row.summary.state === "tracked")).toBe(
      true,
    );
    expect(count.count()).toBeLessThan(15);
    expect(
      (await service.dependenciesList({ workspaceId: "alpha", page: 2 })).rows,
    ).toEqual([]);
    expect(
      (
        await service.dependenciesList({
          workspaceId: "alpha",
          search: "other",
        })
      ).total,
    ).toBe(0);
    expect(DEPENDENCIES_LIMITS.PAGE_SIZE).toBeLessThanOrEqual(20);
  });
  it("correlates accepted inspection diagnostics without logging repository content or credential identities", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await owner.repositoryDependencies({
      ...input(),
      refresh: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.dependencies.inspected",
        reference: result.evidence!.inspectionId,
        workspaceId: "alpha",
        sourceId: "github",
        repositoryId,
        requests: 6,
        outcome: "passed",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(F.privateValue);
    expect(JSON.stringify(log.mock.calls)).not.toContain(F.token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      await credentialHash(F.token),
    );
    log.mockClear();
    await owner.repositoryDependencies(input());
    expect(log).not.toHaveBeenCalled();
  });
  it("exposes the same bounded commands to browser, CLI and MCP", () => {
    expect(commands.dependencies_list.method).toBe("dependenciesList");
    expect(commands.repository_dependencies.method).toBe(
      "repositoryDependencies",
    );
    expect(
      commandAnnotations(
        "repository_dependencies",
        commands.repository_dependencies.readOnly,
      ).readOnlyHint,
    ).toBe(true);
    expect(
      commands.repository_dependencies.schema.safeParse({
        ...input(),
        path: "private.json",
      }).success,
    ).toBe(false);
    expect(
      commands.repository_dependencies.schema.safeParse({
        ...input(),
        checkUpstream: true,
      }).success,
    ).toBe(false);
    expect(CAPABILITY.READ).toBe("read");
  });
});
