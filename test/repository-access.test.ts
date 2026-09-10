import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  ROLE_CAPABILITIES,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import {
  hqOperationGates,
  repositoryAccessSchema,
} from "../shared/repository-access";
import { SOURCE_LIMITS } from "../shared/sources";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { callCommand, clientConfiguration } from "../cli/client";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspaceId = "alpha";
const SECRET = "synthetic-never-return-this-value";
let now: number;
let runtime: Env;
let repositoryId: string;
const as = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
const input = () => ({ workspaceId, repositoryId });
async function source(
  id = "github",
  credentialRef: string | null = "reference",
) {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare(
      "INSERT INTO connections (workspace_id,id,name,provider,credential_ref,configuration_json,enabled) VALUES ('alpha',?,?,'github',?,'{\"refreshIntervalMinutes\":15}',1)",
    ).bind(id, "Source " + id, credentialRef),
    bindings.HQ_DB.prepare(
      "INSERT INTO source_repositories (workspace_id,source_id,repository_id) VALUES ('alpha',?,?)",
    ).bind(id, repositoryId),
  ]);
}
async function credential() {
  await bindings.HQ_DB.prepare(
    "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('client','alpha','owner','Synthetic client','synthetic-hash','[\"read\"]',?,?)",
  )
    .bind(new Date(now).toISOString(), new Date(now + 86400000).toISOString())
    .run();
  return {
    tokenId: "client",
    workspaceId,
    scopes: [CAPABILITY.READ],
    expiresAt: now + 86400000,
  };
}
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      reference: {
        workspaceId,
        name: "Private reference label",
        token: SECRET,
      },
    }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  repositoryId = (
    await as().createRepository({
      workspaceId,
      repository: {
        fullName: "example/permissions",
        projectId: "project",
        description: "",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    })
  ).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("distinguishes live HQ roles from provider administration without calls or mutations", async () => {
  const fetcher = vi.fn(() => {
    throw new Error("No provider request allowed");
  });
  vi.stubGlobal("fetch", fetcher);
  await source();
  const before = await bindings.HQ_DB.prepare(
    "SELECT COUNT(*) AS total FROM activity",
  ).first<number>("total");
  for (const role of ["owner", "operator", "viewer"] as const) {
    const result = await as(role).repositoryAccess(input());
    expect(result.hq).toEqual({
      role,
      client: "session",
      gates: hqOperationGates(role, ROLE_CAPABILITIES[role]),
    });
    expect(result.github).toMatchObject({
      webhookAdapter: "not_supported",
      administration: "not_verified",
      sources: [
        {
          credential: "configured",
          grant: "not_verified",
          configurationValid: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-never|Private reference|credentialRef|configuration_json/,
    );
    expect(repositoryAccessSchema.safeParse(result).success).toBe(true);
  }
  expect(
    hqOperationGates("viewer", [CAPABILITY.READ]).find(
      (gate) => gate.id === "operate",
    )?.state,
  ).toBe("role_required");
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await bindings.HQ_DB.prepare(
      "SELECT COUNT(*) AS total FROM activity",
    ).first<number>("total"),
  ).toBe(before);
});
it("never turns maintained or watchlist into an upstream grant", async () => {
  const unconfigured = await as().repositoryAccess(input());
  expect(unconfigured.github.sources).toEqual([]);
  await source();
  const watchlist = await as().repositoryAccess(input());
  await bindings.HQ_DB.prepare(
    "UPDATE repositories SET classification='maintained' WHERE id=?",
  )
    .bind(repositoryId)
    .run();
  const maintained = await as().repositoryAccess(input());
  expect(watchlist.github).toEqual(maintained.github);
  expect(watchlist.hq).toEqual(maintained.hq);
});
it("keeps disabled collection, invalid configuration and unavailable credentials separate", async () => {
  await source("missing", null);
  await source("disabled");
  await bindings.HQ_DB.prepare(
    "UPDATE connections SET enabled=0,configuration_json='{}' WHERE id='disabled'",
  ).run();
  const result = await as().repositoryAccess(input());
  expect(result.github.sources).toMatchObject([
    {
      id: "disabled",
      enabled: false,
      credential: "configured",
      configurationValid: false,
    },
    {
      id: "missing",
      enabled: true,
      credential: "unavailable",
      configurationValid: true,
    },
  ]);
  runtime.GITHUB_CREDENTIALS = JSON.stringify({
    reference: { workspaceId: "beta", name: "Wrong workspace", token: SECRET },
  });
  expect(
    (await as().repositoryAccess(input())).github.sources.every(
      (value) => value.credential === "unavailable",
    ),
  ).toBe(true);
});
it("uses live client scopes as well as its principal snapshot and owner role", async () => {
  const principal = await credential();
  const service = as("owner", {
    ...principal,
    scopes: [...ROLE_CAPABILITIES.owner],
  });
  const result = await service.repositoryAccess(input());
  expect(result.hq).toMatchObject({ role: "owner", client: "credential" });
  expect(result.hq.gates.find((gate) => gate.id === "metadata")?.state).toBe(
    "scope_required",
  );
  expect(result.hq.gates.find((gate) => gate.id === "observe")?.state).toBe(
    "allowed",
  );
  await bindings.HQ_DB.prepare(
    "UPDATE credentials SET scopes_json='[\"read\",\"metadata:write\"]' WHERE id='client'",
  ).run();
  expect(
    (await as("owner", principal).repositoryAccess(input())).hq.gates.find(
      (gate) => gate.id === "metadata",
    )?.state,
  ).toBe("scope_required");
  expect(
    (await service.repositoryAccess(input())).hq.gates.find(
      (gate) => gate.id === "metadata",
    )?.state,
  ).toBe("allowed");
});
it("rejects revoked, expired, reporting-only, foreign and missing authority", async () => {
  const principal = await credential();
  for (const extra of [
    { ...principal, sourceId: "publisher" },
    { ...principal, reporterId: "agent" },
    { ...principal, workspaceId: "beta" },
    { expiresAt: now },
  ]) {
    await expect(
      as("owner", extra).repositoryAccess(input()),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  }
  await expect(as("other").repositoryAccess(input())).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    as().repositoryAccess({ ...input(), repositoryId: "missing" }),
  ).rejects.toMatchObject({ status: 404 });
  await bindings.HQ_DB.prepare(
    "UPDATE credentials SET revoked_at=? WHERE id='client'",
  )
    .bind(new Date(now).toISOString())
    .run();
  await expect(
    as("owner", principal).repositoryAccess(input()),
  ).rejects.toMatchObject({ status: 403 });
  await bindings.HQ_DB.prepare(
    "UPDATE credentials SET revoked_at=NULL,expires_at='2020-01-01T00:00:00Z' WHERE id='client'",
  ).run();
  await expect(
    as("owner", principal).repositoryAccess(input()),
  ).rejects.toMatchObject({ status: 403 });
});
it("rechecks live authority after the metadata read", async () => {
  const service = as();
  const authorize = service.authorize.bind(service);
  let calls = 0;
  vi.spyOn(service, "authorize").mockImplementation(async (...args) => {
    if (++calls === 2)
      await bindings.HQ_DB.prepare(
        "DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'",
      ).run();
    return authorize(...args);
  });
  await expect(service.repositoryAccess(input())).rejects.toMatchObject({
    status: 404,
  });
});
it("bounds enrolled metadata and rejects caller-owned provider paths", async () => {
  for (const extra of [
    { sourceId: "github" },
    { url: "https://example.invalid" },
    { credential: SECRET },
  ])
    expect(
      commands.repository_access.schema.safeParse({ ...input(), ...extra })
        .success,
    ).toBe(false);
  await source();
  await bindings.HQ_DB.prepare(
    "UPDATE connections SET name=? WHERE id='github'",
  )
    .bind("x".repeat(121))
    .run();
  await expect(as().repositoryAccess(input())).rejects.toMatchObject({
    status: 503,
  });
  await bindings.HQ_DB.prepare(
    "UPDATE connections SET name='Restored' WHERE id='github'",
  ).run();
  for (let index = 0; index < SOURCE_LIMITS.SOURCES; index++)
    await source("source-" + index);
  await expect(as().repositoryAccess(input())).rejects.toMatchObject({
    status: 503,
  });
});
it("shares a closed-world read-only command across HTTP, CLI and MCP", async () => {
  const app = createApplication(async () => ({
    subject: "viewer",
    displayName: "Viewer",
  }));
  vi.stubGlobal("fetch", (target: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(target)).origin).toBe("https://hq.example");
    return app.fetch(
      new Request(String(target), { ...init, redirect: "manual" }),
      runtime,
    );
  });
  const config = clientConfiguration(
    "https://hq.example",
    false,
    "synthetic-hq-token",
    undefined,
    undefined,
    undefined,
  );
  const result = await callCommand(config, "repository_access", input());
  expect(repositoryAccessSchema.safeParse(result).success).toBe(true);
  expect(
    commandAnnotations(
      "repository_access",
      commands.repository_access.readOnly,
    ),
  ).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  const response = await app.fetch(
    new Request("https://hq.example/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer synthetic-hq-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "repository_access", arguments: input() },
      }),
    }),
    runtime,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("role_required");
});
