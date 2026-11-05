import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS, LIMITS, type Principal } from "../shared/domain";
import { commands } from "../shared/commands";
import { createApplication } from "../worker/app";
import { type HandoffReceipt } from "../shared/hook-handoff";
import { WorkspaceService } from "../worker/service";
import { HookHandoff } from "../worker/hook-handoff";
import type { Env } from "../worker/types";
const bindings = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.HQ_DB;
const authorityId = "a".repeat(32);
const resourceId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "00000000-0000-4000-8000-000000000002";
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
let runtime: Env;
let calls: number;
let lost: boolean;
let privateBehavior: "normal" | "redirect" | "oversize" | "revoke";
let receipts: Map<string, HandoffReceipt>;
const as = (subject = "owner", extra: Partial<Principal> = {}) => new WorkspaceService(runtime, { subject, displayName: subject, ...extra });
const input = { workspaceId: "alpha", connectionId: "hooks", connectionRevision: 1, projectId: "project", projectRevision: 1,
  authorityId, revision: 1, repository: "trusted/external", profile: "activity", sinks: ["phone"] };
beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  calls = 0; lost = false; receipts = new Map(); privateBehavior = "normal";
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha',?),('beta','Beta',?)").bind(time(), time()),
    db.prepare("INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')"),
    db.prepare("INSERT INTO projects(id,workspace_id,name,description) VALUES('project','alpha','Project','')"),
    db.prepare("INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES('repo','alpha','trusted/external','','project','maintained','active',?,?,'setup')").bind(JSON.stringify(DEFAULT_EXPECTATIONS), time()),
    db.prepare("INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('hooks','alpha','Primary hooks','hookrelay','{}','primary',1,1,'setup')"),
  ]);
  const fetcher = { fetch: async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); const fields = body.input;
    if (url.endsWith("/private/github-handoff")) {
      expect(init.redirect).toBe("manual");
      expect(fields.workspaceId).toBe("alpha");
      if (body.action === "adopt_plan") {
        const receipt: HandoffReceipt = { planId: fields.planId, repositoryId, resourceId, repository: fields.repository, name: "github:trusted/external", profile: "activity", profiles: fields.record.profiles, sinks: ["phone"], action: "adopt", status: "ready", routingConfigured: false, createdAt: time(), expiresAt: time(300000), updatedAt: time() };
        receipts.set(fields.planId, receipt);
        return Response.json(receipt, { headers: { "cache-control": "no-store" } });
      }
      if (privateBehavior === "redirect") return Response.redirect("https://other.example", 307);
      if (privateBehavior === "oversize") return new Response("x".repeat(129 * 1024), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      if (privateBehavior === "revoke") await db.prepare("UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'").run();
      return Response.json({ resourceId, repository: "trusted/external", profile: "activity", url: "https://hooks.example/hook/github/synthetic-private-route", secret: "synthetic-private-handoff-secret", events: ["push"], contentType: "application/json", sslVerification: true, settingsUrl: "https://github.com/trusted/external/settings/hooks/new" }, { headers: { "cache-control": "no-store" } });
    }
    let result: unknown;
    if (body.command === "github_handoff_configuration") result = { authorityId, revision: 1, mode: "active", canCreate: true, canReveal: true, reason: "ready", observedAt: time() };
    else if (body.command === "github_handoff_plan") {
      if (!receipts.has(fields.planId)) receipts.set(fields.planId, { planId: fields.planId, repositoryId, resourceId, repository: fields.repository, name: "github:trusted/external", profile: fields.profile, profiles: [fields.profile], sinks: fields.sinks, action: "create", status: "ready", routingConfigured: false, createdAt: time(), expiresAt: time(300000), updatedAt: time() });
      result = receipts.get(fields.planId);
    } else if (body.command === "github_handoff_apply") {
      calls++;
      expect((await db.prepare("SELECT status FROM operations WHERE plan_id=?").bind(fields.planId).first())?.status).toBe("pending");
      const receipt = receipts.get(fields.planId)!; receipt.status = "configured"; receipt.routingConfigured = true;
      if (lost) throw new Error("synthetic private failure"); result = receipt;
    } else if (body.command === "github_handoff_get") result = receipts.get(fields.planId);
    else if (body.command === "github_handoff_repository") result = { repository: "trusted/external", repositoryId, resources: [{ resourceId, profile: "activity", authMode: "environment" }, { resourceId: "00000000-0000-4000-8000-000000000003", profile: "stars", authMode: "environment" }], adoptionRequired: false, observedAt: time() };
    else if (body.command === "configuration_subscription") result = { authorityId, revision: 2, mode: "active", resourceId: fields.resourceId, name: "github:trusted/external" + (fields.resourceId === resourceId ? "" : ":stars"), source: "github", policy: { enabled: true, sinks: ["phone"], filter: null, sinkFilters: {} }, observedAt: time() };
    else throw new Error("Unexpected fixture command");
    return Response.json({ version: 1, capabilities: ["read"], result });
  } };
  runtime = new Proxy(bindings, { get(target, key, receiver) {
    if (key === "HOOKRELAY_TEST") return fetcher;
    if (key === "HOOKRELAY_CREDENTIALS") return JSON.stringify({ primary: { workspaceId: "alpha", name: "Synthetic", binding: "HOOKRELAY_TEST", providerId: "provider", revision: 1, token: "hkr_" + "b".repeat(43) } });
    return Reflect.get(target, key, receiver);
  } });
});
it("creates a manual hook for an unenrolled third-party repository with durable intent and project association", async () => {
  const plan = await as().hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() });
  const request = { workspaceId: "alpha", planId: plan.id, fingerprint: plan.fingerprint };
  const result = await as().hooksHandoffApply(request);
  expect(result).toMatchObject({ linked: true, provider: { routingConfigured: true }, operation: { status: "succeeded" } });
  expect(await as().hooksHandoffApply(request)).toEqual(result);
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private|https:\/\/hooks/);
});
it("requires a live owner for creation and private retrieval but permits safe viewer metadata", async () => {
  for (const subject of ["operator", "viewer"]) {
    await expect(as(subject).hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(new HookHandoff(as(subject)).private("reveal", { workspaceId: "alpha", connectionId: "hooks", resourceId })).rejects.toMatchObject({ status: 403 });
  }
  const plan = await as().hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() });
  expect(await as("viewer").hooksHandoffGet({ workspaceId: "alpha", planId: plan.id })).toMatchObject({ actorMatches: false });
  await expect(as("other").hooksHandoffGet({ workspaceId: "beta", planId: plan.id })).rejects.toMatchObject({ status: 404 });
  const revealed = await new HookHandoff(as()).private("reveal", { workspaceId: "alpha", connectionId: "hooks", resourceId });
  expect(revealed).toMatchObject({ secret: "synthetic-private-handoff-secret" });
  const persisted = await db.prepare("SELECT input_json FROM action_plans").all();
  expect(JSON.stringify(persisted)).not.toContain("synthetic-private");
});
it("reconciles a lost response without regenerating credentials and refuses changed authority", async () => {
  const plan = await as().hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() });
  lost = true;
  expect(await as().hooksHandoffApply({ workspaceId: "alpha", planId: plan.id, fingerprint: plan.fingerprint })).toMatchObject({ operation: { status: "indeterminate" } });
  expect(await as().hooksHandoffReconcile({ workspaceId: "alpha", planId: plan.id })).toMatchObject({ operation: { status: "succeeded" } });
  expect(calls).toBe(1);
  const next = await as().hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() });
  await db.prepare("UPDATE projects SET revision=revision+1 WHERE id='project'").run();
  await expect(as().hooksHandoffApply({ workspaceId: "alpha", planId: next.id, fingerprint: next.fingerprint })).rejects.toMatchObject({ status: 409 });
});
it("handles concurrent duplicate apply requests and preserves the original actor binding", async () => {
  const plan = await as().hooksHandoffPlan({ ...input, reviewId: crypto.randomUUID() });
  const request = { workspaceId: "alpha", planId: plan.id, fingerprint: plan.fingerprint };
  await Promise.all([as().hooksHandoffApply(request), as().hooksHandoffApply(request)]);
  expect(calls).toBe(1);
  await db.prepare("INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','second','Second','owner')").run();
  await expect(as("second").hooksHandoffReconcile({ workspaceId: "alpha", planId: plan.id })).rejects.toMatchObject({ status: 409 });
});
it("associates every adopted profile with the reviewed project and saved repository", async () => {
  const plan = await new HookHandoff(as()).plan({ ...input, savedRepositoryId: "repo", savedRepositoryRevision: 1, reviewId: crypto.randomUUID(), record: { hmac: { name: "HMAC_GITHUB_TRUSTED_EXTERNAL", value: "synthetic-private-adoption-secret" }, slugs: { activity: "synthetic-private-adopt-activity", stars: "synthetic-private-adopt-stars", alerts: "synthetic-private-adopt-alerts" }, profiles: ["activity", "stars"], state: "active" } }, true);
  const result = await as().hooksHandoffApply({ workspaceId: "alpha", planId: plan.id, fingerprint: plan.fingerprint });
  expect(result).toMatchObject({ linked: true, operation: { status: "succeeded" } });
  const associations = await db.prepare("SELECT subscription,project_id FROM hook_associations ORDER BY subscription").all();
  expect(associations.results).toEqual([{ subscription: "github:trusted/external", project_id: "project" }, { subscription: "github:trusted/external:stars", project_id: "project" }]);
  const links = await db.prepare("SELECT resource_key FROM repository_resource_links WHERE repository_id='repo' ORDER BY resource_key").all();
  expect(links.results).toEqual([{ resource_key: "github:trusted/external" }, { resource_key: "github:trusted/external:stars" }]);
});
it("exposes safe command schemas while keeping private actions outside generic HTTP and hosted MCP", () => {
  for (const action of ["configuration", "repository", "plan", "get", "apply", "reconcile", "status"] as const) {
    const name = `hooks_handoff_${action}` as const;
    expect(typeof as()[commands[name].method]).toBe("function");
    expect(() => JSON.stringify(commands[name].schema.toJSONSchema())).not.toThrow();
  }
  expect(Object.hasOwn(commands, "hooks_handoff_reveal")).toBe(false);
  expect(Object.hasOwn(commands, "hooks_handoff_export")).toBe(false);
});
it("rejects redirected, oversized and revoked private reads without revealing values", async () => {
  for (const behavior of ["redirect", "oversize", "revoke"] as const) {
    privateBehavior = behavior;
    await expect(new HookHandoff(as()).private("reveal", { workspaceId: "alpha", connectionId: "hooks", resourceId })).rejects.toBeDefined();
  }
});
it("protects the private HTTP boundary with same-origin, strict bodies and no-store responses", async () => {
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const body = JSON.stringify({ action: "reveal", input: { workspaceId: "alpha", connectionId: "hooks", resourceId } });
  const request = (value = body, origin = "https://hq.example") => new Request("https://hq.example/api/hooks/handoff/private", { method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: value });
  const result = await app.fetch(request(), runtime);
  expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toMatchObject({ secret: "synthetic-private-handoff-secret" });
  expect((await app.fetch(request(body, "https://evil.example"), runtime)).status).toBe(403);
  const invalid = await app.fetch(request(JSON.stringify({ action: "reveal", input: { workspaceId: "alpha", connectionId: "hooks", resourceId, secret: "synthetic-private-error-sentinel" } })), runtime);
  expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("synthetic-private-error-sentinel");
  expect((await app.fetch(request("x".repeat(LIMITS.BODY_BYTES + 1)), runtime)).status).toBe(413);
});
