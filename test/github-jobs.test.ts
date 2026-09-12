import {
  env,
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
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
  LIMITS as WORKSPACE_LIMITS,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import {
  GITHUB_REFRESH_LIMITS as LIMITS,
  githubSourceFields,
  type GitHubSource,
} from "../shared/github";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import { WorkspaceService } from "../worker/service";
import { runGitHubJobs, runGitHubScheduled } from "../worker/github-runner";
import { GitHubJobs, scheduleGitHubSources } from "../worker/github-jobs";
import { credentialHash } from "../worker/credential-hash";
import { createApplication } from "../worker/app";
import production from "../worker/index";
import { callCommand, clientConfiguration } from "../cli/client";
import type { Env } from "../worker/types";
import { countD1Statements } from "./helpers/d1-count";
import { D1_VOLUME_TEST_TIMEOUT_MS } from "./helpers/timeouts";
import { githubCollectionOutcome } from "../shared/github-refresh-summary";
import { commands, commandAnnotations } from "../shared/commands";
import { GITHUB_COVERAGE_LIMITS } from "../shared/github-coverage";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const WORKSPACE = "alpha";
const TOKEN = "synthetic-github-credential";
const OTHER_TOKEN = "synthetic-other-workspace-credential";
const SHA = "a".repeat(40);
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
const sourceInput = { workspaceId: WORKSPACE, sourceId: "github" };
let now: number;
let runtime: Env;
let service: WorkspaceService;
let repositoryId: string;
let secondId: string;
let source: GitHubSource;
const catalog = () =>
  JSON.stringify({
    personal: { workspaceId: WORKSPACE, name: "Personal GitHub", token: TOKEN },
    alias: {
      workspaceId: WORKSPACE,
      name: "Same provider grant",
      token: TOKEN,
    },
    other: { workspaceId: "beta", name: "Other workspace", token: OTHER_TOKEN },
  });
const fields = () => ({
  name: "GitHub",
  enabled: true,
  freshnessMinutes: 30,
  repositoryIds: [repositoryId],
  credentialRef: "personal",
  refreshIntervalMinutes: 15,
});
const refresh = (refreshId = "refresh") => ({
  ...sourceInput,
  revision: source.revision,
  refreshId,
});
const read = (refreshId = "refresh") =>
  service.githubRefreshGet({ ...sourceInput, refreshId });
type Intercept = (url: URL) => Promise<Response | void> | Response | void;
function fixture(intercept?: Intercept) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    const override = await intercept?.(url);
    if (override) return override;
    const fullName = url.pathname.split("/").slice(2, 4).join("/");
    if (url.pathname === "/repos/" + fullName)
      return Response.json({
        full_name: fullName,
        private: true,
        default_branch: "main",
        description: "synthetic-private-payload",
      });
    if (url.pathname.endsWith("/branches/main"))
      return Response.json({ name: "main", commit: { sha: SHA } });
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        total_count: 1,
        check_runs: [
          { id: 1, head_sha: SHA, status: "completed", conclusion: "success" },
        ],
      });
    if (url.pathname.endsWith("/status"))
      return Response.json({
        sha: SHA,
        state: "pending",
        total_count: 0,
        statuses: [],
      });
    if (url.pathname.endsWith("/alerts")) return Response.json([]);
    throw new Error("Unrecognized fixture path");
  }) as unknown as typeof fetch;
}
const run = (fetch = fixture(), maxItems: number = LIMITS.HTTP_ITEMS) =>
  runGitHubJobs(runtime, { now: () => now, fetch, maxItems });

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = { ...bindings, GITHUB_CREDENTIALS: catalog() };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('alpha', 'Alpha', '2026-01-01'), ('beta', 'Beta', '2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id, subject, display_name, role) VALUES ('alpha', 'owner', 'Owner', 'owner'), ('alpha', 'operator', 'Operator', 'operator'), ('alpha', 'viewer', 'Viewer', 'viewer'), ('beta', 'other', 'Other', 'owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  service = new WorkspaceService(runtime, OWNER, false, () => now);
  const repository = {
    fullName: "example/first",
    description: "Synthetic fixture",
    projectId: "project",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
  repositoryId = (
    await service.createRepository({ workspaceId: WORKSPACE, repository })
  ).id;
  secondId = (
    await service.createRepository({
      workspaceId: WORKSPACE,
      repository: { ...repository, fullName: "example/second" },
    })
  ).id;
  source = await service.githubSourceEnroll({
    ...sourceInput,
    source: fields(),
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Workspace-owned GitHub sources", () => {
  it("bounds source selection at one hundred unique repositories", () => {
    const repositoryIds = Array.from(
      { length: 100 },
      (_, index) => "repo-" + index,
    );
    expect(
      githubSourceFields.parse({ ...fields(), repositoryIds }).repositoryIds,
    ).toHaveLength(100);
    expect(
      githubSourceFields.safeParse({
        ...fields(),
        repositoryIds: [...repositoryIds, "overflow"],
      }).success,
    ).toBe(false);
    expect(
      githubSourceFields.safeParse({
        ...fields(),
        repositoryIds: [repositoryId, repositoryId],
      }).success,
    ).toBe(false);
  });
  it("serializes concurrent enrollment, settings saves, and refresh receipts", async () => {
    const input = { ...sourceInput, sourceId: "concurrent", source: fields() };
    const enrolled = await Promise.all([
      service.githubSourceEnroll(input),
      service.githubSourceEnroll(input),
    ]);
    expect(enrolled[0]).toEqual(enrolled[1]);
    const updates = await Promise.allSettled([
      service.githubSourceUpdate({
        ...sourceInput,
        revision: 1,
        source: { ...fields(), name: "First" },
      }),
      service.githubSourceUpdate({
        ...sourceInput,
        revision: 1,
        source: { ...fields(), name: "Second" },
      }),
    ]);
    expect(
      updates.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      updates.filter((value) => value.status === "rejected"),
    ).toMatchObject([{ reason: { code: "revision_conflict" } }]);
    source = await service.githubSourceGet(sourceInput);
    const jobs = await Promise.all([
      service.githubRefresh(refresh()),
      service.githubRefresh(refresh()),
    ]);
    expect(jobs[0]).toEqual(jobs[1]);
    expect(await service.githubRefreshes(sourceInput)).toHaveLength(1);
  });

  it("restricts credential references to owners and the selected workspace without exposing custody", async () => {
    expect(await service.githubCredentials({ workspaceId: WORKSPACE })).toEqual(
      [
        { id: "personal", name: "Personal GitHub" },
        { id: "alias", name: "Same provider grant" },
      ],
    );
    const snapshots = JSON.stringify(
      await service.snapshot({ workspaceId: WORKSPACE }),
    );
    expect(snapshots).not.toContain(TOKEN);
    expect(snapshots).not.toContain(await credentialHash(TOKEN));
    expect(source).toMatchObject({
      credentialConfigured: true,
      github: { credentialRef: "personal", configurationValid: true },
    });
    expect(
      await service.githubSourceEnroll({ ...sourceInput, source: fields() }),
    ).toEqual(source);
    await expect(
      service.githubSourceEnroll({
        ...sourceInput,
        source: { ...fields(), name: "Different" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.githubSourceEnroll({
        ...sourceInput,
        sourceId: "cross",
        source: { ...fields(), credentialRef: "other" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.githubSourceUpdate({
        ...sourceInput,
        revision: 1,
        source: { ...fields(), repositoryIds: ["not-enrolled"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    for (const subject of ["operator", "viewer"]) {
      const actor = new WorkspaceService(runtime, {
        subject,
        displayName: subject,
      });
      await expect(
        actor.githubCredentials({ workspaceId: WORKSPACE }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        actor.githubSourceUpdate({
          ...sourceInput,
          revision: 1,
          source: fields(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await actor.githubSourceGet(sourceInput)).toMatchObject({
        id: source.id,
      });
    }
    await expect(
      service.githubSourceGet({ ...sourceInput, workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.githubSourceEnroll({
        ...sourceInput,
        sourceId: "invalid",
        source: { ...fields(), freshnessMinutes: 10 },
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("supports honest unconfigured sources, corrupt bindings, and optimistic settings conflicts", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: 1,
      source: { ...fields(), credentialRef: null },
    });
    expect(source.credentialConfigured).toBe(false);
    await expect(service.githubRefresh(refresh())).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(
      service.githubSourceUpdate({
        ...sourceInput,
        revision: 1,
        source: fields(),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    for (const value of [
      "not-json",
      "[]",
      JSON.stringify({
        personal: { workspaceId: WORKSPACE, name: "Missing token" },
      }),
    ]) {
      runtime.GITHUB_CREDENTIALS = value;
      expect(
        await service.githubCredentials({ workspaceId: WORKSPACE }),
      ).toEqual([]);
      expect(
        (await service.githubSourceGet(sourceInput)).credentialConfigured,
      ).toBe(false);
    }
  });

  it("preserves existing expiry on a rename or longer policy and expires only incompatible evidence", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: 1,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    await service.githubRefresh(refresh());
    await run(fixture(), 2);
    const before = await service.observations({ workspaceId: WORKSPACE });
    now += LIMITS.MINUTE_MS;
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: {
        ...fields(),
        name: "Renamed",
        freshnessMinutes: 60,
        repositoryIds: [repositoryId, secondId],
      },
    });
    expect(await service.observations({ workspaceId: WORKSPACE })).toEqual(
      before,
    );
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), freshnessMinutes: 10, refreshIntervalMinutes: 5 },
    });
    const narrowed = await service.observations({ workspaceId: WORKSPACE });
    expect(narrowed).toHaveLength(1);
    expect(Date.parse(narrowed[0].expiresAt)).toBe(
      Date.parse(before[0].observedAt) + 10 * LIMITS.MINUTE_MS,
    );
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), enabled: false },
    });
    expect(
      (await service.observations({ workspaceId: WORKSPACE }))[0].expiresAt,
    ).toBe(new Date(now).toISOString());
  });
});

describe("Durable GitHub refresh work", () => {
  it("keeps source-edit eligibility without turning the minimum refresh interval into a failure", async () => {
    await service.githubRefresh(refresh("before-scope-edit"));
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    expect((await read("before-scope-edit")).status).toBe("cancelled");

    await scheduleGitHubSources(runtime, () => now);
    const waiting = await service.githubSourceGet(sourceInput);
    expect(waiting.lastError).toBeNull();
    expect(waiting.github.nextRefreshAt).toBe(new Date(now).toISOString());
    expect(waiting.github.activeRefreshId).toBeNull();

    now += LIMITS.MANUAL_INTERVAL_MS;
    await scheduleGitHubSources(runtime, () => now);
    const accepted = await service.githubSourceGet(sourceInput);
    expect(accepted.lastError).toBeNull();
    expect(accepted.github.activeRefreshId).not.toBeNull();
    const receipt = await read(accepted.github.activeRefreshId!);
    expect(receipt).toMatchObject({
      sourceRevision: source.revision,
      trigger: "scheduled",
      status: "queued",
      total: 2,
    });
  });

  it("preserves the shared provider cooldown without replacing a genuine previous error", async () => {
    const previousError = "An earlier repository read failed";
    const retryAt = new Date(now + LIMITS.MINUTE_MS * 2).toISOString();
    await runtime.HQ_DB.batch([
      runtime.HQ_DB.prepare(
        "UPDATE connections SET last_error = ? WHERE workspace_id = ? AND id = ?",
      ).bind(previousError, WORKSPACE, source.id),
      runtime.HQ_DB.prepare(
        "INSERT INTO github_cooldowns (credential_hash, retry_at) VALUES (?, ?)",
      ).bind(await credentialHash(TOKEN), retryAt),
    ]);
    await scheduleGitHubSources(runtime, () => now);
    const cooling = await service.githubSourceGet(sourceInput);
    expect(cooling.lastError).toBe(previousError);
    expect(cooling.github.retryAt).toBe(retryAt);
    expect(cooling.github.nextRefreshAt).toBe(source.github.nextRefreshAt);
    expect(cooling.github.activeRefreshId).toBeNull();

    now = Date.parse(retryAt);
    await scheduleGitHubSources(runtime, () => now);
    expect(
      (await service.githubSourceGet(sourceInput)).github.activeRefreshId,
    ).not.toBeNull();
  });

  it("leaves a concurrent accepted refresh intact without creating another job", async () => {
    const original = GitHubJobs.prototype.start;
    vi.spyOn(GitHubJobs.prototype, "start").mockImplementationOnce(
      async function (this: GitHubJobs, input, scheduled) {
        await original.call(
          this,
          { ...input, refreshId: "accepted-first" },
          scheduled,
        );
        return original.call(this, input, scheduled);
      },
    );
    await scheduleGitHubSources(runtime, () => now);
    const accepted = await service.githubSourceGet(sourceInput);
    expect(accepted.lastError).toBeNull();
    expect(accepted.github.activeRefreshId).toBe("accepted-first");
    expect(await service.githubRefreshes(sourceInput)).toHaveLength(1);
  });

  it("still records unavailable configuration and propagates unexpected scheduling failures", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), credentialRef: null },
    });
    await scheduleGitHubSources(runtime, () => now);
    const unavailable = await service.githubSourceGet(sourceInput);
    expect(unavailable.lastError).toContain(
      "No workspace-bound GitHub credential",
    );
    expect(unavailable.github.activeRefreshId).toBeNull();
    expect(unavailable.github.nextRefreshAt).toBe(
      new Date(
        now + LIMITS.DEFAULT_INTERVAL_MINUTES * LIMITS.MINUTE_MS,
      ).toISOString(),
    );
    now += LIMITS.DEFAULT_INTERVAL_MINUTES * LIMITS.MINUTE_MS;
    const failure = new Error("Synthetic scheduling failure");
    vi.spyOn(GitHubJobs.prototype, "start").mockRejectedValueOnce(failure);
    await expect(scheduleGitHubSources(runtime, () => now)).rejects.toBe(
      failure,
    );
  });

  it("keeps saturated recovery and due-source scheduling within the Paid database budget", async () => {
    const sourceCount = LIMITS.RECOVERY_JOBS + LIMITS.DUE_SOURCES;
    for (let index = 0; index < sourceCount; index++) {
      const sourceId =
        index === 0 ? sourceInput.sourceId : "load-source-" + index;
      if (index > 0)
        await service.githubSourceEnroll({
          workspaceId: WORKSPACE,
          sourceId,
          source: { ...fields(), repositoryIds: [repositoryId, secondId] },
        });
      if (index < LIMITS.RECOVERY_JOBS)
        await service.githubRefresh({
          workspaceId: WORKSPACE,
          sourceId,
          revision: 1,
          refreshId: "load-refresh-" + index,
        });
    }
    const sql = countD1Statements(runtime.HQ_DB);
    const fetch = fixture();
    const result = await runGitHubScheduled(
      { ...runtime, HQ_DB: sql.db },
      { now: () => now, fetch },
    );
    expect(result.processed).toBe(LIMITS.CRON_ITEMS);
    expect(sql.count()).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(LIMITS.CRON_ITEMS * 7);
    expect(
      await runtime.HQ_DB.prepare(
        "SELECT count(*) FROM github_refreshes",
      ).first("count(*)"),
    ).toBe(sourceCount);
    expect(
      await runtime.HQ_DB.prepare(
        "SELECT count(*) FROM github_refresh_items WHERE status = 'succeeded'",
      ).first("count(*)"),
    ).toBe(LIMITS.CRON_ITEMS);
  }, D1_VOLUME_TEST_TIMEOUT_MS);

  it("leaves untouched work queued when a scheduled slice cannot reserve a full repository deadline", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let elapsed = 0;
    const fetch = fixture(() => {
      elapsed = LIMITS.CRON_BUDGET_MS - LIMITS.CRON_ITEM_RESERVE_MS + 1;
    });
    expect(
      await runGitHubScheduled(runtime, {
        now: () => now,
        wallNow: () => elapsed,
        fetch,
      }),
    ).toEqual({ processed: 1 });
    const [job] = await service.githubRefreshes(sourceInput);
    const detail = await service.githubRefreshGet({
      ...sourceInput,
      refreshId: job.id,
    });
    expect(detail).toMatchObject({ status: "running", finished: 1 });
    expect(
      detail.items?.map((item) => ({
        status: item.status,
        attempts: item.attempts,
      })),
    ).toEqual(
      expect.arrayContaining([
        { status: "succeeded", attempts: 1 },
        { status: "queued", attempts: 0 },
      ]),
    );
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.github.batch.completed",
        trigger: "scheduled",
        processed: 1,
        stopReason: "time_limit",
        elapsedMs: elapsed,
        failed: false,
      }),
    );
    elapsed = 0;
    expect(
      await runGitHubScheduled(runtime, {
        now: () => now,
        wallNow: () => elapsed,
        fetch: fixture(),
      }),
    ).toEqual({ processed: 1 });
    expect(
      await service.githubRefreshGet({ ...sourceInput, refreshId: job.id }),
    ).toMatchObject({ status: "succeeded", finished: 2 });
  });

  it.each([1, 2])(
    "leaves work unclaimed when wall-budget gate %i expires during setup or lookup",
    async (expiryRead) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let clockReads = 0;
      const fetch = fixture();
      const wallNow = () =>
        clockReads++ < expiryRead ? 0 : LIMITS.CRON_BUDGET_MS;
      expect(
        await runGitHubScheduled(runtime, { now: () => now, wallNow, fetch }),
      ).toEqual({ processed: 0 });
      expect(fetch).not.toHaveBeenCalled();
      const [job] = await service.githubRefreshes(sourceInput);
      expect(
        await service.githubRefreshGet({ ...sourceInput, refreshId: job.id }),
      ).toMatchObject({
        status: "queued",
        finished: 0,
        items: [{ status: "queued", attempts: 0 }],
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "hq.github.batch.completed",
          stopReason: "time_limit",
          elapsedMs: LIMITS.CRON_BUDGET_MS,
        }),
      );
    },
  );

  it("drains a fifty-repository source within three ordinary scheduled slices and leaves idle ticks cheap", async () => {
    const repositoryIds = [repositoryId, secondId];
    while (repositoryIds.length < 50) {
      repositoryIds.push(
        (
          await service.createRepository({
            workspaceId: WORKSPACE,
            repository: {
              fullName: "example/fleet-" + repositoryIds.length,
              description: "Synthetic fleet",
              projectId: "project",
              classification: "maintained",
              lifecycle: "active",
              expectations: DEFAULT_EXPECTATIONS,
            },
          })
        ).id,
      );
    }
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds, refreshIntervalMinutes: 5 },
    });
    const sql = countD1Statements(runtime.HQ_DB);
    const measured = { ...runtime, HQ_DB: sql.db };
    const fetch = fixture();
    const observed: number[] = [];
    for (const finished of [20, 40, 50]) {
      sql.reset();
      const result = await runGitHubScheduled(measured, {
        now: () => now,
        fetch,
      });
      observed.push(sql.count());
      expect(result.processed).toBeLessThanOrEqual(20);
      expect(sql.count()).toBeLessThan(1000);
      expect((await service.githubRefreshes(sourceInput))[0].finished).toBe(
        finished,
      );
      now += LIMITS.MINUTE_MS;
    }
    const [job] = await service.githubRefreshes(sourceInput);
    expect(job).toMatchObject({ status: "succeeded", total: 50, finished: 50 });
    expect(fetch).toHaveBeenCalledTimes(50 * 7);
    expect(
      (await service.githubRefreshGet({ ...sourceInput, refreshId: job.id }))
        .items,
    ).toHaveLength(50);
    expect(Math.max(...observed)).toBeGreaterThan(50);
    vi.mocked(fetch).mockClear();
    sql.reset();
    await runGitHubScheduled(measured, { now: () => now, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(sql.count()).toBe(9);
    expect(observed.every((statements) => statements <= 300)).toBe(true);
    now += 2 * LIMITS.MINUTE_MS;
    await runGitHubScheduled(measured, { now: () => now, fetch });
    expect(await service.githubRefreshes(sourceInput)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(20 * 7);
  }, D1_VOLUME_TEST_TIMEOUT_MS);
  it("keeps workspace evidence bounded and reports storage capacity as a failed refresh", async () => {
    await bindings.HQ_DB.prepare(
      "INSERT INTO observations (workspace_id, source_id, resource_type, resource_id, name, health, summary, details_json, observed_at, received_at, expires_at) SELECT 'alpha', 'github', 'repository', 'capacity-' || value, 'Synthetic', 'unknown', 'Synthetic capacity fixture', '{}', ?, ?, ? FROM json_each(?)",
    )
      .bind(
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        JSON.stringify(
          Array.from(
            { length: WORKSPACE_LIMITS.MAX_OBSERVATIONS },
            (_, index) => index,
          ),
        ),
      )
      .run();
    await service.githubRefresh(refresh());
    await run();
    expect(await read()).toMatchObject({
      status: "failed",
      items: [
        {
          status: "failed",
          summary:
            "Workspace evidence capacity reached. Review source scope before retrying.",
        },
      ],
    });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS total FROM observations",
      ).first("total"),
    ).toBe(WORKSPACE_LIMITS.MAX_OBSERVATIONS);
    expect(
      (await service.githubSourceGet(sourceInput)).lastSuccessAt,
    ).toBeNull();
  });

  it("keeps the latest receipt while pruning expired history and does not replay older evidence", async () => {
    await service.githubRefresh(refresh());
    await run();
    const before = await service.observations({ workspaceId: WORKSPACE });
    now -= LIMITS.MINUTE_MS;
    await bindings.HQ_DB.prepare(
      "UPDATE connections SET last_attempt_at = NULL WHERE workspace_id = 'alpha' AND id = 'github'",
    ).run();
    await service.githubRefresh(refresh("older-observation"));
    await run();
    expect(await service.observations({ workspaceId: WORKSPACE })).toEqual(
      before,
    );
    now += (LIMITS.RETENTION_DAYS + 1) * LIMITS.DAY_MS;
    await run();
    expect(
      (await service.githubRefreshes(sourceInput)).map((job) => job.id),
    ).toEqual(["older-observation"]);
  });

  it("persists intent, handles duplicate IDs, and bounds each pass while preserving per-repository outcomes", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: 1,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    const operator = new WorkspaceService(
      runtime,
      { subject: "operator", displayName: "Operator" },
      false,
      () => now,
    );
    const queued = await operator.githubRefresh(refresh());
    expect(queued).toMatchObject({ status: "queued", total: 2, finished: 0 });
    expect(await operator.githubRefresh(refresh())).toEqual(queued);
    await expect(service.githubRefresh(refresh())).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(
      operator.githubRefresh(refresh("another")),
    ).rejects.toMatchObject({ status: 409 });
    const fetch = fixture();
    expect(await run(fetch)).toEqual({ processed: 1 });
    expect(await read()).toMatchObject({ status: "running", finished: 1 });
    expect(await run(fetch)).toEqual({ processed: 1 });
    expect(await read()).toMatchObject({
      status: "succeeded",
      finished: 2,
      actor: "Operator",
    });
    expect(fetch).toHaveBeenCalledTimes(14);
    const observations = await service.observations({ workspaceId: WORKSPACE });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      health: "healthy",
      details: { ci: "passing" },
    });
    const publicData = JSON.stringify([
      await read(),
      await service.snapshot({ workspaceId: WORKSPACE }),
    ]);
    for (const forbidden of [
      TOKEN,
      await credentialHash(TOKEN),
      "synthetic-private-payload",
      "credential_hash",
      "input_hash",
      "actor_token_id",
    ])
      expect(publicData).not.toContain(forbidden);
    expect((await service.githubSourceGet(sourceInput)).lastSuccessAt).toBe(
      new Date(now).toISOString(),
    );
    await expect(
      operator.githubRefresh(refresh("too-soon")),
    ).rejects.toMatchObject({ status: 409 });
    const viewer = new WorkspaceService(runtime, {
      subject: "viewer",
      displayName: "Viewer",
    });
    await expect(viewer.githubRefresh(refresh("denied"))).rejects.toMatchObject(
      { status: 403 },
    );
    expect(
      await viewer.githubRefreshGet({ ...sourceInput, refreshId: "refresh" }),
    ).toMatchObject({ status: "succeeded" });
  });

  it("does not publish results after a source is changed while GitHub is being read", async () => {
    await service.githubRefresh(refresh());
    let changed = false;
    await run(
      fixture(async () => {
        if (!changed) {
          changed = true;
          source = await service.githubSourceUpdate({
            ...sourceInput,
            revision: 1,
            source: { ...fields(), enabled: false },
          });
        }
      }),
    );
    expect(await read()).toMatchObject({ status: "cancelled" });
    expect(await service.observations({ workspaceId: WORKSPACE })).toHaveLength(
      0,
    );
    expect(
      (await service.githubSourceGet(sourceInput)).lastSuccessAt,
    ).toBeNull();
  });

  it("checks pinned repository identity, provider credential rotation, and membership again before accepting", async () => {
    for (const change of ["identity", "credential", "membership"] as const) {
      now += LIMITS.MANUAL_INTERVAL_MS;
      const id = "change-" + change;
      await service.githubRefresh(refresh(id));
      let changed = false;
      await run(
        fixture(async () => {
          if (changed) return;
          changed = true;
          if (change === "identity")
            await bindings.HQ_DB.prepare(
              "UPDATE repositories SET full_name = 'example/renamed' WHERE id = ?",
            )
              .bind(repositoryId)
              .run();
          if (change === "credential")
            runtime.GITHUB_CREDENTIALS = catalog().replace(
              TOKEN,
              "synthetic-rotated-token",
            );
          if (change === "membership")
            await bindings.HQ_DB.prepare(
              "UPDATE members SET role = 'viewer' WHERE workspace_id = 'alpha' AND subject = 'owner'",
            ).run();
        }),
      );
      expect(await read(id)).toMatchObject({ status: "cancelled" });
      expect(
        await service.observations({ workspaceId: WORKSPACE }),
      ).toHaveLength(0);
      runtime.GITHUB_CREDENTIALS = catalog();
      await bindings.HQ_DB.prepare(
        "UPDATE members SET role = 'owner' WHERE workspace_id = 'alpha' AND subject = 'owner'",
      ).run();
    }
  });

  it("honors live operator bearer expiry and revocation, and denies publisher credentials", async () => {
    const tokenId = "operator-credential";
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id, workspace_id, owner_subject, name, token_hash, scopes_json, created_at, expires_at) VALUES (?, 'alpha', 'operator', 'Operator', ?, ?, ?, ?)",
    )
      .bind(
        tokenId,
        await credentialHash("synthetic-operator-token"),
        JSON.stringify([CAPABILITY.READ, CAPABILITY.OPERATE]),
        new Date(now).toISOString(),
        new Date(now + LIMITS.DAY_MS).toISOString(),
      )
      .run();
    const actor = new WorkspaceService(
      runtime,
      {
        subject: "operator",
        displayName: "Operator",
        tokenId,
        workspaceId: WORKSPACE,
        scopes: [CAPABILITY.READ, CAPABILITY.OPERATE],
      },
      false,
      () => now,
    );
    await actor.githubRefresh(refresh());
    let changed = false;
    await run(
      fixture(async () => {
        if (!changed) {
          changed = true;
          await bindings.HQ_DB.prepare(
            "UPDATE credentials SET revoked_at = ? WHERE id = ?",
          )
            .bind(new Date(now).toISOString(), tokenId)
            .run();
        }
      }),
    );
    expect(await read()).toMatchObject({ status: "cancelled" });
    expect(await service.observations({ workspaceId: WORKSPACE })).toHaveLength(
      0,
    );
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at = NULL, expires_at = ? WHERE id = ?",
    )
      .bind(new Date(now + LIMITS.MINUTE_MS).toISOString(), tokenId)
      .run();
    now += LIMITS.MANUAL_INTERVAL_MS;
    await expect(actor.githubRefresh(refresh("expired"))).rejects.toMatchObject(
      { status: 403, code: "forbidden" },
    );
    const publisher = new WorkspaceService(runtime, {
      ...OWNER,
      tokenId: "publisher",
      sourceId: "laptop",
      scopes: [CAPABILITY.PUBLISH],
    });
    await expect(
      publisher.githubRefresh(refresh("publisher")),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("cancels idempotently and never accepts a cancelled lease", async () => {
    await service.githubRefresh(refresh());
    let cancelled = false;
    await run(
      fixture(async () => {
        if (!cancelled) {
          cancelled = true;
          const result = await service.githubRefreshCancel({
            ...sourceInput,
            refreshId: "refresh",
          });
          expect(
            await service.githubRefreshCancel({
              ...sourceInput,
              refreshId: "refresh",
            }),
          ).toEqual(result);
        }
      }),
    );
    expect(await read()).toMatchObject({ status: "cancelled" });
    expect(await service.observations({ workspaceId: WORKSPACE })).toHaveLength(
      0,
    );
  });

  it("recovers expired leases and terminates repeated interruptions or over-age jobs", async () => {
    await service.githubRefresh(refresh());
    await bindings.HQ_DB.prepare(
      "UPDATE github_refresh_items SET status = 'running', lease_id = 'old', attempts = 1, lease_until = ?",
    )
      .bind(new Date(now - 1).toISOString())
      .run();
    await run();
    expect(await read()).toMatchObject({
      status: "succeeded",
      items: [{ attempts: 2 }],
    });
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("exhausted"));
    await bindings.HQ_DB.prepare(
      "UPDATE github_refresh_items SET status = 'running', lease_id = 'old', attempts = ?, lease_until = ? WHERE refresh_id = 'exhausted'",
    )
      .bind(LIMITS.MAX_ATTEMPTS, new Date(now - 1).toISOString())
      .run();
    const fetch = fixture();
    await run(fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(await read("exhausted")).toMatchObject({ status: "failed" });
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("old"));
    now += LIMITS.JOB_MAX_AGE_MS;
    await run(fetch);
    expect(await read("old")).toMatchObject({ status: "failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a result whose lease expires during collection and safely retries later", async () => {
    await service.githubRefresh(refresh());
    let expired = false;
    await run(
      fixture(() => {
        if (!expired) {
          expired = true;
          now += LIMITS.LEASE_MS;
        }
      }),
    );
    expect(await service.observations({ workspaceId: WORKSPACE })).toHaveLength(
      0,
    );
    expect(await read()).toMatchObject({
      status: "running",
      items: [{ status: "queued", attempts: 1 }],
    });
    await run();
    expect(await read()).toMatchObject({
      status: "succeeded",
      items: [{ attempts: 2 }],
    });
  });

  it("shares provider cooldowns across aliases and leaves unread repositories visibly queued", async () => {
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: 1,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    await service.githubSourceEnroll({
      ...sourceInput,
      sourceId: "alias-source",
      source: { ...fields(), credentialRef: "alias" },
    });
    await service.githubRefresh(refresh());
    const fetch = fixture(
      () =>
        new Response("synthetic-provider-error-body", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    await run(fetch, 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({ status: "running", finished: 1 });
    const alias = await service.githubSourceGet({
      ...sourceInput,
      sourceId: "alias-source",
    });
    expect(alias.github.retryAt).toBe(
      new Date(now + 2 * LIMITS.MINUTE_MS).toISOString(),
    );
    await expect(
      service.githubRefresh({
        workspaceId: WORKSPACE,
        sourceId: alias.id,
        revision: 1,
        refreshId: "alias-refresh",
      }),
    ).rejects.toMatchObject({ status: 429 });
    const observation = (
      await service.observations({ workspaceId: WORKSPACE })
    )[0];
    expect(observation.health).toBe("unknown");
    expect(JSON.stringify(observation)).not.toContain(
      "synthetic-provider-error-body",
    );
    now += 2 * LIMITS.MINUTE_MS;
    await run();
    expect(await read()).toMatchObject({ status: "partial", finished: 2 });
  });

  it("does not turn failed reads into fresh passing evidence or advance complete-success clocks", async () => {
    await service.githubRefresh(refresh());
    await run();
    const successAt = (await service.githubSourceGet(sourceInput))
      .lastSuccessAt;
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("failed"));
    await run(
      fixture(() => new Response("synthetic-sensitive-error", { status: 403 })),
    );
    expect(await read("failed")).toMatchObject({ status: "failed" });
    expect(
      (await service.observations({ workspaceId: WORKSPACE }))[0],
    ).toMatchObject({ health: "unknown", details: { ci: "unknown" } });
    expect((await service.githubSourceGet(sourceInput)).lastSuccessAt).toBe(
      successAt,
    );
  });

  it("serializes simultaneous invocations for a source", async () => {
    await service.githubRefresh(refresh());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const fetch = fixture(async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
    });
    const worker = run(fetch);
    await started;
    expect(await run(fetch)).toEqual({ processed: 0 });
    release();
    await worker;
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(await read()).toMatchObject({ status: "succeeded" });
  });

  it("keeps fully paginated scheduled batches within the Paid request limit and resumes queued work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const externalRequestLimit = 10000;
    const repositoriesPerInvocation = LIMITS.CRON_ITEMS;
    const repositoryIds = [repositoryId, secondId];
    while (repositoryIds.length <= repositoriesPerInvocation) {
      const repository = await service.createRepository({
        workspaceId: WORKSPACE,
        repository: {
          fullName: "example/batch-" + repositoryIds.length,
          description: "Synthetic batch fixture",
          projectId: "project",
          classification: "maintained",
          lifecycle: "active",
          expectations: DEFAULT_EXPECTATIONS,
        },
      });
      repositoryIds.push(repository.id);
    }
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds },
    });
    const fetch = fixture((url) => {
      const checks = url.pathname.endsWith("/check-runs");
      const statuses = url.pathname.endsWith("/status");
      if (!checks && !statuses && !url.pathname.endsWith("/alerts")) return;
      const page = Number(
        url.searchParams.get("after") ?? url.searchParams.get("page") ?? "1",
      );
      const offset = (page - 1) * GITHUB_LIMITS.PAGE_SIZE;
      const items = Array.from({ length: GITHUB_LIMITS.PAGE_SIZE }, (_, i) => {
        const id = offset + i + 1;
        return checks
          ? { id, head_sha: SHA, status: "completed", conclusion: "success" }
          : statuses
            ? { id, state: "success", context: "fixture-" + id }
            : { number: id, state: "open" };
      });
      const total = GITHUB_LIMITS.PAGE_SIZE * GITHUB_LIMITS.MAX_PAGES;
      const body = checks
        ? { total_count: total, check_runs: items }
        : statuses
          ? { sha: SHA, state: "success", total_count: total, statuses: items }
          : items;
      const headers: Record<string, string> = {};
      if (page < GITHUB_LIMITS.MAX_PAGES) {
        const next = new URL(url);
        if (url.pathname.includes("/dependabot/"))
          next.searchParams.set("after", String(page + 1));
        else next.searchParams.set("page", String(page + 1));
        headers.Link = "<" + next.href + '>; rel="next"';
      }
      return Response.json(body, { headers });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    await production.scheduled({} as ScheduledController, runtime);
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(
      externalRequestLimit,
    );
    expect(fetch).toHaveBeenCalledTimes(
      repositoriesPerInvocation * GITHUB_LIMITS.MAX_REQUESTS,
    );
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(50);
    const [receipt] = await service.githubRefreshes(sourceInput);
    const detail = await service.githubRefreshGet({
      ...sourceInput,
      refreshId: receipt.id,
    });
    expect(
      detail.items
        ?.filter((item) => item.diagnostics)
        .every(
          (item) => item.diagnostics?.requests === GITHUB_LIMITS.MAX_REQUESTS,
        ),
    ).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.github.repository.completed",
        refreshId: receipt.id,
        diagnostics: expect.objectContaining({
          requests: GITHUB_LIMITS.MAX_REQUESTS,
          pages: 5 * GITHUB_LIMITS.MAX_PAGES,
        }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.github.batch.completed",
        processed: repositoriesPerInvocation,
        stopReason: "item_limit",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain("example/");
    expect(receipt).toMatchObject({
      trigger: "scheduled",
      status: "running",
      finished: repositoriesPerInvocation,
      total: repositoryIds.length,
    });
    vi.mocked(fetch).mockClear();
    await production.scheduled({} as ScheduledController, runtime);
    expect(fetch).toHaveBeenCalledTimes(GITHUB_LIMITS.MAX_REQUESTS);
    expect(await service.githubRefreshes(sourceInput)).toMatchObject([
      {
        id: receipt.id,
        status: "succeeded",
        finished: repositoryIds.length,
      },
    ]);
  });

  it("runs due sources without a browser or local publisher and avoids unchanged success activity spam", async () => {
    const fetch = fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    await production.scheduled({} as ScheduledController, runtime);
    const history = await service.githubRefreshes(sourceInput);
    expect(history).toMatchObject([
      { trigger: "scheduled", status: "succeeded" },
    ]);
    const before = (await service.activity({ workspaceId: WORKSPACE })).filter(
      (item) => item.type.startsWith("github.refresh"),
    );
    expect(before).toHaveLength(1);
    now = Date.parse(
      (await service.githubSourceGet(sourceInput)).github.nextRefreshAt!,
    );
    await runGitHubScheduled(runtime, { now: () => now, fetch });
    expect(await service.githubRefreshes(sourceInput)).toHaveLength(2);
    expect(
      (await service.activity({ workspaceId: WORKSPACE })).filter((item) =>
        item.type.startsWith("github.refresh"),
      ),
    ).toEqual(before);
  });
});

describe("Source-linked GitHub refresh Activity", () => {
  it("retains exact source and receipt references across Activity reads and receipt retention", async () => {
    await service.githubRefresh(refresh());
    await run();
    const receipt = await read();
    expect(receipt.items?.[0].changes).toEqual(["first"]);
    expect(receipt.summary).toContain("example/first (first observation)");
    const events = await service.activity({ workspaceId: WORKSPACE });
    const completed = events.find(
      (event) => event.type === "github.refresh.completed",
    )!;
    expect(completed).toMatchObject({
      title: "GitHub refresh completed: GitHub",
      githubSourceId: source.id,
      githubSourceName: source.name,
      githubRefreshId: receipt.id,
    });
    expect(
      events.find((event) => event.type === "github.refresh.started"),
    ).toMatchObject({ githubRefreshId: receipt.id });
    expect(
      (await service.activityFeed({ workspaceId: WORKSPACE })).groups,
    ).toContainEqual({ kind: "event", event: completed });
    const relevant = () =>
      service.activityFeed({ workspaceId: WORKSPACE, repositoryId });
    expect((await relevant()).groups).toContainEqual({
      kind: "event",
      event: completed,
    });
    expect(
      (
        await service.activityFeed({
          workspaceId: WORKSPACE,
          repositoryId: secondId,
        })
      ).groups,
    ).not.toContainEqual({ kind: "event", event: completed });
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds: [secondId] },
    });
    expect((await relevant()).groups).toContainEqual({
      kind: "event",
      event: completed,
    });
    expect(
      (
        await service.activityFeed({
          workspaceId: WORKSPACE,
          repositoryId: secondId,
        })
      ).groups,
    ).not.toContainEqual({ kind: "event", event: completed });
    await expect(
      service.githubRefreshGet({
        ...sourceInput,
        sourceId: "wrong-source",
        refreshId: receipt.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.githubRefreshGet({
        ...sourceInput,
        workspaceId: "beta",
        refreshId: receipt.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await bindings.HQ_DB.prepare(
      "DELETE FROM github_refreshes WHERE workspace_id = ? AND id = ?",
    )
      .bind(WORKSPACE, receipt.id)
      .run();
    await expect(read()).rejects.toMatchObject({ status: 404 });
    expect((await relevant()).groups).toContainEqual({
      kind: "event",
      event: completed,
    });
    expect(
      (await service.activity({ workspaceId: WORKSPACE })).find(
        (event) => event.id === completed.id,
      ),
    ).toEqual(completed);
    const serialized = JSON.stringify({ events, receipt });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("synthetic-private-payload");
  });

  it("captures cancelled refresh relevance once without attributing other repositories", async () => {
    await service.githubRefresh(refresh());
    await service.githubRefreshCancel({ ...sourceInput, refreshId: "refresh" });
    await service.githubRefreshCancel({ ...sourceInput, refreshId: "refresh" });
    const related = await service.activityFeed({
      workspaceId: WORKSPACE,
      repositoryId,
    });
    const cancelled = related.groups.filter(
      (group) =>
        group.kind === "event" &&
        group.event.type === "github.refresh.cancelled",
    );
    expect(cancelled).toHaveLength(1);
    const unrelated = await service.activityFeed({
      workspaceId: WORKSPACE,
      repositoryId: secondId,
    });
    expect(unrelated.groups).not.toContainEqual(cancelled[0]);
    expect(
      (await bindings.HQ_DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("keeps unchanged permission gaps quiet and identifies changed CI without relabeling missing evidence as healthy", async () => {
    const gaps = fixture((url) =>
      url.pathname.endsWith("/secret-scanning/alerts")
        ? new Response("synthetic-private-denial", { status: 403 })
        : undefined,
    );
    await runGitHubScheduled(runtime, { now: () => now, fetch: gaps });
    const first = (await service.githubRefreshes(sourceInput))[0];
    expect(first).toMatchObject({ status: "partial" });
    expect(first.summary).toContain("1 with access or feature gaps");
    expect(first.summary).not.toContain("needing collection attention");
    expect(githubCollectionOutcome((await read(first.id)).items![0])).toBe(
      "coverage_gap",
    );
    const before = (await service.activity({ workspaceId: WORKSPACE })).filter(
      (event) => event.type === "github.refresh.completed",
    );
    now += LIMITS.DEFAULT_INTERVAL_MINUTES * LIMITS.MINUTE_MS;
    await runGitHubScheduled(runtime, { now: () => now, fetch: gaps });
    const second = (await service.githubRefreshes(sourceInput))[0];
    expect((await read(second.id)).items![0].changes).toEqual([]);
    expect(second.summary).toContain("No evidence changes");
    expect(
      (await service.activity({ workspaceId: WORKSPACE })).filter(
        (event) => event.type === "github.refresh.completed",
      ),
    ).toEqual(before);
    now += LIMITS.DEFAULT_INTERVAL_MINUTES * LIMITS.MINUTE_MS;
    await runGitHubScheduled(runtime, {
      now: () => now,
      fetch: fixture((url) => {
        if (url.pathname.endsWith("/secret-scanning/alerts"))
          return new Response("synthetic-private-denial", { status: 403 });
        if (url.pathname.endsWith("/check-runs"))
          return Response.json({
            total_count: 1,
            check_runs: [
              {
                id: 1,
                head_sha: SHA,
                status: "completed",
                conclusion: "failure",
              },
            ],
          });
      }),
    });
    const changed = (await service.githubRefreshes(sourceInput))[0];
    expect(changed.summary).toContain("ci results");
    expect(changed.summary).toContain("1 with access or feature gaps");
    expect((await read(changed.id)).items![0].changes).toEqual([
      "ci",
      "assessment",
    ]);
    expect(
      (await service.activity({ workspaceId: WORKSPACE })).filter(
        (event) => event.type === "github.refresh.completed",
      ),
    ).toHaveLength(before.length + 1);
  });

  it("reports credential rejection as collection attention and records manual unchanged refreshes", async () => {
    await service.githubRefresh(refresh());
    await run();
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("unchanged"));
    await run();
    expect((await read("unchanged")).summary).toContain("No evidence changes");
    expect(
      (await service.activity({ workspaceId: WORKSPACE })).filter(
        (event) => event.type === "github.refresh.completed",
      ),
    ).toHaveLength(2);
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("rejected"));
    await run(
      fixture(
        () =>
          new Response("synthetic-private-credential-error", { status: 401 }),
      ),
    );
    const rejected = await read("rejected");
    expect(rejected.summary).toContain("1 needing collection attention");
    expect(rejected.summary).toContain("Credential rejected");
    expect(rejected.summary).not.toContain("with access or feature gaps");
    expect(githubCollectionOutcome(rejected.items![0])).toBe("failure");
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("recovered"));
    await run();
    const recovered = await read("recovered");
    expect(recovered.summary).toContain("evidence coverage");
    expect(recovered.summary).toContain("1 fully collected");
    expect((await service.githubSourceGet(sourceInput)).lastError).toBeNull();
  });
});

describe("Bounded GitHub coverage reads", () => {
  const coverage = () =>
    service.githubCoverage({
      workspaceId: WORKSPACE,
      repositoryIds: [repositoryId, secondId],
    });

  it("reads only the selected repositories and separates queued attempts from accepted evidence", async () => {
    await service.githubRefresh(refresh());
    const queued = await coverage();
    expect(queued.repositories.map((row) => row.repository.id)).toEqual([
      repositoryId,
      secondId,
    ]);
    expect(queued.repositories[0]).toMatchObject({
      state: "awaiting",
      sources: [
        {
          latestRefresh: {
            refreshId: "refresh",
            currentRevision: true,
            status: "queued",
            attempts: 0,
          },
          evidence: null,
        },
      ],
    });
    expect(queued.repositories[1]).toMatchObject({
      state: "not_collected",
      sources: [],
    });
    await run();
    const collected = (await coverage()).repositories[0];
    expect(collected.state).toBe("current");
    expect(collected.sources[0].latestRefresh).toMatchObject({
      status: "succeeded",
      attempts: 1,
      identityMatches: true,
    });
    expect(collected.sources[0].evidence?.checks).toHaveLength(7);
    const accepted = collected.sources[0].evidence;
    now += LIMITS.MANUAL_INTERVAL_MS;
    await service.githubRefresh(refresh("next-refresh"));
    const pending = (await coverage()).repositories[0];
    expect(pending.state).toBe("current");
    expect(pending.sources[0].latestRefresh).toMatchObject({
      refreshId: "next-refresh",
      status: "queued",
      attempts: 0,
    });
    expect(pending.sources[0].evidence).toEqual(accepted);
  });

  it("does not call providers, reveal custody or grow database statements with the selected row count", async () => {
    await service.githubRefresh(refresh());
    await run(
      fixture((url) =>
        url.pathname.endsWith("/secret-scanning/alerts")
          ? new Response("private-denial", { status: 403 })
          : undefined,
      ),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider read"));
    const measured = countD1Statements(runtime.HQ_DB);
    const reader = new WorkspaceService(
      { ...runtime, HQ_DB: measured.db },
      { subject: "viewer", displayName: "Viewer" },
      false,
      () => now,
    );
    const one = await reader.githubCoverage({
      workspaceId: WORKSPACE,
      repositoryIds: [repositoryId],
    });
    const count = measured.count();
    measured.reset();
    await reader.githubCoverage({
      workspaceId: WORKSPACE,
      repositoryIds: [repositoryId, secondId],
    });
    expect(measured.count()).toBe(count);
    expect(count).toBeLessThan(20);
    expect(fetch).not.toHaveBeenCalled();
    expect(one.repositories[0].state).toBe("unavailable");
    const json = JSON.stringify(one);
    for (const privateValue of [
      TOKEN,
      OTHER_TOKEN,
      "synthetic-private-payload",
      "private-denial",
      await credentialHash(TOKEN),
    ])
      expect(json).not.toContain(privateValue);
    expect(json).not.toMatch(
      /credentialRef|credential_hash|result_json|actor_token_id/,
    );
  });

  it("marks receipts from prior source settings and repository names as historical context", async () => {
    await service.githubRefresh(refresh());
    source = await service.githubSourceUpdate({
      ...sourceInput,
      revision: source.revision,
      source: { ...fields(), repositoryIds: [repositoryId, secondId] },
    });
    const edited = await coverage();
    expect(edited.repositories[0].sources[0].latestRefresh).toMatchObject({
      currentRevision: false,
      status: "cancelled",
      attempts: 0,
    });
    expect(edited.repositories[1].sources[0].latestRefresh).toBeNull();
    await runtime.HQ_DB.prepare(
      "UPDATE repositories SET full_name='example/renamed',revision=revision+1 WHERE workspace_id=? AND id=?",
    )
      .bind(WORKSPACE, repositoryId)
      .run();
    expect(
      (await coverage()).repositories[0].sources[0].latestRefresh
        ?.identityMatches,
    ).toBe(false);
  });

  it("keeps an explicit source filter workspace-bound without inventing membership", async () => {
    const filtered = await service.githubCoverage({
      workspaceId: WORKSPACE,
      repositoryIds: [secondId],
      sourceId: source.id,
    });
    expect(filtered).toMatchObject({
      sourceId: source.id,
      repositories: [{ state: "not_collected", sources: [] }],
    });
    await expect(
      service.githubCoverage({
        workspaceId: WORKSPACE,
        repositoryIds: [repositoryId],
        sourceId: "missing",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.githubCoverage({
        workspaceId: WORKSPACE,
        repositoryIds: [repositoryId, "foreign"],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires live workspace read authority, not a publisher or reporter identity", async () => {
    const input = { workspaceId: WORKSPACE, repositoryIds: [repositoryId] };
    for (const extra of [
      { sourceId: "publisher" },
      { reporterId: "agent" },
      { scopes: [CAPABILITY.ACTIVITY] },
    ]) {
      const client = new WorkspaceService(
        runtime,
        { ...OWNER, ...extra },
        false,
        () => now,
      );
      await expect(client.githubCoverage(input)).rejects.toMatchObject({
        status: 403,
      });
    }
    const outside = new WorkspaceService(
      runtime,
      { subject: "other", displayName: "Other" },
      false,
      () => now,
    );
    await expect(outside.githubCoverage(input)).rejects.toMatchObject({
      status: 404,
    });
    await runtime.HQ_DB.prepare(
      "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('coverage-reader','alpha','owner','Reader','synthetic-hash','[\"read\"]',?,?)",
    )
      .bind(
        new Date(now).toISOString(),
        new Date(now + LIMITS.MINUTE_MS).toISOString(),
      )
      .run();
    const reader = new WorkspaceService(
      runtime,
      { ...OWNER, workspaceId: WORKSPACE, tokenId: "coverage-reader", scopes: [CAPABILITY.READ] },
      false,
      () => now,
    );
    expect((await reader.githubCoverage(input)).repositories).toHaveLength(1);
    await runtime.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='coverage-reader'",
    )
      .bind(new Date(now).toISOString())
      .run();
    await expect(reader.githubCoverage(input)).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    ["DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'", 404],
    [
      "UPDATE repositories SET full_name='example/changed',revision=revision+1 WHERE workspace_id='alpha' AND full_name='example/first'",
      409,
    ],
    [
      "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha'",
      409,
    ],
  ])(
    "revalidates live authority and identity after reading: %s",
    async (sql, status) => {
      let changed = false;
      const database = new Proxy(runtime.HQ_DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (!changed) {
                changed = true;
                await target.prepare(sql).run();
              }
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const reader = new WorkspaceService(
        { ...runtime, HQ_DB: database },
        OWNER,
        false,
        () => now,
      );
      await expect(
        reader.githubCoverage({
          workspaceId: WORKSPACE,
          repositoryIds: [repositoryId],
        }),
      ).rejects.toMatchObject({ status });
    },
  );

  it("reports malformed saved evidence without returning private data", async () => {
    await service.githubRefresh(refresh());
    await run();
    await runtime.HQ_DB.prepare(
      "UPDATE observations SET details_json=? WHERE workspace_id=?",
    )
      .bind(JSON.stringify({ github: { private: TOKEN } }), WORKSPACE)
      .run();
    await expect(coverage()).rejects.toMatchObject({
      code: "evidence_unavailable",
      status: 503,
    });
  });

  it("fails closed at source-row and response-byte bounds and recovers with an exact connection", async () => {
    const repositoryIds = Array.from(
      { length: GITHUB_COVERAGE_LIMITS.REPOSITORIES },
      (_, index) => "coverage-repository-" + index,
    );
    const sourceIds = Array.from(
      {
        length:
          Math.floor(
            GITHUB_COVERAGE_LIMITS.SOURCE_ROWS / repositoryIds.length,
          ) + 1,
      },
      (_, index) => "coverage-source-" + index,
    );
    const timestamp = new Date(now).toISOString();
    await runtime.HQ_DB.batch([
      runtime.HQ_DB.prepare(
        `INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,
          expectations_json,updated_at,write_id)
         SELECT value,?,'example/' || value,'','project','maintained','active',?,?,value FROM json_each(?)`,
      ).bind(
        WORKSPACE,
        JSON.stringify(DEFAULT_EXPECTATIONS),
        timestamp,
        JSON.stringify(repositoryIds),
      ),
      runtime.HQ_DB.prepare(
        `INSERT INTO connections (id,workspace_id,name,provider,configuration_json,credential_ref)
         SELECT value,?,value,'github',?,'personal' FROM json_each(?)`,
      ).bind(
        WORKSPACE,
        JSON.stringify({ refreshIntervalMinutes: 15 }),
        JSON.stringify(sourceIds),
      ),
      runtime.HQ_DB.prepare(
        `INSERT INTO source_repositories (workspace_id,source_id,repository_id)
         SELECT ?,s.value,r.value FROM json_each(?) s CROSS JOIN json_each(?) r`,
      ).bind(
        WORKSPACE,
        JSON.stringify(sourceIds),
        JSON.stringify(repositoryIds),
      ),
    ]);
    const input = { workspaceId: WORKSPACE, repositoryIds };
    await expect(service.githubCoverage(input)).rejects.toMatchObject({
      code: "capacity",
      status: 409,
      message: expect.stringContaining("too many GitHub connections"),
    });
    await runtime.HQ_DB.prepare(
      "DELETE FROM connections WHERE workspace_id=? AND id=?",
    )
      .bind(WORKSPACE, sourceIds.at(-1))
      .run();
    await runtime.HQ_DB.prepare(
      `INSERT INTO observations (workspace_id,source_id,resource_type,resource_id,name,health,summary,
        details_json,observed_at,received_at,expires_at)
       SELECT sr.workspace_id,sr.source_id,'repository',sr.repository_id,r.full_name,'unknown','',?,?,?,?
       FROM source_repositories sr JOIN repositories r ON r.workspace_id=sr.workspace_id AND r.id=sr.repository_id
       WHERE sr.workspace_id=? AND sr.repository_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(
        JSON.stringify({
          github: {
            checks: GITHUB_CHECK_KEYS.map((key) => ({
              key,
              state: "observed",
              summary: "Read",
              count: 0,
            })),
          },
        }),
        timestamp,
        timestamp,
        new Date(now + 600000).toISOString(),
        WORKSPACE,
        JSON.stringify(repositoryIds),
      )
      .run();
    await expect(service.githubCoverage(input)).rejects.toMatchObject({
      code: "capacity",
      status: 409,
      message: expect.stringContaining("response limit"),
    });
    const selected = await service.githubCoverage({
      ...input,
      sourceId: sourceIds[0],
    });
    expect(selected.repositories).toHaveLength(repositoryIds.length);
    expect(
      selected.repositories.every(
        (row) => row.state === "current" && row.sources.length === 1,
      ),
    ).toBe(true);
  });

  it("shares a bounded read-only contract across HTTP, CLI and MCP", async () => {
    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const input = { workspaceId: WORKSPACE, repositoryIds: [repositoryId] };
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/github_coverage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify(input),
      }),
      runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositories: [{ repository: { id: repositoryId }, state: "awaiting" }],
    });
    expect(commands.github_coverage.method).toBe("githubCoverage");
    expect(
      commandAnnotations("github_coverage", commands.github_coverage.readOnly),
    ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const config = clientConfiguration(
      "https://hq.example",
      false,
      "synthetic-reader",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) =>
      app.fetch(new Request(request, { ...init, redirect: "manual" }), runtime),
    );
    const result = await callCommand(config, "github_coverage", input);
    expect(result).toMatchObject({
      repositories: [{ repository: { id: repositoryId }, state: "awaiting" }],
    });
    const rpc = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "github_coverage", arguments: input },
        }),
      }),
      runtime,
    );
    expect(rpc.status).toBe(200);
    const body = (await rpc.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).not.toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      repositories: [{ repository: { id: repositoryId }, state: "awaiting" }],
    });
  });
});

describe("Shared GitHub application contract", () => {
  it("runs a bounded HTTP background slice behind the production bearer resolver", async () => {
    const token = "synthetic-http-operator";
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id, workspace_id, owner_subject, name, token_hash, scopes_json, created_at, expires_at) VALUES ('http-operator', 'alpha', 'operator', 'HTTP operator', ?, ?, ?, ?)",
    )
      .bind(
        await credentialHash(token),
        JSON.stringify([CAPABILITY.READ, CAPABILITY.OPERATE]),
        new Date(now).toISOString(),
        new Date(now + LIMITS.DAY_MS).toISOString(),
      )
      .run();
    const fetch = fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    const context = createExecutionContext();
    const response = await production.fetch(
      new Request("https://hq.example/api/commands/github_refresh", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(refresh()),
      }),
      runtime,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "queued",
      actor: "Operator",
    });
    expect(await read()).toMatchObject({ status: "succeeded" });
    expect(fetch).toHaveBeenCalledTimes(7);
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at = ? WHERE id = 'http-operator'",
    )
      .bind(new Date(now).toISOString())
      .run();
    const denied = await production.fetch(
      new Request("https://hq.example/api/commands/github_refresh_get", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...sourceInput, refreshId: "refresh" }),
      }),
      runtime,
    );
    expect(denied.status).toBe(401);
  });

  it("uses HTTP, CLI, and MCP controls over the same scoped jobs and schemas", async () => {
    const app = createApplication(async () => OWNER);
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/github_refresh", {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(refresh()),
      }),
      runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "queued" });
    const rpc = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "github_refresh_get",
            arguments: { ...sourceInput, refreshId: "refresh" },
          },
        }),
      }),
      runtime,
    );
    const body = (await rpc.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(body.result.isError).not.toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      status: "queued",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      app.fetch(new Request(input, { ...init, redirect: "manual" }), runtime),
    );
    const result = await callCommand(
      clientConfiguration(
        "https://hq.example",
        false,
        "synthetic-operator-token",
      ),
      "github_refresh_cancel",
      { ...sourceInput, refreshId: "refresh" },
    );
    expect(result).toMatchObject({ status: "cancelled" });
    await expect(
      service.githubRefresh({
        ...refresh("unbounded"),
        url: "https://untrusted.example",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      service.githubRefreshes({ ...sourceInput, limit: LIMITS.HISTORY + 1 }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
