import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CAPABILITY, DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { callCommand, clientConfiguration } from "../cli/client";
import { request } from "../src/lib/api";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const origin = "https://hq.example";
const owner: Principal = { subject: "owner", displayName: "Owner" };
let reader: Principal;
let repositoryId: string;
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  const timestamp = new Date().toISOString();
  reader = {
    ...owner,
    tokenId: "reader",
    workspaceId: "alpha",
    scopes: [CAPABILITY.READ],
    expiresAt: Date.now() + 86400000,
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?)").bind(timestamp),
    bindings.HQ_DB.prepare("INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner')"),
    bindings.HQ_DB.prepare("INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')"),
    bindings.HQ_DB.prepare("INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('reader','alpha','owner','Synthetic reader','synthetic-hash','[\"read\"]',?,?)")
      .bind(timestamp, new Date(reader.expiresAt!).toISOString()),
  ]);
  repositoryId = (await new WorkspaceService(bindings, owner).createRepository({
    ...workspace,
    repository: {
      fullName: "example/private-inventory",
      description: "Synthetic private inventory",
      projectId: "project",
      classification: "maintained",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  })).id;
});
afterEach(() => vi.restoreAllMocks());

const readers = (service: WorkspaceService) => [
  () => service.session(),
  () => service.repositories(workspace),
  () => service.repository({ ...workspace, repositoryId }),
  () => service.activity(workspace),
  () => service.goals(workspace),
  () => service.connections(workspace),
  () => service.observations(workspace),
  () => service.preferencesGet(workspace),
];

for (const change of [
  "revoked_at='2026-01-01T00:00:00Z'",
  "expires_at='2020-01-01T00:00:00Z'",
  "scopes_json='[\"activity:write\"]'",
] as const) {
  it("rechecks a resolved reader after its live credential changes: " + change, async () => {
    const service = new WorkspaceService(bindings, reader);
    expect(await service.repositories(workspace)).toHaveLength(1);
    await bindings.HQ_DB.prepare("UPDATE credentials SET " + change + " WHERE id='reader'").run();
    for (const read of readers(service))
      await expect(read()).rejects.toMatchObject({ status: 403 });
  });
}

it("does not reuse an expired human identity for basic reads", async () => {
  const service = new WorkspaceService(bindings, { ...owner, expiresAt: Date.now() - 1 });
  for (const read of readers(service))
    await expect(read()).rejects.toMatchObject({ status: 401 });
});

it("binds live credentials to the resolved owner, workspace and publisher identity", async () => {
  for (const extra of [
    { subject: "someone-else" },
    { workspaceId: "beta" },
    { sourceId: "publisher" },
    { reporterId: "reporter" },
  ]) {
    const service = new WorkspaceService(bindings, { ...reader, ...extra });
    await expect(service.session()).rejects.toMatchObject({ status: 403 });
  }
});

it("enforces revocation between identity resolution and browser, CLI or MCP execution", async () => {
  const app = createApplication(async () => {
    await bindings.HQ_DB.prepare("UPDATE credentials SET revoked_at=? WHERE id='reader'")
      .bind(new Date().toISOString()).run();
    return reader;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => app.fetch(
    new Request(new URL(String(input), origin), {
      ...init,
      redirect: "manual",
      headers: { ...init?.headers, Origin: origin },
    }), bindings,
  ));
  await expect(request("/api/commands/repositories_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspace),
  })).rejects.toMatchObject({ status: 403 });
  await expect(callCommand(clientConfiguration(origin, false, "synthetic-token", "", "", ""),
    "repositories_list", workspace)).rejects.toThrow(/access|credential/);
  const response = await app.fetch(new Request(origin + "/mcp", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "repositories_list", arguments: workspace,
    } }),
  }), bindings);
  const result = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
  expect(result.result.isError).toBe(true);
  expect(JSON.parse(result.result.content[0].text).error.code).toBe("forbidden");
  expect(JSON.stringify(result)).not.toContain("private-inventory");
});
