import { applyD1Migrations, env } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  LIMITS,
  type Principal,
} from "../shared/domain";
import {
  PROJECT_ORGANIZATION_LIMITS,
  newOrganizationProject,
  projectOrganizationPlanInput,
  suggestProject,
  type ProjectOrganizationFields,
} from "../shared/project-organization";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { ProjectOrganizationService } from "../worker/project-organization";
import { createApplication } from "../worker/app";
import { credentialHash } from "../worker/credential-hash";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const owner: Principal = { subject: "owner", displayName: "Owner" };
const workspace = { workspaceId: "alpha" };
let now: number;
const as = (principal = owner) =>
  new WorkspaceService(bindings, principal, false, () => now);
const applyInput = (review: { planId: string; fingerprint: string }) => ({
  ...workspace,
  planId: review.planId,
  fingerprint: review.fingerprint,
});
const fields = (): ProjectOrganizationFields => ({
  ...workspace,
  repositories: [
    { repositoryId: "first", revision: 1, targetKey: "new" },
    { repositoryId: "second", revision: 1, targetKey: "new" },
  ],
  targets: [
    {
      key: "new",
      kind: "new",
      project: newOrganizationProject("Shared effort"),
    },
  ],
});
const count = (table: string) =>
  bindings.HQ_DB.prepare("SELECT count(*) AS n FROM " + table).first<number>(
    "n",
  );
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  now = Date.now();
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','owner','Owner','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects(id,workspace_id,name,description,importance,importance_note,portfolio_json,updated_at) VALUES ('old','alpha','Old project','Keep old description','high','Keep old importance',?,?),('target','alpha','Target project','Keep target description','critical','Keep target importance',?,?)",
    ).bind(
      JSON.stringify({
        ...DEFAULT_PORTFOLIO,
        status: "excluded",
        reason: "Keep exclusion",
      }),
      new Date(now).toISOString(),
      JSON.stringify({
        ...DEFAULT_PORTFOLIO,
        status: "listed",
        url: "https://example.com/target",
      }),
      new Date(now).toISOString(),
    ),
    bindings.HQ_DB.prepare(
      `INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES ('first','alpha','example/first','Keep first','old','maintained','active',?,?,'seed'),('second','alpha','example/second','Keep second','old','watchlist','archived',?,?,'seed'),('unselected','alpha','example/unselected','Keep third','target','maintained','active',?,?,'seed')`,
    ).bind(
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
      JSON.stringify(DEFAULT_EXPECTATIONS),
      new Date(now).toISOString(),
    ),
  ]);
});

describe("Reviewed project organization", () => {
  it("never expands an empty existing-project patch into presentation defaults", () => {
    const parsed = projectOrganizationPlanInput.parse({
      ...workspace,
      repositories: [{ repositoryId: "first", revision: 1, targetKey: "p" }],
      targets: [
        {
          key: "p",
          kind: "existing",
          projectId: "old",
          revision: 1,
          patch: {},
        },
      ],
    });
    expect(parsed.targets[0]).toMatchObject({ patch: {} });
    expect(Object.keys((parsed.targets[0] as { patch: object }).patch)).toEqual(
      [],
    );
  });
  it("preserves a saved assignment without inferring from repository names", async () => {
    const repos = await as().repositories(workspace),
      projects = await as().projects(workspace);
    expect(
      suggestProject(
        repos.find((row) => row.id === "first")!,
        projects,
      ),
    ).toMatchObject({ projectId: "old", reason: "Keep saved project" });
    const unavailable = {
      ...repos[0]!,
      projectId: "missing",
      fullName: "example/target-project",
    };
    expect(suggestProject(unavailable, projects)).toMatchObject({
      projectId: null,
      reason: "Saved project unavailable; choose a project",
    });
    expect(await count("action_plans")).toBe(0);
  });
  it("creates a shared project once, preserves repository metadata, and attributes both old and new projects", async () => {
    const before = await as().repositories(workspace);
    const review = await as().projectOrganizationPlan(fields());
    expect(review.state).toBe("ready");
    expect(await count("projects")).toBe(2);
    const receipt = await as().projectOrganizationApply(applyInput(review));
    expect(receipt.createdProjectIds).toHaveLength(1);
    expect(receipt.assignedRepositoryIds).toEqual(["first", "second"]);
    const after = await as().repositories(workspace);
    for (const original of before)
      expect(after.find((row) => row.id === original.id)).toEqual(
        original.id === "unselected"
          ? original
          : {
              ...original,
              projectId: receipt.createdProjectIds[0],
              revision: 2,
              updatedAt: receipt.appliedAt,
            },
      );
    expect(await count("activity")).toBe(3);
    const event = await bindings.HQ_DB.prepare(
      "SELECT id FROM activity WHERE resource_id='first'",
    ).first<string>("id");
    const projects = await bindings.HQ_DB.prepare(
      "SELECT project_id AS id FROM activity_project_links WHERE event_id=? ORDER BY project_id",
    )
      .bind(event)
      .all<{ id: string }>();
    expect(projects.results.map((row) => row.id).sort()).toEqual(
      ["old", receipt.createdProjectIds[0]].sort(),
    );
    expect(await count("activity_repository_links")).toBe(2);
    expect(await count("observations")).toBe(0);
    expect(await count("connections")).toBe(0);
    now += LIMITS.PLAN_TTL_MS * 2;
    expect(await as().projectOrganizationApply(applyInput(review))).toEqual(
      receipt,
    );
    expect(
      (
        await as().projectOrganizationReview({
          ...workspace,
          planId: review.planId,
        })
      ).receipt,
    ).toEqual(receipt);
    expect(await count("operations")).toBe(1);
    expect(await count("activity")).toBe(3);
  });
  it("keeps existing project decisions unless selected and changes only project-owned presentation", async () => {
    const before = await as().project({ ...workspace, projectId: "target" });
    const input: ProjectOrganizationFields = {
      ...workspace,
      repositories: [{ repositoryId: "first", revision: 1, targetKey: "p" }],
      targets: [
        {
          key: "p",
          kind: "existing",
          projectId: "target",
          revision: 1,
          patch: {},
        },
      ],
    };
    const first = await as().projectOrganizationPlan(input);
    expect(first.projects[0]!.changed).toEqual([]);
    expect(first.projects[0]!.linkedRepositoryCount).toBe(1);
    await as().projectOrganizationApply(applyInput(first));
    expect(await as().project({ ...workspace, projectId: "target" })).toEqual(
      before,
    );
    input.repositories[0]!.revision = 2;
    input.targets = [
      {
        key: "p",
        kind: "existing",
        projectId: "target",
        revision: 1,
        patch: { importance: "high" },
      },
    ];
    const second = await as().projectOrganizationPlan(input);
    expect(second.projects[0]!.changed).toEqual(["importance"]);
    const receipt = await as().projectOrganizationApply(applyInput(second));
    expect(receipt.unchangedRepositoryIds).toEqual(["first"]);
    expect(receipt.assignedRepositoryIds).toEqual([]);
    expect(await as().project({ ...workspace, projectId: "target" })).toEqual({
      ...before,
      importance: "high",
      revision: 2,
      updatedAt: receipt.appliedAt,
    });
    expect(
      (await as().repository({ ...workspace, repositoryId: "unselected" }))
        .revision,
    ).toBe(1);
  });
  it("does not emit events or revisions for a complete no-op", async () => {
    const input = {
      ...workspace,
      repositories: [{ repositoryId: "first", revision: 1, targetKey: "p" }],
      targets: [
        {
          key: "p",
          kind: "existing",
          projectId: "old",
          revision: 1,
          patch: {},
        },
      ],
    };
    const review = await as().projectOrganizationPlan(input);
    const receipt = await as().projectOrganizationApply(applyInput(review));
    expect(receipt).toMatchObject({
      createdProjectIds: [],
      updatedProjectIds: [],
      assignedRepositoryIds: [],
      unchangedRepositoryIds: ["first"],
    });
    expect(await count("activity")).toBe(0);
    expect(
      (await as().project({ ...workspace, projectId: "old" })).revision,
    ).toBe(1);
  });
  it("preserves provider observations, connection configuration and source enrollment", async () => {
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "INSERT INTO connections(id,workspace_id,name,provider,configuration_json) VALUES ('source','alpha','Source','local','{\"preserve\":true}')",
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES ('alpha','source','repository','first','First','unknown','Source-owned evidence','{}',?,?,?)",
      ).bind(
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        new Date(now + 60000).toISOString(),
      ),
      bindings.HQ_DB.prepare(
        "INSERT INTO source_repositories(workspace_id,source_id,repository_id) VALUES ('alpha','source','first')",
      ),
    ]);
    const tables = ["connections", "observations", "source_repositories"];
    const before = await Promise.all(
      tables.map((table) =>
        bindings.HQ_DB.prepare("SELECT * FROM " + table).all(),
      ),
    );
    const review = await as().projectOrganizationPlan(fields());
    await as().projectOrganizationApply(applyInput(review));
    const after = await Promise.all(
      tables.map((table) =>
        bindings.HQ_DB.prepare("SELECT * FROM " + table).all(),
      ),
    );
    expect(after.map((rows) => rows.results)).toEqual(
      before.map((rows) => rows.results),
    );
  });
  it("rejects project capacity filled between review and the atomic write", async () => {
    const review = await as().projectOrganizationPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
      async (statements) => {
        await bindings.HQ_DB.prepare(
          "INSERT INTO projects(id,workspace_id,name,description,updated_at) SELECT value,'alpha',value,'',? FROM json_each(?)",
        )
          .bind(
            new Date(now).toISOString(),
            JSON.stringify(
              Array.from(
                { length: LIMITS.MAX_PROJECTS - 2 },
                (_, i) => "capacity-" + i,
              ),
            ),
          )
          .run();
        return batch(statements);
      },
    );
    await expect(
      as().projectOrganizationApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("operations")).toBe(0);
    expect(await count("activity")).toBe(0);
    expect(
      (await as().repository({ ...workspace, repositoryId: "first" }))
        .projectId,
    ).toBe("old");
  });
  it("rejects duplicate, unused, missing, extra-field and oversized selections", () => {
    const input = fields();
    const invalid = [
      { ...input, repositories: [] },
      {
        ...input,
        repositories: [...input.repositories, input.repositories[0]],
      },
      { ...input, targets: [...input.targets, input.targets[0]] },
      {
        ...input,
        targets: [
          ...input.targets,
          {
            key: "unused",
            kind: "new",
            project: newOrganizationProject("Unused"),
          },
        ],
      },
      {
        ...input,
        targets: [
          {
            key: "new",
            kind: "existing",
            projectId: "old",
            revision: 1,
            patch: { name: "Renamed" },
          },
        ],
      },
      {
        ...input,
        targets: [
          {
            key: "new",
            kind: "new",
            project: {
              ...newOrganizationProject("Excluded"),
              portfolio: { ...DEFAULT_PORTFOLIO, status: "excluded" },
            },
          },
        ],
      },
      {
        ...input,
        repositories: Array.from(
          { length: PROJECT_ORGANIZATION_LIMITS.REPOSITORIES + 1 },
          (_, i) => ({ repositoryId: "r" + i, revision: 1, targetKey: "new" }),
        ),
      },
    ];
    for (const value of invalid)
      expect(projectOrganizationPlanInput.safeParse(value).success).toBe(false);
  });
  it.each([
    "repository",
    "source project",
    "target project",
    "name",
    "membership",
  ])(
    "rejects the entire batch when %s changes at the write boundary",
    async (change) => {
      const input = fields();
      if (change === "target project")
        input.targets = [
          {
            key: "new",
            kind: "existing",
            projectId: "target",
            revision: 1,
            patch: { importance: "high" },
          },
        ];
      const review = await as().projectOrganizationPlan(input);
      const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
      const sql = {
        repository:
          "UPDATE repositories SET revision=revision+1 WHERE id='second'",
        "source project":
          "UPDATE projects SET revision=revision+1,name='Renamed old' WHERE id='old'",
        "target project":
          "UPDATE projects SET revision=revision+1 WHERE id='target'",
        name: "UPDATE projects SET name='Shared effort' WHERE id='target'",
        membership:
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
      }[change]!;
      vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
        async (statements) => {
          await bindings.HQ_DB.prepare(sql).run();
          return batch(statements);
        },
      );
      await expect(
        as().projectOrganizationApply(applyInput(review)),
      ).rejects.toMatchObject({ status: 409 });
      expect(await count("operations")).toBe(0);
      expect(await count("activity")).toBe(0);
      expect(await count("projects")).toBe(2);
      expect(
        (await as().repository({ ...workspace, repositoryId: "first" }))
          .projectId,
      ).toBe("old");
    },
  );
  it("rejects expired or tampered reviews and changed credential identity", async () => {
    const review = await as().projectOrganizationPlan(fields());
    await expect(
      as().projectOrganizationApply({
        ...applyInput(review),
        fingerprint: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    now += LIMITS.PLAN_TTL_MS + 1;
    expect(
      (
        await as().projectOrganizationReview({
          ...workspace,
          planId: review.planId,
        })
      ).state,
    ).toBe("expired");
    await expect(
      as().projectOrganizationApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 409 });
    now -= LIMITS.PLAN_TTL_MS + 1;
    await bindings.HQ_DB.prepare(
      "UPDATE action_plans SET input_json=json_set(input_json,'$.projects[0].after.name','Tampered') WHERE id=?",
    )
      .bind(review.planId)
      .run();
    await expect(
      as().projectOrganizationReview({ ...workspace, planId: review.planId }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("enforces viewer, source, reporter, workspace and actor boundaries, including live token scopes", async () => {
    const operator = { subject: "operator", displayName: "Operator" };
    const review = await as(operator).projectOrganizationPlan(fields());
    for (const principal of [
      { subject: "viewer", displayName: "Viewer" },
      { ...owner, reporterId: "reporter" },
      { ...owner, sourceId: "source" },
    ])
      await expect(
        as(principal).projectOrganizationPlan(fields()),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      as().projectOrganizationReview({ ...workspace, planId: review.planId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as().projectOrganizationReview({
        workspaceId: "beta",
        planId: review.planId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const token = {
      ...owner,
      tokenId: "token",
      workspaceId: "alpha",
      scopes: [CAPABILITY.READ, CAPABILITY.EDIT],
    };
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('token','alpha','owner','Synthetic',?,?,?,?)",
    )
      .bind(
        await credentialHash("synthetic"),
        JSON.stringify(token.scopes),
        new Date(now).toISOString(),
        new Date(now + 86400000).toISOString(),
      )
      .run();
    const tokenReview = await as(token).projectOrganizationPlan(fields());
    await expect(
      as().projectOrganizationApply(applyInput(tokenReview)),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='token'",
    )
      .bind(new Date(now).toISOString())
      .run();
    await expect(
      as(token).projectOrganizationApply(applyInput(tokenReview)),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await as(operator).projectOrganizationApply(applyInput(review)))
        .createdProjectIds,
    ).toHaveLength(1);
  });
  it("rolls back new projects, assignments, metadata, history and receipt if a late statement fails", async () => {
    const review = await as().projectOrganizationPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce((statements) =>
      batch([
        ...statements,
        bindings.HQ_DB.prepare(
          "INSERT INTO projects(id,workspace_id,name,description,updated_at) VALUES ('old','alpha','Duplicate','',?)",
        ).bind(new Date(now).toISOString()),
      ]),
    );
    await expect(
      as().projectOrganizationApply(applyInput(review)),
    ).rejects.toThrow();
    expect(await count("projects")).toBe(2);
    expect(await count("operations")).toBe(0);
    expect(await count("activity")).toBe(0);
    expect(
      (await as().repository({ ...workspace, repositoryId: "first" }))
        .projectId,
    ).toBe("old");
    expect(
      (
        await as().projectOrganizationReview({
          ...workspace,
          planId: review.planId,
        })
      ).state,
    ).toBe("ready");
    expect(
      (await as().projectOrganizationApply(applyInput(review)))
        .createdProjectIds,
    ).toHaveLength(1);
  });
  it("retains a committed receipt without disclosing it if access is lost after commit", async () => {
    const review = await as().projectOrganizationPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
      async (statements) => {
        const result = await batch(statements);
        await bindings.HQ_DB.prepare(
          "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        ).run();
        return result;
      },
    );
    await expect(
      as().projectOrganizationApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("operations")).toBe(1);
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='owner',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    expect(
      (await as().projectOrganizationApply(applyInput(review)))
        .createdProjectIds,
    ).toHaveLength(1);
    expect(await count("projects")).toBe(3);
  });
  it("reconciles concurrent duplicate Apply to one set of stable identities and events", async () => {
    const review = await as().projectOrganizationPlan(fields());
    const receipts = await Promise.all([
      as().projectOrganizationApply(applyInput(review)),
      as().projectOrganizationApply(applyInput(review)),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await count("projects")).toBe(3);
    expect(await count("operations")).toBe(1);
    expect(await count("activity")).toBe(3);
  });
  it("returns the committed receipt when Apply finishes between review reads", async () => {
    const review = await as().projectOrganizationPlan(fields());
    const target = ProjectOrganizationService.prototype as unknown as {
      matching: (workspaceId: string, reviewed: unknown) => Promise<boolean>;
    };
    const matching = target.matching;
    vi.spyOn(target, "matching").mockImplementationOnce(async function (
      this: ProjectOrganizationService,
      workspaceId,
      reviewed,
    ) {
      await as().projectOrganizationApply(applyInput(review));
      return matching.call(this, workspaceId, reviewed);
    });
    const saved = await as().projectOrganizationReview({
      ...workspace,
      planId: review.planId,
    });
    expect(saved.state).toBe("applied");
    expect(saved.receipt?.createdProjectIds).toHaveLength(1);
  });
  it("supports the bounded selection without expanding D1 bind parameters", async () => {
    const repositories = Array.from(
      { length: PROJECT_ORGANIZATION_LIMITS.REPOSITORIES },
      (_, i) => ({
        repositoryId: "bulk-" + i,
        revision: 1,
        targetKey: "p" + i,
      }),
    );
    await bindings.HQ_DB.prepare(
      "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) SELECT json_extract(value,'$.repositoryId'),'alpha','example/'||json_extract(value,'$.repositoryId'),'','old','maintained','active',?,?,'seed' FROM json_each(?)",
    )
      .bind(
        JSON.stringify(DEFAULT_EXPECTATIONS),
        new Date(now).toISOString(),
        JSON.stringify(repositories),
      )
      .run();
    const review = await as().projectOrganizationPlan({
      ...workspace,
      repositories,
      targets: repositories.map((row, i) => ({
        key: row.targetKey,
        kind: "new",
        project: newOrganizationProject("Project " + i),
      })),
    });
    expect(
      (await as().projectOrganizationApply(applyInput(review)))
        .createdProjectIds,
    ).toHaveLength(PROJECT_ORGANIZATION_LIMITS.REPOSITORIES);
  });
  it("bounds pending reviews and retains applied receipts while reaping expired drafts", async () => {
    const applied = await as().projectOrganizationPlan(fields());
    const receipt = await as().projectOrganizationApply(applyInput(applied));
    const input = fields();
    input.repositories.forEach((repo) => {
      repo.revision = 2;
    });
    input.targets = [
      {
        key: "new",
        kind: "new",
        project: newOrganizationProject("Another shared effort"),
      },
    ];
    for (let i = 0; i < PROJECT_ORGANIZATION_LIMITS.PENDING_PLANS; i++)
      await as().projectOrganizationPlan(input);
    await expect(as().projectOrganizationPlan(input)).rejects.toMatchObject({
      code: "capacity",
    });
    now += LIMITS.PLAN_TTL_MS + 1;
    await as().projectOrganizationPlan(input);
    expect(await count("action_plans")).toBe(2);
    expect(
      (
        await as().projectOrganizationReview({
          ...workspace,
          planId: applied.planId,
        })
      ).receipt,
    ).toEqual(receipt);
  });
  it("shares strict HTTP and MCP semantics", async () => {
    const app = createApplication(async () => owner);
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/projects_organize_plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify(fields()),
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(commands.projects_organize_review.readOnly).toBe(true);
    expect(commandAnnotations("projects_organize_apply", false)).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
