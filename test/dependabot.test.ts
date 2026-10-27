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
import {
  dependabotPageSchema,
  dependabotResultSchema,
  DEPENDABOT_LIMITS,
} from "../shared/dependabot";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";
import { inspectDependabotFile } from "../worker/dependabot-client";
import { credentialHash } from "../worker/credential-hash";
import { GITHUB_CONTEXT_LIMITS } from "../shared/github-context";
import {
  DEPENDABOT_PROVIDER as F,
  DEPENDABOT_SOURCE,
  dependabotProviderFixture,
} from "./fixtures/dependabot-provider";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
let now: number,
  runtime: Env,
  owner: WorkspaceService,
  viewer: WorkspaceService,
  repositoryId: string;
let provider: Awaited<ReturnType<typeof dependabotProviderFixture>>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const scope = () => ({
  workspaceId: "alpha",
  sourceId: "github",
  repositoryId,
});
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.parse("2026-10-26T08:00:00Z");
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      read: { workspaceId: "alpha", name: "Reader", token: F.token },
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
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project',''),('other-project','alpha','Other','')",
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
        description: "Synthetic schedule fixture",
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
      name: "Schedule reader",
      enabled: true,
      freshnessMinutes: 30,
      repositoryIds: [repositoryId],
      credentialRef: "read",
      refreshIntervalMinutes: 15,
    },
  });
  provider = await dependabotProviderFixture();
  fetcher = vi.fn(async (target) => provider.response(new URL(String(target))));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bounded immutable Dependabot inspection", () => {
  const inspect = () =>
    inspectDependabotFile(F.repository, F.token, { now: () => now });
  it("reads only root/.github trees and the exact blob without exposing registry material", async () => {
    const result = await inspect();
    expect(result.evidence).toMatchObject({
      configuration: "present",
      read: { state: "observed" },
      branch: "main",
      headSha: F.head,
      treeSha: F.root,
      requests: 5,
    });
    expect(result.evidence.entries).toHaveLength(1);
    expect(result.files.get(".github/dependabot.yml")).toBe(DEPENDABOT_SOURCE);
    expect(JSON.stringify(result.evidence)).not.toContain(F.privateValue);
    expect(
      fetcher.mock.calls.every(([url]) => !String(url).includes("recursive=")),
    ).toBe(true);
    dependabotResultSchema.parse({
      repository: { id: repositoryId, fullName: F.repository, revision: 1 },
      source: { id: "github", name: "Reader", revision: 1 },
      state: "ready",
      nextReadAt: null,
      evidence: result.evidence,
    });
  });
  it("confirms absence only through a complete tree, and distinguishes denied reads", async () => {
    provider.tree.tree.length = 0;
    expect((await inspect()).evidence).toMatchObject({
      configuration: "missing",
      read: { state: "observed" },
      entries: [],
    });
    fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
    expect((await inspect()).evidence).toMatchObject({
      configuration: "unknown",
      read: { state: "unavailable", reason: "permission" },
      entries: [],
      file: null,
    });
  });
  it("rejects dual filenames without choosing one", async () => {
    provider.tree.tree.push({
      ...provider.tree.tree[0]!,
      path: "dependabot.yaml",
    });
    expect((await inspect()).evidence).toMatchObject({
      configuration: "ambiguous",
      entries: [],
      file: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each(["truncated", "duplicate", "symlink", "size", "sha", "blob"])(
    "does not trust %s tree/blob evidence",
    async (kind) => {
      if (kind === "truncated") provider.root.truncated = true;
      if (kind === "duplicate")
        provider.tree.tree.push({ ...provider.tree.tree[0]! });
      if (kind === "symlink") provider.tree.tree[0]!.mode = "120000";
      if (kind === "size") provider.blob.size++;
      if (kind === "sha") provider.tree.sha = "d".repeat(40);
      if (kind === "blob")
        provider.blob.content = btoa("x".repeat(provider.blob.size));
      const result = await inspect();
      expect(result.evidence.read.state).not.toBe("observed");
      expect(result.evidence.entries).toEqual([]);
      expect(result.evidence.file).toBeNull();
    },
  );
  it("keeps malformed and unsupported YAML distinct without raw parser diagnostics", async () => {
    for (const [source, configuration] of [
      ["version: [", "malformed"],
      ["version: 3\nupdates: []\n", "unsupported"],
    ]) {
      provider = await dependabotProviderFixture(source);
      const result = await inspect();
      expect(result.evidence.configuration).toBe(configuration);
      expect(JSON.stringify(result.evidence)).not.toContain("version: [");
    }
  });
  it("accepts byte-verified UTF-8 BOM and rejects invalid UTF-8", async () => {
    provider = await dependabotProviderFixture("\ufeff" + DEPENDABOT_SOURCE);
    expect((await inspect()).evidence.configuration).toBe("present");
    provider = await dependabotProviderFixture(new Uint8Array([0xc3, 0x28]));
    expect((await inspect()).evidence.read.state).toBe("error");
  });
});

describe("workspace schedule evidence", () => {
  it("loads retained inventory without provider reads and retains bounded normalized observations", async () => {
    const first = dependabotPageSchema.parse(
      await viewer.dependabotSchedules({ workspaceId: "alpha" }),
    );
    expect(first.rows[0]).toMatchObject({
      repository: { id: repositoryId },
      source: { id: "github" },
      result: { state: "waiting", evidence: null },
    });
    expect(fetcher).not.toHaveBeenCalled();
    const read = await viewer.repositoryDependabot({
      ...scope(),
      refresh: true,
    });
    expect(read.evidence?.configuration).toBe("present");
    const requests = fetcher.mock.calls.length;
    const saved = dependabotPageSchema.parse(
      await viewer.dependabotSchedules({ workspaceId: "alpha" }),
    );
    expect(saved.rows[0]!.result?.evidence?.entries).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(requests);
    const cached = await bindings.HQ_DB.prepare(
      "SELECT result_json FROM github_dependabot_cache",
    ).first<string>("result_json");
    expect(cached).not.toContain(F.privateValue);
    now += DEPENDABOT_LIMITS.CACHE_MS + 1;
    expect(
      (await viewer.dependabotSchedules({ workspaceId: "alpha" })).rows[0]!
        .result?.evidence?.observedAt,
    ).toBe(read.evidence!.observedAt);
  });
  it("paginates all enrolled rows and honors project scope without a silent first-page cutoff", async () => {
    for (let index = 0; index < DEPENDABOT_LIMITS.PAGE_SIZE + 2; index++)
      await owner.createRepository({
        workspaceId: "alpha",
        repository: {
          fullName: "example/other-" + index,
          projectId: "other-project",
          description: "",
          classification: "watchlist",
          lifecycle: "active",
          expectations: DEFAULT_EXPECTATIONS,
        },
      });
    const first = await viewer.dependabotSchedules({
      workspaceId: "alpha",
      page: 1,
    });
    const second = await viewer.dependabotSchedules({
      workspaceId: "alpha",
      page: 2,
    });
    expect(first.total).toBe(DEPENDABOT_LIMITS.PAGE_SIZE + 3);
    expect(first.rows).toHaveLength(DEPENDABOT_LIMITS.PAGE_SIZE);
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row.repository.id))
        .size,
    ).toBe(first.total);
    expect(first.revision).toBe(second.revision);
    expect(
      (
        await viewer.dependabotSchedules({
          workspaceId: "alpha",
          projectId: "project",
        })
      ).total,
    ).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks other workspaces, source-bound publishers, and unavailable source authority", async () => {
    await expect(
      viewer.dependabotSchedules({ workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    const publisher = new WorkspaceService(
      runtime,
      { subject: "owner", displayName: "Publisher", sourceId: "github" },
      false,
      () => now,
    );
    await expect(
      publisher.repositoryDependabot({ ...scope(), refresh: true }),
    ).rejects.toMatchObject({ status: 403 });
    await bindings.HQ_DB.prepare(
      "UPDATE connections SET enabled=0,revision=revision+1 WHERE id='github'",
    ).run();
    expect(
      (await viewer.repositoryDependabot({ ...scope(), refresh: true })).state,
    ).toBe("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves cooldowns and does not issue reads with missing credentials", async () => {
    runtime.GITHUB_CREDENTIALS = undefined;
    expect(
      (await viewer.repositoryDependabot({ ...scope(), refresh: true })).state,
    ).toBe("not_configured");
    expect(fetcher).not.toHaveBeenCalled();
    runtime.GITHUB_CREDENTIALS = JSON.stringify({
      read: { workspaceId: "alpha", name: "Reader", token: F.token },
    });
    fetcher.mockImplementation(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "600" } }),
    );
    const read = await viewer.repositoryDependabot({
      ...scope(),
      refresh: true,
    });
    expect(read.evidence?.retryAt).not.toBeNull();
    await viewer.repositoryDependabot({ ...scope(), refresh: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("hides retained evidence after read credentials become unavailable", async () => {
    await viewer.repositoryDependabot({ ...scope(), refresh: true });
    runtime.GITHUB_CREDENTIALS = undefined;
    const page = await viewer.dependabotSchedules({ workspaceId: "alpha" });
    expect(page.rows[0]!.result).toMatchObject({
      state: "not_configured",
      evidence: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not serve internally inconsistent retained observations", async () => {
    const inspected = await viewer.repositoryDependabot({
      ...scope(),
      refresh: true,
    });
    const evidence = inspected.evidence!;
    for (const patch of [
      { file: null },
      { headSha: null },
      { read: { state: "error", reason: "response_invalid" } },
      {
        entries: [
          {
            ...evidence.entries[0]!,
            id: "sha256:" + "d".repeat(64) + ":update:0",
          },
        ],
      },
    ]) {
      await bindings.HQ_DB.prepare(
        "UPDATE github_dependabot_cache SET result_json=? WHERE repository_id=?",
      )
        .bind(JSON.stringify({ ...evidence, ...patch }), repositoryId)
        .run();
      expect(
        (await viewer.dependabotSchedules({ workspaceId: "alpha" })).rows[0]!
          .result?.evidence,
      ).toBeNull();
    }
  });

  it("rechecks membership after the final credential hash before returning cached evidence", async () => {
    await viewer.repositoryDependabot({ ...scope(), refresh: true });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 2)
        await bindings.HQ_DB.prepare(
          "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
        ).run();
      return result;
    });
    await expect(viewer.repositoryDependabot(scope())).rejects.toHaveProperty(
      "status",
    );
  });

  it("rechecks authority after delivering the inspection notification", async () => {
    runtime.WORKSPACE_EVENTS = {
      getByName: () => ({
        publish: async () => {
          await bindings.HQ_DB.prepare(
            "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
          ).run();
        },
      }),
    } as unknown as Env["WORKSPACE_EVENTS"];
    await expect(
      viewer.repositoryDependabot({ ...scope(), refresh: true }),
    ).rejects.toHaveProperty("status");
  });

  it("uses the shared credential read budget before sending provider requests", async () => {
    const window =
      Math.floor(now / GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS) *
      GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS;
    await bindings.HQ_DB.prepare(
      "INSERT INTO github_context_budgets (credential_hash,window_start,reads) VALUES (?,?,?)",
    )
      .bind(
        await credentialHash(F.token),
        window,
        GITHUB_CONTEXT_LIMITS.READS_PER_WINDOW,
      )
      .run();
    const result = await viewer.repositoryDependabot({
      ...scope(),
      refresh: true,
    });
    expect(result).toMatchObject({ state: "waiting", evidence: null });
    expect(Date.parse(result.nextReadAt!)).toBe(
      window + GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["membership", "source", "credential", "expiry"])(
    "does not return evidence when %s changes during inspection",
    async (kind) => {
      const principal: Principal = {
        subject: "viewer",
        displayName: "Viewer",
        expiresAt: now + 10000,
      };
      const actor = new WorkspaceService(runtime, principal, false, () => now);
      fetcher.mockImplementation(async (target) => {
        const url = new URL(String(target));
        if (url.pathname.includes("/git/blobs/")) {
          if (kind === "membership")
            await bindings.HQ_DB.prepare(
              "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
            ).run();
          if (kind === "source")
            await bindings.HQ_DB.prepare(
              "UPDATE connections SET revision=revision+1 WHERE id='github'",
            ).run();
          if (kind === "credential")
            runtime.GITHUB_CREDENTIALS = JSON.stringify({
              read: {
                workspaceId: "alpha",
                name: "Reader",
                token: F.token + "-rotated",
              },
            });
          if (kind === "expiry") now += 20000;
        }
        return provider.response(url);
      });
      await expect(
        actor.repositoryDependabot({ ...scope(), refresh: true }),
      ).rejects.toHaveProperty("status");
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT result_json FROM github_dependabot_cache WHERE repository_id=?",
        )
          .bind(repositoryId)
          .first<string>("result_json"),
      ).toBeNull();
    },
  );
  it("registers strict shared read-only commands and rejects arbitrary paths", () => {
    expect(commands.dependabot_schedules.method).toBe("dependabotSchedules");
    expect(
      commandAnnotations(
        "repository_dependabot",
        commands.repository_dependabot.readOnly,
      ),
    ).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(
      commands.repository_dependabot.schema.safeParse({
        ...scope(),
        path: ".github/other.yml",
      }).success,
    ).toBe(false);
  });
});
