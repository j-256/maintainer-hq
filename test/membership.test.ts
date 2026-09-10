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
import { CAPABILITY, type Principal } from "../shared/domain";
import { MEMBERSHIP_LIMITS } from "../shared/membership";
import { commands } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ISSUER = "https://identity.example";
const AUDIENCE = "synthetic-application";
const workspace = { workspaceId: "alpha" };
const account = (
  subject = "owner",
  email = subject + "@example.test",
): Principal => ({
  subject,
  displayName: email,
  access: { issuer: ISSUER, audience: AUDIENCE, email },
});
let now: number;
let runtime: Env;
let service: WorkspaceService;
const as = (principal: Principal) =>
  new WorkspaceService(runtime, principal, false, () => now);
const member = (subject: string, revision = 1) => ({
  ...workspace,
  subject,
  revision,
});
const invitation = (
  invitationId = "invite",
  email = "recipient@example.test",
) => ({
  ...workspace,
  invitationId,
  email,
  role: "operator",
  expiresInDays: 7,
});
const accept = (invitationId = "invite", revision = 1) => ({
  invitationId,
  revision,
});
const count = (table: string) =>
  bindings.HQ_DB.prepare(
    "SELECT count(*) AS total FROM " + table,
  ).first<number>("total");

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = { ...bindings, ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUDIENCE };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM installation_setup"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
  ]);
  service = as(account());
});
afterEach(() => vi.restoreAllMocks());

async function prepareSetup() {
  await bindings.HQ_DB.prepare("DELETE FROM workspaces").run();
  const permit = {
    setupId: "setup-one",
    workspaceId: "alpha",
    workspaceName: "My workspace",
    ownerSubject: "owner",
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  runtime.INITIAL_OWNER_SETUP = JSON.stringify(permit);
  return permit;
}
async function credential(subject = "owner") {
  const token = "synthetic-credential";
  await bindings.HQ_DB.prepare(
    "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('credential','alpha',?,'Automation',?,'[\"read\",\"workspace:admin\"]',?,?)",
  )
    .bind(
      subject,
      await credentialHash(token),
      new Date(now).toISOString(),
      new Date(now + 600000).toISOString(),
    )
    .run();
  return {
    ...account(subject),
    access: undefined,
    tokenId: "credential",
    workspaceId: "alpha",
    scopes: [CAPABILITY.READ, CAPABILITY.ADMIN],
  };
}

describe("Deliberate first-owner setup", () => {
  it("requires the reviewed deployment permit and commits a single idempotent receipt with membership and audit", async () => {
    await prepareSetup();
    const status = await service.setupStatus({});
    expect(status).toMatchObject({
      state: "ready",
      workspaceName: "My workspace",
      owner: "owner@example.test",
    });
    if (status.state !== "ready") throw new Error("Missing setup");
    expect(await count("members")).toBe(0);
    const results = await Promise.all([
      service.setupApply({ fingerprint: status.fingerprint }),
      service.setupApply({ fingerprint: status.fingerprint }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await count("installation_setup")).toBe(1);
    expect(await count("members")).toBe(1);
    expect(await count("activity")).toBe(1);
    expect((await service.session()).workspaces).toMatchObject([
      { id: "alpha", role: "owner" },
    ]);
    runtime.INITIAL_OWNER_SETUP = undefined;
    expect(
      await service.setupApply({ fingerprint: status.fingerprint }),
    ).toEqual(results[0]);
    await bindings.HQ_DB.prepare("DELETE FROM workspaces").run();
    await prepareSetup();
    expect(await service.setupStatus({})).toEqual({
      state: "complete",
      workspaceId: "alpha",
    });
    await service.setupApply({ fingerprint: status.fingerprint });
    expect(await count("members")).toBe(0);
    await expect(
      service.setupApply({ fingerprint: "f".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects unverified, service, development, wrong-account and altered-plan initialization", async () => {
    const permit = await prepareSetup();
    const ready = await service.setupStatus({});
    if (ready.state !== "ready") throw new Error();
    for (const principal of [
      { subject: "owner", displayName: "Owner" },
      { ...account(), tokenId: "service" },
      {
        ...account(),
        access: { issuer: "https://wrong.example", audience: AUDIENCE },
      },
    ])
      await expect(
        as(principal).setupApply({ fingerprint: ready.fingerprint }),
      ).rejects.toMatchObject({ status: 403 });
    expect(await as(account("other")).setupStatus({})).toEqual({
      state: "unavailable",
    });
    await expect(
      as(account("other")).setupApply({ fingerprint: ready.fingerprint }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      new WorkspaceService(runtime, account(), true).setupApply({
        fingerprint: ready.fingerprint,
      }),
    ).rejects.toMatchObject({ status: 403 });
    runtime.INITIAL_OWNER_SETUP = JSON.stringify({
      ...permit,
      workspaceName: "Changed name",
    });
    await expect(
      service.setupApply({ fingerprint: ready.fingerprint }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("workspaces")).toBe(0);
  });
  it("fails closed for expired, future, oversized, malformed, long-lived permits and nonempty databases", async () => {
    const permit = await prepareSetup();
    for (const changes of [
      { expiresAt: new Date(now).toISOString() },
      { issuedAt: new Date(now + 1000).toISOString() },
      {
        expiresAt: new Date(
          now + MEMBERSHIP_LIMITS.SETUP_TTL_MS + 1,
        ).toISOString(),
      },
    ]) {
      runtime.INITIAL_OWNER_SETUP = JSON.stringify({ ...permit, ...changes });
      await expect(service.setupStatus({})).rejects.toMatchObject({
        status: 409,
      });
    }
    for (const raw of [
      "not-json",
      "x".repeat(MEMBERSHIP_LIMITS.SETUP_BYTES + 1),
      JSON.stringify({ ...permit, unexpected: true }),
    ]) {
      runtime.INITIAL_OWNER_SETUP = raw;
      await expect(service.setupStatus({})).rejects.toMatchObject({
        status: 503,
      });
    }
    runtime.INITIAL_OWNER_SETUP = JSON.stringify(permit);
    const ready = await service.setupStatus({});
    if (ready.state !== "ready") throw new Error();
    await bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('existing','Existing',?)",
    )
      .bind(new Date(now).toISOString())
      .run();
    expect(await service.setupStatus({})).toEqual({ state: "unavailable" });
    await expect(
      service.setupApply({ fingerprint: ready.fingerprint }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("installation_setup")).toBe(0);
  });
});

describe("Workspace membership", () => {
  it("restricts access administration and invite metadata to owners in the selected workspace", async () => {
    for (const subject of ["viewer", "operator"]) {
      await expect(
        as(account(subject)).membersList(workspace),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        as(account(subject)).invitationCreate(invitation()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        as(account(subject)).invitationsList(workspace),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        as(account(subject)).memberRemove(member("viewer")),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      service.membersList({ workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.membersList(workspace)).toHaveLength(3);
    for (const principal of [
      { ...account(), scopes: [CAPABILITY.READ] },
      { ...account(), scopes: [CAPABILITY.ADMIN] },
    ])
      await expect(
        as(principal).invitationCreate(invitation()),
      ).rejects.toMatchObject({ status: 403 });
  });
  it("serializes role edits and concurrent last-owner demotions or removal", async () => {
    await expect(
      service.memberUpdate({ ...member("owner"), role: "viewer" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.memberRemove(member("owner"))).rejects.toMatchObject({
      status: 409,
    });
    await service.memberUpdate({ ...member("operator"), role: "owner" });
    const results = await Promise.allSettled([
      service.memberUpdate({ ...member("owner"), role: "viewer" }),
      as(account("operator")).memberRemove(member("operator", 2)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS total FROM members WHERE workspace_id='alpha' AND role='owner'",
      ).first("total"),
    ).toBe(1);
    const live = await bindings.HQ_DB.prepare(
      "SELECT subject FROM members WHERE workspace_id='alpha' AND role='owner'",
    ).first<string>("subject");
    const edit = { ...member("viewer"), role: "operator" };
    const writes = await Promise.allSettled([
      as(account(live!)).memberUpdate(edit),
      as(account(live!)).memberUpdate(edit),
    ]);
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });
  it("rechecks authority atomically after request authorization", async () => {
    const original = service.authorize.bind(service);
    vi.spyOn(service, "authorize").mockImplementation(
      async (id, capability) => {
        const result = await original(id, capability);
        if (capability === CAPABILITY.ADMIN)
          await bindings.HQ_DB.prepare(
            "UPDATE members SET role='viewer' WHERE workspace_id='alpha' AND subject='owner'",
          ).run();
        return result;
      },
    );
    await expect(
      service.memberUpdate({ ...member("operator"), role: "owner" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("activity")).toBe(0);
  });
  it("revokes removed members' credentials and rejects stale pre-removal revisions after reinvitation", async () => {
    await credential("operator");
    await service.memberUpdate({ ...member("operator"), role: "owner" });
    await as(account("operator")).invitationCreate(invitation("from-removed"));
    await service.memberRemove(member("operator", 2));
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT revoked_at FROM credentials WHERE id='credential'",
      ).first("revoked_at"),
    ).toBeTruthy();
    expect(await as(account("recipient")).ownInvitations({})).toEqual([]);
    await service.invitationCreate(
      invitation("return", "operator@example.test"),
    );
    await as(account("operator")).invitationAccept(accept("return"));
    expect(
      (await service.membersList(workspace)).find(
        (item) => item.subject === "operator",
      ),
    ).toMatchObject({ revision: 3, role: "operator" });
    await expect(
      service.memberRemove(member("operator", 2)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT revoked_at FROM credentials WHERE id='credential'",
      ).first("revoked_at"),
    ).toBeTruthy();
  });
});

describe("Verified account invitations", () => {
  it("deduplicates creation and acceptance, pins the verified subject, and minimizes read-only audit", async () => {
    const input = invitation("invite", "Recipient@Example.Test");
    const invites = await Promise.all([
      service.invitationCreate(input),
      service.invitationCreate(input),
    ]);
    expect(invites[0]).toEqual(invites[1]);
    expect(invites[0].email).toBe("recipient@example.test");
    const recipient = as(account("recipient"));
    expect(await recipient.ownInvitations({})).toMatchObject([
      { id: "invite", workspaceName: "Alpha", role: "operator" },
    ]);
    expect(await as(account("stranger")).ownInvitations({})).toEqual([]);
    await expect(
      as({
        subject: "recipient",
        displayName: "recipient@example.test",
      }).invitationAccept(accept()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as(account("stranger")).invitationAccept(accept()),
    ).rejects.toMatchObject({ status: 404 });
    const results = await Promise.all([
      recipient.invitationAccept(accept()),
      recipient.invitationAccept(accept()),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await recipient.session()).workspaces).toMatchObject([
      { id: "alpha", role: "operator" },
    ]);
    expect(await recipient.ownInvitations({})).toEqual([]);
    expect((await service.invitationsList(workspace))[0].state).toBe(
      "accepted",
    );
    const activity = await as(account("viewer")).activity(workspace);
    expect(
      activity.filter((item) => item.type === "invitation.created"),
    ).toHaveLength(1);
    expect(
      activity.filter((item) => item.type === "invitation.accepted"),
    ).toHaveLength(1);
    expect(
      activity.find((item) => item.type === "invitation.created")?.summary,
    ).not.toContain("recipient@example.test");
  });
  it("rejects conflicting duplicate invitations, wrong revisions, expired or revoked invitations, and existing-member promotion", async () => {
    await service.invitationCreate(invitation());
    await expect(
      service.invitationCreate({ ...invitation(), role: "owner" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.invitationCreate(invitation("duplicate")),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(account("recipient")).invitationAccept(accept("invite", 2)),
    ).rejects.toMatchObject({ status: 409 });
    await service.invitationRevoke({ ...workspace, ...accept() });
    await expect(
      as(account("recipient")).invitationAccept(accept()),
    ).rejects.toMatchObject({ status: 409 });
    await service.invitationCreate(invitation("expired"));
    now += 8 * 86400000;
    expect(await as(account("recipient")).ownInvitations({})).toEqual([]);
    await expect(
      as(account("recipient")).invitationAccept(accept("expired")),
    ).rejects.toMatchObject({ status: 409 });
    await service.invitationCreate(invitation("replacement"));
    expect(
      (await service.invitationsList(workspace)).find(
        (item) => item.id === "expired",
      )?.state,
    ).toBe("expired");
    await service.invitationCreate({
      ...invitation("existing", "viewer@example.test"),
      role: "owner",
    });
    await expect(
      as(account("viewer")).invitationAccept(accept("existing")),
    ).rejects.toMatchObject({ status: 409 });
    expect((await as(account("viewer")).session()).workspaces[0].role).toBe(
      "viewer",
    );
  });
  it("invalidates invitations when the inviter or its scoped credential loses authority", async () => {
    const principal = await credential();
    await as(principal).invitationCreate(invitation());
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='credential'",
    )
      .bind(new Date(now).toISOString())
      .run();
    expect(await as(account("recipient")).ownInvitations({})).toEqual([]);
    await expect(
      as(account("recipient")).invitationAccept(accept()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(principal).memberUpdate({ ...member("viewer"), role: "operator" }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      as({ ...account("recipient"), tokenId: "credential" }).invitationAccept(
        accept(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.invitationCreate(invitation("human", "second@example.test"));
    await service.memberUpdate({ ...member("operator"), role: "owner" });
    await service.memberUpdate({ ...member("owner"), role: "operator" });
    expect(await as(account("second")).ownInvitations({})).toEqual([]);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT state FROM invitations WHERE id='human'",
      ).first("state"),
    ).toBe("revoked");
  });
  it("bounds member capacity and invitation expiry and rejects unrecognized inputs", async () => {
    await expect(
      service.invitationCreate({ ...invitation(), expiresInDays: 31 }),
    ).rejects.toThrow();
    await expect(
      service.invitationCreate({ ...invitation(), unexpected: true }),
    ).rejects.toThrow();
    await service.invitationCreate(invitation());
    const inserts = Array.from(
      { length: MEMBERSHIP_LIMITS.MEMBERS - 3 },
      (_, index) =>
        bindings.HQ_DB.prepare(
          "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha',?,?,'viewer')",
        ).bind("capacity-" + index, "Capacity"),
    );
    await bindings.HQ_DB.batch(inserts);
    await expect(
      as(account("recipient")).invitationAccept(accept()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.invitationCreate(invitation("full", "full@example.test")),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("members")).toBe(MEMBERSHIP_LIMITS.MEMBERS + 1);
  });
  it("shares schema-backed commands with the HTTP API and MCP without accepting forged identity input", async () => {
    for (const definition of Object.values(commands))
      expect(() => z.toJSONSchema(definition.schema)).not.toThrow();
    const app = createApplication(async () => account());
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/invitation_create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify(invitation()),
      }),
      runtime,
    );
    expect(response.status).toBe(200);
    const rpc = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "members_list", arguments: workspace },
        }),
      }),
      runtime,
    );
    expect(rpc.status).toBe(200);
    expect(await rpc.text()).toContain("Owner");
    const forged = await app.fetch(
      new Request("https://hq.example/api/commands/invitations_mine", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify({ email: "recipient@example.test" }),
      }),
      runtime,
    );
    expect(forged.status).toBe(400);
  });
});
