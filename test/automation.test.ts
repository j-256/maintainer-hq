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
import { z } from "zod";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  LIMITS,
  type Principal,
} from "../shared/domain";
import {
  AUTOMATION_LIMITS,
  AUTOMATION_SCOPES,
  type AutomationPlanFields,
} from "../shared/automation";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createProductionPrincipalResolver } from "../worker/auth";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const owner: Principal = { subject: "owner", displayName: "Test owner" };
let now: number;
let service: WorkspaceService;
const as = (principal: Principal) =>
  new WorkspaceService(bindings, principal, false, () => now);
const fields = (credentialId = "reporter"): AutomationPlanFields => ({
  ...workspace,
  credentialId,
  name: "Test reporter",
  profile: "reporter",
  reporterId: "agent-one",
  expiresInDays: 7,
});
const count = (table: string) =>
  bindings.HQ_DB.prepare(
    "SELECT count(*) AS total FROM " + table,
  ).first<number>("total");
async function issue(input = fields()) {
  const plan = await service.automationCredentialPlan(input);
  return service.automationCredentialIssue({
    ...workspace,
    planId: plan.planId,
    fingerprint: plan.fingerprint,
  });
}
async function principal(token: string) {
  return createProductionPrincipalResolver(fetch, () => now)(
    new Request("https://hq.example", {
      headers: { Authorization: "Bearer " + token },
    }),
    bindings,
  );
}
function report() {
  return {
    ...workspace,
    goalId: "goal",
    sourceId: "agent-one",
    objective: "  The actual /goal\nVerbatim, including whitespace.  ",
    status: "active",
    startedAt: new Date(now - 2000).toISOString(),
    reportedAt: new Date(now - 1000).toISOString(),
  };
}
const note = {
  ...workspace,
  eventId: "note",
  kind: "progress",
  title: "A reported update",
  summary: "Synthetic progress",
  resourceId: null,
};

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Test owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  service = as(owner);
});
afterEach(() => vi.restoreAllMocks());

describe("Reviewed automation credentials", () => {
  it("binds reviews to the initiating credential and refuses a cached actor after credential revocation", async () => {
    const token = "synthetic-owner-administration";
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('admin','alpha','owner','Synthetic administration',?,'[\"read\",\"workspace:admin\"]',?,?)",
    )
      .bind(
        await credentialHash(token),
        new Date(now).toISOString(),
        new Date(now + AUTOMATION_LIMITS.DAY_MS).toISOString(),
      )
      .run();
    const administrator = as(await principal(token));
    const humanPlan = await service.automationCredentialPlan(fields());
    await expect(
      administrator.automationCredentialIssue({
        ...workspace,
        planId: humanPlan.planId,
        fingerprint: humanPlan.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const machinePlan = await administrator.automationCredentialPlan(fields());
    const apply = {
      ...workspace,
      planId: machinePlan.planId,
      fingerprint: machinePlan.fingerprint,
    };
    await expect(
      service.automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='admin'",
    )
      .bind(new Date(now).toISOString())
      .run();
    await expect(
      administrator.automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await count("credentials")).toBe(1);
  });
  it("binds a short-lived review, returns the value once, and stores only its digest with minimized metadata", async () => {
    const plan = await service.automationCredentialPlan(fields());
    expect(plan).toMatchObject({
      ...fields(),
      actor: "Test owner",
      workspaceName: "Alpha",
      scopes: AUTOMATION_SCOPES.reporter,
    });
    expect(Date.parse(plan.expiresAt) - now).toBe(LIMITS.PLAN_TTL_MS);
    const apply = {
      ...workspace,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
    };
    const result = await service.automationCredentialIssue(apply);
    expect(result.token).toMatch(/^hqa_[a-f0-9]{64}$/);
    expect(result.credential).toMatchObject({
      profile: "reporter",
      reporterId: "agent-one",
      owner: "owner",
      revokedAt: null,
    });
    expect(Date.parse(result.credential.expiresAt) - now).toBe(
      7 * AUTOMATION_LIMITS.DAY_MS,
    );
    const row = await bindings.HQ_DB.prepare(
      "SELECT * FROM credentials WHERE id='reporter'",
    ).first();
    expect(row).toMatchObject({
      token_hash: await credentialHash(result.token),
      scopes_json: JSON.stringify(AUTOMATION_SCOPES.reporter),
      source_id: null,
    });
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(
      JSON.stringify(await service.automationCredentials(workspace)),
    ).not.toMatch(/token|hash|scopes_json/);
    expect(JSON.stringify(await service.activity(workspace))).not.toContain(
      result.token,
    );
    await expect(
      service.automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.automationCredentialPlan(fields()),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("credentials")).toBe(1);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "automation.credential.issued",
      ),
    ).toHaveLength(1);
  });
  it("enforces workspace, owner, fixed scopes, exact actor, membership revision, and expiry", async () => {
    for (const subject of ["operator", "viewer"])
      await expect(
        as({ subject, displayName: subject }).automationCredentialPlan(
          fields(),
        ),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.automationCredentialPlan({ ...fields(), workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    for (const invalid of [
      { profile: "owner" },
      { scopes: [CAPABILITY.ADMIN] },
      { profile: "reader" },
      { reporterId: null },
      { expiresInDays: 365 },
      { actor: "forged" },
    ])
      await expect(
        service.automationCredentialPlan({ ...fields(), ...invalid }),
      ).rejects.toThrow();
    const plan = await service.automationCredentialPlan(fields());
    const apply = {
      ...workspace,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
    };
    await expect(
      service.automationCredentialIssue({
        ...apply,
        fingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await service.memberUpdate({
      ...workspace,
      subject: "operator",
      revision: 1,
      role: "owner",
    });
    await expect(
      as({
        subject: "operator",
        displayName: "Operator",
      }).automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(
      service.automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await service.automationCredentialPlan(fields());
    now += LIMITS.PLAN_TTL_MS;
    await expect(
      service.automationCredentialIssue({
        ...apply,
        planId: fresh.planId,
        fingerprint: fresh.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("credentials")).toBe(0);
  });
  it("deduplicates concurrent issuance and recovers a lost response through inspect, revoke, and deliberate replacement", async () => {
    const plan = await service.automationCredentialPlan(fields());
    const apply = {
      ...workspace,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
    };
    const results = await Promise.allSettled([
      service.automationCredentialIssue(apply),
      service.automationCredentialIssue(apply),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
    expect(
      (await service.automationCredentials(workspace)).map(
        (credential) => credential.id,
      ),
    ).toEqual(["reporter"]);
    const revoke = { ...workspace, credentialId: "reporter" };
    const revoked = await Promise.all([
      service.automationCredentialRevoke(revoke),
      service.automationCredentialRevoke(revoke),
    ]);
    expect(revoked[0]).toEqual(revoked[1]);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "automation.credential.revoked",
      ),
    ).toHaveLength(1);
    const replacement = await issue(fields("replacement"));
    expect((await principal(replacement.token)).reporterId).toBe("agent-one");
  });
  it("does not issue or revoke after authority is lost between authorization and the write", async () => {
    await issue(fields("existing"));
    const plan = await service.automationCredentialPlan(fields());
    const original = service.authorize.bind(service);
    vi.spyOn(service, "authorize").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === CAPABILITY.ADMIN)
        await bindings.HQ_DB.prepare(
          "UPDATE members SET role='viewer' WHERE workspace_id='alpha' AND subject='owner'",
        ).run();
      return result;
    });
    await expect(
      service.automationCredentialIssue({
        ...workspace,
        planId: plan.planId,
        fingerprint: plan.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("credentials")).toBe(1);
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='owner' WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(
      service.automationCredentialRevoke({
        ...workspace,
        credentialId: "existing",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT revoked_at FROM credentials WHERE id='existing'",
      ).first("revoked_at"),
    ).toBeNull();
  });
  it("bounds pending reviews and active credentials while keeping revoked history visible", async () => {
    for (let index = 0; index < AUTOMATION_LIMITS.PENDING_PLANS; index++)
      await service.automationCredentialPlan(fields("pending-" + index));
    await expect(
      service.automationCredentialPlan(fields("overflow")),
    ).rejects.toMatchObject({ status: 409 });
    now += LIMITS.PLAN_TTL_MS + 1;
    const plan = await service.automationCredentialPlan(fields());
    await bindings.HQ_DB.batch(
      Array.from({ length: AUTOMATION_LIMITS.ACTIVE_CREDENTIALS }, (_, index) =>
        bindings.HQ_DB.prepare(
          "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,automation_profile,created_at,expires_at) VALUES (?,'alpha','owner','Capacity',?,'[\"read\"]','reader',?,?)",
        ).bind(
          "capacity-" + index,
          "synthetic-hash-" + index,
          new Date(now).toISOString(),
          new Date(now + AUTOMATION_LIMITS.DAY_MS).toISOString(),
        ),
      ),
    );
    const apply = {
      ...workspace,
      planId: plan.planId,
      fingerprint: plan.fingerprint,
    };
    await expect(
      service.automationCredentialIssue(apply),
    ).rejects.toMatchObject({ status: 409 });
    await service.automationCredentialRevoke({
      ...workspace,
      credentialId: "capacity-0",
    });
    await service.automationCredentialIssue(apply);
    expect(
      (await service.automationCredentials(workspace)).find(
        (credential) => credential.id === "capacity-0",
      )?.revokedAt,
    ).toBeTruthy();
  });
});

describe("Reporter identity and live permissions", () => {
  it("keeps paused and cleared reports bound to their original workspace, owner and reporter", async () => {
    const issued = await issue();
    const reporter = as(await principal(issued.token));
    const goal = report();
    await reporter.syncGoal(goal);
    const alternate = as(
      await principal(
        (await issue({ ...fields("alternate"), reporterId: "agent-two" }))
          .token,
      ),
    );
    for (const [index, status] of ["paused", "cleared"].entries()) {
      const update = {
        ...goal,
        status,
        reportedAt: new Date(now + index + 1).toISOString(),
      };
      expect(await reporter.syncGoal(update)).toMatchObject({
        status,
        objective: goal.objective,
      });
      await expect(
        alternate.syncGoal({ ...update, sourceId: "agent-two" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(service.syncGoal(update)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        reporter.syncGoal({ ...update, workspaceId: "beta" }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(reporter.goals(workspace)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(await count("goals")).toBe(1);
  });
  it("permits only a reporter's own reports, preserves verbatim goals and stable retries, and refuses reads and operator actions", async () => {
    const issued = await issue();
    const actor = await principal(issued.token);
    expect(actor).toMatchObject({
      scopes: AUTOMATION_SCOPES.reporter,
      reporterId: "agent-one",
      displayName: "Test reporter (automation)",
    });
    const reporter = as(actor);
    const goal = report();
    expect(await reporter.syncGoal(goal)).toMatchObject({
      objective: goal.objective,
      actor: "Test reporter (automation)",
    });
    const receipt = await reporter.addActivity(note);
    expect(await reporter.addActivity(note)).toEqual(receipt);
    expect(await reporter.syncGoal(goal)).toEqual(
      await reporter.syncGoal(goal),
    );
    for (const action of [
      () => reporter.session(),
      () => reporter.snapshot(workspace),
      () => reporter.goals(workspace),
      () => reporter.activity(workspace),
      () => reporter.automationCredentials(workspace),
      () => reporter.automationCredentialPlan(fields("escalate")),
      () =>
        reporter.createProject({
          ...workspace,
          name: "Not allowed",
          description: "",
        }),
      () => reporter.githubCredentials(workspace),
    ])
      await expect(action()).rejects.toMatchObject({ status: 403 });
    await expect(
      reporter.syncGoal({ ...goal, sourceId: "someone-else" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reporter.syncGoal({ ...goal, workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reporter.syncGoal({ ...goal, objective: "Different objective" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      reporter.syncGoal({
        ...goal,
        reportedAt: new Date(now - 1500).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const repository = await service.createRepository({
      ...workspace,
      repository: {
        fullName: "example/repository",
        description: "",
        projectId: "project",
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    });
    expect(
      await reporter.addActivity({
        ...note,
        eventId: "repository-note",
        resourceId: repository.id,
      }),
    ).toMatchObject({ resourceId: repository.id });
    await expect(
      reporter.repository({ ...workspace, repositoryId: repository.id }),
    ).rejects.toMatchObject({ status: 403 });
    const alternate = as(
      await principal(
        (await issue({ ...fields("alternate"), reporterId: "agent-two" }))
          .token,
      ),
    );
    await expect(alternate.addActivity(note)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      alternate.syncGoal({ ...goal, sourceId: "agent-two" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.syncGoal(goal)).rejects.toMatchObject({ status: 409 });
    await expect(service.addActivity(note)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT reporter_id FROM activity WHERE type='goal.active'",
      ).first("reporter_id"),
    ).toBe("agent-one");
  });
  it("allows credential replacement for the same reporter but not revival after member removal", async () => {
    const issued = await issue();
    const oldPrincipal = await principal(issued.token);
    const goal = report();
    const before = await as(oldPrincipal).syncGoal(goal);
    await service.automationCredentialRevoke({
      ...workspace,
      credentialId: "reporter",
    });
    await expect(principal(issued.token)).rejects.toMatchObject({
      status: 401,
    });
    await expect(as(oldPrincipal).syncGoal(goal)).rejects.toMatchObject({
      status: 403,
    });
    const replacement = await issue(fields("replacement"));
    const reporter = as(await principal(replacement.token));
    expect(await reporter.syncGoal(goal)).toEqual(before);
    expect(
      await reporter.syncGoal({
        ...goal,
        status: "complete",
        reportedAt: new Date(now).toISOString(),
      }),
    ).toMatchObject({ status: "complete" });
    await service.memberUpdate({
      ...workspace,
      subject: "operator",
      revision: 1,
      role: "owner",
    });
    await as({ subject: "operator", displayName: "Operator" }).memberRemove({
      ...workspace,
      subject: "owner",
      revision: 1,
    });
    await expect(principal(replacement.token)).rejects.toMatchObject({
      status: 401,
    });
    await bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Rejoined','owner')",
    ).run();
    await expect(principal(replacement.token)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("checks credential expiry, live membership and revocation inside atomic goal and activity writes", async () => {
    const issued = await issue();
    const actor = await principal(issued.token);
    const reporter = as(actor);
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    const spy = vi
      .spyOn(bindings.HQ_DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await bindings.HQ_DB.prepare(
          "UPDATE credentials SET revoked_at=? WHERE id='reporter'",
        )
          .bind(new Date(now).toISOString())
          .run();
        return batch(statements);
      });
    await expect(reporter.syncGoal(report())).rejects.toMatchObject({
      status: 403,
    });
    expect(await count("goals")).toBe(0);
    spy.mockRestore();
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=NULL WHERE id='reporter'",
    ).run();
    const originalPrepare = bindings.HQ_DB.prepare.bind(bindings.HQ_DB);
    const prepareSpy = vi
      .spyOn(bindings.HQ_DB, "prepare")
      .mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.startsWith("INSERT INTO activity (id, workspace_id"))
          return statement;
        const originalBind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          const bound = originalBind(...values);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            await originalPrepare(
              "UPDATE credentials SET revoked_at=? WHERE id='reporter'",
            )
              .bind(new Date(now).toISOString())
              .run();
            return run();
          };
          return bound;
        };
        return statement;
      });
    await expect(reporter.addActivity(note)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT id FROM activity WHERE id='note'",
      ).first(),
    ).toBeNull();
    prepareSpy.mockRestore();
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=NULL WHERE id='reporter'",
    ).run();
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='viewer' WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(reporter.syncGoal(report())).rejects.toMatchObject({
      status: 403,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='owner' WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    now += 7 * AUTOMATION_LIMITS.DAY_MS;
    await expect(principal(issued.token)).rejects.toMatchObject({
      status: 401,
    });
    await expect(reporter.addActivity(note)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
  it("keeps Reader and Publisher permissions separate from Reporter, including HTTP and MCP", async () => {
    const reader = as(
      await principal(
        (
          await issue({
            ...fields("reader"),
            profile: "reader",
            reporterId: null,
          })
        ).token,
      ),
    );
    expect((await reader.snapshot(workspace)).capabilities).toEqual([
      CAPABILITY.READ,
    ]);
    await expect(reader.syncGoal(report())).rejects.toMatchObject({
      status: 403,
    });
    await expect(reader.addActivity(note)).rejects.toMatchObject({
      status: 403,
    });
    await expect(reader.automationCredentials(workspace)).rejects.toMatchObject(
      { status: 403 },
    );
    const publisher = as({
      ...owner,
      workspaceId: "alpha",
      tokenId: "publisher",
      sourceId: "source",
      scopes: [CAPABILITY.PUBLISH],
    });
    await expect(publisher.syncGoal(report())).rejects.toMatchObject({
      status: 403,
    });
    const token = (await issue()).token;
    const app = createApplication(
      createProductionPrincipalResolver(fetch, () => now),
    );
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    };
    const api = await app.fetch(
      new Request("https://hq.example/api/commands/goal_sync", {
        method: "POST",
        headers,
        body: JSON.stringify(report()),
      }),
      bindings,
    );
    expect(api.status).toBe(200);
    expect(api.headers.get("Cache-Control")).toBe("no-store");
    const mcp = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          ...headers,
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "activity_add", arguments: note },
        }),
      }),
      bindings,
    );
    expect(mcp.status).toBe(200);
    const data = (await mcp.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(data.result.isError).not.toBe(true);
    expect(JSON.parse(data.result.content[0]!.text)).toMatchObject({
      id: "note",
      title: note.title,
    });
    for (const name of [
      "automation_credentials_list",
      "automation_credential_plan",
      "automation_credential_issue",
      "automation_credential_revoke",
    ] as const)
      expect(() => z.toJSONSchema(commands[name].schema)).not.toThrow();
    expect(
      commandAnnotations("automation_credential_issue", false),
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(
      commandAnnotations("automation_credential_revoke", false),
    ).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
});
