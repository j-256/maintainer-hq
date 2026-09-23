import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import {
  HOOK_LIMITS,
  HOOK_POLICY_KIND,
  hookPolicySchema,
  type HookPolicy,
  type HookPolicyReceipt,
} from "../shared/hooks";
import { WorkspaceService } from "../worker/service";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";
import { D1_VOLUME_TEST_TIMEOUT_MS } from "./helpers/timeouts";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const workspace = { workspaceId: "alpha" };
const connection = { ...workspace, connectionId: "hooks" };
const resourceId = "00000000-0000-4000-8000-000000000001";
const destinationId = "00000000-0000-4000-8000-000000000002";
const authorityId = "a".repeat(32);
const token = "hkr_" + "b".repeat(43);
const PRIVATE = "private-provider-route-or-payload";
const initialPolicy: HookPolicy = {
  enabled: true,
  sinks: ["phone"],
  filter: null,
  sinkFilters: {},
};
let runtime: Env;
let policy: HookPolicy;
let revision: number;
let credentialRevision: number;
let canConfigure: boolean;
let supported: boolean;
let mode: "legacy" | "active";
let applyMode: "normal" | "before" | "after";
let applyCalls: number;
let receipts: Map<string, HookPolicyReceipt>;
let fetcher: ReturnType<
  typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>
>;
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
const as = (
  subject = "owner",
  extra: Partial<Principal> = {},
  target = runtime,
) => new WorkspaceService(target, { subject, displayName: subject, ...extra });
const error = (code: string, status = 409) =>
  Response.json({ error: { code, message: PRIVATE } }, { status });
const detail = () => ({
  authorityId,
  revision,
  mode,
  resourceId,
  name: "events",
  source: "github",
  policy,
  observedAt: time(),
});
const review = (service = as(), fields = {}) =>
  service.hooksPolicyPlan({
    ...connection,
    resourceId,
    reviewId: crypto.randomUUID(),
    connectionRevision: 1,
    authorityId,
    revision: 1,
    policy: { ...initialPolicy, enabled: false },
    ...fields,
  });
const apply = (plan: { id: string; fingerprint: string }, service = as()) =>
  service.hooksPolicyApply({
    ...workspace,
    planId: plan.id,
    fingerprint: plan.fingerprint,
  });

beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  policy = structuredClone(initialPolicy);
  revision = 1;
  credentialRevision = 1;
  canConfigure = true;
  supported = true;
  mode = "active";
  applyMode = "normal";
  applyCalls = 0;
  receipts = new Map();
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fail_policy_receipt"),
    db.prepare("DELETE FROM workspaces"),
    db
      .prepare(
        "INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha',?),('beta','Beta',?)",
      )
      .bind(time(), time()),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    db.prepare(
      "INSERT INTO projects(id,workspace_id,name,description) VALUES('project','alpha','Project','')",
    ),
    db.prepare(
      "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('hooks','alpha','Primary hooks','hookrelay','{}','primary',1,1,'setup')",
    ),
  ]);
  fetcher = vi.fn(async (url, init) => {
    expect(url).toBe("https://hookrelay.internal/admin/api/v1");
    expect(init.redirect).toBe("manual");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      authorization: "Bearer " + token,
      "content-type": "application/json",
    });
    const { command, input } = JSON.parse(init.body as string);
    expect(input.workspaceId).toBe("alpha");
    expect(input.actorId).toMatch(/^hq_[a-f0-9]{64}$/);
    if (!supported) return error("validation", 400);
    let result: unknown;
    switch (command) {
      case "configuration":
        result = {
          authorityId,
          revision,
          mode,
          canConfigure: mode === "active" && canConfigure,
          supported: { policy: true, create: false, retire: false },
          observedAt: time(),
        };
        break;
      case "configuration_subscription":
        if (mode !== "active") return error("inactive");
        result = detail();
        break;
      case "configuration_subscriptions":
      case "configuration_sinks": {
        if (mode !== "active") return error("inactive");
        if (input.revision !== revision) return error("conflict");
        result = {
          authorityId,
          revision,
          mode,
          observedAt: time(),
          nextCursor: null,
          items:
            command === "configuration_subscriptions"
              ? [{ resourceId, name: "events", source: "github", policy }]
              : [
                  {
                    resourceId: destinationId,
                    name: "phone",
                    type: "ntfy",
                    retired: false,
                  },
                ],
        };
        break;
      }
      case "configuration_policy_plan": {
        if (!canConfigure) return error("forbidden", 403);
        if (input.revision !== revision || input.authorityId !== authorityId)
          return error("conflict");
        if (mode !== "active") return error("inactive");
        if (!receipts.has(input.planId))
          receipts.set(input.planId, {
            planId: input.planId,
            authorityId,
            revision,
            resourceId,
            resourceName: "events",
            status: "ready",
            before: structuredClone(policy),
            after: input.policy,
            createdAt: time(),
            expiresAt: time(300000),
            receipt: null,
            effect: "future-ingress-policy",
          });
        result = receipts.get(input.planId);
        break;
      }
      case "configuration_policy_apply": {
        applyCalls += 1;
        if (!canConfigure) return error("forbidden", 403);
        if (applyMode === "before") throw new Error(PRIVATE);
        const receipt = receipts.get(input.planId)!;
        if (receipt.status !== "accepted") {
          if (receipt.revision !== revision) return error("conflict");
          policy = structuredClone(receipt.after);
          revision += 1;
          receipt.status = "accepted";
          receipt.receipt = {
            operationId: input.planId,
            revision,
            acceptedAt: time(),
          };
        }
        if (applyMode === "after") throw new Error(PRIVATE);
        result = receipt;
        break;
      }
      case "configuration_policy_get":
        if (!receipts.has(input.planId)) return error("not_found", 404);
        result = receipts.get(input.planId);
        break;
      default:
        throw new Error("Unexpected synthetic command");
    }
    return Response.json({
      version: 1,
      capabilities: ["read", "retry"],
      result,
    });
  });
  runtime = new Proxy(bindings, {
    get(target, key, receiver) {
      if (key === "HOOKRELAY_TEST") return { fetch: fetcher };
      if (key === "HOOKRELAY_CREDENTIALS")
        return JSON.stringify({
          primary: {
            workspaceId: "alpha",
            name: "Synthetic Hookrelay",
            binding: "HOOKRELAY_TEST",
            providerId: "provider",
            revision: credentialRevision,
            token,
          },
        });
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => vi.restoreAllMocks());

it("shares bounded reads and reviewed policy actions with CLI and MCP discovery", () => {
  for (const name of [
    "hooks_configuration",
    "hooks_policy_subscriptions",
    "hooks_policy_destinations",
    "hooks_policy_subscription",
    "hooks_policy_plan",
    "hooks_policy_apply",
    "hooks_policy_get",
    "hooks_policy_reconcile",
  ] as const) {
    expect(commands[name].schema).toBeDefined();
    expect(typeof as()[commands[name].method]).toBe("function");
    expect(
      commandAnnotations(name, commands[name].readOnly).openWorldHint,
    ).toBe(name !== "hooks_policy_get");
  }
  expect(commandAnnotations("hooks_policy_apply", false)).toMatchObject({
    destructiveHint: true,
    idempotentHint: true,
    readOnlyHint: false,
  });
});

it("reads stable, secret-free policy metadata and reports unsupported, inactive and read-only providers", async () => {
  const viewer = as("viewer");
  expect(await viewer.hooksConfiguration(connection)).toMatchObject({
    status: "supported",
    configuration: { mode: "active", canConfigure: true },
  });
  expect(
    await viewer.hooksPolicySubscription({ ...connection, resourceId }),
  ).toMatchObject({ result: { resourceId, policy: initialPolicy } });
  const page = { ...connection, authorityId, revision: 1 };
  const inventory = await viewer.hooksPolicySubscriptions(page);
  expect(inventory).toMatchObject({ result: { items: [{ resourceId }] } });
  expect(JSON.stringify(inventory)).not.toContain(PRIVATE);
  expect(await viewer.hooksPolicyDestinations(page)).toMatchObject({
    result: { items: [{ resourceId: destinationId, name: "phone" }] },
  });
  await expect(
    viewer.hooksPolicySubscriptions({ ...page, authorityId: "f".repeat(32) }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  canConfigure = false;
  expect(await viewer.hooksConfiguration(connection)).toMatchObject({
    configuration: { canConfigure: false },
  });
  mode = "legacy";
  expect(await viewer.hooksConfiguration(connection)).toMatchObject({
    configuration: { mode: "legacy" },
  });
  supported = false;
  expect(await viewer.hooksConfiguration(connection)).toEqual({
    status: "unsupported",
    configuration: null,
  });
  expect(applyCalls).toBe(0);
});

it("changes synthetic provider policy only after confirmation and does not replay duplicate applies", async () => {
  const plan = await review();
  expect(plan).toMatchObject({
    resourceId,
    actorMatches: true,
    operation: null,
    provider: {
      status: "ready",
      before: initialPolicy,
      after: { enabled: false },
    },
  });
  expect(policy.enabled).toBe(true);
  const result = await apply(plan);
  expect(result.operation?.status).toBe("succeeded");
  expect(result.provider?.receipt?.revision).toBe(2);
  expect(policy.enabled).toBe(false);
  expect((await apply(plan)).operation?.id).toBe(result.operation?.id);
  expect(applyCalls).toBe(1);
  expect(await as().hooksHistory(workspace)).toMatchObject([
    { planId: plan.id, kind: HOOK_POLICY_KIND, status: "succeeded" },
  ]);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(
    (
      await db
        .prepare(
          "SELECT generation FROM operational_coverage_epochs WHERE workspace_id='alpha' AND connection_id='hooks'",
        )
        .first()
    )?.generation,
  ).toBeGreaterThan(1);
});

it.each(["before", "after"] as const)(
  "retains %s-response loss without resending the operation",
  async (failure) => {
    const plan = await review();
    applyMode = failure;
    const uncertain = await apply(plan);
    expect(uncertain.operation?.status).toBe("indeterminate");
    expect(JSON.stringify(uncertain)).not.toContain(PRIVATE);
    expect((await apply(plan)).operation?.status).toBe("indeterminate");
    expect(applyCalls).toBe(1);
    const result = await as("operator").hooksPolicyReconcile({
      ...workspace,
      planId: plan.id,
    });
    expect(result.operation?.status).toBe(
      failure === "after" ? "succeeded" : "indeterminate",
    );
    expect(applyCalls).toBe(1);
    if (failure === "before") {
      receipts.get(plan.id)!.status = "expired";
      expect(
        (await as().hooksPolicyReconcile({ ...workspace, planId: plan.id }))
          .operation?.status,
      ).toBe("failed");
    }
  },
);

it("recovers receipts after connection disablement but refuses a replacement provider identity", async () => {
  const plan = await review();
  applyMode = "after";
  await apply(plan);
  await db
    .prepare(
      "UPDATE connections SET enabled=0,revision=revision+1 WHERE workspace_id='alpha' AND id='hooks'",
    )
    .run();
  credentialRevision += 1;
  await expect(
    as().hooksPolicyReconcile({ ...workspace, planId: plan.id }),
  ).rejects.toMatchObject({ code: "hooks_provider_changed" });
  credentialRevision -= 1;
  expect(
    (
      await as("operator").hooksPolicyReconcile({
        ...workspace,
        planId: plan.id,
      })
    ).operation?.status,
  ).toBe("succeeded");
  expect(applyCalls).toBe(1);
});

it("rejects viewers, foreign workspaces, changed actors and revoked provider authority", async () => {
  await expect(review(as("viewer"))).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(
    as("other").hooksConfiguration(connection),
  ).rejects.toMatchObject({ code: "not_found" });
  const plan = await review();
  await expect(apply(plan, as("operator"))).rejects.toMatchObject({
    code: "revision_conflict",
  });
  await expect(
    as().hooksPolicyGet({ workspaceId: "beta", planId: plan.id }),
  ).rejects.toMatchObject({ code: "not_found" });
  canConfigure = false;
  expect((await apply(plan)).operation?.status).toBe("failed");
  expect(policy).toEqual(initialPolicy);
  expect(applyCalls).toBe(1);
});

it("rechecks membership and connection revisions before submission", async () => {
  const plan = await review();
  await db
    .prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    )
    .run();
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(applyCalls).toBe(0);
  const next = await review();
  await db
    .prepare(
      "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha' AND id='hooks'",
    )
    .run();
  await expect(apply(next)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(applyCalls).toBe(0);
});

it("rejects stale policy baselines and never selects a route from its display name", async () => {
  const plan = await review();
  revision += 1;
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(applyCalls).toBe(0);
  expect(
    hookPolicySchema.safeParse({
      ...initialPolicy,
      filter: { eventTypes: { include: ["*", "github.*", "push"] } },
    }).success,
  ).toBe(true);
  for (const pattern of ["Push", "push*", "bad.", "bad key"]) {
    expect(
      hookPolicySchema.safeParse({
        ...initialPolicy,
        filter: { eventTypes: { include: [pattern] } },
      }).success,
    ).toBe(false);
  }
  await expect(review(as(), { resourceId: "events" })).rejects.toThrow();
});

it("retains exact reviews after planning response loss and rejects reused IDs with altered policy", async () => {
  const reviewId = crypto.randomUUID();
  const first = await review(as(), { reviewId });
  const second = await review(as(), { reviewId });
  expect(second).toEqual(first);
  await expect(
    review(as(), { reviewId, policy: { ...initialPolicy, sinks: [] } }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(
    fetcher.mock.calls.filter(
      ([, init]) =>
        JSON.parse(init.body as string).command === "configuration_policy_plan",
    ),
  ).toHaveLength(1);
});

it("admits only one concurrent local submission and bounds pending reviews", async () => {
  const plan = await review();
  await Promise.all([apply(plan), apply(plan)]);
  expect(applyCalls).toBe(1);
  revision = 1;
  for (let index = 0; index < HOOK_LIMITS.PENDING_REVIEWS; index += 1)
    await review();
  await expect(review()).rejects.toThrow();
}, D1_VOLUME_TEST_TIMEOUT_MS);

it("requires bounded operator automation scopes and live original credentials", async () => {
  const id = "reader";
  await db
    .prepare(
      `INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at)
    VALUES(?,'alpha','owner','Synthetic',?,?,?,?)`,
    )
    .bind(
      id,
      await credentialHash("synthetic-token"),
      JSON.stringify([CAPABILITY.READ]),
      time(),
      time(3600000),
    )
    .run();
  const reader = as("owner", {
    tokenId: id,
    workspaceId: "alpha",
    scopes: [CAPABILITY.READ],
  });
  expect(await reader.hooksConfiguration(connection)).toMatchObject({
    status: "supported",
  });
  await expect(review(reader)).rejects.toMatchObject({ code: "forbidden" });
  const scopes = [CAPABILITY.READ, CAPABILITY.OPERATE];
  await db
    .prepare("UPDATE credentials SET scopes_json=? WHERE id=?")
    .bind(JSON.stringify(scopes), id)
    .run();
  const operator = as("owner", { tokenId: id, workspaceId: "alpha", scopes });
  const plan = await review(operator);
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  await db
    .prepare("UPDATE credentials SET revoked_at=? WHERE id=?")
    .bind(time(), id)
    .run();
  await expect(apply(plan, operator)).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(applyCalls).toBe(0);
});

it.each([
  "target",
  "authority",
  "revision",
  "before",
  "after",
  "receipt",
  "private-field",
])("keeps an uncertain outcome for a malformed %s receipt", async (field) => {
  const plan = await review();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (
      JSON.parse(init.body as string).command !== "configuration_policy_apply"
    )
      return response;
    const body = (await response.json()) as {
      result: HookPolicyReceipt & { privateValue?: string };
    };
    switch (field) {
      case "target":
        body.result.resourceId = destinationId;
        break;
      case "authority":
        body.result.authorityId = "f".repeat(32);
        break;
      case "revision":
        body.result.revision += 1;
        break;
      case "before":
        body.result.before.sinks = [];
        break;
      case "after":
        body.result.after.enabled = true;
        break;
      case "receipt":
        body.result.receipt!.operationId = crypto.randomUUID();
        break;
      case "private-field":
        body.result.privateValue = PRIVATE;
        break;
    }
    return Response.json(body);
  });
  const result = await apply(plan);
  expect(result.operation?.status).toBe("indeterminate");
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(policy.enabled).toBe(false);
  fetcher.mockImplementation(original);
  expect(
    (await as().hooksPolicyReconcile({ ...workspace, planId: plan.id }))
      .operation?.status,
  ).toBe("succeeded");
  expect(applyCalls).toBe(1);
});

it("recovers provider acceptance after local receipt storage fails", async () => {
  const plan = await review();
  await db
    .prepare(
      "CREATE TRIGGER fail_policy_receipt BEFORE UPDATE ON operations WHEN NEW.kind='hookrelay.subscription.policy' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'Synthetic receipt storage failure'); END",
    )
    .run();
  const result = await apply(plan);
  expect(result.operation?.status).toBe("indeterminate");
  expect(policy.enabled).toBe(false);
  await db.prepare("DROP TRIGGER fail_policy_receipt").run();
  expect(
    (await as().hooksPolicyReconcile({ ...workspace, planId: plan.id }))
      .operation?.status,
  ).toBe("succeeded");
  expect(applyCalls).toBe(1);
});

it("fences authority revoked during the last provider read before submission", async () => {
  const plan = await review();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (
      JSON.parse(init.body as string).command === "configuration_subscription"
    )
      await db
        .prepare(
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        )
        .run();
    return response;
  });
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(applyCalls).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM operations WHERE kind=?")
      .bind(HOOK_POLICY_KIND)
      .first("count"),
  ).toBe(0);
});

it("rejects expired reviews and stale before policies before persisting an operation", async () => {
  const plan = await review();
  policy.sinks = [];
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  policy = structuredClone(initialPolicy);
  await db
    .prepare("UPDATE action_plans SET expires_at=? WHERE id=?")
    .bind(time(-1000), plan.id)
    .run();
  await expect(apply(plan)).rejects.toMatchObject({
    code: "revision_conflict",
  });
  expect(applyCalls).toBe(0);
});

it("retains original repository context through reconciliation and invalidates provider coverage", async () => {
  const repository = await as().createRepository({
    ...workspace,
    repository: {
      fullName: "example/linked",
      description: "Synthetic context",
      projectId: "project",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  await as().resourceRepositoriesSave({
    ...connection,
    kind: "hook",
    resourceKey: "events",
    revision: 0,
    connectionRevision: 1,
    repositoryIds: [repository.id],
  });
  const plan = await review();
  await db
    .prepare(
      "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES('alpha','hooks','repository',?,'Synthetic coverage','healthy','Configuration observed','{\"coverage\":{}}',?,?,?)",
    )
    .bind(repository.id, time(), time(), time(3600000))
    .run();
  applyMode = "after";
  const pending = await apply(plan);
  const requestedAt = await db
    .prepare("SELECT created_at FROM activity WHERE id=?")
    .bind(pending.operation!.id)
    .first<string>("created_at");
  const expiresAt = await db
    .prepare(
      "SELECT expires_at FROM observations WHERE workspace_id='alpha' AND source_id='hooks' AND resource_id=?",
    )
    .bind(repository.id)
    .first<string>("expires_at");
  expect(Date.parse(expiresAt!)).toBeLessThanOrEqual(Date.parse(requestedAt!));
  await as().resourceRepositoriesSave({
    ...connection,
    kind: "hook",
    resourceKey: "events",
    revision: 1,
    connectionRevision: 1,
    repositoryIds: [],
  });
  await as().hooksPolicyReconcile({ ...workspace, planId: plan.id });
  expect(
    (
      await db
        .prepare(
          "SELECT repository_id FROM activity_repository_links WHERE event_id=?",
        )
        .bind(pending.operation!.id + "_succeeded")
        .all()
    ).results,
  ).toEqual([{ repository_id: repository.id }]);
});
