import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import {
  REPOSITORY_CREDENTIAL_COVERAGE_LIMITS as LIMITS,
  repositoryCredentialCoverageSchema,
} from "../shared/repository-credential-coverage";
import { PROVIDER_CREDENTIAL_LIMITS } from "../shared/provider-credentials";
import { SOURCE_LIMITS } from "../shared/sources";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { callCommand, clientConfiguration } from "../cli/client";
import { countD1Statements } from "./helpers/d1-count";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspaceId = "alpha";
const PRIVATE = "PRIVATE_VALUE_NEVER_RETURN";
let now: number;
let runtime: Env;
let repositoryIds: string[];
const service = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
const input = () => ({ workspaceId, repositoryIds });

async function source(
  id = "github",
  credentialRef: string | null = "private-read-reference",
) {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare(
      "INSERT INTO connections (workspace_id,id,name,provider,credential_ref,configuration_json,enabled) VALUES ('alpha',?,?,'github',?,'{\"refreshIntervalMinutes\":15}',1)",
    ).bind(id, PRIVATE, credentialRef),
    ...repositoryIds.map((repositoryId) =>
      bindings.HQ_DB.prepare(
        "INSERT INTO source_repositories (workspace_id,source_id,repository_id) VALUES ('alpha',?,?)",
      ).bind(id, repositoryId),
    ),
  ]);
}
async function maintenance(
  id = "writer",
  options: {
    names?: string[];
    writable?: boolean;
    expiresAt?: string;
    key?: string;
    workspace?: string;
    kind?: string;
    retired?: boolean;
  } = {},
) {
  const retired = options.retired ?? false;
  await bindings.HQ_DB.prepare(
    "INSERT INTO provider_credentials (workspace_id,id,provider_kind,settings_json,revision,identity,key_id,nonce,ciphertext,created_at,updated_at,retired_at,write_id) VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?)",
  )
    .bind(
      options.workspace ?? workspaceId,
      "managed-private-" + id,
      options.kind ?? "github-repositories",
      JSON.stringify({
        name: PRIVATE,
        providerKind: options.kind ?? "github-repositories",
        writable: options.writable ?? true,
        expiresAt: options.expiresAt ?? new Date(now + 86400000).toISOString(),
        scope: {
          repositoryNames: options.names ?? [
            "example/one",
            "example/two",
            "private/not-requested",
          ],
        },
      }),
      PRIVATE,
      retired ? null : (options.key ?? "private-key"),
      retired ? null : "invalid-nonce-must-not-decrypt",
      retired ? null : "invalid-ciphertext-must-not-decrypt",
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      retired ? new Date(now).toISOString() : null,
      "fixture-write",
    )
    .run();
}
async function client() {
  await bindings.HQ_DB.prepare(
    "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('client','alpha','owner','Reader','synthetic-hash','[\"read\"]',?,?)",
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
function changeAfterRead(change: () => Promise<unknown>, afterBatch = 1) {
  let batches = 0;
  runtime = {
    ...runtime,
    HQ_DB: new Proxy(bindings.HQ_DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (++batches === afterBatch) await change();
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      "private-read-reference": { workspaceId, name: PRIVATE, token: PRIVATE },
    }),
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "private-key",
      keys: [{ id: "private-key", key: btoa("a".repeat(32)) }],
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
  repositoryIds = [];
  for (const name of ["one", "two"])
    repositoryIds.push(
      (
        await service().createRepository({
          workspaceId,
          repository: {
            fullName: "example/" + name,
            projectId: "project",
            description: "",
            classification: "maintained",
            lifecycle: "active",
            expectations: DEFAULT_EXPECTATIONS,
          },
        })
      ).id,
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lets readers inspect aggregate configured coverage without provider calls, decryption or mutations", async () => {
  await source();
  await maintenance();
  const principal = await client();
  const fetcher = vi.fn(() => {
    throw new Error("No provider calls");
  });
  vi.stubGlobal("fetch", fetcher);
  const snapshot = () =>
    bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "SELECT * FROM workspace_push_outbox ORDER BY workspace_id",
      ),
      bindings.HQ_DB.prepare("SELECT count(*) AS count FROM activity"),
    ]);
  const before = await snapshot();
  for (const subject of ["owner", "operator", "viewer"]) {
    const result = await service(subject).repositoryCredentialCoverage(input());
    expect(repositoryCredentialCoverageSchema.parse(result)).toEqual(result);
    expect(result.rows.map((row) => row.repository.id)).toEqual(repositoryIds);
    expect(result.rows[0]).toMatchObject({
      collection: {
        configured: 1,
        disabled: 0,
        invalidConfiguration: 0,
        credentialUnavailable: 0,
        grant: "not_verified",
      },
      maintenance: {
        configuredForWrites: 1,
        readOnly: 0,
        expired: 0,
        keyUnavailable: 0,
        grant: "not_verified",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_VALUE|managed-private|private-key|private-read-reference|private\/not-requested|nonce|ciphertext|credentialRef|settings_json|identity/,
    );
  }
  expect(
    (await service("owner", principal).repositoryCredentialCoverage(input()))
      .rows,
  ).toHaveLength(2);
  expect(fetcher).not.toHaveBeenCalled();
  const after = await snapshot();
  expect(after.map((result) => result.results)).toEqual(
    before.map((result) => result.results),
  );
});

it("keeps mixed availability, matching scopes, expiry and key state distinct", async () => {
  await maintenance("writer", { names: ["EXAMPLE/ONE"] });
  await maintenance("read-only", { writable: false });
  await maintenance("expired", { expiresAt: new Date(now).toISOString() });
  await maintenance("key-unavailable", { key: "missing-key" });
  await maintenance("retired", { retired: true });
  await maintenance("other-workspace", { workspace: "beta" });
  await maintenance("other-purpose", { kind: "github-actions" });
  const result = await service("viewer").repositoryCredentialCoverage(input());
  expect(result.rows.map((row) => row.maintenance)).toEqual([
    {
      configuredForWrites: 1,
      readOnly: 1,
      expired: 1,
      keyUnavailable: 1,
      grant: "not_verified",
    },
    {
      configuredForWrites: 0,
      readOnly: 1,
      expired: 1,
      keyUnavailable: 1,
      grant: "not_verified",
    },
  ]);
  runtime.PROVIDER_CREDENTIAL_KEYS = undefined;
  expect(
    (await service().repositoryCredentialCoverage(input())).rows[0].maintenance,
  ).toMatchObject({ configuredForWrites: 0, keyUnavailable: 3, expired: 1 });
});

it("separates missing enrollment from disabled, malformed and unconfigured collection", async () => {
  const empty = await service().repositoryCredentialCoverage(input());
  expect(empty.rows[0].collection).toEqual({
    configured: 0,
    disabled: 0,
    invalidConfiguration: 0,
    credentialUnavailable: 0,
    grant: "not_verified",
  });
  await source("ready");
  await source("missing", null);
  await source("disabled");
  await source("invalid");
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare(
      "UPDATE connections SET enabled=0 WHERE id='disabled'",
    ),
    bindings.HQ_DB.prepare(
      "UPDATE connections SET configuration_json='{}' WHERE id='invalid'",
    ),
  ]);
  expect(
    (await service().repositoryCredentialCoverage(input())).rows[0].collection,
  ).toEqual({
    configured: 1,
    disabled: 1,
    invalidConfiguration: 1,
    credentialUnavailable: 1,
    grant: "not_verified",
  });
  runtime.GITHUB_CREDENTIALS = JSON.stringify({
    "private-read-reference": {
      workspaceId: "beta",
      name: PRIVATE,
      token: PRIVATE,
    },
  });
  expect(
    (await service().repositoryCredentialCoverage(input())).rows[0].collection
      .credentialUnavailable,
  ).toBe(2);
});

it("preserves request order and rejects foreign or missing repositories without partial results", async () => {
  const result = await service().repositoryCredentialCoverage({
    workspaceId,
    repositoryIds: [...repositoryIds].reverse(),
  });
  expect(result.rows.map((row) => row.repository.id)).toEqual(
    [...repositoryIds].reverse(),
  );
  await bindings.HQ_DB.prepare(
    "INSERT INTO projects (id,workspace_id,name,description) VALUES ('other-project','beta','Other','')",
  ).run();
  const foreign = await service("other").createRepository({
    workspaceId: "beta",
    repository: {
      fullName: "example/foreign",
      projectId: "other-project",
      description: "",
      classification: "watchlist",
      lifecycle: "active",
      expectations: DEFAULT_EXPECTATIONS,
    },
  });
  for (const id of ["missing", foreign.id])
    await expect(
      service().repositoryCredentialCoverage({
        workspaceId,
        repositoryIds: [repositoryIds[0], id],
      }),
    ).rejects.toMatchObject({ status: 404 });
  await expect(
    service("other").repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: 404 });
});

it("rejects expired, revoked, cross-workspace, reporting-only and read-less clients", async () => {
  const principal = await client();
  for (const extra of [
    { ...principal, sourceId: "publisher" },
    { ...principal, reporterId: "reporter" },
    { ...principal, workspaceId: "beta" },
    { ...principal, expiresAt: now },
    { ...principal, scopes: [] },
  ]) {
    await expect(
      service("owner", extra).repositoryCredentialCoverage(input()),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  }
  await bindings.HQ_DB.prepare(
    "UPDATE credentials SET revoked_at=? WHERE id='client'",
  )
    .bind(new Date(now).toISOString())
    .run();
  await expect(
    service("owner", principal).repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: 403 });
  await bindings.HQ_DB.prepare(
    "UPDATE credentials SET revoked_at=NULL,expires_at='2020-01-01T00:00:00Z' WHERE id='client'",
  ).run();
  await expect(
    service("owner", principal).repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: 403 });
});

it.each(["membership", "repository", "source", "credential", "client"])(
  "rejects concurrent %s changes",
  async (kind) => {
    await source();
    await maintenance();
    const principal = await client();
    changeAfterRead(async () => {
      const queries = {
        membership:
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        repository:
          "UPDATE repositories SET revision=revision+1 WHERE workspace_id='alpha'",
        source:
          "UPDATE connections SET enabled=0 WHERE workspace_id='alpha' AND provider='github'",
        credential:
          "UPDATE provider_credentials SET revision=revision+1 WHERE workspace_id='alpha'",
        client: "UPDATE credentials SET scopes_json='[]' WHERE id='client'",
      };
      await bindings.HQ_DB.prepare(queries[kind as keyof typeof queries]).run();
    });
    await expect(
      service("owner", principal).repositoryCredentialCoverage(input()),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  },
);

it("fails explicitly for malformed maintenance metadata and resource bounds", async () => {
  await maintenance();
  await bindings.HQ_DB.prepare(
    "UPDATE provider_credentials SET settings_json='{}'",
  ).run();
  await expect(
    service().repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: 503 });
  await bindings.HQ_DB.prepare("DELETE FROM provider_credentials").run();
  for (let index = 0; index <= PROVIDER_CREDENTIAL_LIMITS.WORKSPACE; index++)
    await maintenance(String(index));
  await expect(
    service().repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: expect.any(Number) });
  await bindings.HQ_DB.prepare("DELETE FROM provider_credentials").run();
  for (let index = 0; index <= SOURCE_LIMITS.SOURCES; index++)
    await source("source-" + index);
  await expect(
    service().repositoryCredentialCoverage(input()),
  ).rejects.toMatchObject({ status: 503 });
});

it.each(["repository", "source", "credential"])(
  "rejects %s changes during final authorization",
  async (kind) => {
    await source();
    await maintenance();
    const reader = service("owner", await client());
    const authorize = reader.authorize.bind(reader);
    let authorizations = 0;
    vi.spyOn(reader, "authorize").mockImplementation(async (...args) => {
      if (++authorizations === 2) {
        const queries = {
          repository:
            "UPDATE repositories SET revision=revision+1 WHERE workspace_id='alpha'",
          source:
            "UPDATE connections SET enabled=0 WHERE workspace_id='alpha' AND provider='github'",
          credential:
            "UPDATE provider_credentials SET retired_at='2026-10-26T00:00:00Z',key_id=NULL,nonce=NULL,ciphertext=NULL WHERE workspace_id='alpha'",
        };
        await bindings.HQ_DB.prepare(
          queries[kind as keyof typeof queries],
        ).run();
      }
      return authorize(...args);
    });
    await expect(
      reader.repositoryCredentialCoverage(input()),
    ).rejects.toMatchObject({ status: 409 });
  },
);

it("evaluates maintenance expiry at the returned observation time", async () => {
  await maintenance("expires-during-read", {
    expiresAt: new Date(now + 1000).toISOString(),
  });
  changeAfterRead(async () => {
    now += 1000;
  }, 2);
  const result = await service().repositoryCredentialCoverage(input());
  expect(result.generatedAt).toBe(new Date(now).toISOString());
  expect(result.rows[0].maintenance).toMatchObject({
    configuredForWrites: 0,
    expired: 1,
  });
});

it("parses the configured credential catalog once for shared collection sources", async () => {
  for (let index = 0; index < 10; index++) await source("shared-" + index);
  const catalog = runtime.GITHUB_CREDENTIALS;
  const parser = vi.spyOn(JSON, "parse");
  const result = await service("viewer").repositoryCredentialCoverage(input());
  expect(result.rows[0].collection.configured).toBe(10);
  expect(parser.mock.calls.filter(([text]) => text === catalog)).toHaveLength(
    1,
  );
});

it("batches a bounded fleet and shares a closed-world read through HTTP, CLI and MCP", async () => {
  await source();
  await maintenance();
  const counter = countD1Statements(bindings.HQ_DB);
  runtime = { ...runtime, HQ_DB: counter.db };
  const result = await service("viewer").repositoryCredentialCoverage(input());
  const calls = counter.calls();
  expect(calls).toBeLessThan(15);
  expect(
    new TextEncoder().encode(JSON.stringify(result)).byteLength,
  ).toBeLessThan(LIMITS.RESPONSE_BYTES);
  const fullIds = [...repositoryIds];
  while (fullIds.length < LIMITS.REPOSITORIES)
    fullIds.push(
      (
        await service().createRepository({
          workspaceId,
          repository: {
            fullName: "example/fleet-" + fullIds.length,
            projectId: "project",
            description: "",
            classification: "watchlist",
            lifecycle: "active",
            expectations: DEFAULT_EXPECTATIONS,
          },
        })
      ).id,
    );
  counter.reset();
  const full = await service("viewer").repositoryCredentialCoverage({
    workspaceId,
    repositoryIds: fullIds,
  });
  expect(counter.calls()).toBe(calls);
  expect(full.rows).toHaveLength(LIMITS.REPOSITORIES);
  expect(
    new TextEncoder().encode(JSON.stringify(full)).byteLength,
  ).toBeLessThan(LIMITS.RESPONSE_BYTES);
  const command = commands.repository_credential_coverage;
  expect(
    commandAnnotations("repository_credential_coverage", command.readOnly),
  ).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  for (const fields of [
    { repositoryIds: [] },
    { repositoryIds: [repositoryIds[0], repositoryIds[0]] },
    {
      repositoryIds: Array.from(
        { length: LIMITS.REPOSITORIES + 1 },
        (_, index) => "repo-" + index,
      ),
    },
    { url: "https://example.invalid" },
    { credential: PRIVATE },
  ])
    expect(command.schema.safeParse({ ...input(), ...fields }).success).toBe(
      false,
    );
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
  expect(
    repositoryCredentialCoverageSchema.parse(
      await callCommand(config, "repository_credential_coverage", input()),
    ).rows,
  ).toHaveLength(2);
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
        params: { name: "repository_credential_coverage", arguments: input() },
      }),
    }),
    runtime,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("configuredForWrites");
});
