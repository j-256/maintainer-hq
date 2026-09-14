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
      let result: unknown;
      if (command === "github_setup_configuration")
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
