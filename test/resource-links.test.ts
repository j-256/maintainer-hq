import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { RESOURCE_LINK_LIMITS } from "../shared/resource-links";
import { REPOSITORY_CONTEXT_LIMITS } from "../shared/repository-context";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import {
  captureResourceActivity,
  copyActivityContext,
} from "../worker/resource-links";
import { createApplication } from "../worker/app";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const reference = {
  ...workspace,
  kind: "hook",
  connectionId: "hooks",
  resourceKey: "shared-hook",
};
const now = new Date().toISOString();
function as(
  subject = "owner",
  extra: Partial<Principal> = {},
  runtime = bindings,
) {
  return new WorkspaceService(runtime, {
    subject,
    displayName: subject,
    ...extra,
  });
}
async function save(
  repositoryIds = ["repo-a", "repo-b"],
  revision = 0,
  fields = {},
) {
  return as().resourceRepositoriesSave({
    ...reference,
    connectionRevision: 1,
    revision,
    repositoryIds,
    ...fields,
  });
}

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(now, now),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project',''),('beta-project','beta','Beta project','')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO connections (id,workspace_id,name,provider) VALUES ('hooks','alpha','Primary hooks','hookrelay'),('monitors','alpha','Primary monitoring','endpoint-monitor'),('other','beta','Other hooks','hookrelay')",
    ),
    ...["repo-a", "repo-b", "repo-c"].map((id) =>
      bindings.HQ_DB.prepare(
        `INSERT INTO repositories
      (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES (?,'alpha',?,'','project','maintained','active',?,?,?)`,
      ).bind(
        id,
        "example/" + id,
        JSON.stringify(DEFAULT_EXPECTATIONS),
        now,
        id,
      ),
    ),
    bindings.HQ_DB.prepare(
      `INSERT INTO repositories
      (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES ('foreign','beta','example/foreign','','beta-project','maintained','active',?,?,'foreign')`,
    ).bind(JSON.stringify(DEFAULT_EXPECTATIONS), now),
  ]);
});

describe("Bounded repository overview context", () => {
  const input = { ...workspace, repositoryId: "repo-a" };
  const secretResource = (index: number) => ({
    id: "worker-" + index,
    label: "Worker " + index,
    identity: "private-provider-identity-canary",
    repositories: [{ id: "repo-a", fullName: "example/repo-a" }],
  });
  async function secrets(resources = [secretResource(0)]) {
    await bindings.HQ_DB.prepare(
      `INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id)
      VALUES ('alpha','secrets','Worker secrets','cloudflare-workers','private-credential-canary',?,0,1,'initial')`,
    )
      .bind(JSON.stringify(resources))
      .run();
  }

  it("returns exact counts with bounded disabled and shared previews without contacting providers or exposing custody", async () => {
    const size = REPOSITORY_CONTEXT_LIMITS.RESOURCE_PREVIEW + 2;
    for (let index = 0; index < size; index++) {
      await save(["repo-a", "repo-b"], 0, { resourceKey: "hook-" + index });
      await save(["repo-a"], 0, {
        kind: "monitor",
        connectionId: "monitors",
        resourceKey: "target-" + index,
      });
    }
    await bindings.HQ_DB.prepare(
      "UPDATE connections SET enabled=0 WHERE id='hooks'",
    ).run();
    await secrets(
      Array.from({ length: size }, (_, index) => secretResource(index)),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No provider reads expected"));
    try {
      const result = await as("viewer").repositoryContext(input);
      expect(result).toMatchObject({
        repositoryId: "repo-a",
        hooks: {
          total: size,
          items: [
            expect.objectContaining({
              connectionEnabled: false,
              repositoryCount: 2,
            }),
            expect.anything(),
            expect.anything(),
          ],
        },
        monitoring: { total: size },
        secrets: {
          total: size,
          items: [
            expect.objectContaining({
              connectionEnabled: false,
              identityMatches: true,
              providerKind: "cloudflare-workers",
            }),
            expect.anything(),
            expect.anything(),
          ],
        },
      });
      for (const section of [result.hooks, result.monitoring, result.secrets])
        expect(section.items).toHaveLength(
          REPOSITORY_CONTEXT_LIMITS.RESOURCE_PREVIEW,
        );
      expect(result.secrets.items.map((item) => item.resourceId)).toEqual([
        "worker-0",
        "worker-1",
        "worker-2",
      ]);
      const output = JSON.stringify(result);
      for (const canary of [
        "private-provider-identity-canary",
        "private-credential-canary",
        "credentialRef",
        "resources_json",
      ])
        expect(output).not.toContain(canary);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("does not infer links from names or project membership and distinguishes a renamed Secrets binding", async () => {
    await secrets();
    const empty = await as().repositoryContext({
      ...workspace,
      repositoryId: "repo-c",
    });
    for (const section of [empty.hooks, empty.monitoring, empty.secrets])
      expect(section).toEqual({ total: 0, items: [] });
    await bindings.HQ_DB.prepare(
      "UPDATE repositories SET full_name='example/renamed',revision=revision+1 WHERE id='repo-a'",
    ).run();
    expect(
      (await as().repositoryContext(input)).secrets.items[0],
    ).toMatchObject({ identityMatches: false });
    expect((await as().repositoryContext(input)).hooks).toEqual({
      total: 0,
      items: [],
    });
  });

  it("requires workspace-local repository identity and live reader access", async () => {
    for (const repositoryId of ["foreign", "missing"])
      await expect(
        as().repositoryContext({ ...workspace, repositoryId }),
      ).rejects.toMatchObject({ status: 404 });
    await expect(as("outside").repositoryContext(input)).rejects.toMatchObject({
      status: 404,
    });
    for (const principal of [
      { reporterId: "reporter" },
      { sourceId: "publisher" },
      { scopes: [CAPABILITY.ACTIVITY] },
    ])
      await expect(
        as("owner", principal).repositoryContext(input),
      ).rejects.toMatchObject({ status: 403 });
    await bindings.HQ_DB.prepare(
      `INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at)
      VALUES ('reader','alpha','owner','Reader','synthetic-hash','["read"]',?,?)`,
    )
      .bind(now, new Date(Date.now() + 60000).toISOString())
      .run();
    const reader = as("owner", {
      tokenId: "reader",
      workspaceId: "alpha",
      scopes: [CAPABILITY.READ],
    });
    expect((await reader.repositoryContext(input)).repositoryId).toBe("repo-a");
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='reader'",
    )
      .bind(now)
      .run();
    await expect(reader.repositoryContext(input)).rejects.toMatchObject({
      status: 403,
    });
  });

  it.each([
    ["DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'", 404],
    ["DELETE FROM repositories WHERE id='repo-a'", 404],
    [
      "UPDATE repositories SET full_name='example/changed',revision=revision+1 WHERE id='repo-a'",
      409,
    ],
  ])(
    "rechecks authority and identity after the context read: %s",
    async (sql, status) => {
      const db = new Proxy(bindings.HQ_DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              await target.prepare(sql).run();
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const runtime = new Proxy(bindings, {
        get: (target, key) => (key === "HQ_DB" ? db : Reflect.get(target, key)),
      });
      await expect(
        as("owner", {}, runtime).repositoryContext(input),
      ).rejects.toMatchObject({ status });
    },
  );

  it("reports malformed metadata without returning private bindings", async () => {
    await secrets([{ ...secretResource(0), label: "" }]);
    await expect(as().repositoryContext(input)).rejects.toMatchObject({
      code: "metadata_unavailable",
      status: 503,
    });
  });

  it("shares the read-only contract with the browser, CLI and MCP registry", async () => {
    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/repository_context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify(input),
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositoryId: "repo-a",
      secrets: { total: 0, items: [] },
    });
    expect(commands.repository_context.schema.parse(input)).toEqual(input);
    expect(commands.repository_context.method).toBe("repositoryContext");
    expect(
      commandAnnotations(
        "repository_context",
        commands.repository_context.readOnly,
      ),
    ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe("Explicit shared-resource repository links", () => {
  it("links a hook to multiple repositories without changing the provider or inferring project ownership", async () => {
    expect(await as().resourceRepositories(reference)).toMatchObject({
      revision: 0,
      connectionRevision: 1,
      repositoryIds: [],
    });
    const linked = await save();
    expect(linked).toMatchObject({
      revision: 1,
      repositoryIds: ["repo-a", "repo-b"],
    });
    for (const repositoryId of linked.repositoryIds) {
      expect(
        await as().repositoryResources({ ...workspace, repositoryId }),
      ).toMatchObject({
        items: [
          {
            kind: "hook",
            resourceKey: "shared-hook",
            connectionName: "Primary hooks",
            repositoryCount: 2,
          },
        ],
        nextCursor: null,
      });
    }
    expect(
      (await as().repositoryResources({ ...workspace, repositoryId: "repo-c" }))
        .items,
    ).toEqual([]);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT configuration_json,revision FROM connections WHERE id='hooks'",
      ).first(),
    ).toEqual({ configuration_json: "{}", revision: 1 });
    const monitor = await save(["repo-a"], 0, {
      kind: "monitor",
      connectionId: "monitors",
      resourceKey: "example-health",
    });
    expect(monitor.kind).toBe("monitor");
    expect(
      (
        await as().repositoryResources({
          ...workspace,
          repositoryId: "repo-a",
          kind: "monitor",
        })
      ).items,
    ).toHaveLength(1);
  });

  it("requires live edit authority, correct provider identity, and workspace-local repositories", async () => {
    const input = {
      ...reference,
      connectionRevision: 1,
      revision: 0,
      repositoryIds: ["repo-a"],
    };
    await expect(
      as("viewer").resourceRepositoriesSave(input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("outside").resourceRepositories(reference),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as("owner", { reporterId: "reporter" }).resourceRepositories(reference),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("owner", { sourceId: "source" }).resourceRepositoriesSave(input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(save(["foreign"])).rejects.toMatchObject({ status: 409 });
    await expect(save(["missing"])).rejects.toMatchObject({ status: 409 });
    await expect(save(["repo-a", "repo-a"])).rejects.toThrow();
    await expect(
      save(["repo-a"], 0, { kind: "monitor" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      save(["repo-a"], 0, {
        kind: "monitor",
        connectionId: "monitors",
        resourceKey: "bad-",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      as().repositoryResources({ ...workspace, repositoryId: "foreign" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT COUNT(*) AS count FROM activity",
        ).first()
      )?.count,
    ).toBe(0);
    expect(await as("operator").resourceRepositoriesSave(input)).toMatchObject({
      revision: 1,
    });
  });

  it("rejects stale forms and connection changes without losing saved links", async () => {
    await save();
    await expect(save(["repo-c"], 0)).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE connections SET revision=revision+1 WHERE id='hooks'",
    ).run();
    await expect(save(["repo-c"], 1)).rejects.toMatchObject({ status: 409 });
    expect(await as().resourceRepositories(reference)).toMatchObject({
      repositoryIds: ["repo-a", "repo-b"],
      revision: 1,
      connectionRevision: 2,
    });
    await save(["repo-c"], 1, { connectionRevision: 2 });
    expect(
      (await as().repositoryResources({ ...workspace, repositoryId: "repo-a" }))
        .items,
    ).toEqual([]);
  });

  it("captures historical relevance and carries it forward to the operation receipt", async () => {
    await save();
    const event = await as().addActivity({
      ...workspace,
      eventId: "hook-operation",
      kind: "progress",
      title: "Hook operation",
      summary: "Synthetic operation",
      resourceId: null,
    });
    await bindings.HQ_DB.batch([
      ...captureResourceActivity(
        bindings.HQ_DB,
        "alpha",
        event.id,
        "hooks",
        "hook",
        "shared-hook",
      ),
    ]);
    await save(["repo-c"], 1);
    await as().addActivity({
      ...workspace,
      eventId: "hook-result",
      kind: "verification",
      title: "Hook result",
      summary: "Synthetic receipt",
      resourceId: null,
    });
    await bindings.HQ_DB.batch([
      ...copyActivityContext(bindings.HQ_DB, "alpha", event.id, "hook-result"),
    ]);
    for (const repositoryId of ["repo-a", "repo-b"]) {
      const feed = await as().activityFeed({ ...workspace, repositoryId });
      expect(feed.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "event",
            event: expect.objectContaining({ id: "hook-operation" }),
          }),
          expect.objectContaining({
            kind: "event",
            event: expect.objectContaining({ id: "hook-result" }),
          }),
        ]),
      );
    }
    const newer = await as().activityFeed({
      ...workspace,
      repositoryId: "repo-c",
    });
    expect(newer.groups).toHaveLength(1);
    expect(newer.groups[0]).toMatchObject({
      kind: "event",
      event: { type: "resource.repositories.updated" },
    });
    expect((await as().resourceRepositories(reference)).repositoryIds).toEqual([
      "repo-c",
    ]);
  });

  it("pages resource links without duplicates and binds cursors to the repository and filter", async () => {
    for (let index = 0; index <= RESOURCE_LINK_LIMITS.PAGE_SIZE; index++)
      await save(["repo-a"], 0, {
        resourceKey: "hook-" + String(index).padStart(3, "0"),
      });
    const first = await as().repositoryResources({
      ...workspace,
      repositoryId: "repo-a",
    });
    const next = await as().repositoryResources({
      ...workspace,
      repositoryId: "repo-a",
      cursor: first.nextCursor,
    });
    expect(first.items).toHaveLength(RESOURCE_LINK_LIMITS.PAGE_SIZE);
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...next.items].map((item) => item.resourceKey))
        .size,
    ).toBe(RESOURCE_LINK_LIMITS.PAGE_SIZE + 1);
    await expect(
      as().repositoryResources({
        ...workspace,
        repositoryId: "repo-b",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      as().repositoryResources({
        ...workspace,
        repositoryId: "repo-a",
        kind: "hook",
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("checks membership inside the write transaction and exposes browser, CLI, and MCP commands", async () => {
    const db = new Proxy(bindings.HQ_DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
              )
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = new Proxy(bindings, {
      get: (target, key) => (key === "HQ_DB" ? db : Reflect.get(target, key)),
    });
    await expect(
      as("owner", {}, runtime).resourceRepositoriesSave({
        ...reference,
        revision: 0,
        connectionRevision: 1,
        repositoryIds: ["repo-a"],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT COUNT(*) AS count FROM activity",
        ).first()
      )?.count,
    ).toBe(0);
    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/repository_resources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify({ ...workspace, repositoryId: "repo-a" }),
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [] });
    expect(commands.resource_repositories_save.method).toBe(
      "resourceRepositoriesSave",
    );
    expect(commandAnnotations("repository_resources", true)).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(
      commandAnnotations("resource_repositories_save", false),
    ).toMatchObject({
      readOnlyHint: false,
      openWorldHint: false,
      idempotentHint: false,
    });
  });
});
