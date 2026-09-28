import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  COVERAGE_LIMITS,
  coverageAssessment,
} from "../shared/coverage-evidence";
import { runHookCoverageScheduled } from "../worker/hook-coverage-runner";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
let now: number;
let runtime: Env;
let successLog: ReturnType<typeof vi.spyOn>;
let warningLog: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let fetcher: ReturnType<
  typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>
>;
const stamp = () => new Date(now).toISOString();
const run = () => runHookCoverageScheduled(runtime, () => now);
const inventory = () => ({
  items: [
    { name: "events", source: "github", enabled: true, sinks: ["phone"] },
  ],
  nextCursor: null,
  disappeared: 0,
  observedAt: stamp(),
});
const response = (result: Record<string, unknown> = inventory()) =>
  Response.json({ version: 1, capabilities: ["read"], result });
async function repositories(count: number, workspace = "alpha", start = 0) {
  for (let i = start; i < start + count; i++) {
    const id =
      (workspace === "alpha" ? "" : "beta-") +
      "repo" +
      String(i).padStart(3, "0");
    await db.batch([
      db
        .prepare(
          "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES(?,?,'example/'||?,'',?,'maintained','active','{}',?,?)",
        )
        .bind(id, workspace, id, workspace + "-project", stamp(), id),
      db
        .prepare(
          "INSERT INTO repository_resource_links(workspace_id,kind,connection_id,resource_key,repository_id) VALUES(?,'hook','hook','events',?)",
        )
        .bind(workspace, id),
    ]);
  }
}
async function coverage(workspace = "alpha", repository = "repo000") {
  const row = await db
    .prepare(
      "SELECT details_json FROM observations WHERE workspace_id=? AND source_id='hook' AND resource_id=?",
    )
    .bind(workspace, (workspace === "alpha" ? "" : "beta-") + repository)
    .first<{ details_json: string }>();
  return row ? JSON.parse(row.details_json).coverage : null;
}
beforeAll(async () => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  successLog = vi.spyOn(console, "log").mockImplementation(() => {});
  warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  await db.prepare("DELETE FROM workspaces").run();
  for (const workspace of ["alpha", "beta"]) {
    await db.batch([
      db
        .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
        .bind(workspace, workspace, stamp()),
      db
        .prepare(
          "INSERT INTO projects(id,workspace_id,name,description) VALUES(?,?,'Project','')",
        )
        .bind(workspace + "-project", workspace),
      db
        .prepare(
          "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('hook',?,'Hooks','hookrelay','{}','primary',1,1,'hook')",
        )
        .bind(workspace),
      db
        .prepare(
          "INSERT INTO repository_resource_associations(workspace_id,kind,connection_id,resource_key,revision,updated_at,write_id) VALUES(?,'hook','hook','events',1,?,'events')",
        )
        .bind(workspace, stamp()),
    ]);
  }
  fetcher = vi.fn(async () => response());
  runtime = {
    ...bindings,
    HOOKRELAY_PRIMARY: { fetch: fetcher },
    HOOKRELAY_CREDENTIALS: JSON.stringify({
      primary: {
        workspaceId: "alpha",
        name: "Synthetic",
        binding: "HOOKRELAY_PRIMARY",
        providerId: "synthetic",
        revision: 1,
        token: "hkr_" + "a".repeat(43),
      },
    }),
  } as unknown as Env;
});
afterEach(() => vi.restoreAllMocks());

it("refreshes linked repositories without a browser or operator identity and resumes a bounded page", async () => {
  await repositories(COVERAGE_LIMITS.SCHEDULE_REPOSITORIES + 2);
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await coverage()).toMatchObject({
    complete: true,
    resources: [{ state: "configured" }],
  });
  expect(await coverage("alpha", "repo025")).toBeNull();
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += COVERAGE_LIMITS.REFRESH_MS;
  await run();
  expect(await coverage("alpha", "repo026")).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  now += COVERAGE_LIMITS.HOOK_SCHEDULE_MS;
  await run();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(coverageAssessment(await coverage(), now).satisfied).toBe(true);
  now += COVERAGE_LIMITS.HOOK_FRESH_MS;
  expect(coverageAssessment(await coverage(), now).satisfied).toBe(false);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM members").first("count"),
  ).toBe(0);
  await expect(
    new WorkspaceService(runtime, {
      subject: "system:hook-coverage-collector",
      displayName: "Synthetic",
    }).repositoryCoverageGet({ workspaceId: "alpha", repositoryId: "repo000" }),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("keeps scoped credentials separate and replaces prior success with unavailable evidence on failure", async () => {
  await repositories(1);
  await repositories(1, "beta");
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await coverage("beta")).resources[0].state).toBe("unavailable");
  expect(coverageAssessment(await coverage(), now).satisfied).toBe(true);
  now += COVERAGE_LIMITS.HOOK_SCHEDULE_MS;
  fetcher.mockRejectedValue(new Error("synthetic-private-value"));
  await run();
  expect((await coverage()).resources[0].state).toBe("unavailable");
  expect(coverageAssessment(await coverage(), now).satisfied).toBe(false);
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
    "synthetic-private-value",
  );
  expect(errorLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "hq.hooks.coverage.completed",
      failed: true,
      runId: expect.any(String),
    }),
  );
});

it.each(["revision", "epoch", "disabled", "credential"])(
  "rejects in-flight evidence after %s authority changes",
  async (change) => {
    await repositories(1);
    fetcher.mockImplementation(async () => {
      if (change === "epoch")
        await db
          .prepare(
            "INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation) VALUES('alpha','hook',1) ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1",
          )
          .run();
      else if (change === "credential") runtime.HOOKRELAY_CREDENTIALS = "{}";
      else
        await db
          .prepare(
            `UPDATE connections SET ${change === "revision" ? "revision=revision+1" : "enabled=0"} WHERE workspace_id='alpha'`,
          )
          .run();
      return response();
    });
    await run();
    expect(await coverage()).toBeNull();
  },
);

it("rejects changed links and preserves newer evidence during acceptance", async () => {
  await repositories(3);
  fetcher.mockImplementation(async () => {
    await db
      .prepare(
        "DELETE FROM repository_resource_links WHERE workspace_id='alpha' AND repository_id='repo001'",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES('alpha','hook','repository','repo002','example/repo002','unknown','Newer check','{}',?,?,?)",
      )
      .bind(
        new Date(now + 1).toISOString(),
        stamp(),
        new Date(now + COVERAGE_LIMITS.HOOK_FRESH_MS).toISOString(),
      )
      .run();
    return response();
  });
  await run();
  expect(await coverage()).not.toBeNull();
  expect(await coverage("alpha", "repo001")).toBeNull();
  expect(
    await db
      .prepare("SELECT summary FROM observations WHERE resource_id='repo002'")
      .first("summary"),
  ).toBe("Newer check");
  expect(warningLog).toHaveBeenCalledWith(
    expect.objectContaining({ limited: true, stored: 1 }),
  );
});

it("allows only one concurrent inventory and recovers an abandoned lease", async () => {
  await repositories(1);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetcher.mockImplementation(async () => {
    await blocked;
    return response();
  });
  const first = run();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  release();
  await first;
  await db
    .prepare(
      "UPDATE hook_coverage_refreshes SET completed_at=NULL,next_read_at=?",
    )
    .bind(new Date(now + COVERAGE_LIMITS.LEASE_MS).toISOString())
    .run();
  await run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += COVERAGE_LIMITS.LEASE_MS;
  await run();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("continues pagination across bounded provider clock skew without extending evidence freshness", async () => {
  await repositories(1);
  fetcher.mockImplementation(async (_url, init) => {
    const { input } = JSON.parse(String(init.body));
    return response({
      ...inventory(),
      items: input.cursor ? [] : inventory().items,
      nextCursor: input.cursor ? null : "next-page",
      observedAt: new Date(now + COVERAGE_LIMITS.HOOK_CLOCK_SKEW_MS).toISOString(),
    });
  });
  await run();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const result = await coverage();
  expect(result.complete).toBe(true);
  expect(result.resources[0]).toMatchObject({
    state: "configured",
    observedAt: stamp(),
  });
  expect(result.freshUntil).toBe(
    new Date(now + COVERAGE_LIMITS.HOOK_FRESH_MS).toISOString(),
  );
  expect(successLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "hq.hooks.coverage.source",
      inventoryLimitReason: null,
      providerClockSkewMs: COVERAGE_LIMITS.HOOK_CLOCK_SKEW_MS,
    }),
  );
});

it("preserves expired page evidence when another page has tolerated clock skew", async () => {
  await repositories(1);
  const earlier = now - COVERAGE_LIMITS.HOOK_FRESH_MS;
  fetcher.mockImplementation(async (_url, init) => {
    const { input } = JSON.parse(String(init.body));
    return response({
      ...inventory(),
      items: input.cursor ? [] : inventory().items,
      nextCursor: input.cursor ? null : "next-page",
      observedAt: new Date(
        input.cursor ? earlier : now + COVERAGE_LIMITS.HOOK_CLOCK_SKEW_MS,
      ).toISOString(),
    });
  });
  await run();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const result = await coverage();
  expect(result.complete).toBe(true);
  expect(result.resources[0].observedAt).toBe(new Date(earlier).toISOString());
  expect(result.freshUntil).toBe(stamp());
  expect(coverageAssessment(result, now).satisfied).toBe(false);
});

it("does not turn bounded, inconsistent, or excessively future subscription inventory into healthy coverage", async () => {
  await repositories(1);
  fetcher.mockImplementation(async () =>
    response({ ...inventory(), nextCursor: crypto.randomUUID() }),
  );
  await run();
  expect(fetcher).toHaveBeenCalledTimes(COVERAGE_LIMITS.SUBSCRIPTION_PAGES);
  expect((await coverage()).complete).toBe(false);
  expect((await coverage()).resources[0].state).toBe("limited");
  now += COVERAGE_LIMITS.HOOK_SCHEDULE_MS;
  fetcher.mockImplementation(async () =>
    response({
      ...inventory(),
      observedAt: new Date(
        now + COVERAGE_LIMITS.HOOK_CLOCK_SKEW_MS + 1,
      ).toISOString(),
    }),
  );
  await run();
  expect((await coverage()).complete).toBe(false);
  expect(warningLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "hq.hooks.coverage.source",
      inventoryLimitReason: "future-timestamp",
    }),
  );
});
