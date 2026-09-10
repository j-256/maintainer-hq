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
  LIMITS,
  assessRepository,
  type Principal,
} from "../shared/domain";
import {
  EXPECTATION_BULK_LIMITS,
  EXPECTATION_PRESETS,
  expectationBulkPlanInput,
  patchExpectations,
  type ExpectationBulkFields,
} from "../shared/expectation-bulk";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { ExpectationBulkService } from "../worker/expectation-bulk";
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
const fields = (): ExpectationBulkFields => ({
  ...workspace,
  repositories: [
    {
      repositoryId: "first",
      revision: 1,
      patch: { ci: "optional" as const },
    },
    {
      repositoryId: "second",
      revision: 1,
      patch: { ci: "unmanaged" as const },
    },
  ],
});
const count = async (table: string) =>
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
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','owner','Owner','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description,updated_at) VALUES ('project','alpha','Project','',?),('other-project','alpha','Other project','',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      `INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES ('first','alpha','example/first','Keep description','project','maintained','active',?,?,'seed-first'),
      ('second','alpha','example/second','Keep archived watchlist','project','watchlist','archived',?,?,'seed-second')`,
    ).bind(
      JSON.stringify({
        ...DEFAULT_EXPECTATIONS,
        reviewDate: "2027-01-01",
        note: "First specific note",
      }),
      new Date(now).toISOString(),
      JSON.stringify({
        ...DEFAULT_EXPECTATIONS,
        note: "Second specific note",
      }),
      new Date(now).toISOString(),
    ),
  ]);
});

describe("Reviewed expectation changes", () => {
  it("recovers the receipt when Apply commits between review reads", async () => {
    const review = await as().expectationBulkPlan(fields());
    const target = ExpectationBulkService.prototype as unknown as {
      matching: (workspaceId: string, reviewed: unknown) => Promise<boolean>;
    };
    const matching = target.matching;
    vi.spyOn(target, "matching").mockImplementationOnce(async function (
      this: ExpectationBulkService,
      workspaceId,
      reviewed,
    ) {
      await as().expectationBulkApply(applyInput(review));
      return matching.call(this, workspaceId, reviewed);
    });
    const saved = await as().expectationBulkReview({
      ...workspace,
      planId: review.planId,
    });
    expect(saved.state).toBe("applied");
    expect(saved.receipt?.changedRepositoryIds).toHaveLength(2);
  });
  it("uses opt-in patches and presets without granting authority or inventing health", () => {
    for (const preset of EXPECTATION_PRESETS) {
      const after = patchExpectations(
        { ...DEFAULT_EXPECTATIONS, note: "Keep", reviewDate: "2027-01-01" },
        preset.patch,
      );
      expect(after.note).toBe("Keep");
      expect(after.reviewDate).toBe("2027-01-01");
      expect(after.visibility).toBe("any");
    }
    const observe = patchExpectations(
      DEFAULT_EXPECTATIONS,
      EXPECTATION_PRESETS[2].patch,
    );
    expect(
      assessRepository(
        {
          id: "r",
          workspaceId: "alpha",
          fullName: "a/r",
          description: "",
          projectId: "project",
          classification: "watchlist",
          lifecycle: "active",
          expectations: observe,
          revision: 1,
          updatedAt: new Date().toISOString(),
        },
        [],
      ).health,
    ).toBe("unknown");
    expect(
      patchExpectations(DEFAULT_EXPECTATIONS, {
        note: "",
        reviewDate: null,
        ci: undefined,
      }),
    ).toEqual(DEFAULT_EXPECTATIONS);
    for (const repositories of [
      [],
      [...fields().repositories, fields().repositories[0]],
      [{ repositoryId: "first", revision: 1, patch: {} }],
      [
        {
          repositoryId: "first",
          revision: 1,
          patch: { projectId: "project" },
        },
      ],
      Array.from(
        { length: EXPECTATION_BULK_LIMITS.REPOSITORIES + 1 },
        (_, i) => ({
          repositoryId: "r" + i,
          revision: 1,
          patch: { ci: "optional" },
        }),
      ),
      Array.from({ length: EXPECTATION_BULK_LIMITS.REPOSITORIES }, (_, i) => ({
        repositoryId: "large-" + i,
        revision: 1,
        patch: { note: "x".repeat(1500) },
      })),
    ])
      expect(
        expectationBulkPlanInput.safeParse({ ...workspace, repositories })
          .success,
      ).toBe(false);
  });
  it("preserves other fields and observations, records exact changes and returns the same receipt after expiry", async () => {
    const before = await as().repositories(workspace);
    const review = await as().expectationBulkPlan(fields());
    expect(review.state).toBe("ready");
    expect(review.rows.map((row) => row.changed)).toEqual([["ci"], ["ci"]]);
    expect(await as().repositories(workspace)).toEqual(before);
    const receipt = await as().expectationBulkApply(applyInput(review));
    expect(receipt.changedRepositoryIds).toEqual(["first", "second"]);
    const after = await as().repositories(workspace);
    for (const original of before) {
      const updated = after.find((row) => row.id === original.id)!;
      expect(updated).toMatchObject({
        ...original,
        expectations: {
          ...original.expectations,
          ci: original.id === "first" ? "optional" : "unmanaged",
        },
        revision: 2,
        updatedAt: receipt.appliedAt,
      });
    }
    expect(await count("activity")).toBe(2);
    expect(await count("activity_project_links")).toBe(2);
    expect(await count("activity_repository_links")).toBe(2);
    expect(await count("observations")).toBe(0);
    expect(await count("connections")).toBe(0);
    now += LIMITS.PLAN_TTL_MS * 2;
    expect(await as().expectationBulkApply(applyInput(review))).toEqual(
      receipt,
    );
    expect(
      (
        await as().expectationBulkReview({
          ...workspace,
          planId: review.planId,
        })
      ).receipt,
    ).toEqual(receipt);
    expect(await count("operations")).toBe(1);
    expect(await count("activity")).toBe(2);
  });
  it("allows operators but rejects viewer, cross-workspace, actor, reporter and source access", async () => {
    const review = await as({
      subject: "operator",
      displayName: "Operator",
    }).expectationBulkPlan(fields());
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as({ subject: "viewer", displayName: "Viewer" }).expectationBulkPlan(
        fields(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as().expectationBulkReview({
        workspaceId: "beta",
        planId: review.planId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    for (const principal of [
      { ...owner, reporterId: "r" },
      { ...owner, sourceId: "s" },
    ])
      await expect(
        as(principal).expectationBulkPlan(fields()),
      ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await as({
          subject: "operator",
          displayName: "Operator",
        }).expectationBulkApply(applyInput(review))
      ).changedRepositoryIds,
    ).toHaveLength(2);
  });
  it("does not increment unchanged revisions or emit no-op Activity", async () => {
    const input = fields();
    input.repositories[0]!.patch = { ci: "required" };
    const review = await as().expectationBulkPlan(input);
    expect(review.rows[0]!.changed).toEqual([]);
    const receipt = await as().expectationBulkApply(applyInput(review));
    expect(receipt.unchangedRepositoryIds).toEqual(["first"]);
    expect(
      (await as().repository({ ...workspace, repositoryId: "first" })).revision,
    ).toBe(1);
    expect(await count("activity")).toBe(1);
  });
  it.each(["edit", "delete", "move", "membership"])(
    "rejects all changes when %s happens after review",
    async (change) => {
      const review = await as().expectationBulkPlan(fields());
      const sql = {
        edit: "UPDATE repositories SET description='Changed',revision=revision+1 WHERE id='second'",
        delete: "DELETE FROM repositories WHERE id='second'",
        move: "UPDATE repositories SET project_id='other-project',revision=revision+1 WHERE id='second'",
        membership:
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
      }[change]!;
      await bindings.HQ_DB.prepare(sql).run();
      expect(
        (
          await as().expectationBulkReview({
            ...workspace,
            planId: review.planId,
          })
        ).state,
      ).toBe("stale");
      await expect(
        as().expectationBulkApply(applyInput(review)),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await as().repository({ ...workspace, repositoryId: "first" }))
          .expectations.ci,
      ).toBe("required");
      expect(await count("operations")).toBe(0);
      expect(await count("activity")).toBe(0);
    },
  );
  it("rechecks all revisions at the atomic write boundary", async () => {
    const review = await as().expectationBulkPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
      async (statements) => {
        await bindings.HQ_DB.prepare(
          "UPDATE repositories SET revision=revision+1 WHERE id='second'",
        ).run();
        return batch(statements);
      },
    );
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("operations")).toBe(0);
    expect(
      (await as().repository({ ...workspace, repositoryId: "first" })).revision,
    ).toBe(1);
  });
  it("rechecks live authority at the atomic write boundary", async () => {
    const review = await as().expectationBulkPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
      async (statements) => {
        await bindings.HQ_DB.prepare(
          "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        ).run();
        return batch(statements);
      },
    );
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("operations")).toBe(0);
    expect(await count("activity")).toBe(0);
  });
  it("enforces expiry, fingerprint integrity and stored input integrity", async () => {
    const review = await as().expectationBulkPlan(fields());
    await expect(
      as().expectationBulkApply({
        ...applyInput(review),
        fingerprint: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    now += LIMITS.PLAN_TTL_MS + 1;
    expect(
      (
        await as().expectationBulkReview({
          ...workspace,
          planId: review.planId,
        })
      ).state,
    ).toBe("expired");
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 409 });
    now -= LIMITS.PLAN_TTL_MS + 1;
    await bindings.HQ_DB.prepare(
      "UPDATE action_plans SET input_json=json_set(input_json,'$.rows[0].after.ci','unmanaged') WHERE id=?",
    )
      .bind(review.planId)
      .run();
    await expect(
      as().expectationBulkReview({ ...workspace, planId: review.planId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("operations")).toBe(0);
  });
  it("rolls back the receipt, updates and Activity if a later database statement fails", async () => {
    const review = await as().expectationBulkPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce((statements) =>
      batch([
        ...statements,
        bindings.HQ_DB.prepare(
          "INSERT INTO projects (id,workspace_id,name,description,updated_at) VALUES ('project','alpha','Duplicate project','',?)",
        ).bind(new Date(now).toISOString()),
      ]),
    );
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toThrow();
    expect(await count("operations")).toBe(0);
    expect(await count("activity")).toBe(0);
    expect(
      (await as().repository({ ...workspace, repositoryId: "first" })).revision,
    ).toBe(1);
    expect(
      (
        await as().expectationBulkReview({
          ...workspace,
          planId: review.planId,
        })
      ).state,
    ).toBe("ready");
    expect(
      (await as().expectationBulkApply(applyInput(review)))
        .changedRepositoryIds,
    ).toHaveLength(2);
  });
  it("retains a committed receipt when access is lost before the response, without disclosing it", async () => {
    const review = await as().expectationBulkPlan(fields());
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
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("operations")).toBe(1);
    expect(await count("activity")).toBe(2);
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role='owner',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    expect(
      (await as().expectationBulkApply(applyInput(review)))
        .changedRepositoryIds,
    ).toHaveLength(2);
    expect(await count("activity")).toBe(2);
  });
  it("binds token identity and observes revocation or scope loss without allowing browser substitution", async () => {
    const token = {
      ...owner,
      tokenId: "token",
      workspaceId: "alpha",
      scopes: [CAPABILITY.READ, CAPABILITY.EDIT],
    };
    await bindings.HQ_DB.prepare(
      `INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at)
      VALUES ('token','alpha','owner','Synthetic',?,?,?,?)`,
    )
      .bind(
        await credentialHash("synthetic-token"),
        JSON.stringify(token.scopes),
        new Date(now).toISOString(),
        new Date(now + 86400000).toISOString(),
      )
      .run();
    const review = await as(token).expectationBulkPlan(fields());
    await expect(
      as().expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json='[\"read\"]' WHERE id='token'",
    ).run();
    await expect(
      as(token).expectationBulkApply(applyInput(review)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("operations")).toBe(0);
  });
  it("reconciles concurrent duplicate application to one receipt and one set of events", async () => {
    const review = await as().expectationBulkPlan(fields());
    const receipts = await Promise.all([
      as().expectationBulkApply(applyInput(review)),
      as().expectationBulkApply(applyInput(review)),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await count("operations")).toBe(1);
    expect(await count("activity")).toBe(2);
  });
  it("supports the bounded fleet size without exceeding D1 bound-parameter limits", async () => {
    const input = {
      ...workspace,
      repositories: Array.from(
        { length: EXPECTATION_BULK_LIMITS.REPOSITORIES },
        (_, i) => ({
          repositoryId: "bulk-" + i,
          revision: 1,
          patch: { monitoring: "required" as const },
        }),
      ),
    };
    await bindings.HQ_DB.prepare(
      `INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      SELECT json_extract(value,'$.repositoryId'),'alpha','example/'||json_extract(value,'$.repositoryId'),'','project','maintained','active',?,?,'seed' FROM json_each(?)`,
    )
      .bind(
        JSON.stringify(DEFAULT_EXPECTATIONS),
        new Date(now).toISOString(),
        JSON.stringify(input.repositories),
      )
      .run();
    const review = await as().expectationBulkPlan(input);
    const receipt = await as().expectationBulkApply(applyInput(review));
    expect(receipt.changedRepositoryIds).toHaveLength(
      EXPECTATION_BULK_LIMITS.REPOSITORIES,
    );
  });
  it("bounds open reviews and reaps only expired unapplied reviews of this kind", async () => {
    for (let i = 0; i < EXPECTATION_BULK_LIMITS.PENDING_PLANS; i++)
      await as().expectationBulkPlan(fields());
    await expect(as().expectationBulkPlan(fields())).rejects.toMatchObject({
      code: "capacity",
    });
    now += LIMITS.PLAN_TTL_MS + 1;
    expect((await as().expectationBulkPlan(fields())).state).toBe("ready");
    expect(await count("action_plans")).toBe(1);
  });
  it("uses the same validated HTTP contract and declares bounded CLI/MCP semantics", async () => {
    const app = createApplication(async () => owner);
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/expectations_plan", {
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
    const plan = (await response.json()) as { planId: string };
    expect(plan.planId).toBeTruthy();
    expect(commands.expectations_review.readOnly).toBe(true);
    expect(commandAnnotations("expectations_apply", false)).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
