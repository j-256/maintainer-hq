import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  assessRepository,
  type Principal,
} from "../shared/domain";
import { COVERAGE_LIMITS } from "../shared/coverage-evidence";
import { HOOK_LIMITS } from "../shared/hooks";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { MonitoringService } from "../worker/monitoring";
import { HooksService } from "../worker/hooks";
import { MonitorProviderError } from "../worker/monitoring-client";
import { DomainError } from "../worker/errors";
import type { Env } from "../worker/types";

const runtime = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = runtime.HQ_DB;
const input = { workspaceId: "alpha", repositoryId: "repo" };
let now: number;
let checkState:
  "passed" | "failed" | "unobserved" | "configuration_changed" | "stale";
const time = (offset = 0) => new Date(now + offset).toISOString();
const metadata = () => ({
  configFingerprint: "sha256:" + "a".repeat(64),
  revision: 1,
  targetCount: 1,
  updatedAt: time(),
  updatedBy: "owner",
  updatedWorkspace: "alpha",
});
const service = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
const fields = {
  fullName: "example/repo",
  description: "",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  expectations: {
    ...DEFAULT_EXPECTATIONS,
    ci: "unmanaged",
    security: "unmanaged",
    monitoring: "required",
    hooks: "required",
  },
};
beforeAll(async () => applyD1Migrations(db, runtime.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  checkState = "passed";
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db
      .prepare(
        "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
      )
      .bind(time(), time()),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    db.prepare(
      "INSERT INTO projects(id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES('repo','alpha','example/repo','','project','maintained','active',?,?,'repo')",
      )
      .bind(JSON.stringify(fields.expectations), time()),
    ...["monitor", "hook"].map((kind) =>
      db
        .prepare(
          "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES(?,'alpha',?,?, '{}','primary',1,1,?)",
        )
        .bind(
          kind,
          kind,
          kind === "monitor" ? "endpoint-monitor" : "hookrelay",
          kind,
        ),
    ),
  ]);
  await link("monitor", "health");
  await link("hook", "events");
  vi.spyOn(MonitoringService.prototype, "snapshot").mockImplementation(
    async () => ({
      capabilities: ["read"],
      result: {
        readAt: time(),
        configuration: metadata(),
        runtimeConfigured: true,
        enabled: true,
        deliveryEnabled: true,
        analyticsEnabled: false,
        openIncidents: { count: 0, truncated: false },
        pendingDeliveries: { count: 0, truncated: false },
        execution: {
          state: "fresh",
          freshUntil: time(120_000),
          expectedIntervalSeconds: 60,
          retainedRunLimit: 120,
          lastRun: {
            scheduledAt: time(-1000),
            startedAt: time(-1000),
            completedAt: time(-500),
            enabled: true,
            configurationRevision: 1,
            configFingerprint: "sha256:" + "a".repeat(64),
            probeIntervalMinutes: 5,
            targetCount: 1,
            dueTargets: 1,
            succeededProbes: 1,
            failedProbes: 0,
            phaseErrors: 0,
            deliveriesFailed: 0,
            subrequests: 1,
          },
        },
      },
    }),
  );
  vi.spyOn(MonitoringService.prototype, "target").mockImplementation(
    async (value) => {
      const targetId = (value as { targetId: string }).targetId;
      return {
        capabilities: ["read"],
        repositoryLinks: [],
        result: {
          readAt: time(),
          configuration: metadata(),
          nextCursor: null,
          items: [
            {
              id: targetId,
              url: "https://example.com/private-target",
              method: "GET",
              failureThreshold: 2,
              recoveryThreshold: 2,
              timeoutMilliseconds: 1000,
              evidence: {
                state: "unobserved",
                observedAt: null,
                incidentId: null,
                configurationMatches: null,
                status: null,
                errorCode: null,
                check: {
                  state: checkState,
                  observedAt: time(-1000),
                  lastSuccessAt: time(-1000),
                  freshUntil: time(30_000),
                  scheduledAt: time(-1000),
                  configurationRevision: 1,
                  configurationMatches: checkState !== "configuration_changed",
                  status: 200,
                  errorCode: null,
                },
              },
            },
          ],
        },
      };
    },
  );
  vi.spyOn(HooksService.prototype, "subscriptions").mockResolvedValue({
    capabilities: ["read"],
    associations: [],
    repositoryLinks: [],
    result: {
      items: [
        {
          name: "events",
          enabled: true,
          sinks: ["private-sink"],
          source: "github",
        },
      ],
      nextCursor: null,
      disappeared: 0,
      observedAt: time(),
    },
  });
});
afterEach(() => vi.restoreAllMocks());
async function link(
  kind: "hook" | "monitor",
  resourceKey: string,
  connectionId = kind as string,
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO repository_resource_associations(workspace_id,kind,connection_id,resource_key,revision,updated_at,write_id) VALUES('alpha',?,?,?,1,?,?)",
      )
      .bind(kind, connectionId, resourceKey, time(), resourceKey),
    db
      .prepare(
        "INSERT INTO repository_resource_links(workspace_id,kind,connection_id,resource_key,repository_id) VALUES('alpha',?,?,?,'repo')",
      )
      .bind(kind, connectionId, resourceKey),
  ]);
}
async function assessment() {
  const s = service();
  return assessRepository(
    await s.repository(input),
    await s.observations({ workspaceId: input.workspaceId }),
    now,
  );
}

it("reads empty retained coverage without reserving a check, publishing evidence or contacting providers", async () => {
  const before = await service().workspaceView({
    workspaceId: "alpha",
    view: "repositories",
  });
  expect(await service("viewer").repositoryCoverageGet(input)).toMatchObject({
    phase: "ready",
    links: { hooks: 1, monitoring: 1 },
    evidence: [],
    nextReadAt: null,
  });
  expect(MonitoringService.prototype.snapshot).not.toHaveBeenCalled();
  expect(HooksService.prototype.subscriptions).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM operational_coverage_reads")
      .first("count"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM operational_coverage_budgets")
      .first("count"),
  ).toBe(0);
  expect(
    (
      await service().workspaceView({
        workspaceId: "alpha",
        view: "repositories",
      })
    ).cursor,
  ).toBe(before.cursor);
  expect(
    commandAnnotations(
      "repository_coverage_get",
      commands.repository_coverage_get.readOnly,
    ),
  ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  expect(
    commands.repository_coverage_get.schema.safeParse({
      ...input,
      refresh: true,
    }).success,
  ).toBe(false);
});

it("keeps retained evidence deadlines and read budgets unchanged after the check window expires", async () => {
  const checked = await service().repositoryCoverage(input);
  const before = await db
    .prepare("SELECT * FROM operational_coverage_reads")
    .all();
  const budget = await db
    .prepare("SELECT * FROM operational_coverage_budgets")
    .all();
  now += COVERAGE_LIMITS.LEASE_MS + COVERAGE_LIMITS.REFRESH_MS;
  const retained = await service("viewer").repositoryCoverageGet(input);
  expect(retained.evidence).toEqual(checked.evidence);
  expect(retained.generatedAt).toBe(time());
  expect(
    retained.evidence.every(
      (item) => Date.parse(item.observation.expiresAt) < now,
    ),
  ).toBe(true);
  expect(
    (await db.prepare("SELECT * FROM operational_coverage_reads").all())
      .results,
  ).toEqual(before.results);
  expect(
    (await db.prepare("SELECT * FROM operational_coverage_budgets").all())
      .results,
  ).toEqual(budget.results);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
  expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(1);
});

it("lets another viewer read an accepted result after pending without starting a second provider check", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = vi
    .mocked(MonitoringService.prototype.target)
    .getMockImplementation()!;
  vi.mocked(MonitoringService.prototype.target).mockImplementation(
    async function (this: MonitoringService, input) {
      await gate;
      return original.call(this, input);
    },
  );
  const checking = service().repositoryCoverage(input);
  await vi.waitFor(() =>
    expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1),
  );
  const waiting = await service("viewer").repositoryCoverageGet(input);
  expect(waiting.phase).toBe("pending");
  expect(waiting.evidence).toEqual([]);
  release();
  const accepted = await checking;
  const retained = await service("viewer").repositoryCoverageGet(input);
  expect(retained.phase).toBe("ready");
  expect(retained.evidence).toEqual(accepted.evidence);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
  expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(1);
});

it("retained reads respect changed links and workspace authority", async () => {
  await service().repositoryCoverage(input);
  await link("monitor", "new-health");
  const retained = await service("viewer").repositoryCoverageGet(input);
  expect(retained.phase).toBe("cooldown");
  expect(retained.links.monitoring).toBe(2);
  expect(
    retained.evidence
      .filter((item) => item.kind === "monitor")
      .every((item) => Date.parse(item.observation.expiresAt) <= Date.now()),
  ).toBe(true);
  await expect(
    service("other").repositoryCoverageGet(input),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service().repositoryCoverageGet({
      workspaceId: "beta",
      repositoryId: "repo",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  await db
    .prepare(
      "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
    )
    .run();
  await expect(
    service("viewer").repositoryCoverageGet(input),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
});

it("invalidates the provider requirement when a new connection adds previously unchecked links", async () => {
  await service().repositoryCoverage(input);
  expect((await assessment()).health).toBe("healthy");
  await db
    .prepare(
      "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('extra','alpha','Extra','endpoint-monitor','{}','primary',1,1,'extra')",
    )
    .run();
  await link("monitor", "other", "extra");
  now = Math.max(now, Date.now() + 1);
  expect((await assessment()).health).toBe("unknown");
  expect((await assessment()).reasons).toContain(
    "Monitoring coverage is unverified",
  );
  expect((await service().repositoryCoverage(input)).phase).toBe("cooldown");
  now += COVERAGE_LIMITS.REFRESH_MS;
  await service().repositoryCoverage(input);
  expect((await assessment()).reasons).not.toContain(
    "Monitoring coverage is unverified",
  );
});

it("does not carry coverage leases into a project's destination workspace or block its reviewed transfer", async () => {
  const s = service();
  const project = await s.createProject({
    workspaceId: "alpha",
    name: "Moved project",
    description: "",
    importance: "standard",
    importanceNote: "",
    portfolio: { status: "undecided", reason: "", url: null, reviewDate: null },
  });
  await db
    .prepare("UPDATE repositories SET project_id=? WHERE id='repo'")
    .bind(project.id)
    .run();
  await s.repositoryCoverage(input);
  await db
    .prepare(
      "DELETE FROM repository_resource_links WHERE workspace_id='alpha' AND repository_id='repo'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES('beta','owner','Owner','owner')",
    )
    .run();
  const review = await s.projectTransferPlan({
    workspaceId: "alpha",
    projectId: project.id,
    projectRevision: project.revision,
    destinationWorkspaceId: "beta",
    sourceBindings: [],
    reviewId: crypto.randomUUID(),
  });
  const receipt = await s.projectTransferApply({
    workspaceId: "alpha",
    reviewId: review.reviewId,
    fingerprint: review.fingerprint,
  });
  expect(receipt.status).toBe("succeeded");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM operational_coverage_reads WHERE repository_id='repo'",
      )
      .first<number>("count"),
  ).toBe(0);
  await expect(s.repositoryCoverage(input)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    await s.repositoryCoverage({ workspaceId: "beta", repositoryId: "repo" }),
  ).toMatchObject({ links: { hooks: 0, monitoring: 0 }, evidence: [] });
});

it("checks exact linked resources, retains minimized evidence and updates fleet projections without provider writes", async () => {
  const s = service("viewer");
  const view = await s.workspaceView({
    workspaceId: "alpha",
    view: "repositories",
  });
  expect((await assessment()).health).toBe("unknown");
  const result = await s.repositoryCoverage(input);
  expect(result).toMatchObject({
    phase: "ready",
    links: { monitoring: 1, hooks: 1 },
  });
  expect(result.evidence).toHaveLength(2);
  expect((await assessment()).health).toBe("healthy");
  expect(MonitoringService.prototype.target).toHaveBeenCalledWith({
    workspaceId: "alpha",
    connectionId: "monitor",
    targetId: "health",
  });
  expect(JSON.stringify(result)).not.toContain("private-target");
  expect(JSON.stringify(result)).not.toContain("private-sink");
  const changes = await s.workspaceChanges({
    workspaceId: "alpha",
    view: "repositories",
    cursor: view.cursor,
    memberRevision: view.memberRevision,
  });
  expect(changes).toMatchObject({ type: "delta" });
  expect(JSON.stringify(changes)).toContain("coverage");
  expect(commands.repository_coverage.readOnly).toBe(true);
  expect(
    commands.repository_coverage.schema.safeParse({
      ...input,
      url: "https://example.com",
    }).success,
  ).toBe(false);
});

it("rejects excessive connection fanout before starting provider calls or accepting partial success", async () => {
  for (let index = 0; index < COVERAGE_LIMITS.CONNECTIONS; index++) {
    const id = "extra-" + index;
    await db
      .prepare(
        "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES(?,'alpha',?,'endpoint-monitor','{}','primary',1,1,?)",
      )
      .bind(id, id, id)
      .run();
    await link("monitor", "target", id);
  }
  await expect(service().repositoryCoverage(input)).rejects.toMatchObject({
    code: "capacity",
    status: 409,
  });
  expect(MonitoringService.prototype.snapshot).not.toHaveBeenCalled();
  expect(HooksService.prototype.subscriptions).not.toHaveBeenCalled();
  expect(await service().observations({ workspaceId: "alpha" })).toEqual([]);
});

it("does not mistake missing links, failed checks or configuration changes for coverage", async () => {
  checkState = "configuration_changed";
  const result = await service().repositoryCoverage(input);
  expect(
    result.evidence.find((item) => item.kind === "monitor")?.observation.details
      .coverage.resources[0]?.state,
  ).toBe("changed");
  expect((await assessment()).health).toBe("unknown");
  now += COVERAGE_LIMITS.REFRESH_MS + 1;
  checkState = "failed";
  await service().repositoryCoverage(input);
  expect((await assessment()).health).toBe("warning");
  await db
    .prepare("DELETE FROM repository_resource_links WHERE workspace_id='alpha'")
    .run();
  expect((await service().repositoryCoverage(input)).links).toEqual({
    hooks: 0,
    monitoring: 0,
  });
  expect((await assessment()).health).toBe("unknown");
});

it("ages check evidence without extending provider deadlines or requiring a refresh", async () => {
  const result = await service().repositoryCoverage(input);
  const monitoring = result.evidence.find((item) => item.kind === "monitor")!;
  expect(monitoring.observation.expiresAt).toBe(time(30_000));
  now += 30_001;
  expect((await assessment()).health).toBe("unknown");
  await service().repositoryCoverage(input);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
});

it("shares a durable read lease and cooldown across concurrent viewers", async () => {
  const results = await Promise.all([
    service().repositoryCoverage(input),
    service("viewer").repositoryCoverage(input),
  ]);
  expect(results.some((result) => result.phase === "ready")).toBe(true);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
  expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(1);
  await service().repositoryCoverage(input);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
});

it("keeps an unresolved recovery incident visible even when the latest check passed", async () => {
  const target = await new MonitoringService(service()).target({
    workspaceId: "alpha",
    connectionId: "monitor",
    targetId: "health",
  });
  const item = target.result.items[0]!;
  vi.mocked(MonitoringService.prototype.target).mockResolvedValue({
    ...target,
    result: {
      ...target.result,
      items: [
        {
          ...item,
          evidence: {
            ...item.evidence,
            state: "incident",
            incidentId: "recovering",
            configurationMatches: true,
            observedAt: item.evidence.check.observedAt,
          },
        },
      ],
    },
  });
  const result = await service().repositoryCoverage(input);
  expect(
    result.evidence.find((value) => value.kind === "monitor")!.observation
      .details.coverage.resources[0]!.state,
  ).toBe("incident");
  expect((await assessment()).health).toBe("warning");
});

it.each(["disabled", "revision", "fingerprint"] as const)(
  "rejects passing coverage when the last scheduler run has mismatched %s evidence",
  async (mismatch) => {
    const snapshot = await new MonitoringService(service()).snapshot({
      workspaceId: "alpha",
      connectionId: "monitor",
    });
    const run = snapshot.result.execution.lastRun!;
    vi.mocked(MonitoringService.prototype.snapshot).mockResolvedValue({
      ...snapshot,
      result: {
        ...snapshot.result,
        execution: {
          ...snapshot.result.execution,
          lastRun: {
            ...run,
            ...(mismatch === "disabled"
              ? { enabled: false }
              : mismatch === "revision"
                ? { configurationRevision: 2 }
                : { configFingerprint: "sha256:" + "b".repeat(64) }),
          },
        },
      },
    });
    const result = await service().repositoryCoverage(input);
    expect(
      result.evidence.find((value) => value.kind === "monitor")!.observation
        .details.coverage.resources[0]!.state,
    ).toBe(mismatch === "disabled" ? "unverified" : "changed");
    expect((await assessment()).health).toBe("unknown");
  },
);

it("does not substitute a retained passing check for a fresh enabled scheduler", async () => {
  const snapshot = await new MonitoringService(service()).snapshot({
    workspaceId: "alpha",
    connectionId: "monitor",
  });
  vi.mocked(MonitoringService.prototype.snapshot).mockResolvedValue({
    ...snapshot,
    result: { ...snapshot.result, enabled: false },
  });
  await service().repositoryCoverage(input);
  expect((await assessment()).reasons).toContain(
    "Monitoring coverage is disabled",
  );
  now += COVERAGE_LIMITS.REFRESH_MS + 1;
  vi.mocked(MonitoringService.prototype.snapshot).mockResolvedValue({
    ...snapshot,
    result: {
      ...snapshot.result,
      execution: { ...snapshot.result.execution, state: "stale" },
    },
  });
  await service().repositoryCoverage(input);
  expect((await assessment()).health).toBe("unknown");
});

it("invalidates coverage and fences in-flight reads when a provider operation starts", async () => {
  const second = await service().createRepository({
    workspaceId: "alpha",
    repository: {
      ...fields,
      fullName: "example/shared",
      classification: "maintained",
      lifecycle: "active",
      expectations: {
        ...DEFAULT_EXPECTATIONS,
        ci: "unmanaged",
        security: "unmanaged",
        monitoring: "required",
        hooks: "unmanaged",
      },
    },
  });
  await db
    .prepare(
      "INSERT INTO repository_resource_links(workspace_id,kind,connection_id,resource_key,repository_id) VALUES('alpha','monitor','monitor','health',?)",
    )
    .bind(second.id)
    .run();
  await service().repositoryCoverage(input);
  await service().repositoryCoverage({ ...input, repositoryId: second.id });
  await db.batch([
    db
      .prepare(
        "INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) VALUES('provider-plan','alpha','owner','endpoint-monitor.operation',?,'fingerprint',?,?)",
      )
      .bind(
        JSON.stringify({ request: { input: { connectionId: "monitor" } } }),
        time(),
        time(60_000),
      ),
    db
      .prepare(
        "INSERT INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at) VALUES('provider-operation','alpha','provider-plan','owner','endpoint-monitor.operation','pending','Review accepted',?,?)",
      )
      .bind(time(), time()),
  ]);
  expect((await assessment()).health).toBe("unknown");
  expect(
    await db
      .prepare(
        "SELECT generation FROM operational_coverage_epochs WHERE workspace_id='alpha' AND connection_id='monitor'",
      )
      .first<number>("generation"),
  ).toBe(1);
  expect((await service().repositoryCoverage(input)).phase).toBe("cooldown");
  const shared = (
    await service().observations({ workspaceId: "alpha" })
  ).filter((item) => item.sourceId === "monitor");
  expect(shared).toHaveLength(2);
  expect(shared.every((item) => Date.parse(item.expiresAt) <= now)).toBe(true);
  now += COVERAGE_LIMITS.REFRESH_MS + 1;
  const target = vi
    .mocked(MonitoringService.prototype.target)
    .getMockImplementation()!;
  vi.mocked(MonitoringService.prototype.target).mockImplementationOnce(
    async (value) => {
      await db
        .prepare(
          "UPDATE operations SET updated_at=? WHERE id='provider-operation'",
        )
        .bind(time())
        .run();
      return target(value);
    },
  );
  await expect(service().repositoryCoverage(input)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(
    (await service().observations({ workspaceId: "alpha" })).filter(
      (item) => item.sourceId === "monitor",
    ),
  ).toEqual(shared);
});

it("invalidates linked evidence after a connection or association change", async () => {
  await service().repositoryCoverage(input);
  await db
    .prepare(
      "UPDATE connections SET enabled=0,revision=revision+1 WHERE workspace_id='alpha' AND id='monitor'",
    )
    .run();
  now = Math.max(now, Date.now() + 1);
  expect((await assessment()).health).toBe("unknown");
  expect((await service().repositoryCoverage(input)).phase).toBe("cooldown");
  now += COVERAGE_LIMITS.REFRESH_MS + 1;
  await service().repositoryCoverage(input);
  expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
  expect((await assessment()).health).toBe("unknown");
  await link("hook", "another");
  expect((await assessment()).health).toBe("unknown");
});

it("rejects membership and link changes during provider reads without accepting the result", async () => {
  vi.mocked(MonitoringService.prototype.target).mockImplementationOnce(
    async () => {
      await db
        .prepare(
          "UPDATE repository_resource_associations SET revision=revision+1 WHERE workspace_id='alpha' AND kind='monitor'",
        )
        .run();
      throw new MonitorProviderError("unavailable");
    },
  );
  await expect(service().repositoryCoverage(input)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM observations")
      .first<number>("n"),
  ).toBe(0);
  now += COVERAGE_LIMITS.LEASE_MS + 1;
  vi.mocked(MonitoringService.prototype.target).mockImplementationOnce(
    async () => {
      await db
        .prepare(
          "DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'",
        )
        .run();
      throw new DomainError("forbidden", "Revoked", 403);
    },
  );
  await expect(service().repositoryCoverage(input)).rejects.toMatchObject({
    status: 403,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM observations")
      .first<number>("n"),
  ).toBe(0);
});

it.each([4, 8])(
  "shares a complete %i-page inventory across linked subscriptions without dropping monitoring",
  async (pageCount) => {
    await link("hook", "alerts");
    await link("hook", "stars");
    const subscription = (name: string) => ({
      name,
      enabled: true,
      sinks: ["private-sink"],
      source: "github" as const,
    });
    const pages = Array.from({ length: pageCount }, (_, index) =>
      Array.from({ length: HOOK_LIMITS.PAGE_SIZE }, (_, item) =>
        subscription(`unrelated-${index}-${item}`),
      ),
    );
    pages[0]![0] = subscription("stars");
    pages[pageCount - 2]![0] = subscription("alerts");
    pages[pageCount - 1]![0] = subscription("events");
    vi.mocked(HooksService.prototype.subscriptions).mockImplementation(
      async (value) => {
        const { cursor } = value as { cursor: string | null };
        const page = cursor === null ? 0 : Number(cursor);
        return {
          capabilities: ["read"],
          associations: [],
          repositoryLinks: [],
          result: {
            items: pages[page]!,
            nextCursor: page + 1 < pageCount ? String(page + 1) : null,
            disappeared: 0,
            observedAt: time(),
          },
        };
      },
    );
    const result = await service().repositoryCoverage(input);
    const coverage = result.evidence.find((item) => item.kind === "hook")!
      .observation.details.coverage;
    expect(coverage.complete).toBe(true);
    expect(coverage.resources).toEqual(
      ["alerts", "events", "stars"].map((resourceKey) =>
        expect.objectContaining({ resourceKey, state: "configured" }),
      ),
    );
    expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(
      pageCount,
    );
    expect(MonitoringService.prototype.snapshot).toHaveBeenCalledTimes(1);
    expect(MonitoringService.prototype.target).toHaveBeenCalledTimes(1);
    expect((await assessment()).health).toBe("healthy");
    const retained = await service("viewer").repositoryCoverageGet(input);
    expect(retained.evidence).toEqual(result.evidence);
    expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(
      pageCount,
    );
  },
);

it("rejects a duplicate matching name found after the former page boundary", async () => {
  const pageCount = 4;
  vi.mocked(HooksService.prototype.subscriptions).mockImplementation(
    async (value) => {
      const { cursor } = value as { cursor: string | null };
      const page = cursor === null ? 0 : Number(cursor);
      return {
        capabilities: ["read"],
        associations: [],
        repositoryLinks: [],
        result: {
          items: [
            {
              name:
                page === 0 || page === pageCount - 1
                  ? "events"
                  : `other-${page}`,
              enabled: true,
              sinks: ["private-sink"],
              source: "github",
            },
          ],
          nextCursor: page + 1 < pageCount ? String(page + 1) : null,
          disappeared: 0,
          observedAt: time(),
        },
      };
    },
  );
  const result = await service().repositoryCoverage(input);
  expect(
    result.evidence.find((item) => item.kind === "hook")!.observation.details
      .coverage.resources[0]!.state,
  ).toBe("ambiguous");
  expect((await assessment()).health).toBe("unknown");
});

it("retains the total provider budget across multiple paginated connections", async () => {
  await db
    .prepare(
      "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES ('hook-other','alpha','Other hooks','hookrelay','{}','secondary',1,1,'hook-other')",
    )
    .run();
  await link("hook", "events", "hook-other");
  vi.mocked(HooksService.prototype.subscriptions).mockResolvedValue({
    capabilities: ["read"],
    associations: [],
    repositoryLinks: [],
    result: {
      items: [],
      nextCursor: "more",
      disappeared: 0,
      observedAt: time(),
    },
  });
  const result = await service().repositoryCoverage(input);
  const providerCalls =
    vi.mocked(HooksService.prototype.subscriptions).mock.calls.length +
    vi.mocked(MonitoringService.prototype.snapshot).mock.calls.length +
    vi.mocked(MonitoringService.prototype.target).mock.calls.length;
  expect(providerCalls).toBe(COVERAGE_LIMITS.PROVIDER_CALLS);
  expect(
    result.evidence.every(
      (item) => !item.observation.details.coverage.complete,
    ),
  ).toBe(true);
  expect((await assessment()).health).toBe("unknown");
});

it("stops pagination at the existing elapsed allowance without renewing old evidence", async () => {
  const observedAt = time();
  vi.mocked(HooksService.prototype.subscriptions).mockImplementation(
    async () => {
      now += COVERAGE_LIMITS.ELAPSED_MS;
      return {
        capabilities: ["read"],
        associations: [],
        repositoryLinks: [],
        result: { items: [], nextCursor: "more", disappeared: 0, observedAt },
      };
    },
  );
  const result = await service().repositoryCoverage(input);
  expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(1);
  const observation = result.evidence.find(
    (item) => item.kind === "hook",
  )!.observation;
  expect(observation.details.coverage.complete).toBe(false);
  expect(Date.parse(observation.expiresAt)).toBeLessThanOrEqual(now);
  expect((await assessment()).health).toBe("unknown");
});

it("keeps provider errors and disappeared or bounded-out subscriptions unverified", async () => {
  vi.mocked(MonitoringService.prototype.target).mockRejectedValueOnce(
    new MonitorProviderError("unavailable"),
  );
  vi.mocked(HooksService.prototype.subscriptions).mockResolvedValue({
    capabilities: ["read"],
    associations: [],
    repositoryLinks: [],
    result: {
      items: [],
      nextCursor: "more",
      disappeared: 0,
      observedAt: time(),
    },
  });
  const result = await service().repositoryCoverage(input);
  expect(
    result.evidence
      .flatMap((item) =>
        item.observation.details.coverage.resources.map(
          (resource) => resource.state,
        ),
      )
      .sort(),
  ).toEqual(["limited", "unavailable"]);
  expect((await assessment()).health).toBe("unknown");
  expect(HooksService.prototype.subscriptions).toHaveBeenCalledTimes(
    COVERAGE_LIMITS.SUBSCRIPTION_PAGES,
  );
});

it.each([
  { nextCursor: "more", disappeared: 0, duplicate: false, state: "limited" },
  { nextCursor: null, disappeared: 1, duplicate: false, state: "limited" },
  { nextCursor: null, disappeared: 0, duplicate: true, state: "ambiguous" },
])(
  "does not verify a matching subscription in ambiguous inventory: $state",
  async ({ nextCursor, disappeared, duplicate, state }) => {
    const subscription = {
      name: "events",
      enabled: true,
      sinks: ["private-sink"],
      source: "github" as const,
    };
    vi.mocked(HooksService.prototype.subscriptions).mockResolvedValue({
      capabilities: ["read"],
      associations: [],
      repositoryLinks: [],
      result: {
        items: duplicate
          ? [subscription, { ...subscription, enabled: false }]
          : [subscription],
        nextCursor,
        disappeared,
        observedAt: time(),
      },
    });
    const result = await service().repositoryCoverage(input);
    expect(
      result.evidence.find((item) => item.kind === "hook")?.observation.details
        .coverage.resources,
    ).toEqual([expect.objectContaining({ resourceKey: "events", state })]);
    expect((await assessment()).health).toBe("unknown");
  },
);

it("requires every linked target and keeps omitted resources incomplete", async () => {
  for (let i = 0; i < COVERAGE_LIMITS.RESOURCES; i++)
    await link("monitor", "health-" + i);
  const result = await service().repositoryCoverage(input);
  expect(
    result.evidence.find((item) => item.kind === "monitor")?.observation.details
      .coverage.complete,
  ).toBe(false);
  expect(
    vi.mocked(MonitoringService.prototype.target).mock.calls.length,
  ).toBeLessThanOrEqual(COVERAGE_LIMITS.PROVIDER_CALLS);
  expect((await assessment()).health).toBe("unknown");
});

it("enforces workspace read budgets and denies outside, reporting and publishing identities before provider access", async () => {
  await db
    .prepare(
      "INSERT INTO operational_coverage_budgets(workspace_id,window_at,used) VALUES ('alpha',?,?)",
    )
    .bind(
      new Date(
        Math.floor(now / COVERAGE_LIMITS.REFRESH_MS) *
          COVERAGE_LIMITS.REFRESH_MS,
      ).toISOString(),
      COVERAGE_LIMITS.WORKSPACE_READS,
    )
    .run();
  expect((await service().repositoryCoverage(input)).phase).toBe("cooldown");
  await expect(
    service("other").repositoryCoverage(input),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    service("owner", { reporterId: "agent" }).repositoryCoverage(input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service("owner", { sourceId: "source" }).repositoryCoverage(input),
  ).rejects.toMatchObject({ status: 403 });
  expect(MonitoringService.prototype.target).not.toHaveBeenCalled();
});
