import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { commands } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import type { Env } from "../worker/types";
const bindings = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.HQ_DB;
const resourceId = "00000000-0000-4000-8000-000000000001";
const authorityId = "a".repeat(32);
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
let runtime: Env;
let writes: number;
let privateWrites: number;
let lost: boolean;
let privateLost: boolean;
let deny: boolean;
let partial: boolean;
let privateRejection: boolean;
let privateCorrelation: boolean;
let rejectionStatus: number;
let applyRejectionStatus: number | null;
let applyRejectionCode: string;
let observedEvents: number;
let receipts: Map<string, Record<string, unknown>>;
const service = (subject = "owner") => new WorkspaceService(runtime, { subject, displayName: subject });
async function invoke(name: string, input: unknown, subject = "owner"): Promise<any> {
  const command = (commands as Record<string, { method: keyof WorkspaceService }>)[name];
  expect(command, "Lifecycle command must exist").toBeDefined();
  return (service(subject)[command!.method] as (input: unknown) => Promise<unknown>)(input);
}
const plan = (kind = "destination-retire", extra = {}) => invoke("hooks_lifecycle_plan", { workspaceId: "alpha", connectionId: "hooks", connectionRevision: 1, planId: crypto.randomUUID(), authorityId, revision: 1, change: { kind, resourceId, ...extra } });
beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  writes = 0; privateWrites = 0; lost = false; privateLost = false; deny = false; partial = false; privateRejection = false; privateCorrelation = true; rejectionStatus = 400; applyRejectionStatus = null; applyRejectionCode = "validation"; observedEvents = 0; receipts = new Map();
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha',?),('beta','Beta',?)").bind(time(), time()),
    db.prepare("INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')"),
    db.prepare("INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('hooks','alpha','Synthetic provider','hookrelay','{}','primary',1,1,'setup')"),
  ]);
  const fetcher = { fetch: async (url: string, init: RequestInit) => {
    if (deny) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    if (url.includes("/lifecycle-input/")) {
      privateWrites++;
      if (privateRejection) return Response.json({ error: { code: "validation", message: "Private destination input is invalid" }, ...(privateCorrelation ? { correlationId: crypto.randomUUID() } : {}) }, { status: rejectionStatus, headers: { "cache-control": "no-store" } });
      const id = url.split("/").at(-1)!;
      const receipt = receipts.get(id)!;
      expect(new Headers(init.headers).get("if-match")).toBe(receipt.fingerprint);
      expect(init.redirect).toBe("manual");
      receipt.privateInputReceived = true;
      if (privateLost) throw new Error("synthetic-private-sentinel");
      return Response.json({ planId: id, state: "ready", privateInputReceived: true, submitted: true }, { headers: { "cache-control": "no-store" } });
    }
    const { command, input } = JSON.parse(String(init.body));
    let result: unknown;
    if (command === "lifecycle_configuration") result = { authorityId, revision: 1, mode: "active", canProvision: true, canConfigure: true, canSupplyPrivate: true, canManageHooks: true, reason: "ready", observedAt: time() };
    else if (command === "lifecycle_plan") {
      if (!receipts.has(input.planId)) receipts.set(input.planId, { id: input.planId, authorityId, revision: input.revision, fingerprint: "d".repeat(64), state: "ready", change: input.change, before: { resourceId, name: "Synthetic destination", type: "ntfy", retired: false, ...(observedEvents ? { events: Array.from({ length: observedEvents }, (_, index) => "observed_event_" + index) } : {}) }, after: { resourceId, name: "Synthetic destination", type: "ntfy", retired: true }, affectedSubscriptions: [], privateInputRequired: input.change.kind === "destination-update", privateInputReceived: false, expiresAt: time(300000), outcome: null, observedAt: time() });
      result = receipts.get(input.planId);
    } else if (command === "lifecycle_get") result = receipts.get(input.planId);
    else if (command === "lifecycle_apply") {
      writes++;
      expect((await db.prepare("SELECT status FROM operations WHERE plan_id=?").bind(input.planId).first())?.status).toBe("pending");
      if (applyRejectionStatus) return Response.json({ error: { code: applyRejectionCode, message: "Synthetic provider refusal" } }, { status: applyRejectionStatus, headers: { "cache-control": "no-store" } });
      const receipt = receipts.get(input.planId)!;
      receipt.state = partial ? "failed" : "applied"; receipt.outcome = { configuration: "applied", upstream: partial ? "failed" : "not_requested" };
      if (lost) throw new Error("synthetic-private-sentinel");
      result = receipt;
    } else throw new Error("Unexpected synthetic command " + command);
    return Response.json({ version: 1, capabilities: ["read"], result });
  } };
  runtime = new Proxy(bindings, { get(target, key, receiver) {
    if (key === "HOOKRELAY_TEST") return fetcher;
    if (key === "HOOKRELAY_CREDENTIALS") return JSON.stringify({ primary: { workspaceId: "alpha", name: "Synthetic", binding: "HOOKRELAY_TEST", providerId: "provider", revision: 1, token: "hkr_" + "b".repeat(43) } });
    return Reflect.get(target, key, receiver);
  } });
});
it("exposes strict metadata-only lifecycle schemas", () => {
  for (const action of ["configuration", "plan", "get", "apply", "reconcile"]) {
    const entry = (commands as Record<string, any>)["hooks_lifecycle_" + action];
    expect(entry).toBeDefined();
    expect(() => JSON.stringify(entry.schema.toJSONSchema())).not.toThrow();
  }
  expect(Object.hasOwn(commands, "hooks_lifecycle_input")).toBe(false);
});
it("persists intent before effects and returns one operation for concurrent duplicate applies", async () => {
  const review = await plan();
  const selected = { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint };
  await Promise.all([invoke("hooks_lifecycle_apply", selected), invoke("hooks_lifecycle_apply", selected)]);
  expect(writes).toBe(1);
  const result = await invoke("hooks_lifecycle_apply", selected);
  expect(result).toMatchObject({ state: "applied", operation: { status: "succeeded" } });
  expect(JSON.stringify(result)).not.toContain("synthetic-private");
});
it("permits operators and safe viewers while fencing membership, connection and workspace", async () => {
  const review = await plan();
  await expect(invoke("hooks_lifecycle_get", { workspaceId: "beta", planId: review.id }, "other")).rejects.toMatchObject({ status: 404 });
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id }, "viewer")).toMatchObject({ actorMatches: false });
  await expect(invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint }, "viewer")).rejects.toMatchObject({ status: 403 });
  await db.prepare("UPDATE connections SET revision=revision+1 WHERE id='hooks'").run();
  await expect(invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint })).rejects.toMatchObject({ status: 409 });
});
it("reconciles lost acknowledgements through retained receipts without replay", async () => {
  const review = await plan(); lost = true;
  expect(await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint })).toMatchObject({ operation: { status: "indeterminate" } });
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ state: "applied", operation: { status: "succeeded" } });
  expect(writes).toBe(1);
});
it("authorizes private input before reading and binds actor, fingerprint, workspace and expiry", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  let actor = "owner";
  const app = createApplication(async () => ({ subject: actor, displayName: actor }));
  const request = (fingerprint = review.fingerprint, workspace = "alpha", origin = "https://hq.example") => new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: origin, "content-type": "application/json", "x-workspace-id": workspace, "if-match": fingerprint }, body: JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }) });
  actor = "operator";
  expect((await app.fetch(request(), runtime)).status).toBe(409);
  actor = "owner";
  expect((await app.fetch(request("e".repeat(64)), runtime)).status).toBe(409);
  expect((await app.fetch(request(review.fingerprint, "beta"), runtime)).status).toBe(404);
  expect((await app.fetch(request(review.fingerprint, "alpha", "https://evil.example"), runtime)).status).toBe(403);
  expect(privateWrites).toBe(0);
  const response = await app.fetch(request(), runtime);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ privateInputReceived: true, submitted: true });
  expect(privateWrites).toBe(1);
  expect(JSON.stringify((await db.prepare("SELECT input_json FROM action_plans").all()).results)).not.toContain("synthetic-private");
});
it("recovers private input acceptance and never resends consumed input", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  const app = createApplication(async () => ({ subject: "owner", displayName: "owner" }));
  const request = () => new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: "https://hq.example", "content-type": "application/json", "x-workspace-id": "alpha", "if-match": review.fingerprint }, body: JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }) });
  privateLost = true;
  expect((await app.fetch(request(), runtime)).status).toBe(503);
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ privateInputReceived: true });
  const response = await app.fetch(request(), runtime);
  expect(await response.json()).toMatchObject({ privateInputReceived: true, submitted: false });
  expect(privateWrites).toBe(1);
});
it("denies local pre-read eligibility after membership, connection or provider grant changes", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  const selected = { workspaceId: "alpha", planId: review.id };
  expect(await invoke("hooks_lifecycle_get", selected)).toMatchObject({ canSupplyPrivate: true });
  deny = true;
  expect(await invoke("hooks_lifecycle_get", selected)).toMatchObject({ canSupplyPrivate: false });
  deny = false;
  await db.prepare("UPDATE connections SET revision=revision+1 WHERE id='hooks'").run();
  expect(await invoke("hooks_lifecycle_get", selected)).toMatchObject({ canSupplyPrivate: false });
});
it("blocks a second change while the same resource has an uncertain outcome", async () => {
  const review = await plan(); lost = true;
  await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  await expect(plan("destination-restore")).rejects.toBeDefined();
  expect(writes).toBe(1);
});
it("refuses malformed lifecycle variants and private fields in ordinary metadata", async () => {
  const schema = (commands as Record<string, any>).hooks_lifecycle_plan.schema;
  for (const change of [{ kind: "destination-create", name: "Phone", type: "ntfy", topic: "synthetic-private-sentinel" }, { kind: "github-hook-adopt", resourceId, repository: "owner/repo", hookId: Number.MAX_SAFE_INTEGER + 1 }, { kind: "github-hook-update", resourceId, events: ["push", "push"], active: true }]) expect(schema.safeParse({ workspaceId: "alpha", connectionId: "hooks", connectionRevision: 1, planId: crypto.randomUUID(), authorityId, revision: 1, change }).success).toBe(false);
});
it("blocks local file reads while private acceptance is unresolved", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  await db.prepare("INSERT INTO hook_lifecycle_inputs(plan_id,status,created_at,updated_at) VALUES(?,'indeterminate',?,?)").bind(review.id, time(), time()).run();
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ canSupplyPrivate: false });
});
it("requires unexpired input and current membership before any private body read", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  await db.prepare("UPDATE action_plans SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").bind(review.id).run();
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const response = await app.fetch(new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: "https://hq.example", "content-type": "application/json", "x-workspace-id": "alpha", "if-match": review.fingerprint }, body: "invalid synthetic private document" }), runtime);
  expect(response.status).toBe(409); expect(privateWrites).toBe(0);
  const next = await plan("destination-update", { replaceCredentials: true });
  await db.prepare("UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'").run();
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: next.id })).toMatchObject({ canSupplyPrivate: false });
  await expect(invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: next.id, fingerprint: next.fingerprint })).rejects.toMatchObject({ status: 409 });
});
it("allows an operator lifecycle plan but denies publishers and malformed provider metadata", async () => {
  const fields = { workspaceId: "alpha", connectionId: "hooks", connectionRevision: 1, planId: crypto.randomUUID(), authorityId, revision: 1, change: { kind: "subscription-retire", resourceId } };
  const operator = await invoke("hooks_lifecycle_plan", fields, "operator");
  expect(operator.actorMatches).toBe(true);
  await expect(new WorkspaceService(runtime, { subject: "owner", displayName: "Publisher", sourceId: "source" }).hooksLifecyclePlan({ ...fields, planId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
  receipts.get(operator.id)!.fingerprint = "e".repeat(64);
  await expect(invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: operator.id }, "operator")).rejects.toMatchObject({ code: "hooks_provider_metadata_invalid" });
});

it("allows a new review after a fully known partial outcome while preserving its original receipt", async () => {
  const review = await plan(); partial = true;
  const applied = await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  expect(applied).toMatchObject({ operation: { status: "partial" }, outcome: { configuration: "applied", upstream: "failed" } });
  const next = await plan("destination-restore");
  expect(next.id).not.toBe(review.id);
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ operation: { status: "partial" } });
});
it("keeps partial outcomes with an indeterminate component blocked for reconciliation", async () => {
  const review = await plan(); lost = true;
  await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  const provider = receipts.get(review.id)!;
  provider.state = "failed"; provider.outcome = { configuration: "applied", upstream: "indeterminate" };
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ operation: { status: "indeterminate" } });
  await expect(plan("destination-restore")).rejects.toMatchObject({ status: 409 });
});

it("permits corrected private input only after a bounded definite provider rejection", async () => {
  const review = await plan("destination-update", { replaceCredentials: true });
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const request = () => new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: "https://hq.example", "content-type": "application/json", "x-workspace-id": "alpha", "if-match": review.fingerprint }, body: JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }) });
  privateRejection = true;
  expect((await app.fetch(request(), runtime)).status).toBe(400);
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ canSupplyPrivate: true });
  privateRejection = false;
  expect((await app.fetch(request(), runtime)).status).toBe(200);
  expect(privateWrites).toBe(2);
});

it("keeps mismatched private error status indeterminate instead of allowing another value", async () => {
  const review = await plan("destination-update", { replaceCredentials: true }); privateRejection = true; rejectionStatus = 503;
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const request = () => new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: "https://hq.example", "content-type": "application/json", "x-workspace-id": "alpha", "if-match": review.fingerprint }, body: JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }) });
  expect((await app.fetch(request(), runtime)).status).toBe(503);
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ canSupplyPrivate: false });
  expect((await app.fetch(request(), runtime)).status).toBe(409);
  expect(privateWrites).toBe(1);
});
it("recovers provider acceptance after the HQ receipt write fails without replaying", async () => {
  const review = await plan();
  await db.prepare("CREATE TRIGGER fail_lifecycle_ack BEFORE UPDATE ON operations WHEN NEW.kind='hookrelay.resource.lifecycle' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'Synthetic receipt write failure'); END").run();
  try {
    await expect(invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint })).rejects.toBeDefined();
    expect(writes).toBe(1);
    expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ operation: { status: "pending" } });
  } finally { await db.prepare("DROP TRIGGER fail_lifecycle_ack").run(); }
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ state: "applied", operation: { status: "succeeded" } });
  expect(writes).toBe(1);
});
it("never labels a contradictory applied receipt with a failed component successful", async () => {
  const review = await plan(); lost = true;
  await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  const provider = receipts.get(review.id)!;
  provider.state = "applied"; provider.outcome = { configuration: "applied", upstream: "failed" };
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ operation: { status: "partial" }, outcome: { upstream: "failed" } });
  expect(writes).toBe(1);
});
it("keeps an applied receipt without component outcomes indeterminate", async () => {
  const review = await plan(); lost = true;
  await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  const provider = receipts.get(review.id)!; provider.state = "applied"; provider.outcome = null;
  expect(await invoke("hooks_lifecycle_reconcile", { workspaceId: "alpha", planId: review.id })).toMatchObject({ operation: { status: "indeterminate" } });
  expect(writes).toBe(1);
});

it("keeps mismatched provider apply errors indeterminate and blocks the resource", async () => {
  const review = await plan(); applyRejectionStatus = 503; applyRejectionCode = "validation";
  expect(await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint })).toMatchObject({ operation: { status: "indeterminate" } });
  await expect(plan("destination-restore")).rejects.toMatchObject({ status: 409 });
});
it("records an authenticated documented not-found refusal as known failure", async () => {
  const review = await plan(); applyRejectionStatus = 404; applyRejectionCode = "not_found";
  expect(await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint })).toMatchObject({ operation: { status: "failed", summary: expect.stringContaining("not_found") } });
  expect((await plan("destination-restore")).id).not.toBe(review.id);
});
it("expires stored coverage and advances its collection fence on lifecycle intent and outcome", async () => {
  const review = await plan(); const received = time(-10000); const expiry = time(300000);
  await db.prepare("INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES('alpha','hooks','repository','synthetic-repo','Synthetic coverage','healthy','Configuration observed',?,?,?,?)").bind(JSON.stringify({ coverage: {} }), received, received, expiry).run();
  const generation = await db.prepare("SELECT generation FROM operational_coverage_epochs WHERE workspace_id='alpha' AND connection_id='hooks'").first<number>("generation") ?? 0;
  await invoke("hooks_lifecycle_apply", { workspaceId: "alpha", planId: review.id, fingerprint: review.fingerprint });
  const advanced = await db.prepare("SELECT generation FROM operational_coverage_epochs WHERE workspace_id='alpha' AND connection_id='hooks'").first<number>("generation");
  expect(advanced ?? 0).toBeGreaterThan(generation + 1);
  expect(await db.prepare("SELECT expires_at FROM observations WHERE workspace_id='alpha' AND source_id='hooks'").first<string>("expires_at")).not.toBe(expiry);
});

it("accepts bounded broad observed hook events while keeping requested updates constrained", async () => {
  observedEvents = 60;
  const review = await plan("github-hook-adopt", { repository: "trusted/external", hookId: 1 });
  expect(review.before.events).toHaveLength(observedEvents);
});

it("keeps private rejection without required correlation metadata indeterminate", async () => {
  const review = await plan("destination-update", { replaceCredentials: true }); privateRejection = true; privateCorrelation = false;
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const response = await app.fetch(new Request("https://hq.example/api/hooks/lifecycle-input/" + review.id, { method: "POST", headers: { Origin: "https://hq.example", "content-type": "application/json", "x-workspace-id": "alpha", "if-match": review.fingerprint }, body: JSON.stringify({ type: "ntfy", topic: "synthetic-private-sentinel" }) }), runtime);
  expect(response.status).toBe(503);
  expect(await invoke("hooks_lifecycle_get", { workspaceId: "alpha", planId: review.id })).toMatchObject({ canSupplyPrivate: false });
  expect(privateWrites).toBe(1);
});
