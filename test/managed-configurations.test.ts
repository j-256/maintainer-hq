import { applyD1Migrations, env } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { commands, commandAnnotations } from "../shared/commands";
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_CUSTODY,
  MANAGED_CONFIGURATION_DESIRED_STATE,
  MANAGED_CONFIGURATION_STATUS,
  type ManagedConfigurationFields,
} from "../shared/managed-configurations";
import {
  SECRET_ENTRY_KIND,
  SECRET_MANAGEMENT,
  SECRET_PROVIDER_KIND,
} from "../shared/secrets";
import { createApplication } from "../worker/app";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const connection = { ...workspace, connectionId: "secrets" };
const target = {
  resourceId: "repo-a",
  scope: { kind: "repository" as const },
};
const destination = {
  connectionId: "secrets",
  connectionRevision: 1,
  target,
  name: "DEPLOY_REGION",
};
const PRIVATE = "synthetic-provider-token-canary";
const descriptor = {
  workspaceId: workspace.workspaceId,
  name: "Selected Actions configuration",
  revision: 1,
  token: PRIVATE,
  expiresAt: "2099-01-01T00:00:00.000Z",
  repositoryNames: ["example/repo-a", "example/repo-b"],
  writable: true,
};
const metadata = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
let runtime: Env;
let now: number;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let variables: Map<string, string>;
let writeStatus: number;
let repositoryIdentity: number;

function as(subject = "owner", extra: Partial<Principal> = {}) {
  return new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
}

function saveConnection(
  revision = 0,
  name = "Actions configuration",
  resourceIds = [target.resourceId],
) {
  return as().secretsConnectionSave({
    ...connection,
    revision,
    connection: {
      name,
      providerKind: SECRET_PROVIDER_KIND.GITHUB,
      providerRef: "selected",
      resourceIds,
      enabled: true,
    },
  });
}

function fields(
  desiredValue = "eu-west-1",
  desiredState: "present" | "absent" =
    MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
): ManagedConfigurationFields {
  return {
    label: "Deploy region",
    entryKind: SECRET_ENTRY_KIND.VARIABLE,
    custody: MANAGED_CONFIGURATION_CUSTODY.NONE,
    desiredValue,
    destinations: [{ destination, desiredState }],
  };
}

function saveConfiguration(
  revision = 0,
  requestId = "configuration-save",
  configuration = fields(),
) {
  return as().secretsConfigurationSave({
    ...workspace,
    configurationId: "deploy-region",
    revision,
    requestId,
    configuration,
  });
}

function plan(planId = "managed-review", configurationRevision = 1) {
  return as().secretsConfigurationPlan({
    ...workspace,
    configurationId: "deploy-region",
    configurationRevision,
    destinationIndex: 0,
    planId,
  });
}

function writes() {
  return fetcher.mock.calls.filter(([, init]) =>
    ["POST", "PATCH", "DELETE"].includes(init?.method ?? "GET"),
  );
}

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));

beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    GITHUB_SECRET_CREDENTIALS: JSON.stringify({ selected: descriptor }),
  };
  variables = new Map([[destination.name, "us-central1"]]);
  writeStatus = 204;
  repositoryIdentity = 42;
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
    bindings.HQ_DB.prepare(
      `INSERT INTO repositories
      (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES ('repo-a','alpha','example/repo-a','','project','maintained','active',?,?,?),
        ('repo-b','alpha','example/repo-b','','project','maintained','active',?,?,?)`,
    ).bind(
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
      "repo-a",
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
      "repo-b",
    ),
  ]);
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    expect(url.origin).toBe("https://api.github.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + PRIVATE,
    );
    if (url.pathname === "/repos/example/repo-a")
      return Response.json({
        id: repositoryIdentity,
        full_name: "example/repo-a",
        archived: false,
        disabled: false,
        owner: { id: 7, login: "example", type: "Organization" },
        private: true,
      });
    const environmentRoots = [
      "/repos/example/repo-a/environments/Production%20%2F%20Blue",
      "/repos/example/repo-a/environments/production%20%2F%20blue",
    ];
    if (environmentRoots.includes(url.pathname))
      return Response.json({ id: 8, name: "Production / Blue" });
    const variableRoots = [
      "/repos/example/repo-a/actions/variables",
      ...environmentRoots.map((root) => root + "/variables"),
    ];
    const variableRoot = variableRoots.find(
      (root) => url.pathname === root || url.pathname.startsWith(root + "/"),
    );
    if (url.pathname === variableRoot && method === "GET")
      return Response.json({
        total_count: variables.size,
        variables: [...variables].map(([name, value]) => ({
          name,
          value,
          ...metadata,
        })),
      });
    if (
      variableRoot &&
      url.pathname.startsWith(variableRoot + "/") &&
      method === "GET"
    ) {
      const name = decodeURIComponent(url.pathname.slice(variableRoot.length + 1));
      const value = variables.get(name);
      return value === undefined
        ? Response.json({ message: "Not found" }, { status: 404 })
        : Response.json({ name, value, ...metadata });
    }
    if (url.pathname === variableRoot && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        value: string;
      };
      if (writeStatus === 201) variables.set(body.name, body.value);
      return new Response(null, { status: writeStatus });
    }
    if (
      variableRoot &&
      url.pathname.startsWith(variableRoot + "/") &&
      ["PATCH", "DELETE"].includes(method)
    ) {
      const name = decodeURIComponent(url.pathname.slice(variableRoot.length + 1));
      if (writeStatus === 204) {
        if (method === "DELETE") variables.delete(name);
        else {
          const body = JSON.parse(String(init?.body)) as { value: string };
          variables.set(name, body.value);
        }
      }
      return new Response(null, { status: writeStatus });
    }
    const secretRoot = "/repos/example/repo-a/actions/secrets";
    if (url.pathname === secretRoot && method === "GET")
      return Response.json({
        total_count: 1,
        secrets: [{ name: "DEPLOY_TOKEN", ...metadata }],
      });
    if (url.pathname === secretRoot + "/DEPLOY_TOKEN" && method === "GET")
      return Response.json({ name: "DEPLOY_TOKEN", ...metadata });
    if (url.pathname === secretRoot + "/public-key" && method === "GET")
      return Response.json({ key_id: "key", key: "A".repeat(43) + "=" });
    return Response.json({ message: "Not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Managed configuration without secret custody", () => {
  it("saves desired variable state, marks exact inventory ownership, and applies one reviewed update", async () => {
    await saveConnection();
    await as().secretsConnectionSave({
      ...workspace,
      connectionId: "secrets-alias",
      revision: 0,
      connection: {
        name: "Actions alias",
        providerKind: SECRET_PROVIDER_KIND.GITHUB,
        providerRef: "selected",
        resourceIds: [target.resourceId],
        enabled: true,
      },
    });
    const saved = await saveConfiguration();
    expect(saved).toMatchObject({
      id: "deploy-region",
      revision: 1,
      custody: "none",
      desiredValue: "eu-west-1",
    });
    expect(await saveConfiguration()).toEqual(saved);
    await expect(
      saveConfiguration(0, "configuration-save", fields("changed-reuse")),
    ).rejects.toMatchObject({ code: "managed_configuration_conflict" });
    expect(await as("viewer").secretsConfigurations(workspace)).toEqual([
      saved,
    ]);
    expect(
      await as("viewer").secretsConfigurationStatus({
        ...workspace,
        configurationId: saved.id,
      }),
    ).toMatchObject({
      observations: [
        {
          status: MANAGED_CONFIGURATION_STATUS.DRIFTED,
          item: {
            name: destination.name,
            management: SECRET_MANAGEMENT.HQ,
            managedConfigurationId: saved.id,
          },
        },
      ],
    });
    const inventory = await as("viewer").secretsInventory({
      ...connection,
      target,
      entryKind: SECRET_ENTRY_KIND.VARIABLE,
      page: 1,
    });
    expect(inventory.items[0]).toMatchObject({
      name: destination.name,
      management: SECRET_MANAGEMENT.HQ,
      managedConfigurationId: saved.id,
    });
    const aliasInventory = await as("viewer").secretsInventory({
      ...workspace,
      connectionId: "secrets-alias",
      target,
      entryKind: SECRET_ENTRY_KIND.VARIABLE,
      page: 1,
    });
    expect(aliasInventory.items[0]).toMatchObject({
      management: SECRET_MANAGEMENT.HQ,
      managedConfigurationId: saved.id,
    });
    await expect(
      as().secretsConfigurationSave({
        ...workspace,
        configurationId: "alias-owner",
        revision: 0,
        requestId: "alias-owner-save",
        configuration: {
          ...fields(),
          destinations: [
            {
              destination: {
                ...destination,
                connectionId: "secrets-alias",
              },
              desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "managed_destination_conflict" });
    const review = await plan();
    expect(review).toMatchObject({
      action: "update",
      actorMatches: true,
      writable: true,
      operation: null,
    });
    const applied = await as().secretsConfigurationApply({
      ...workspace,
      planId: review.id,
      fingerprint: review.fingerprint,
    });
    expect(applied.operation).toMatchObject({
      status: "succeeded",
      receipt: {
        writeStatus: "accepted",
        observationStatus: MANAGED_CONFIGURATION_STATUS.IN_SYNC,
      },
    });
    expect(variables.get(destination.name)).toBe("eu-west-1");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![1]?.method).toBe("PATCH");
    expect(
      await as().secretsConfigurationApply({
        ...workspace,
        planId: review.id,
        fingerprint: review.fingerprint,
      }),
    ).toEqual(applied);
    expect(writes()).toHaveLength(1);
    expect(
      await as("viewer").secretsConfigurationHistory({
        ...workspace,
        repositoryId: "repo-a",
      }),
    ).toHaveLength(1);
    expect(
      await as("viewer").secretsConfigurationHistory({
        ...workspace,
        repositoryId: "repo-b",
      }),
    ).toEqual([]);
    const stored = JSON.stringify(
      (
        await bindings.HQ_DB.prepare(
          "SELECT * FROM action_plans JOIN operations ON operations.plan_id=action_plans.id",
        ).all()
      ).results,
    );
    expect(stored).not.toContain(PRIVATE);
    const activity = JSON.stringify(
      (
        await bindings.HQ_DB.prepare(
          "SELECT title,summary FROM activity WHERE workspace_id='alpha'",
        ).all()
      ).results,
    );
    expect(activity).not.toContain(PRIVATE);
    expect(activity).not.toContain("eu-west-1");
  });

  it("uses collection creation and named deletion endpoints from exact reviews", async () => {
    variables.clear();
    writeStatus = 201;
    await saveConnection();
    await saveConfiguration();
    const create = await plan("create-review");
    expect(create.action).toBe("create");
    await as().secretsConfigurationApply({
      ...workspace,
      planId: create.id,
      fingerprint: create.fingerprint,
    });
    expect(writes()[0]![1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({
      name: destination.name,
      value: "eu-west-1",
    });

    writeStatus = 204;
    const absent = await saveConfiguration(
      1,
      "configuration-absent",
      fields("retained-but-unused", MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT),
    );
    expect(
      await saveConfiguration(
        1,
        "configuration-absent",
        fields(
          "retained-but-unused",
          MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT,
        ),
      ),
    ).toEqual(absent);
    const removal = await plan("delete-review", absent.revision);
    expect(removal.action).toBe("delete");
    await as().secretsConfigurationApply({
      ...workspace,
      planId: removal.id,
      fingerprint: removal.fingerprint,
    });
    expect(writes()[1]![1]).toMatchObject({ method: "DELETE" });
    expect(variables.has(destination.name)).toBe(false);
  });

  it("writes environment variables at their environment endpoint and keeps organization scope inventory-only", async () => {
    await saveConnection();
    const environmentDestination = {
      ...destination,
      target: {
        resourceId: target.resourceId,
        scope: { kind: "environment" as const, name: "Production / Blue" },
      },
    };
    const saved = await saveConfiguration(
      0,
      "environment-configuration",
      {
        ...fields(),
        destinations: [
          {
            destination: environmentDestination,
            desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
          },
        ],
      },
    );
    const review = await plan("environment-review", saved.revision);
    await as().secretsConfigurationApply({
      ...workspace,
      planId: review.id,
      fingerprint: review.fingerprint,
    });
    const writeUrl = new URL(String(writes()[0]![0]));
    expect(writeUrl.pathname).toBe(
      "/repos/example/repo-a/environments/Production%20%2F%20Blue/variables/DEPLOY_REGION",
    );

    const lowerCaseEnvironment = {
      ...environmentDestination,
      target: {
        resourceId: target.resourceId,
        scope: { kind: "environment" as const, name: "production / blue" },
      },
    };
    const updated = await saveConfiguration(1, "lower-case-environment", {
      ...fields(),
      destinations: [
        {
          destination: lowerCaseEnvironment,
          desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
        },
      ],
    });
    expect(
      await as().secretsConfigurationStatus({
        ...workspace,
        configurationId: updated.id,
      }),
    ).toMatchObject({
      observations: [{ status: MANAGED_CONFIGURATION_STATUS.IN_SYNC }],
    });

    await expect(
      as().secretsConfigurationSave({
        ...workspace,
        configurationId: "same-environment-different-case",
        revision: 0,
        requestId: "case-insensitive-environment",
        configuration: {
          ...fields(),
          destinations: [
            {
              destination: {
                ...environmentDestination,
              },
              desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "managed_destination_conflict" });

    await expect(
      as().secretsConfigurationSave({
        ...workspace,
        configurationId: "organization-variable",
        revision: 0,
        requestId: "organization-configuration",
        configuration: {
          ...fields(),
          destinations: [
            {
              destination: {
                ...destination,
                target: {
                  resourceId: target.resourceId,
                  scope: { kind: "organization", name: "example" },
                },
              },
              desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "managed_configuration_unsupported" });
    expect(writes()).toHaveLength(1);
  });

  it("adopts secret names for ownership and unverifiable status without enabling value writes", async () => {
    await saveConnection();
    const secretDestination = {
      ...destination,
      name: "DEPLOY_TOKEN",
    };
    const saved = await as().secretsConfigurationSave({
      ...workspace,
      configurationId: "deploy-token",
      revision: 0,
      requestId: "secret-adoption",
      configuration: {
        label: "Deploy token",
        entryKind: SECRET_ENTRY_KIND.SECRET,
        custody: MANAGED_CONFIGURATION_CUSTODY.NONE,
        desiredValue: null,
        destinations: [
          {
            destination: secretDestination,
            desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
          },
        ],
      },
    });
    expect(
      await as("viewer").secretsConfigurationStatus({
        ...workspace,
        configurationId: saved.id,
      }),
    ).toMatchObject({
      observations: [
        {
          status: MANAGED_CONFIGURATION_STATUS.UNVERIFIABLE,
          item: { value: null, management: SECRET_MANAGEMENT.HQ },
        },
      ],
    });
    expect(
      (
        await as("viewer").secretsInventory({
          ...connection,
          target,
          entryKind: SECRET_ENTRY_KIND.SECRET,
          page: 1,
        })
      ).items[0],
    ).toMatchObject({
      name: "DEPLOY_TOKEN",
      management: SECRET_MANAGEMENT.HQ,
      managedConfigurationId: saved.id,
    });
    await expect(
      as().secretsConfigurationPlan({
        ...workspace,
        configurationId: saved.id,
        configurationRevision: saved.revision,
        destinationIndex: 0,
        planId: "secret-review",
      }),
    ).rejects.toMatchObject({ code: "managed_configuration_unsupported" });
    expect(writes()).toHaveLength(0);
  });

  it("fences changed preflight state and resolves uncertain submission only through live reads", async () => {
    await saveConnection();
    await saveConfiguration();
    const changed = await plan("changed-review");
    variables.set(destination.name, "asia-east-1");
    const rejected = await as().secretsConfigurationApply({
      ...workspace,
      planId: changed.id,
      fingerprint: changed.fingerprint,
    });
    expect(rejected.operation).toMatchObject({
      status: "failed",
      receipt: { writeStatus: "not-sent", reason: "preflight_changed" },
    });
    expect(writes()).toHaveLength(0);

    variables.set(destination.name, "us-central1");
    const uncertain = await plan("uncertain-review");
    writeStatus = 500;
    const submitted = await as().secretsConfigurationApply({
      ...workspace,
      planId: uncertain.id,
      fingerprint: uncertain.fingerprint,
    });
    expect(submitted.operation).toMatchObject({
      status: "partial",
      receipt: {
        writeStatus: "indeterminate",
        observationStatus: MANAGED_CONFIGURATION_STATUS.DRIFTED,
      },
    });
    expect(writes()).toHaveLength(1);
    expect(
      await saveConnection(1, "Changed during uncertain operation"),
    ).toMatchObject({ revision: 2 });
    await expect(
      saveConnection(2, "Remove managed target", ["repo-b"]),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      as().secretsConfigurationStop({
        ...workspace,
        configurationId: "deploy-region",
        revision: 1,
        requestId: "blocked-stop",
      }),
    ).rejects.toMatchObject({ code: "managed_configuration_conflict" });
    variables.set(destination.name, "eu-west-1");
    repositoryIdentity = 43;
    const changedTarget = await as().secretsConfigurationReconcile({
      ...workspace,
      planId: uncertain.id,
    });
    expect(changedTarget.operation).toMatchObject({
      status: "indeterminate",
      receipt: {
        writeStatus: "indeterminate",
        observationStatus: MANAGED_CONFIGURATION_STATUS.UNAVAILABLE,
      },
    });
    repositoryIdentity = 42;
    const reconciled = await as().secretsConfigurationReconcile({
      ...workspace,
      planId: uncertain.id,
    });
    expect(reconciled.operation).toMatchObject({
      status: "succeeded",
      receipt: {
        writeStatus: "indeterminate",
        observationStatus: MANAGED_CONFIGURATION_STATUS.IN_SYNC,
      },
    });
    expect(writes()).toHaveLength(1);
    await as().secretsConfigurationStop({
      ...workspace,
      configurationId: "deploy-region",
      revision: 1,
      requestId: "stop-after-reconcile",
    });
    expect(variables.get(destination.name)).toBe("eu-west-1");
  });

  it("does not save a definition after its connection revision changes", async () => {
    await saveConnection();
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    let calls = 0;
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementation(async (statements) => {
      calls++;
      if (calls === 1)
        await bindings.HQ_DB.prepare(
          "UPDATE secret_connections SET revision=revision+1 WHERE workspace_id='alpha' AND id='secrets'",
        ).run();
      return batch(statements);
    });
    await expect(saveConfiguration()).rejects.toMatchObject({
      code: "managed_configuration_conflict",
    });
    expect(calls).toBe(1);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT COUNT(*) AS total FROM managed_configurations",
      ).first("total"),
    ).toBe(0);
  });

  it("fails closed when stored destination ordering is inconsistent", async () => {
    await saveConnection();
    await saveConfiguration();
    await bindings.HQ_DB.prepare(
      `UPDATE managed_configuration_destinations SET destination_index=1
      WHERE workspace_id='alpha' AND configuration_id='deploy-region'`,
    ).run();
    await expect(as().secretsConfigurations(workspace)).rejects.toMatchObject({
      code: "managed_configuration_invalid",
    });
  });

  it("enforces owner writes, revision isolation, exact destination ownership, and MCP parity", async () => {
    await saveConnection();
    const saved = await saveConfiguration();
    for (const subject of ["operator", "viewer", "outside"])
      await expect(
        as(subject).secretsConfigurationSave({
          ...workspace,
          configurationId: "denied",
          revision: 0,
          requestId: "denied-" + subject,
          configuration: fields(),
        }),
      ).rejects.toBeDefined();
    await expect(
      as().secretsConfigurationSave({
        ...workspace,
        configurationId: "duplicate-target",
        revision: 0,
        requestId: "duplicate-target-save",
        configuration: fields(),
      }),
    ).rejects.toMatchObject({ code: "managed_destination_conflict" });
    await expect(
      saveConfiguration(0, "stale-save", fields("changed")),
    ).rejects.toMatchObject({ code: "managed_configuration_conflict" });

    const app = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    const request = (path: string, body: object) =>
      new Request("https://hq.example" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const http = await app.fetch(
      request("/api/commands/secrets_configurations", workspace),
      runtime,
    );
    expect(await http.json()).toEqual([saved]);
    const mcp = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: "managed-configurations",
        method: "tools/call",
        params: {
          name: "secrets_configurations",
          arguments: workspace,
        },
      }),
      runtime,
    );
    const envelope = (await mcp.json()) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(envelope.result.content[0]!.text)).toEqual([saved]);
    expect(
      commandAnnotations(
        "secrets_configuration_apply",
        commands.secrets_configuration_apply.readOnly,
      ),
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: true,
    });
  });
});
