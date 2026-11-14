import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import { HOOK_SETUP_KIND, type HookSetupReceipt } from "../shared/hook-setup";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const authorityId = "a".repeat(32);
const resourceId = "00000000-0000-4000-8000-000000000001";
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
let runtime: Env;
let calls: number;
let inventoryReads: number;
let inventoryFault: "name" | "page" | "private" | "denied" | "rate_limited" | null;
let duringInventory: (() => Promise<void>) | null;
let lost: boolean;
let receipts: Map<string, HookSetupReceipt>;
const as = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(runtime, { subject, displayName: subject, ...extra });
const input = {
  workspaceId: "alpha",
  connectionId: "hooks",
  connectionRevision: 1,
  repositoryId: "repo",
  repositoryRevision: 1,
  authorityId,
  revision: 1,
  resourceId: null,
  name: "repository-hooks",
  events: ["push"],
  sinks: ["phone"],
};
beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  calls = 0;
  inventoryReads = 0; inventoryFault = null; duringInventory = null;
  lost = false;
  receipts = new Map();
  await db.batch([
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
    db
      .prepare(
        "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES('repo','alpha','owner/repo','','project','maintained','active',?,?,'setup')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS), time()),
    db.prepare(
      "INSERT INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('hooks','alpha','Primary hooks','hookrelay','{}','primary',1,1,'setup')",
    ),
  ]);
  const fetcher = {
    fetch: async (_url: string, init: RequestInit) => {
      const { command, input: fields } = JSON.parse(String(init.body));
      expect(Object.keys(fields)).not.toContain("privateKey");
      expect(Object.keys(fields)).not.toContain("installationToken");
      expect(Object.keys(fields)).not.toContain("registrationId");
      let result: unknown;
      if (command === "github_repository_hooks") {
        inventoryReads++;
        if (inventoryFault === "denied" || inventoryFault === "rate_limited") return Response.json({ error: { code: inventoryFault, message: "private-provider-message-canary" } }, { status: inventoryFault === "denied" ? 403 : 429 });
        expect(fields.repository).toBe("owner/repo");
        expect(fields).not.toHaveProperty("repositoryId");
        await duringInventory?.();
        result = { repository: inventoryFault === "name" ? "owner/other" : fields.repository, repositoryId: 101, items: [{ id: 42, active: true, events: ["push"] }], page: inventoryFault === "page" ? 2 : fields.page, nextPage: null, limited: false, observedAt: time(), ...(inventoryFault === "private" ? { url: "https://private.invalid/receiver" } : {}) };
      } else if (command === "github_setup_configuration")
        result = {
          authorityId,
          revision: 1,
          mode: "active",
          canCreate: true,
          reason: "ready",
          observedAt: time(),
        };
      else if (command === "github_setup_plan") {
        if (!receipts.has(fields.planId))
          receipts.set(fields.planId, {
            planId: fields.planId,
            resourceId,
            name: fields.name,
            repository: fields.repository,
            events: fields.events,
            sinks: fields.sinks,
            action: "create",
            status: "ready",
            routingConfigured: false,
            webhookInstalled: false,
            webhookId: null,
            errorCode: null,
            createdAt: time(),
            expiresAt: time(300000),
            updatedAt: time(),
          });
        result = receipts.get(fields.planId);
      } else if (command === "github_setup_apply") {
        calls++;
        expect(
          (
            await db
              .prepare("SELECT status FROM operations WHERE plan_id=?")
              .bind(fields.planId)
              .first()
          )?.status,
        ).toBe("pending");
        const receipt = receipts.get(fields.planId)!;
        receipt.status = "installed";
        receipt.routingConfigured = true;
        receipt.webhookInstalled = true;
        receipt.webhookId = 42;
        if (lost) throw new Error("synthetic private failure");
        result = receipt;
      } else if (command === "github_setup_get")
        result = receipts.get(fields.planId);
      else if (command === "configuration_subscription")
        result = {
          authorityId,
          revision: 2,
          mode: "active",
          resourceId,
          name: "repository-hooks",
          source: "github",
          policy: {
            enabled: true,
            sinks: ["phone"],
            filter: null,
            sinkFilters: {},
          },
          observedAt: time(),
        };
      else throw new Error("Unexpected command " + command);
      return Response.json({ version: 1, capabilities: ["read"], result });
    },
  };
  runtime = new Proxy(bindings, {
    get(target, key, receiver) {
      if (key === "GITHUB_APP_DEPLOYMENT_ID")
        return "synthetic-hq-app-deployment";
      if (key === "HOOKRELAY_TEST") return fetcher;
      if (key === "HOOKRELAY_CREDENTIALS")
        return JSON.stringify({
          primary: {
            workspaceId: "alpha",
            name: "Synthetic",
            binding: "HOOKRELAY_TEST",
            providerId: "provider",
            revision: 1,
            token: "hkr_" + "b".repeat(43),
          },
        });
      return Reflect.get(target, key, receiver);
    },
  });
});
it("exposes shared CLI and MCP contracts", () => {
  for (const key of [
    "configuration",
    "status",
    "plan",
    "get",
    "apply",
    "reconcile",
  ] as const) {
    const name = `hooks_setup_${key}` as const;
    expect(typeof as()[commands[name].method]).toBe("function");
    expect(
      commandAnnotations(name, commands[name].readOnly).openWorldHint,
    ).toBe(key !== "get");
  }
});
it("creates a durable operation before submission, links the repository, and applies the same review once", async () => {
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  const request = {
    workspaceId: "alpha",
    planId: plan.id,
    fingerprint: plan.fingerprint,
  };
  const result = await as().hooksSetupApply(request);
  expect(result).toMatchObject({
    linked: true,
    operation: { status: "succeeded" },
    provider: { webhookInstalled: true },
  });
  expect(await as().hooksSetupApply(request)).toEqual(result);
  expect(calls).toBe(1);
  expect(await as().hooksHistory({ workspaceId: "alpha" })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: HOOK_SETUP_KIND }),
    ]),
  );
});
it("recovers a lost provider response without resubmitting and leaves the receipt available to other operators", async () => {
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  lost = true;
  expect(
    await as().hooksSetupApply({
      workspaceId: "alpha",
      planId: plan.id,
      fingerprint: plan.fingerprint,
    }),
  ).toMatchObject({ operation: { status: "indeterminate" } });
  expect(
    await as("operator").hooksSetupReconcile({
      workspaceId: "alpha",
      planId: plan.id,
    }),
  ).toMatchObject({ linked: true, operation: { status: "succeeded" } });
  expect(calls).toBe(1);
});
it("rejects viewers, other workspaces, changed repository revisions and different actors", async () => {
  await expect(
    as("viewer").hooksSetupPlan({ ...input, reviewId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ status: 403 });
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  await expect(
    as("other").hooksSetupGet({ workspaceId: "beta", planId: plan.id }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    as("operator").hooksSetupApply({
      workspaceId: "alpha",
      planId: plan.id,
      fingerprint: plan.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await db
    .prepare(
      "UPDATE repositories SET revision=revision+1 WHERE workspace_id='alpha' AND id='repo'",
    )
    .run();
  await expect(
    as().hooksSetupApply({
      workspaceId: "alpha",
      planId: plan.id,
      fingerprint: plan.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0);
});
it("rejects changed inputs for the same plan and never leaks provider failure text", async () => {
  const reviewId = crypto.randomUUID();
  const plan = await as().hooksSetupPlan({ ...input, reviewId });
  await expect(
    as().hooksSetupPlan({ ...input, reviewId, name: "different" }),
  ).rejects.toMatchObject({ status: 409 });
  lost = true;
  const result = await as().hooksSetupApply({
    workspaceId: "alpha",
    planId: plan.id,
    fingerprint: plan.fingerprint,
  });
  expect(JSON.stringify(result)).not.toContain("synthetic private failure");
});
it("submits concurrent duplicate requests only once", async () => {
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  const request = {
    workspaceId: "alpha",
    planId: plan.id,
    fingerprint: plan.fingerprint,
  };
  await Promise.all([
    as().hooksSetupApply(request),
    as().hooksSetupApply(request),
  ]);
  expect(calls).toBe(1);
  expect(
    await as().hooksSetupGet({ workspaceId: "alpha", planId: plan.id }),
  ).toMatchObject({ linked: true, operation: { status: "succeeded" } });
});
it("keeps completed installation separate from a changed repository link and emits bounded diagnostics", async () => {
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  lost = true;
  await as().hooksSetupApply({
    workspaceId: "alpha",
    planId: plan.id,
    fingerprint: plan.fingerprint,
  });
  await db
    .prepare(
      "UPDATE repositories SET revision=revision+1 WHERE workspace_id='alpha' AND id='repo'",
    )
    .run();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await as().hooksSetupReconcile({
      workspaceId: "alpha",
      planId: plan.id,
    });
    expect(result).toMatchObject({
      linked: false,
      operation: { status: "partial" },
      provider: { webhookInstalled: true },
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.hooks.setup",
        reference: result.operation!.id,
        state: "installed",
        linked: false,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "synthetic private failure",
    );
  } finally {
    log.mockRestore();
  }
});
it("recovers a saved provider review without applying it", async () => {
  const plan = await as().hooksSetupPlan({
    ...input,
    reviewId: crypto.randomUUID(),
  });
  await db
    .prepare(
      "UPDATE hook_reviews SET provider_review_json=NULL WHERE plan_id=?",
    )
    .bind(plan.id)
    .run();
  expect(
    await as().hooksSetupReconcile({ workspaceId: "alpha", planId: plan.id }),
  ).toMatchObject({ operation: null, provider: { status: "ready" } });
  expect(calls).toBe(0);
});


it("exposes bounded read-only GitHub webhook inventory through the shared CLI/MCP contract", async () => {
  const name = "hooks_github_inventory" as const;
  expect(commands[name].readOnly).toBe(true);
  expect(commandAnnotations(name, true)).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  expect(await as("viewer").hooksGitHubInventory({ workspaceId: "alpha", connectionId: "hooks", repositoryId: "repo" })).toMatchObject({ repository: "owner/repo", repositoryId: 101, page: 1, items: [{ id: 42, active: true, events: ["push"] }] });
  expect(inventoryReads).toBe(1);
  expect(calls).toBe(0);
});
it("authorizes workspace, enrolled repository, connection, and page before reading GitHub", async () => {
  const fields = { workspaceId: "alpha", connectionId: "hooks", repositoryId: "repo" };
  await expect(as("other").hooksGitHubInventory(fields)).rejects.toMatchObject({ code: "not_found" });
  await expect(as().hooksGitHubInventory({ ...fields, repositoryId: "missing" })).rejects.toMatchObject({ code: "not_found" });
  await expect(as().hooksGitHubInventory({ ...fields, page: 101 })).rejects.toThrow();
  expect(inventoryReads).toBe(0);
});
it.each(["name", "page", "private"] as const)("rejects unsafe or mismatched GitHub inventory %s without exposing provider data", async fault => {
  inventoryFault = fault;
  await expect(as().hooksGitHubInventory({ workspaceId: "alpha", connectionId: "hooks", repositoryId: "repo" })).rejects.toMatchObject({ code: fault === "private" ? "hooks_provider_unavailable" : "hooks_provider_metadata_invalid" });
});
it.each(["repository", "connection", "membership"])("rejects GitHub inventory when %s changes during the read", async target => {
  duringInventory = async () => {
    if (target === "repository") await db.prepare("UPDATE repositories SET revision=revision+1 WHERE id='repo'").run();
    if (target === "connection") await db.prepare("UPDATE connections SET revision=revision+1 WHERE id='hooks'").run();
    if (target === "membership") await db.prepare("DELETE FROM members WHERE subject='owner'").run();
  };
  await expect(as().hooksGitHubInventory({ workspaceId: "alpha", connectionId: "hooks", repositoryId: "repo" })).rejects.toMatchObject({ code: target === "membership" ? "not_found" : "revision_conflict" });
});


it.each([['denied', 'github_denied', 403], ['rate_limited', 'github_rate_limited', 429]] as const)("preserves actionable GitHub inventory %s failures without forwarding provider text", async (failure, code, status) => {
  inventoryFault = failure;
  const error = await as().hooksGitHubInventory({ workspaceId: "alpha", connectionId: "hooks", repositoryId: "repo" }).catch(error => error);
  expect(error).toMatchObject({ code: "hooks_provider_" + code, status });
  expect(error.message).not.toContain("private-provider-message-canary");
  expect(error.message).not.toContain("Reconcile");
  expect(error.message).toContain(failure === "denied" ? "repository" : "limit");
});
