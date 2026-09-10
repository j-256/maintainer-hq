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
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  LIMITS,
  type Principal,
} from "../shared/domain";
import {
  FLEET_DISCOVERY_LIMITS,
  type FleetReconciliationInput,
  type FleetReconciliationReview,
} from "../shared/fleet-discovery";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { FleetReconciliationService } from "../worker/fleet-reconciliation";
import { FleetAuthority } from "../worker/fleet-authority";
import { createApplication } from "../worker/app";
import { callCommand, clientConfiguration } from "../cli/client";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
const TOKEN = "synthetic-fleet-reconciliation-credential";
let now: number;
let runtime: Env;
const as = (principal = OWNER) =>
  new WorkspaceService(runtime, principal, false, () => now);
const fields = (): FleetReconciliationInput => ({
  workspaceId: "alpha",
  sourceId: "github",
  sourceRevision: 1,
  reviewId: crypto.randomUUID(),
  selections: [
    {
      githubId: "node-first",
      fullName: "example/renamed",
      lifecycle: "archived",
      repositoryId: "first",
      revision: 1,
      classification: null,
      projectId: null,
      projectRevision: null,
      collect: false,
    },
    {
      githubId: "node-new",
      fullName: "example/new",
      lifecycle: "active",
      repositoryId: null,
      revision: null,
      classification: "watchlist",
      projectId: "project",
      projectRevision: 1,
      collect: true,
    },
  ],
});
const applyInput = (
  review: Pick<
    FleetReconciliationReview,
    "workspaceId" | "planId" | "fingerprint"
  >,
) => ({
  workspaceId: review.workspaceId,
  planId: review.planId,
  fingerprint: review.fingerprint,
});
const api = (id: string, fullName: string, archived = false) => ({
  id,
  nameWithOwner: fullName,
  description: "Provider description",
  isArchived: archived,
  isPrivate: true,
});
const catalog = () => [
  api("node-first", "example/renamed", true),
  api("node-new", "example/new"),
  api("node-anchor", "example/anchor"),
];
function provider(
  intercept?: (body: {
    query: string;
    variables: Record<string, string>;
  }) => Promise<Response | void> | Response | void,
) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.github.com/graphql");
    const body = JSON.parse(String(init?.body));
    expect(body.query).toMatch(/^query /);
    const override = await intercept?.(body);
    if (override) return override;
    const indices = [
      ...new Set(
        Object.keys(body.variables).map((key) => key.replace(/^[a-z]+/, "")),
      ),
    ];
    return Response.json({
      data: Object.fromEntries(
        indices.map((index) => {
          const id = body.variables["id" + index];
          const fullName =
            body.variables["owner" + index] +
            "/" +
            body.variables["name" + index];
          return [
            "repository" + index,
            catalog().find((row) =>
              id
                ? row.id === id
                : row.nameWithOwner ===
                  (fullName === "example/first" ? "example/renamed" : fullName),
            ) ?? null,
          ];
        }),
      ),
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const count = (table: string) =>
  bindings.HQ_DB.prepare("SELECT count(*) AS n FROM " + table).first<number>(
    "n",
  );
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      personal: { workspaceId: "alpha", name: "Read authority", token: TOKEN },
    }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DROP TRIGGER IF EXISTS fail_fleet_reconciliation"),
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM github_context_budgets"),
    bindings.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','other','Other','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','owner','Owner','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects(workspace_id,id,name,description,updated_at) VALUES ('alpha','project','Project','Preserve portfolio and project',?)",
    ).bind(new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','first','example/first','Keep description','project','reference','active',?,?,'seed-first'),('alpha','anchor','example/anchor','Anchor','project','maintained','active',?,?,'seed-anchor')",
    ).bind(
      JSON.stringify({
        ...DEFAULT_EXPECTATIONS,
        ci: "optional",
        reviewDate: "2027-01-01",
        note: "Preserve this decision",
      }),
      new Date(now).toISOString(),
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
    ),
  ]);
  await as().githubSourceEnroll({
    workspaceId: "alpha",
    sourceId: "github",
    source: {
      name: "Read authority",
      enabled: true,
      freshnessMinutes: 30,
      repositoryIds: ["first", "anchor"],
      credentialRef: "personal",
      refreshIntervalMinutes: 15,
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Reviewed GitHub fleet reconciliation", () => {
  it("rolls back metadata, scope, identities, activity and receipt if a later statement fails", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    const tables = [
      "repositories",
      "source_repositories",
      "connections",
      "github_repository_identities",
      "activity",
      "operations",
    ];
    const snapshot = () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await bindings.HQ_DB.prepare(
                "SELECT * FROM " + table + " ORDER BY rowid",
              ).all()
            ).results,
        ),
      );
    const before = await snapshot();
    await bindings.HQ_DB.prepare(
      "CREATE TRIGGER fail_fleet_reconciliation BEFORE INSERT ON activity WHEN NEW.type='fleet.reconciled' BEGIN SELECT RAISE(ABORT,'Synthetic enrollment failure'); END",
    ).run();
    await expect(
      as().fleetReconciliationApply(applyInput(plan)),
    ).rejects.toThrow(/Synthetic enrollment failure/);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await as().fleetReconciliationReview({
          workspaceId: "alpha",
          planId: plan.planId,
        })
      ).state,
    ).toBe("ready");
    await bindings.HQ_DB.prepare(
      "DROP TRIGGER fail_fleet_reconciliation",
    ).run();
    expect(
      (await as().fleetReconciliationApply(applyInput(plan)))
        .updatedRepositoryIds,
    ).toEqual(["first"]);
    expect(await count("operations")).toBe(1);
  });
  it("preserves nonempty resource associations and cancels only the changed source's queued work", async () => {
    provider();
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "INSERT INTO connections(workspace_id,id,name,provider,enabled) VALUES ('alpha','hooks','Hooks','hookrelay',1),('alpha','monitor','Monitor','endpoint-monitor',1)",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO repository_resource_associations(workspace_id,kind,connection_id,resource_key,revision,write_id,updated_at) VALUES ('alpha','hook','hooks','subscription',1,'keep','2026-01-01'),('alpha','monitor','monitor','target',1,'keep','2026-01-01')",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO repository_resource_links(workspace_id,kind,connection_id,resource_key,repository_id) VALUES ('alpha','hook','hooks','subscription','first'),('alpha','monitor','monitor','target','first')",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id,updated_at) VALUES ('alpha','hooks','subscription','project',1,'keep','2026-01-01')",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO monitor_project_associations(workspace_id,connection_id,target_id,project_id,revision,write_id,updated_at) VALUES ('alpha','monitor','target','project',1,'keep','2026-01-01')",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES ('alpha','secrets','Secrets','github-actions','kept-reference',?,0,1,'keep')",
      ).bind(
        JSON.stringify([
          { id: "secret-resource", repositories: [{ id: "first" }] },
        ]),
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO secret_project_associations(workspace_id,connection_id,resource_id,project_id,revision,write_id,updated_at) VALUES ('alpha','secrets','secret-resource','project',1,'keep','2026-01-01')",
      ),
    ]);
    await as().githubSourceEnroll({
      workspaceId: "alpha",
      sourceId: "other-source",
      source: {
        name: "Other source",
        enabled: true,
        freshnessMinutes: 30,
        repositoryIds: ["anchor"],
        credentialRef: "personal",
        refreshIntervalMinutes: 15,
      },
    });
    for (const sourceId of ["github", "other-source"])
      await as().githubRefresh({
        workspaceId: "alpha",
        sourceId,
        revision: 1,
        refreshId: "refresh-" + sourceId,
      });
    const tables = [
      "repository_resource_associations",
      "repository_resource_links",
      "hook_associations",
      "monitor_project_associations",
      "secret_connections",
      "secret_project_associations",
    ];
    const snapshot = () =>
      Promise.all(
        tables.map(
          async (table) =>
            (
              await bindings.HQ_DB.prepare(
                "SELECT * FROM " + table + " ORDER BY rowid",
              ).all()
            ).results,
        ),
      );
    const before = await snapshot();
    const plan = await as().fleetReconciliationPlan(fields());
    await as().fleetReconciliationApply(applyInput(plan));
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT source_id,status FROM github_refreshes ORDER BY source_id",
        ).all()
      ).results,
    ).toEqual([
      { source_id: "github", status: "cancelled" },
      { source_id: "other-source", status: "queued" },
    ]);
    expect(
      (
        await bindings.HQ_DB.prepare(
          "SELECT DISTINCT status FROM github_refresh_items WHERE refresh_id='refresh-github'",
        ).all()
      ).results,
    ).toEqual([{ status: "cancelled" }]);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT revision FROM connections WHERE id='other-source'",
      ).first("revision"),
    ).toBe(1);
  });
  it("recovers a concurrent Apply that finishes between receipt and revision checks", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    const target = FleetReconciliationService.prototype as unknown as {
      matching: (workspaceId: string, reviewed: unknown) => Promise<boolean>;
    };
    const original = target.matching;
    vi.spyOn(target, "matching").mockImplementationOnce(async function (
      this: FleetReconciliationService,
      workspaceId,
      reviewed,
    ) {
      await as().fleetReconciliationApply(applyInput(plan));
      return original.call(this, workspaceId, reviewed);
    });
    expect(
      (await as().fleetReconciliationApply(applyInput(plan)))
        .updatedRepositoryIds,
    ).toEqual(["first"]);
    expect(await count("operations")).toBe(1);
  });
  it("executes and recovers the same reviewed operation through MCP tools/call", async () => {
    const fetcher = provider();
    const app = createApplication(async () => OWNER);
    async function rpc(name: string, input: unknown) {
      const response = await app.fetch(
        new Request("https://hq.example/mcp", {
          method: "POST",
          headers: {
            Origin: "https://hq.example",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: input },
          }),
        }),
        runtime,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      expect(body.result.isError).not.toBe(true);
      return JSON.parse(body.result.content[0].text);
    }
    expect(await rpc("fleet_sources", { workspaceId: "alpha" })).toHaveLength(
      1,
    );
    const input = fields();
    const plan = await rpc("fleet_reconciliation_plan", input);
    const receipt = await rpc("fleet_reconciliation_apply", applyInput(plan));
    expect(await rpc("fleet_reconciliation_apply", applyInput(plan))).toEqual(
      receipt,
    );
    expect(
      await rpc("fleet_reconciliation_review", {
        workspaceId: "alpha",
        planId: plan.planId,
      }),
    ).toMatchObject({ state: "applied", receipt });
    expect(await rpc("fleet_reconciliation_plan", input)).toMatchObject({
      state: "applied",
      receipt,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("verifies selected nodes and old names without trusting input or changing HQ until Apply", async () => {
    const fetcher = provider();
    const before = await as().repositories({ workspaceId: "alpha" });
    const input = fields();
    const plan = await as().fleetReconciliationPlan(input);
    expect(plan.state).toBe("ready");
    expect(plan.planId).toBe(input.reviewId);
    expect(plan.source).toMatchObject({
      beforeCount: 2,
      afterCount: 2,
      revision: 1,
    });
    expect(
      plan.changes.find((row) => row.repositoryId === "first"),
    ).toMatchObject({
      before: {
        fullName: "example/first",
        lifecycle: "active",
        classification: "reference",
      },
      after: {
        fullName: "example/renamed",
        lifecycle: "archived",
        classification: "reference",
        description: "Keep description",
        projectId: "project",
        expectations: { note: "Preserve this decision" },
      },
      collectedBefore: true,
      collectedAfter: false,
    });
    expect(plan.changes.find((row) => !row.before)).toMatchObject({
      after: {
        classification: "watchlist",
        projectId: "project",
        expectations: DEFAULT_EXPECTATIONS,
      },
      collectedBefore: false,
      collectedAfter: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fetcher.mock.calls[1][1]?.body)).variables,
    ).toEqual({ owner0: "example", name0: "first" });
    expect(await as().repositories({ workspaceId: "alpha" })).toEqual(before);
    expect(await count("operations")).toBe(0);
    expect(JSON.stringify(plan)).not.toContain(TOKEN);
    expect(JSON.stringify(plan)).not.toContain("credentialHash");
  });
  it("recovers the exact same prepared intent after a lost response and rejects changed inputs under that ID", async () => {
    const fetcher = provider();
    const input = fields();
    const first = await as().fleetReconciliationPlan(input);
    expect(
      await as().fleetReconciliationPlan({
        ...input,
        selections: [...input.selections].reverse(),
      }),
    ).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      as().fleetReconciliationPlan({
        ...input,
        selections: input.selections.slice(0, 1),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("action_plans")).toBe(1);
  });
  it("applies only selected HQ metadata and scope atomically, retains history and returns an immutable receipt", async () => {
    const fetcher = provider();
    const beforeSource = await as().githubSourceGet({
      workspaceId: "alpha",
      sourceId: "github",
    });
    const beforeProject = await bindings.HQ_DB.prepare(
      "SELECT * FROM projects",
    ).first();
    await bindings.HQ_DB.prepare(
      "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES ('alpha','github','repository','first','Historical name','unknown','Historical observation','{}',?,?,?)",
    )
      .bind(
        new Date(now - 1000).toISOString(),
        new Date(now - 1000).toISOString(),
        new Date(now + 600000).toISOString(),
      )
      .run();
    const plan = await as().fleetReconciliationPlan(fields());
    const receipts = await Promise.all([
      as().fleetReconciliationApply(applyInput(plan)),
      as().fleetReconciliationApply(applyInput(plan)),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    const receipt = receipts[0];
    expect(receipt).toMatchObject({
      sourceRevision: 2,
      updatedRepositoryIds: ["first"],
      removedFromSource: ["first"],
    });
    expect(receipt.createdRepositoryIds).toHaveLength(1);
    expect(receipt.addedToSource).toEqual(receipt.createdRepositoryIds);
    const old = await as().repository({
      workspaceId: "alpha",
      repositoryId: "first",
    });
    expect(old).toMatchObject({
      fullName: "example/renamed",
      revision: 2,
      projectId: "project",
      classification: "reference",
      description: "Keep description",
      expectations: { note: "Preserve this decision" },
    });
    expect(
      (
        await as().repository({
          workspaceId: "alpha",
          repositoryId: receipt.createdRepositoryIds[0],
        })
      ).expectations,
    ).toEqual(DEFAULT_EXPECTATIONS);
    const source = await as().githubSourceGet({
      workspaceId: "alpha",
      sourceId: "github",
    });
    expect(source.name).toBe(beforeSource.name);
    expect(source.freshnessMinutes).toBe(beforeSource.freshnessMinutes);
    expect(source.github.credentialRef).toBe(beforeSource.github.credentialRef);
    expect(source.github.refreshIntervalMinutes).toBe(
      beforeSource.github.refreshIntervalMinutes,
    );
    expect(source.repositoryIds.sort()).toEqual(
      ["anchor", ...receipt.createdRepositoryIds].sort(),
    );
    expect(
      await bindings.HQ_DB.prepare("SELECT * FROM projects").first(),
    ).toEqual(beforeProject);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT health,summary,details_json,expires_at FROM observations",
      ).first(),
    ).toEqual({
      health: "unknown",
      summary: "Historical observation",
      details_json: "{}",
      expires_at: receipt.appliedAt,
    });
    expect(await count("operations")).toBe(1);
    expect(await count("github_repository_identities")).toBe(2);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM activity WHERE type='fleet.reconciled'",
      ).first("n"),
    ).toBe(2);
    expect(await count("activity_repository_links")).toBe(2);
    expect(await count("activity_project_links")).toBe(2);
    now += LIMITS.PLAN_TTL_MS + 1;
    expect(await as().fleetReconciliationApply(applyInput(plan))).toEqual(
      receipt,
    );
    expect(await as().fleetReconciliationPlan(plan.fields)).toMatchObject({
      state: "applied",
      receipt,
    });
    expect(
      await as().fleetReconciliationReview({
        workspaceId: "alpha",
        planId: plan.planId,
      }),
    ).toMatchObject({ state: "applied", receipt });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("can add project-owned metadata without collection or copied GitHub permissions", async () => {
    provider();
    const input = fields();
    input.selections = [{ ...input.selections[1], collect: false }];
    const plan = await as().fleetReconciliationPlan(input);
    const result = await as().fleetReconciliationApply(applyInput(plan));
    expect(result.sourceRevision).toBe(1);
    expect(result.addedToSource).toEqual([]);
    expect(
      (
        await as().repository({
          workspaceId: "alpha",
          repositoryId: result.createdRepositoryIds[0],
        })
      ).projectId,
    ).toBe("project");
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT github_id,full_name FROM github_repository_identities",
      ).first(),
    ).toEqual({ github_id: "node-new", full_name: "example/new" });
  });
  it("requires independent identity verification for an existing unpinned repository", async () => {
    provider(({ variables }) =>
      variables.name0
        ? Response.json({
            data: {
              repository0: api("different-node", "example/renamed", true),
            },
          })
        : undefined,
    );
    await expect(as().fleetReconciliationPlan(fields())).rejects.toMatchObject({
      status: 409,
    });
    expect(await count("action_plans")).toBe(0);
  });
  it("uses a previously bound stable node for renames even when the old name becomes unavailable", async () => {
    await bindings.HQ_DB.prepare(
      "INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at) VALUES ('alpha','github','first','node-first','example/first',?)",
    )
      .bind(new Date(now).toISOString())
      .run();
    const fetcher = provider();
    const plan = await as().fleetReconciliationPlan(fields());
    expect(plan.state).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["name", "lifecycle", "identity", "visibility"])(
    "rejects unverified %s input without saving a partial plan",
    async (variant) => {
      const input = fields();
      if (variant === "name") input.selections[0].fullName = "attacker/renamed";
      if (variant === "lifecycle") input.selections[0].lifecycle = "active";
      if (variant === "identity") input.selections[0].githubId = "unknown-node";
      provider(
        variant === "visibility"
          ? () =>
              Response.json({
                data: {
                  repository0: null,
                  repository1: api("node-new", "example/new"),
                },
                errors: [
                  {
                    type: "FORBIDDEN",
                    path: ["repository0"],
                    message: "Private provider payload",
                  },
                ],
              })
          : undefined,
      );
      await expect(as().fleetReconciliationPlan(input)).rejects.toMatchObject({
        status: ["identity", "visibility"].includes(variant) ? 422 : 409,
      });
      expect(await count("action_plans")).toBe(0);
      expect(await count("repositories")).toBe(2);
    },
  );
  it.each(["canonical", "known_identity", "reused_name"])(
    "does not duplicate or merge a %s conflict",
    async (variant) => {
      if (variant === "canonical")
        await bindings.HQ_DB.prepare(
          "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','canonical','example/renamed','','project','maintained','active',?,?,'seed')",
        )
          .bind(
            JSON.stringify(DEFAULT_EXPECTATIONS),
            new Date(now).toISOString(),
          )
          .run();
      if (variant !== "canonical")
        await bindings.HQ_DB.prepare(
          "INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at) VALUES ('alpha','github',?,?,?,?)",
        )
          .bind(
            variant === "known_identity" ? "anchor" : "first",
            variant === "known_identity" ? "node-new" : "other-node",
            variant === "known_identity" ? "example/anchor" : "example/first",
            new Date(now).toISOString(),
          )
          .run();
      provider();
      await expect(
        as().fleetReconciliationPlan(fields()),
      ).rejects.toMatchObject({ status: 409 });
      expect(await count("action_plans")).toBe(0);
    },
  );
  it.each([
    "repository",
    "project",
    "source",
    "scope",
    "identity",
    "capacity",
    "name",
    "membership",
    "credential",
  ])(
    "rejects a live %s change after review without partial effects",
    async (variant) => {
      provider();
      const plan = await as().fleetReconciliationPlan(fields());
      if (variant === "repository")
        await bindings.HQ_DB.prepare(
          "UPDATE repositories SET revision=revision+1 WHERE id='first'",
        ).run();
      if (variant === "project")
        await bindings.HQ_DB.prepare(
          "UPDATE projects SET revision=revision+1 WHERE id='project'",
        ).run();
      if (variant === "source")
        await bindings.HQ_DB.prepare(
          "UPDATE connections SET revision=revision+1",
        ).run();
      if (variant === "scope")
        await bindings.HQ_DB.prepare(
          "DELETE FROM source_repositories WHERE repository_id='first'",
        ).run();
      if (variant === "identity")
        await bindings.HQ_DB.prepare(
          "INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at) VALUES ('alpha','github','first','other-node','example/first',?)",
        )
          .bind(new Date(now).toISOString())
          .run();
      if (variant === "membership")
        await bindings.HQ_DB.prepare(
          "UPDATE members SET revision=revision+1 WHERE subject='owner'",
        ).run();
      if (variant === "credential") runtime.GITHUB_CREDENTIALS = "{}";
      if (variant === "name")
        await bindings.HQ_DB.prepare(
          "UPDATE repositories SET full_name='example/new' WHERE id='anchor'",
        ).run();
      if (variant === "capacity")
        await bindings.HQ_DB.prepare(
          `INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      WITH RECURSIVE entries(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<?) SELECT 'alpha','extra-'||n,'example/extra-'||n,'','project','reference','active',?,?,'seed' FROM entries`,
        )
          .bind(
            LIMITS.MAX_REPOSITORIES - 2,
            JSON.stringify(DEFAULT_EXPECTATIONS),
            new Date(now).toISOString(),
          )
          .run();
      await expect(
        as().fleetReconciliationApply(applyInput(plan)),
      ).rejects.toMatchObject({ status: 409 });
      expect(await count("operations")).toBe(0);
      expect(
        (await as().repository({ workspaceId: "alpha", repositoryId: "first" }))
          .fullName,
      ).toBe("example/first");
      expect(
        (
          await as().fleetReconciliationReview({
            workspaceId: "alpha",
            planId: plan.planId,
          })
        ).state,
      ).toBe("stale");
    },
  );
  it("checks current input, client identity, actor and workspace for readback and apply", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    await expect(
      as({ subject: "other", displayName: "Other" }).fleetReconciliationApply(
        applyInput(plan),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as().fleetReconciliationReview({
        workspaceId: "beta",
        planId: plan.planId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as().fleetReconciliationApply({
        ...applyInput(plan),
        fingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE action_plans SET input_json=json_set(input_json,'$.changes[0].after.description','Changed')",
    ).run();
    await expect(
      as().fleetReconciliationApply(applyInput(plan)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("operations")).toBe(0);
  });
  it("enforces observation-bound expiry and never extends a cached verification into a fresh review", async () => {
    provider();
    const input = fields();
    const plan = await as().fleetReconciliationPlan(input);
    now += LIMITS.PLAN_TTL_MS + 1;
    expect((await as().fleetReconciliationPlan(input)).state).toBe("expired");
    await expect(
      as().fleetReconciliationApply(applyInput(plan)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("operations")).toBe(0);
  });
  it("recovers an Apply that commits between review reads", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    const target = FleetReconciliationService.prototype as unknown as {
      matching: (workspaceId: string, reviewed: unknown) => Promise<boolean>;
    };
    const original = target.matching;
    vi.spyOn(target, "matching").mockImplementationOnce(async function (
      this: FleetReconciliationService,
      workspaceId,
      reviewed,
    ) {
      await as().fleetReconciliationApply(applyInput(plan));
      return original.call(this, workspaceId, reviewed);
    });
    const recovered = await as().fleetReconciliationReview({
      workspaceId: "alpha",
      planId: plan.planId,
    });
    expect(recovered.state).toBe("applied");
    expect(recovered.receipt?.updatedRepositoryIds).toEqual(["first"]);
  });
  it("checks source and metadata-write authorization again at the transaction boundary", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    const original = FleetAuthority.prototype.assertLive;
    let calls = 0;
    vi.spyOn(FleetAuthority.prototype, "assertLive").mockImplementation(
      async function (this: FleetAuthority) {
        await original.call(this);
        calls += 1;
        if (calls === 2)
          await bindings.HQ_DB.prepare(
            "UPDATE members SET role='viewer',revision=revision+1 WHERE subject='owner'",
          ).run();
      },
    );
    await expect(
      as().fleetReconciliationApply(applyInput(plan)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("operations")).toBe(0);
    expect(await count("repositories")).toBe(2);
  });
  it.each([
    { scopes: [CAPABILITY.READ, CAPABILITY.ADMIN] },
    { scopes: [CAPABILITY.READ, CAPABILITY.EDIT] },
  ])(
    "requires both read/admin and metadata-write client scopes: %j",
    async ({ scopes }) => {
      await bindings.HQ_DB.prepare(
        "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('client','alpha','owner','Client','hash',?,?,?)",
      )
        .bind(
          JSON.stringify(scopes),
          new Date(now).toISOString(),
          new Date(now + 600000).toISOString(),
        )
        .run();
      const fetcher = provider();
      await expect(
        as({ ...OWNER, tokenId: "client", scopes }).fleetReconciliationPlan(
          fields(),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("keeps browser, CLI and MCP on the same bounded command and capability contract", async () => {
    for (const name of [
      "fleet_discover",
      "fleet_reconciliation_plan",
      "fleet_reconciliation_review",
      "fleet_reconciliation_apply",
    ] as const) {
      expect(
        commands[name].schema.safeParse({
          workspaceId: "alpha",
          url: "https://untrusted.example",
        }).success,
      ).toBe(false);
      expect(
        commandAnnotations(name, commands[name].readOnly).idempotentHint,
      ).toBe(true);
    }
    expect(
      commandAnnotations("fleet_reconciliation_apply", false),
    ).toMatchObject({ destructiveHint: true, openWorldHint: false });
    expect(
      commandAnnotations("fleet_reconciliation_plan", false).openWorldHint,
    ).toBe(true);
    const realFetch = provider();
    const app = createApplication(async () => OWNER);
    vi.stubGlobal(
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) =>
        String(url).startsWith("https://hq.example/")
          ? app.fetch(
              new Request(url, {
                ...init,
                redirect: "manual",
                headers: {
                  ...Object.fromEntries(new Headers(init?.headers)),
                  Origin: "https://hq.example",
                },
              }),
              runtime,
            )
          : realFetch(url, init),
    );
    const client = clientConfiguration(
      "https://hq.example",
      false,
      "client-placeholder",
      "",
      "",
      "",
    );
    const plan = (await callCommand(
      client,
      "fleet_reconciliation_plan",
      fields(),
    )) as FleetReconciliationReview;
    expect(plan.state).toBe("ready");
    expect(
      (
        (await callCommand(client, "fleet_reconciliation_review", {
          workspaceId: "alpha",
          planId: plan.planId,
        })) as FleetReconciliationReview
      ).fingerprint,
    ).toBe(plan.fingerprint);
    expect(
      (
        (await callCommand(
          client,
          "fleet_reconciliation_apply",
          applyInput(plan),
        )) as { updatedRepositoryIds: string[] }
      ).updatedRepositoryIds,
    ).toEqual(["first"]);
  });
  it("bounds pending review growth per owner without touching existing receipts", async () => {
    provider();
    const plan = await as().fleetReconciliationPlan(fields());
    await bindings.HQ_DB.prepare(
      `INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
      SELECT 'copy-'||value,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at FROM action_plans,json_each(?) WHERE action_plans.id=?`,
    )
      .bind(
        JSON.stringify(
          Array.from(
            { length: FLEET_DISCOVERY_LIMITS.PENDING_PLANS - 1 },
            (_, index) => index,
          ),
        ),
        plan.planId,
      )
      .run();
    await expect(as().fleetReconciliationPlan(fields())).rejects.toMatchObject({
      status: 409,
    });
    expect(await count("action_plans")).toBe(
      FLEET_DISCOVERY_LIMITS.PENDING_PLANS,
    );
    expect(
      (
        await as().fleetReconciliationReview({
          workspaceId: "alpha",
          planId: plan.planId,
        })
      ).state,
    ).toBe("ready");
  });
});
