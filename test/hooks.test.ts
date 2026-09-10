import { env, applyD1Migrations } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  afterEach,
} from "vitest";
import { CAPABILITY, type Principal } from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import {
  HOOK_DELIVERY_STATES,
  HOOK_LIMITS,
  type HookReceipt,
} from "../shared/hooks";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const connection = { ...workspace, connectionId: "hookrelay" };
const identity = { eventId: "github:synthetic", sinkName: "phone" };
const PRIVATE = "PRIVATE-PROVIDER-PAYLOAD";
const token = "hkr_" + "a".repeat(43);
const timestamp = new Date().toISOString();
const rateLimitSignal = {
  code: "ingress-rate-limited",
  severity: "warning",
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  occurrences: 1,
  resolvedAt: null,
};
const delivery = {
  ...identity,
  generation: 4,
  status: "exhausted",
  attempts: 8,
  decisionReason: null,
  updatedAt: timestamp,
  deliveredAt: null,
  receivedAt: timestamp,
  subscription: "synthetic",
  source: "github",
};
let runtime: Env;
let providerRevision = 1;
let providerEnabled = true;
let applyMode: "normal" | "before" | "after" = "normal";
let applyCalls = 0;
let fetcher: ReturnType<
  typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>
>;
let receipts: Map<string, HookReceipt>;
let snapshotSignals: unknown[];

function as(
  subject = "owner",
  extra: Partial<Principal> = {},
  target = runtime,
) {
  return new WorkspaceService(target, {
    subject,
    displayName: subject,
    ...extra,
  });
}
function interceptBatches(
  handler: (
    statements: D1PreparedStatement[],
    db: D1Database,
  ) => Promise<D1Result[]>,
) {
  const db = new Proxy(bindings.HQ_DB, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          handler(statements, target);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(runtime, {
    get(target, key, receiver) {
      return key === "HQ_DB" ? db : Reflect.get(target, key, receiver);
    },
  });
}
async function save(service = as(), revision = 0, fields = {}) {
  return service.hooksConnectionSave({
    ...connection,
    revision,
    connection: {
      name: "Primary hooks",
      enabled: true,
      providerRef: "primary",
      projectId: null,
      ...fields,
    },
  });
}
async function review(service = as(), fields = {}) {
  return service.hooksRetryPlan({
    ...connection,
    ...identity,
    connectionRevision: 1,
    reviewId: crypto.randomUUID(),
    generation: 4,
    updatedAt: timestamp,
    ...fields,
  });
}
async function issueCredential(
  scopes: string[],
  extras: { reporter?: string; source?: string } = {},
) {
  const id = "test-credential";
  await bindings.HQ_DB.prepare(
    `INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,source_id,reporter_id,created_at,expires_at)
     VALUES (?,'alpha','owner','Synthetic',?,?,?,?,?,?)`,
  )
    .bind(
      id,
      await credentialHash("synthetic-test-token"),
      JSON.stringify(scopes),
      extras.source ?? null,
      extras.reporter ?? null,
      timestamp,
      new Date(Date.now() + 3600000).toISOString(),
    )
    .run();
  return {
    tokenId: id,
    workspaceId: "alpha",
    scopes,
    reporterId: extras.reporter,
    sourceId: extras.source,
  } as Partial<Principal>;
}

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  providerRevision = 1;
  providerEnabled = true;
  applyMode = "normal";
  applyCalls = 0;
  receipts = new Map();
  snapshotSignals = [];
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(timestamp, timestamp),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (workspace_id,id,name,description) VALUES ('alpha','independent','Independent service','No repository required'),('beta','foreign','Foreign','')",
    ),
  ]);
  fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://hookrelay.internal/admin/api/v1");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer " + token);
    expect([...headers.keys()].sort()).toEqual([
      "authorization",
      "content-type",
    ]);
    const body = JSON.parse(init.body as string) as {
      command: string;
      input: Record<string, string | number>;
    };
    expect(body.input.workspaceId).toBe("alpha");
    expect(body.input.actorId).toMatch(/^hq_[a-f0-9]{64}$/);
    let result: unknown;
    switch (body.command) {
      case "snapshot":
        result = {
          observedAt: timestamp,
          deliveries: {
            totals: Object.fromEntries(
              HOOK_DELIVERY_STATES.map((state) => [
                state,
                state === "exhausted" ? 1 : 0,
              ]),
            ),
            sampled: 1,
            limit: 1000,
            truncated: false,
          },
          signals: { items: snapshotSignals, truncated: false },
          lastRetentionAt: null,
        };
        break;
      case "subscriptions":
        result = {
          items: [
            {
              name: "synthetic",
              source: "github",
              enabled: true,
              sinks: ["phone"],
            },
          ],
          nextCursor: null,
          disappeared: 0,
          observedAt: timestamp,
        };
        break;
      case "deliveries":
        result = {
          items: [delivery],
          nextCursor: null,
          scanned: 1,
          observedAt: timestamp,
          pagination: "live-updated-desc",
        };
        break;
      case "delivery":
        result = delivery;
        break;
      case "retry_plan": {
        const id = String(body.input.planId);
        if (!receipts.has(id))
          receipts.set(id, {
            planId: id,
            ...identity,
            generation: 4,
            updatedAt: timestamp,
            createdAt: timestamp,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            state: "review",
            acceptedAt: null,
            acceptedGeneration: null,
          });
        result = receipts.get(id);
        break;
      }
      case "retry_apply": {
        applyCalls += 1;
        const saved = await bindings.HQ_DB.prepare(
          "SELECT status FROM operations WHERE plan_id=?",
        )
          .bind(body.input.planId)
          .first<{ status: string }>();
        expect(saved?.status).toBe("running");
        if (applyMode === "before") throw new Error(PRIVATE);
        const receipt = receipts.get(String(body.input.planId))!;
        receipt.state = "accepted";
        receipt.acceptedAt = new Date().toISOString();
        receipt.acceptedGeneration = 5;
        if (applyMode === "after") throw new Error(PRIVATE);
        result = receipt;
        break;
      }
      case "retry_get": {
        const receipt = receipts.get(String(body.input.planId))!;
        if (
          receipt.state === "review" &&
          Date.parse(receipt.expiresAt) <= Date.now()
        )
          receipt.state = "expired";
        result = receipt;
        break;
      }
      default:
        throw new Error("Unexpected synthetic provider command");
    }
    return Response.json({
      version: 1,
      capabilities: ["read", "retry"],
      result,
    });
  });
  runtime = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "HOOKRELAY_TEST")
        return providerEnabled ? { fetch: fetcher } : undefined;
      if (property === "HOOKRELAY_CREDENTIALS")
        return JSON.stringify({
          primary: {
            workspaceId: "alpha",
            name: "Private Hookrelay",
            binding: "HOOKRELAY_TEST",
            providerId: "synthetic",
            revision: providerRevision,
            token,
          },
        });
      return Reflect.get(target, property, receiver);
    },
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Hooks connections and metadata", () => {
  it("accepts the provider's bounded ingress rate-limit signal without retrying", async () => {
    await save();
    snapshotSignals = [rateLimitSignal];
    expect(await as("viewer").hooksSnapshot(connection)).toMatchObject({
      result: { signals: { items: [rateLimitSignal] } },
    });
    expect(applyCalls).toBe(0);
  });

  it.each([
    { ...rateLimitSignal, code: "unknown-provider-signal" },
    { ...rateLimitSignal, message: PRIVATE },
  ])("rejects unsupported or private signal fields", async (signal) => {
    await save();
    snapshotSignals = [signal];
    const result = await as("viewer")
      .hooksSnapshot(connection)
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 503 });
    expect(String(result)).not.toContain(PRIVATE);
    expect(applyCalls).toBe(0);
  });

  it("projects bounded Overview attention with exact links and no raw provider fields", async () => {
    await save(as(), 0, { projectId: "independent" });
    const read = await as("viewer").attentionConnection({
      ...connection,
      revision: 1,
    });
    expect(
      fetcher.mock.calls
        .map(([, init]) => JSON.parse(String(init.body)).command)
        .sort(),
    ).toEqual(["deliveries", "snapshot"]);
    const problem = read.items.find(
      (item) => item.resourceKey === "synthetic",
    )!;
    expect(problem).toMatchObject({
      title: "Hook delivery exhausted retries",
      repositoryIds: [],
      projectIds: [],
    });
    expect(problem.href).toContain("event=github%3Asynthetic");
    expect(problem.href).toContain("sink=phone");
    expect(JSON.stringify(read)).not.toContain(PRIVATE);
    expect(JSON.stringify(read)).not.toContain(token);
    await as().resourceProjectSave({
      ...workspace,
      kind: "hook",
      connectionId: connection.connectionId,
      resourceKey: "synthetic",
      revision: 0,
      connectionRevision: 1,
      projectId: "independent",
      projectRevision: 1,
    });
    const linked = await as("viewer").attentionConnection({
      ...connection,
      revision: 1,
    });
    expect(
      linked.items.find((item) => item.resourceKey === "synthetic")?.projectIds,
    ).toEqual(["independent"]);
    await expect(
      as("other").attentionConnection({ ...connection, revision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as("owner", { reporterId: "reporter" }).attentionConnection({
        ...connection,
        revision: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not read a disabled or revision-mismatched connection and rejects changed membership after provider reads", async () => {
    await save(as(), 0, { enabled: false });
    expect(
      (await as().attentionConnection({ ...connection, revision: 1 })).items[0]
        .category,
    ).toBe("coverage");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      as().attentionConnection({ ...connection, revision: 2 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fetcher).not.toHaveBeenCalled();
    await save(as(), 1, { enabled: true });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      await bindings.HQ_DB.prepare(
        "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
      ).run();
      return response;
    });
    await expect(
      as().attentionConnection({ ...connection, revision: 2 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("starts honestly unconfigured and reveals only safe provider references to owners", async () => {
    expect(await as().hooksConnections(workspace)).toEqual([]);
    const providers = await as().hooksProviders(workspace);
    expect(providers).toEqual([
      { id: "primary", name: "Private Hookrelay", available: true },
    ]);
    expect(JSON.stringify(providers)).not.toContain(token);
    await expect(as("viewer").hooksProviders(workspace)).rejects.toMatchObject({
      status: 403,
    });
    await expect(as("other").hooksConnections(workspace)).rejects.toMatchObject(
      { status: 404 },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enrolls and edits owner metadata with revision protection without changing the provider", async () => {
    expect(await save()).toMatchObject({
      id: "hookrelay",
      revision: 1,
      available: true,
    });
    await expect(save(as("operator"), 1)).rejects.toMatchObject({
      status: 403,
    });
    await expect(save(as(), 0)).rejects.toMatchObject({ status: 409 });
    await expect(save(as(), 1, { projectId: "foreign" })).rejects.toMatchObject(
      { status: 409 },
    );
    const updated = await save(as(), 1, {
      projectId: "independent",
      name: "Renamed",
    });
    expect(updated).toMatchObject({
      revision: 2,
      projectId: "independent",
      name: "Renamed",
    });
    providerEnabled = false;
    expect(await save(as(), 2, { enabled: false })).toMatchObject({
      enabled: false,
      available: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows viewers bounded reads but not retry or cross-workspace access", async () => {
    await save();
    expect(await as("viewer").hooksSnapshot(connection)).toMatchObject({
      result: { deliveries: { sampled: 1 } },
    });
    expect(await as("viewer").hooksSubscriptions(connection)).toMatchObject({
      result: { items: [{ name: "synthetic" }] },
    });
    expect(await as("viewer").hooksDeliveries(connection)).toMatchObject({
      result: { items: [delivery] },
    });
    expect(
      await as("viewer").hooksDelivery({ ...connection, ...identity }),
    ).toMatchObject({ result: delivery });
    await expect(review(as("viewer"))).rejects.toMatchObject({ status: 403 });
    await expect(as("other").hooksSnapshot(connection)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      as("owner", { workspaceId: "beta" }).hooksSnapshot(connection),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("associates individual subscriptions with projects independently of repositories", async () => {
    await save();
    const fields = {
      ...connection,
      subscription: "synthetic",
      projectId: "independent",
      revision: 0,
    };
    expect(
      await as("viewer").hooksAssociationGet({
        ...connection,
        subscription: "synthetic",
      }),
    ).toEqual({ subscription: "synthetic", projectId: null, revision: 0 });
    const associated = await as("operator").hooksAssociationSave(fields);
    expect(associated).toMatchObject({ projectId: "independent", revision: 1 });
    await expect(
      as("operator").hooksAssociationSave(fields),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as("viewer").hooksAssociationSave({ ...fields, revision: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await as().hooksSubscriptions(connection)).toMatchObject({
      associations: [associated],
    });
    expect(
      await as("viewer").hooksAssociationGet({
        ...connection,
        subscription: "synthetic",
      }),
    ).toEqual(associated);
    await expect(
      as("other").hooksAssociationGet({
        ...connection,
        subscription: "synthetic",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      fetcher.mock.calls.every(
        ([, init]) =>
          JSON.parse(init.body as string).command === "subscriptions",
      ),
    ).toBe(true);
  });

  it("keeps unavailable or disabled providers distinct from empty healthy results", async () => {
    await save();
    providerEnabled = false;
    expect(await as().hooksConnections(workspace)).toMatchObject([
      { available: false },
    ]);
    await expect(as().hooksSnapshot(connection)).rejects.toMatchObject({
      code: "hooks_not_configured",
    });
    providerEnabled = true;
    await save(as(), 1, { enabled: false });
    await expect(as().hooksSnapshot(connection)).rejects.toMatchObject({
      code: "hooks_connection_disabled",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks live credential ownership, scopes, expiry, revocation, and reporter isolation", async () => {
    await save();
    const principal = await issueCredential([CAPABILITY.READ]);
    expect(
      await as("owner", principal).hooksSnapshot(connection),
    ).toMatchObject({ result: { deliveries: { sampled: 1 } } });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id=?",
    )
      .bind(timestamp, principal.tokenId)
      .run();
    await expect(
      as("owner", principal).hooksSnapshot(connection),
    ).rejects.toMatchObject({ status: 403 });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=NULL,expires_at='2020-01-01T00:00:00Z' WHERE id=?",
    )
      .bind(principal.tokenId)
      .run();
    await expect(
      as("owner", principal).hooksSnapshot(connection),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("owner", {
        reporterId: "reporter",
        scopes: [CAPABILITY.READ],
      }).hooksSnapshot(connection),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects role changes at the connection write boundary and read revocation during provider I/O", async () => {
    await save();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      await bindings.HQ_DB.prepare(
        "DELETE FROM members WHERE workspace_id='alpha' AND subject='viewer'",
      ).run();
      return response;
    });
    await expect(as("viewer").hooksSnapshot(connection)).rejects.toMatchObject({
      status: 404,
    });
    const target = new Proxy(runtime, {
      get(value, property, receiver) {
        if (property === "HQ_DB")
          return new Proxy(bindings.HQ_DB, {
            get(db, method) {
              if (method === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  await db
                    .prepare(
                      "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
                    )
                    .run();
                  return db.batch(statements);
                };
              const value = Reflect.get(db, method);
              return typeof value === "function" ? value.bind(db) : value;
            },
          });
        return Reflect.get(value, property, receiver);
      },
    });
    await expect(save(as("owner", {}, target), 1)).rejects.toMatchObject({
      status: 409,
    });
    expect(await as("operator").hooksConnections(workspace)).toMatchObject([
      { revision: 1 },
    ]);
  });
});

describe("Hooks operation review and reconciliation", () => {
  beforeEach(() => save());

  it("persists intent before submission, accepts once, and keeps a stable replay receipt", async () => {
    const plan = await review();
    expect(plan.provider?.state).toBe("review");
    expect(plan.operation).toBeNull();
    const accepted = await as().hooksRetryApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    expect(accepted.operation?.status).toBe("succeeded");
    expect(accepted.provider?.state).toBe("accepted");
    expect(
      await as().hooksRetryApply({
        ...workspace,
        planId: plan.id,
        fingerprint: plan.fingerprint,
      }),
    ).toEqual(accepted);
    expect(applyCalls).toBe(1);
    expect(await as("viewer").hooksHistory(workspace)).toMatchObject([
      { planId: plan.id, status: "succeeded" },
    ]);
    expect(
      JSON.stringify(
        await as("viewer").hooksRetryGet({ ...workspace, planId: plan.id }),
      ),
    ).not.toContain(token);
  });

  it("makes concurrent confirmations submit only once", async () => {
    const plan = await review();
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    await Promise.all([
      as().hooksRetryApply(input),
      as().hooksRetryApply(input),
    ]);
    expect(applyCalls).toBe(1);
    expect(
      (await as().hooksRetryGet({ ...workspace, planId: plan.id })).operation
        ?.status,
    ).toBe("succeeded");
  });

  it("rejects tampering, different actors, and stale member, connection, or provider revisions", async () => {
    const plan = await review();
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    await expect(
      as().hooksRetryApply({ ...input, fingerprint: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(as("operator").hooksRetryApply(input)).rejects.toMatchObject({
      status: 409,
    });
    providerRevision = 2;
    await expect(as().hooksRetryApply(input)).rejects.toMatchObject({
      status: 409,
    });
    providerRevision = 1;
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(as().hooksRetryApply(input)).rejects.toMatchObject({
      status: 409,
    });
    const another = await review();
    await save(as(), 1, { name: "Renamed" });
    await expect(
      as().hooksRetryApply({
        ...workspace,
        planId: another.id,
        fingerprint: another.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(applyCalls).toBe(0);
  });

  it("preserves indeterminate outcomes and reconciles the original provider receipt without resending", async () => {
    const plan = await review();
    applyMode = "after";
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    expect((await as().hooksRetryApply(input)).operation?.status).toBe(
      "indeterminate",
    );
    expect((await as().hooksRetryApply(input)).operation?.status).toBe(
      "indeterminate",
    );
    expect(applyCalls).toBe(1);
    await save(as(), 1, { enabled: false });
    const reconciled = await as("operator").hooksRetryReconcile({
      ...workspace,
      planId: plan.id,
    });
    expect(reconciled.operation?.status).toBe("succeeded");
    expect(applyCalls).toBe(1);
    expect(JSON.stringify(reconciled)).not.toContain(PRIVATE);
  });

  it("does not mistake an open provider review for a failed in-flight action", async () => {
    const plan = await review();
    applyMode = "before";
    await as().hooksRetryApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    expect(
      (await as().hooksRetryReconcile({ ...workspace, planId: plan.id }))
        .operation?.status,
    ).toBe("indeterminate");
    receipts.get(plan.id)!.expiresAt = "2020-01-01T00:00:00Z";
    expect(
      (await as().hooksRetryReconcile({ ...workspace, planId: plan.id }))
        .operation?.status,
    ).toBe("failed");
    expect(applyCalls).toBe(1);
  });

  it("refuses a replacement provider identity during reconciliation", async () => {
    const plan = await review();
    applyMode = "after";
    await as().hooksRetryApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    providerRevision = 2;
    await expect(
      as().hooksRetryReconcile({ ...workspace, planId: plan.id }),
    ).rejects.toMatchObject({ code: "hooks_provider_changed" });
    expect(
      (await as().hooksRetryGet({ ...workspace, planId: plan.id })).operation
        ?.status,
    ).toBe("indeterminate");
    expect(applyCalls).toBe(1);
  });

  it("retains stable review IDs after a lost review response and bounds pending reviews", async () => {
    const reviewId = crypto.randomUUID();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error(PRIVATE);
    });
    await expect(review(as(), { reviewId })).rejects.toMatchObject({
      status: 503,
    });
    const recovered = await review(as(), { reviewId });
    expect(recovered.id).toBe(reviewId);
    expect(recovered.provider?.planId).toBe(reviewId);
    await expect(
      review(as(), { reviewId, generation: 5 }),
    ).rejects.toMatchObject({ status: 409 });
    for (let index = 1; index < HOOK_LIMITS.PENDING_REVIEWS; index += 1)
      await review();
    const before = fetcher.mock.calls.length;
    await expect(review()).rejects.toMatchObject({ status: 409 });
    expect(fetcher.mock.calls.length).toBe(before);
    await bindings.HQ_DB.prepare(
      "UPDATE action_plans SET expires_at='2020-01-01T00:00:00Z' WHERE id=?",
    )
      .bind(reviewId)
      .run();
    await expect(
      as().hooksRetryApply({
        ...workspace,
        planId: reviewId,
        fingerprint: recovered.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await review()).provider?.state).toBe("review");
    expect(applyCalls).toBe(0);
  });

  it("pins the original automation credential and refuses live revocation", async () => {
    const principal = await issueCredential([
      CAPABILITY.READ,
      CAPABILITY.OPERATE,
    ]);
    const plan = await review(as("owner", principal));
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    expect(
      (await as().hooksRetryGet({ ...workspace, planId: plan.id }))
        .actorMatches,
    ).toBe(false);
    await expect(as().hooksRetryApply(input)).rejects.toMatchObject({
      status: 409,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id=?",
    )
      .bind(timestamp, principal.tokenId)
      .run();
    await expect(
      as("owner", principal).hooksRetryApply(input),
    ).rejects.toMatchObject({ status: 403 });
    expect(applyCalls).toBe(0);
  });

  it("sends nothing if the intent transaction fails, and reconciles a lost local acceptance write", async () => {
    const plan = await review();
    const input = {
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    };
    const noIntent = interceptBatches(async () => {
      throw new Error(PRIVATE);
    });
    await expect(
      as("owner", {}, noIntent).hooksRetryApply(input),
    ).rejects.toThrow(PRIVATE);
    expect(applyCalls).toBe(0);
    expect(
      (await as().hooksRetryGet({ ...workspace, planId: plan.id })).operation,
    ).toBeNull();
    let batches = 0;
    const lostWrite = interceptBatches(async (statements, db) => {
      batches += 1;
      if (batches === 2) throw new Error(PRIVATE);
      return db.batch(statements);
    });
    expect(
      (await as("owner", {}, lostWrite).hooksRetryApply(input)).operation
        ?.status,
    ).toBe("indeterminate");
    expect(applyCalls).toBe(1);
    expect(
      (
        await as("operator").hooksRetryReconcile({
          ...workspace,
          planId: plan.id,
        })
      ).operation?.status,
    ).toBe("succeeded");
    expect(applyCalls).toBe(1);
  });

  it("rechecks permission after durable intent and before any provider effect", async () => {
    const plan = await review();
    let batches = 0;
    const revoked = interceptBatches(async (statements, db) => {
      const result = await db.batch(statements);
      batches += 1;
      if (batches === 1)
        await db
          .prepare(
            "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
          )
          .run();
      return result;
    });
    const result = await as("owner", {}, revoked).hooksRetryApply({
      ...workspace,
      planId: plan.id,
      fingerprint: plan.fingerprint,
    });
    expect(result.operation?.status).toBe("failed");
    expect(result.operation?.summary).toContain("No provider retry was sent");
    expect(applyCalls).toBe(0);
  });
});

describe("Hooks browser, CLI, and MCP contract", () => {
  it("registers all bounded operator capabilities through the shared service", async () => {
    for (const [name, command] of Object.entries(commands).filter(([name]) =>
      name.startsWith("hooks_"),
    )) {
      expect(typeof as()[command.method]).toBe("function");
      expect(commandAnnotations(name, command.readOnly).readOnlyHint).toBe(
        command.readOnly,
      );
    }
    expect(commandAnnotations("hooks_retry_apply", false)).toMatchObject({
      idempotentHint: true,
      openWorldHint: true,
    });
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/hooks_connections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://hq.example",
        },
        body: JSON.stringify(workspace),
      }),
      runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    const rpc = (method: string, params: unknown) =>
      app.fetch(
        new Request("https://hq.example/mcp", {
          method: "POST",
          headers: {
            origin: "https://hq.example",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        runtime,
      );
    const list = (await (await rpc("tools/list", {})).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((value) => value.name)).toEqual(
      expect.arrayContaining(
        Object.keys(commands).filter((name) => name.startsWith("hooks_")),
      ),
    );
    const called = (await (
      await rpc("tools/call", {
        name: "hooks_connections",
        arguments: workspace,
      })
    ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(called.result.isError).not.toBe(true);
    expect(JSON.parse(called.result.content[0]!.text)).toEqual([]);
    await save();
    snapshotSignals = [rateLimitSignal];
    const snapshot = await app.fetch(
      new Request("https://hq.example/api/commands/hooks_snapshot", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://hq.example",
        },
        body: JSON.stringify(connection),
      }),
      runtime,
    );
    expect(snapshot.status).toBe(200);
    const expected = await snapshot.json();
    expect(expected).toMatchObject({
      result: { signals: { items: [rateLimitSignal] } },
    });
    const snapshotRpc = (await (
      await rpc("tools/call", {
        name: "hooks_snapshot",
        arguments: connection,
      })
    ).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(snapshotRpc.result.isError).not.toBe(true);
    expect(JSON.parse(snapshotRpc.result.content[0]!.text)).toEqual(expected);
    expect(applyCalls).toBe(0);
  });
});
