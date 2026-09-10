import { env, applyD1Migrations } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import {
  MONITOR_DEFAULTS,
  MONITOR_LIMITS,
  type MonitorConfiguration,
  type MonitorIncident,
  type MonitorReceipt,
  type MonitorTarget,
} from "../shared/monitoring";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import { canonicalMonitorConfiguration } from "../worker/monitoring-operations";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const connection = { ...workspace, connectionId: "monitors" };
const target: MonitorTarget = {
  id: "example-health",
  url: "https://example.com/health",
  method: "GET",
  failureThreshold: 2,
  recoveryThreshold: 2,
  timeoutMilliseconds: 10000,
};
const token = "epm_" + "a".repeat(43);
const PRIVATE = "PRIVATE-MONITORING-PAYLOAD";
let now: number;
let runtime: Env;
let configuration: MonitorConfiguration;
let configurationRevision: number;
let incident: MonitorIncident;
let receipts: Map<string, MonitorReceipt>;
let candidates: Map<string, MonitorConfiguration>;
let applies: number;
let mode: "normal" | "before" | "after";
let capabilities: ("read" | "configure" | "triage")[];
let fetcher: ReturnType<
  typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>
>;
const time = () => new Date(now).toISOString();
function as(
  subject = "owner",
  extra: Partial<Principal> = {},
  custom = runtime,
) {
  return new WorkspaceService(
    custom,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
}
async function metadata() {
  return {
    configFingerprint:
      "sha256:" + (await credentialHash(JSON.stringify(configuration))),
    revision: configurationRevision,
    targetCount: configuration.targets.length,
    updatedAt: time(),
    updatedBy: "operator",
    updatedWorkspace: "alpha",
  };
}
async function save(revision = 0, fields = {}, service = as()) {
  return service.monitoringConnectionSave({
    ...connection,
    revision,
    connection: {
      name: "Primary monitoring",
      providerRef: "primary",
      enabled: true,
      projectId: null,
      ...fields,
    },
  });
}
function review(fields = {}, service = as()) {
  return service.monitoringConfigurationPlan({
    ...connection,
    reviewId: crypto.randomUUID(),
    connectionRevision: 1,
    configurationRevision,
    change: {
      kind: "target",
      action: "update",
      targetId: target.id,
      target: { ...target, url: "https://example.com/ready" },
    },
    ...fields,
  });
}
function triage(fields = {}, service = as()) {
  return service.monitoringTriagePlan({
    ...connection,
    reviewId: crypto.randomUUID(),
    connectionRevision: 1,
    incidentId: incident.id,
    incidentRevision: incident.revision,
    action: "acknowledged",
    ...fields,
  });
}

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  configurationRevision = 1;
  configuration = canonicalMonitorConfiguration({
    schemaVersion: 2,
    defaults: { ...MONITOR_DEFAULTS },
    targets: [{ ...target }],
  });
  receipts = new Map();
  candidates = new Map();
  applies = 0;
  mode = "normal";
  capabilities = ["read", "configure", "triage"];
  incident = {
    id: "incident-one",
    targetId: target.id,
    targetUrl: target.url,
    revision: 1,
    status: "open",
    acknowledgedAt: null,
    configFingerprint: (await metadata()).configFingerprint,
    errorCode: null,
    failureKind: "http",
    failureThreshold: 2,
    firstObservedAt: time(),
    firstStatus: 520,
    lastFailureAt: time(),
    latestSignal: "probe",
    latestStatus: 520,
    openedAt: time(),
    recoveryThreshold: 2,
    requestCount: null,
    resolutionReason: null,
    resolvedAt: null,
    snoozedUntil: null,
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(time(), time()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
    ...["repo-a", "repo-b"].map((id) =>
      bindings.HQ_DB.prepare(
        `INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES (?,'alpha',?,'','project','maintained','active',?,?,?)`,
      ).bind(
        id,
        "example/" + id,
        JSON.stringify(DEFAULT_EXPECTATIONS),
        time(),
        id,
      ),
    ),
  ]);
  fetcher = vi.fn(async (url, init) => {
    expect(url).toBe("https://monitoring.internal/admin/api/v1");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer " + token,
    );
    const envelope = JSON.parse(String(init.body));
    expect(envelope.version).toBe(1);
    expect(envelope.input.workspaceId).toBe("alpha");
    const { command, input } = envelope;
    let result: unknown;
    const fail = (code: string, status = 409) =>
      Response.json({ error: { code, message: PRIVATE } }, { status });
    switch (command) {
      case "snapshot":
        result = {
          readAt: time(),
          configuration: await metadata(),
          runtimeConfigured: true,
          enabled: true,
          deliveryEnabled: false,
          analyticsEnabled: false,
          openIncidents: { count: 1, truncated: false },
          pendingDeliveries: { count: 0, truncated: false },
          execution: {
            state: "unobserved",
            freshUntil: null,
            expectedIntervalSeconds: 60,
            retainedRunLimit: 120,
            lastRun: null,
          },
        };
        break;
      case "configuration":
        result = {
          readAt: time(),
          configuration: { ...(await metadata()), configuration },
        };
        break;
      case "targets":
      case "target": {
        const selected =
          command === "target"
            ? configuration.targets.filter(
                (value) => value.id === input.targetId,
              )
            : configuration.targets;
        if (command === "target" && !selected.length)
          return fail("not_found", 404);
        result = {
          readAt: time(),
          configuration: await metadata(),
          items: selected.map((value) => ({
            ...value,
            evidence: {
              state: "unobserved",
              observedAt: null,
              incidentId: null,
              configurationMatches: null,
              status: null,
              errorCode: null,
              check: {
                state: "unobserved",
                observedAt: null,
                lastSuccessAt: null,
                freshUntil: null,
                scheduledAt: null,
                configurationRevision: null,
                configurationMatches: null,
                status: null,
                errorCode: null,
              },
            },
          })),
          nextCursor: null,
        };
        break;
      }
      case "incidents":
        result = {
          readAt: time(),
          items:
            (input.targetId && input.targetId !== incident.targetId) ||
            (input.status !== "all" && input.status !== incident.status)
              ? []
              : [incident],
          nextCursor: null,
        };
        break;
      case "incident":
        result = { readAt: time(), incident, actions: [], nextCursor: null };
        break;
      case "configuration_plan":
      case "triage_plan": {
        const common = {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          credentialId: "hq-provider",
          credentialRevision: 1,
          createdAt: time(),
          expiresAt: new Date(now + 600000).toISOString(),
          appliedAt: null,
          retainUntil: new Date(now + 600000).toISOString(),
          status: "reviewed" as const,
          result: null,
        };
        let receipt: MonitorReceipt;
        if (command === "configuration_plan") {
          if (input.expectedRevision !== configurationRevision)
            return fail("conflict");
          const candidate = canonicalMonitorConfiguration(input.configuration);
          const before = new Map(
            configuration.targets.map((value) => [value.id, value]),
          );
          const after = new Map(
            candidate.targets.map((value) => [value.id, value]),
          );
          const candidateFingerprint =
            "sha256:" + (await credentialHash(JSON.stringify(candidate)));
          const unchanged =
            candidateFingerprint === (await metadata()).configFingerprint;
          receipt = {
            ...common,
            kind: "configuration",
            preview: {
              addedIds: [...after.keys()].filter((id) => !before.has(id)),
              removedIds: [...before.keys()].filter((id) => !after.has(id)),
              changedIds: [...after.keys()].filter(
                (id) =>
                  before.has(id) &&
                  JSON.stringify(before.get(id)) !==
                    JSON.stringify(after.get(id)),
              ),
              defaultsChanged:
                JSON.stringify(configuration.defaults) !==
                JSON.stringify(candidate.defaults),
              expectedFingerprint: candidateFingerprint,
              expectedRevision: configurationRevision,
              remoteFingerprint: (await metadata()).configFingerprint,
              remoteTargetCount: configuration.targets.length,
              targetCount: candidate.targets.length,
              unchanged,
              resultingRevision: configurationRevision + Number(!unchanged),
            },
          };
          candidates.set(receipt.id, candidate);
        } else {
          if (
            input.incidentId !== incident.id ||
            input.expectedRevision !== incident.revision ||
            incident.status !== "open"
          )
            return fail("conflict");
          receipt = {
            ...common,
            kind: "triage",
            preview: {
              action: input.action,
              note: input.note?.trim() ?? null,
              until: input.until ? new Date(input.until).toISOString() : null,
              incidentId: incident.id,
              targetId: incident.targetId,
              incidentRevision: incident.revision,
              configurationRevision,
              effect: "Synthetic reviewed effect",
            },
          };
        }
        receipts.set(receipt.id, receipt);
        result = receipt;
        break;
      }
      case "operation_apply": {
        applies++;
        expect(
          (
            await bindings.HQ_DB.prepare(
              "SELECT COUNT(*) AS count FROM operations WHERE status='running'",
            ).first()
          )?.count,
        ).toBe(1);
        if (mode === "before") throw new Error(PRIVATE);
        const receipt = receipts.get(input.planId)!;
        if (receipt.actorId !== input.actorId) return fail("not_found", 404);
        if (receipt.kind === "configuration") {
          if (configurationRevision !== receipt.preview.expectedRevision)
            return fail("conflict");
          configuration = candidates.get(receipt.id)!;
          configurationRevision = receipt.preview.resultingRevision;
          receipt.result = {
            ...(await metadata()),
            changed: !receipt.preview.unchanged,
          };
        } else {
          if (incident.revision !== receipt.preview.incidentRevision)
            return fail("conflict");
          incident.revision++;
          if (receipt.preview.action === "dismissed") {
            incident.status = "resolved";
            incident.resolutionReason = "operator-dismissed";
            incident.resolvedAt = time();
          }
          receipt.result = {
            actionId: crypto.randomUUID(),
            incidentId: incident.id,
            action: receipt.preview.action,
            createdAt: time(),
          };
        }
        receipt.status = "applied";
        receipt.appliedAt = time();
        if (mode === "after") throw new Error(PRIVATE);
        result = receipt;
        break;
      }
      case "operation_get": {
        const receipt = receipts.get(input.planId)!;
        if (
          receipt.status !== "applied" &&
          Date.parse(receipt.expiresAt) <= now
        )
          receipt.status = "expired";
        result = receipt;
        break;
      }
      default:
        throw new Error("Unexpected provider command");
    }
    return Response.json({ version: 1, capabilities, result });
  });
  const credential = JSON.stringify({
    primary: {
      workspaceId: "alpha",
      name: "Synthetic monitoring",
      binding: "MONITORING_PRIMARY",
      providerId: "hq-provider",
      revision: 1,
      token,
    },
  });
  runtime = new Proxy(bindings, {
    get(target, key) {
      if (key === "MONITORING_CREDENTIALS") return credential;
      if (key === "MONITORING_PRIMARY") return { fetch: fetcher };
      return Reflect.get(target, key);
    },
  });
});
afterEach(() => vi.useRealTimers());

describe("Monitoring enrollment, reads, and private transport", () => {
  it("evaluates a run that completes during the provider read using the post-read clock", async () => {
    await save();
    const original = fetcher.getMockImplementation()!;
    let advanced = false;
    fetcher.mockImplementation(async (url, init) => {
      if (!advanced) {
        now += 1000;
        advanced = true;
      }
      const response = await original(url, init);
      if (JSON.parse(String(init.body)).command !== "snapshot") return response;
      const body = (await response.json()) as {
        result: Record<string, unknown>;
      };
      body.result.execution = {
        state: "fresh",
        freshUntil: new Date(now + 60_000).toISOString(),
        expectedIntervalSeconds: 60,
        retainedRunLimit: 120,
        lastRun: {
          scheduledAt: time(),
          startedAt: time(),
          completedAt: time(),
          enabled: true,
          configurationRevision,
          configFingerprint: (await metadata()).configFingerprint,
          probeIntervalMinutes: 1,
          targetCount: 1,
          dueTargets: 1,
          succeededProbes: 1,
          failedProbes: 0,
          phaseErrors: 0,
          deliveriesFailed: 0,
          subrequests: 1,
        },
      };
      return Response.json(body);
    });
    const result = await as("viewer").attentionConnection({
      ...connection,
      revision: 1,
    });
    expect(result.readAt).toBe(time());
    expect(result.items.some((item) => item.id.endsWith(":scheduler"))).toBe(
      false,
    );
  });

  it("rejects an incident outside the exact open selection", async () => {
    await save();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (JSON.parse(String(init.body)).command !== "incidents")
        return response;
      const body = (await response.json()) as {
        result: { items: MonitorIncident[] };
      };
      body.result.items[0].status = "resolved";
      return Response.json(body);
    });
    await expect(
      as("viewer").attentionConnection({ ...connection, revision: 1 }),
    ).rejects.toMatchObject({
      code: "monitoring_response_invalid",
      status: 503,
    });
  });

  it("reads a safe bounded attention preview without leaking target URLs or pretending missing scheduler evidence is healthy", async () => {
    await save();
    expect(
      (await as("viewer").connections(workspace)).find(
        (source) => source.id === connection.connectionId,
      )?.credentialConfigured,
    ).toBe(true);
    const read = await as("viewer").attentionConnection({
      ...connection,
      revision: 1,
    });
    expect(
      fetcher.mock.calls
        .map(([, init]) => JSON.parse(String(init.body)).command)
        .sort(),
    ).toEqual(["incidents", "snapshot", "targets"]);
    expect(read.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "problem",
          title: "Open monitoring incident",
          resourceKey: target.id,
        }),
        expect.objectContaining({
          category: "coverage",
          title: "Monitoring scheduler has not been observed",
        }),
        expect.objectContaining({
          category: "coverage",
          title: "Monitoring check unobserved",
        }),
      ]),
    );
    expect(
      read.items.find((item) => item.title === "Open monitoring incident")
        ?.href,
    ).toContain("incident=" + incident.id);
    expect(JSON.stringify(read)).not.toContain(target.url);
    expect(JSON.stringify(read)).not.toContain(PRIVATE);
    expect(JSON.stringify(read)).not.toContain(token);
    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/attention_connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify({ ...connection, revision: 1 }),
      }),
      runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connectionId: "monitors",
      revision: 1,
    });
  });

  it("enrolls revision-checked workspace metadata without contacting targets and exposes explicit evidence", async () => {
    await save();
    expect(fetcher).not.toHaveBeenCalled();
    await as().resourceRepositoriesSave({
      ...connection,
      kind: "monitor",
      resourceKey: target.id,
      revision: 0,
      connectionRevision: 1,
      repositoryIds: ["repo-a", "repo-b"],
    });
    expect(await as("viewer").monitoringTargets(connection)).toMatchObject({
      result: {
        items: [
          {
            id: target.id,
            evidence: { state: "unobserved", observedAt: null },
          },
        ],
      },
      repositoryLinks: [{ repositoryIds: ["repo-a", "repo-b"] }],
    });
    expect(await as("viewer").monitoringSnapshot(connection)).toMatchObject({
      result: { execution: { state: "unobserved" }, deliveryEnabled: false },
    });
    expect(
      await as().monitoringTarget({ ...connection, targetId: target.id }),
    ).toMatchObject({ result: { items: [{ id: target.id }] } });
    expect(
      await as().monitoringIncidents({ ...connection, targetId: target.id }),
    ).toMatchObject({ result: { items: [{ id: incident.id }] } });
    expect(
      await as().monitoringIncident({ ...connection, incidentId: incident.id }),
    ).toMatchObject({ result: { incident: { revision: 1 } } });
    await expect(save(0)).rejects.toMatchObject({ status: 409 });
    await save(1, { enabled: false });
    await expect(as().monitoringTargets(connection)).rejects.toMatchObject({
      status: 409,
    });
    expect(configurationRevision).toBe(1);
  });
  it("enforces live roles, workspace isolation, provider allowlists, and forbidden source credentials", async () => {
    await expect(save(0, {}, as("operator"))).rejects.toMatchObject({
      status: 403,
    });
    await expect(save(0, { providerRef: "missing" })).rejects.toMatchObject({
      status: 503,
    });
    await save();
    await expect(
      as("outside").monitoringTargets(connection),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as("viewer").monitoringProviders(workspace),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("owner", { sourceId: "publisher" }).monitoringTargets(connection),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("owner", { reporterId: "reporter" }).monitoringTargets(connection),
    ).rejects.toMatchObject({ status: 403 });
    await expect(review({}, as("viewer"))).rejects.toMatchObject({
      status: 403,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await as().monitoringProviders(workspace)),
    ).not.toContain(token);
    capabilities = ["read"];
    await expect(review()).rejects.toMatchObject({
      code: "monitoring_provider_forbidden",
    });
    expect(receipts.size).toBe(0);
  });
  it("fails closed on unsafe, oversized, wrong-version, and unexpected provider responses", async () => {
    await save();
    for (const response of [
      new Response(PRIVATE),
      Response.json({ version: 2, capabilities: ["read"], result: {} }),
      Response.json({
        version: 1,
        capabilities: ["read"],
        result: { private: PRIVATE },
      }),
      Response.json(
        { error: { code: "internal-private", message: PRIVATE } },
        { status: 500 },
      ),
      Response.json({ data: "x".repeat(MONITOR_LIMITS.RESPONSE_BYTES) }),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(as().monitoringSnapshot(connection)).rejects.toMatchObject({
        status: 503,
      });
    }
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    fetcher.mockRejectedValueOnce(new Error(PRIVATE));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/monitoring_snapshot", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://hq.example",
        },
        body: JSON.stringify(connection),
      }),
      runtime,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(PRIVATE);
    fetcher.mockClear();
    await expect(
      review({
        change: {
          kind: "target",
          action: "update",
          targetId: target.id,
          target: { ...target, url: "http://127.0.0.1/private" },
        },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("detects live access and connection changes after provider reads", async () => {
    await save();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (url, init) => {
      const result = await original(url, init);
      await bindings.HQ_DB.prepare(
        "UPDATE connections SET revision=revision+1 WHERE id='monitors'",
      ).run();
      return result;
    });
    await expect(as().monitoringTargets(connection)).rejects.toMatchObject({
      status: 409,
    });
    fetcher.mockImplementationOnce(async (url, init) => {
      const result = await original(url, init);
      await bindings.HQ_DB.prepare(
        "DELETE FROM members WHERE subject='owner'",
      ).run();
      return result;
    });
    await expect(as().monitoringSnapshot(connection)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("Monitoring reviewed actions and durable reconciliation", () => {
  beforeEach(() => save());
  it("reviews exact target edits without effects, persists intent, and applies only once across confirmations", async () => {
    const plan = await review();
    expect(plan.provider).toMatchObject({
      kind: "configuration",
      status: "reviewed",
      preview: { changedIds: [target.id] },
    });
    expect(plan.before).toMatchObject({ url: target.url });
    expect(configuration.targets[0]?.url).toBe(target.url);
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    await Promise.all([
      as().monitoringApply(input),
      as().monitoringApply(input),
    ]);
    const result = await as("viewer").monitoringReview({
      ...workspace,
      planId: plan.id,
    });
    expect(result.operation?.status).toBe("succeeded");
    expect(configuration.targets[0]?.url).toBe("https://example.com/ready");
    expect(applies).toBe(1);
    expect(await as().monitoringApply(input)).toEqual(
      await as().monitoringReview({ ...workspace, planId: plan.id }),
    );
    expect(applies).toBe(1);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("supports creation, removal, and defaults through the same authority while retaining other targets", async () => {
    const create = await review({
      change: {
        kind: "target",
        action: "create",
        targetId: "another",
        target: { ...target, id: "another", url: "https://example.org/health" },
      },
    });
    await as().monitoringApply({
      ...workspace,
      planId: create.id,
      fingerprint: create.fingerprint,
    });
    expect(configuration.targets).toHaveLength(2);
    const defaults = await review({
      change: {
        kind: "defaults",
        defaults: { ...MONITOR_DEFAULTS, probeIntervalMinutes: 10 },
      },
    });
    await as().monitoringApply({
      ...workspace,
      planId: defaults.id,
      fingerprint: defaults.fingerprint,
    });
    expect(configuration.defaults.probeIntervalMinutes).toBe(10);
    expect(configuration.targets).toHaveLength(2);
    const remove = await review({
      change: {
        kind: "target",
        action: "remove",
        targetId: "another",
        target: null,
      },
    });
    await as().monitoringApply({
      ...workspace,
      planId: remove.id,
      fingerprint: remove.fingerprint,
    });
    expect(configuration.targets.map((value) => value.id)).toEqual([target.id]);
  });
  it("keeps stale forms, mismatched actors, and changed authorization from sending effects", async () => {
    await expect(review({ configurationRevision: 0 })).rejects.toMatchObject({
      status: 409,
    });
    const plan = await review();
    await expect(
      as("operator").monitoringApply({
        ...workspace,
        planId: plan.id,
        fingerprint: plan.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as().monitoringApply({
        ...workspace,
        planId: plan.id,
        fingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE subject='owner'",
    ).run();
    await expect(
      as().monitoringApply({
        ...workspace,
        planId: plan.id,
        fingerprint: plan.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(applies).toBe(0);
    expect((await as().monitoringHistory(workspace)).length).toBe(0);
  });
  it("keeps accepted-but-lost responses indeterminate until an original receipt is reconciled", async () => {
    const plan = await triage({
      action: "dismissed",
      note: "Reviewed endpoint ownership",
    });
    await as().resourceRepositoriesSave({
      ...connection,
      kind: "monitor",
      resourceKey: target.id,
      revision: 0,
      connectionRevision: 1,
      repositoryIds: ["repo-a"],
    });
    mode = "after";
    const accepted = await as().monitoringApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    expect(accepted.operation?.status).toBe("indeterminate");
    expect(incident.status).toBe("resolved");
    await as().resourceRepositoriesSave({
      ...connection,
      kind: "monitor",
      resourceKey: target.id,
      revision: 1,
      connectionRevision: 1,
      repositoryIds: ["repo-b"],
    });
    await save(1, { enabled: false });
    const recovered = await as("operator").monitoringReconcile({
      ...workspace,
      planId: plan.id,
    });
    expect(recovered.operation?.status).toBe("succeeded");
    expect(applies).toBe(1);
    const original = await as().activityFeed({
      ...workspace,
      repositoryId: "repo-a",
    });
    const moved = await as().activityFeed({
      ...workspace,
      repositoryId: "repo-b",
    });
    expect(original.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "monitoring.operation.succeeded",
          }),
        }),
      ]),
    );
    expect(moved.groups).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "monitoring.operation.succeeded",
          }),
        }),
      ]),
    );
    const audit = JSON.stringify(
      await bindings.HQ_DB.prepare("SELECT summary FROM activity").all(),
    );
    expect(audit).not.toContain(target.url);
    expect(audit).not.toContain("Reviewed endpoint ownership");
  });
  it("does not resend uncertain work and treats only expired unaccepted receipts as a failed outcome", async () => {
    const plan = await review();
    mode = "before";
    expect(
      (
        await as().monitoringApply({
          ...workspace,
          planId: plan.id,
          fingerprint: plan.fingerprint,
        })
      ).operation?.status,
    ).toBe("indeterminate");
    expect(
      (await as().monitoringReconcile({ ...workspace, planId: plan.id }))
        .operation?.status,
    ).toBe("indeterminate");
    now += 11 * 60 * 1000;
    expect(
      (await as().monitoringReconcile({ ...workspace, planId: plan.id }))
        .operation?.status,
    ).toBe("failed");
    expect(applies).toBe(1);
    expect(configurationRevision).toBe(1);
  });
  it("requires the original recovery identity and rejects a forged provider receipt", async () => {
    const plan = await review();
    mode = "after";
    await as().monitoringApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    const changed = new Proxy(runtime, {
      get(target, key) {
        return key === "MONITORING_CREDENTIALS"
          ? String(Reflect.get(target, key)).replace(
              '"revision":1',
              '"revision":2',
            )
          : Reflect.get(target, key);
      },
    });
    await expect(
      as("owner", {}, changed).monitoringReconcile({
        ...workspace,
        planId: plan.id,
      }),
    ).rejects.toMatchObject({ code: "monitoring_provider_changed" });
    receipts.get(plan.provider!.id)!.actorId = "another-actor";
    await expect(
      as().monitoringReconcile({ ...workspace, planId: plan.id }),
    ).rejects.toMatchObject({ code: "monitoring_provider_metadata_invalid" });
    expect(
      (await as().monitoringReview({ ...workspace, planId: plan.id })).operation
        ?.status,
    ).toBe("indeterminate");
  });
  it("reuses a completed review id only for its exact original request", async () => {
    const reviewId = crypto.randomUUID();
    const plan = await review({ reviewId });
    expect(await review({ reviewId })).toEqual(plan);
    expect(receipts.size).toBe(1);
    await expect(
      review({
        reviewId,
        change: {
          kind: "target",
          action: "remove",
          targetId: target.id,
          target: null,
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(receipts.size).toBe(1);
  });
});

it("keeps all monitoring controls in the shared CLI and MCP contract", () => {
  for (const [name, command] of Object.entries(commands).filter(([name]) =>
    name.startsWith("monitoring_"),
  )) {
    expect(
      typeof (as() as unknown as Record<string, unknown>)[command.method],
    ).toBe("function");
    expect(commandAnnotations(name, command.readOnly).readOnlyHint).toBe(
      command.readOnly,
    );
  }
  expect(commandAnnotations("monitoring_apply", false)).toMatchObject({
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
  expect(
    commandAnnotations("monitoring_configuration_plan", false).idempotentHint,
  ).toBe(false);
});
