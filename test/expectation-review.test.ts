import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS, type Principal } from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const as = (subject = "owner", extra: Partial<Principal> = {}) =>
  new WorkspaceService(bindings, { subject, displayName: subject, ...extra });
const request = () => ({
  workspaceId: "alpha",
  repositoryId: "repo",
  reviewId: crypto.randomUUID(),
  revision: 1,
  outcome: "Reviewed configuration and documented outstanding CI work",
  nextReviewDate: null,
});
beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','owner','Owner','owner')",
    ),
    db.prepare(
      "INSERT INTO projects(id,workspace_id,name,description) VALUES('project','alpha','Project','')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES('repo','alpha','owner/repo','Keep description','project','maintained','active',?,'2026-01-01','initial')",
      )
      .bind(
        JSON.stringify({
          ...DEFAULT_EXPECTATIONS,
          reviewDate: "2026-01-01",
          note: "Keep note",
        }),
      ),
  ]);
});
it("records the outcome, next date and repository/project Activity atomically without changing other expectations", async () => {
  const input = { ...request(), nextReviewDate: "2099-01-01" };
  const result = await as("operator").expectationReviewComplete(input);
  expect(result).toMatchObject({
    previousReviewDate: "2026-01-01",
    nextReviewDate: "2099-01-01",
    previousRevision: 1,
    revision: 2,
    outcome: input.outcome,
  });
  const saved = await db
    .prepare(
      "SELECT description,expectations_json AS expectations,revision FROM repositories WHERE id='repo'",
    )
    .first<{ description: string; expectations: string; revision: number }>();
  expect(saved?.description).toBe("Keep description");
  expect(JSON.parse(saved!.expectations)).toEqual({
    ...DEFAULT_EXPECTATIONS,
    reviewDate: "2099-01-01",
    note: "Keep note",
  });
  expect(
    await db
      .prepare("SELECT summary FROM activity WHERE type='repository.reviewed'")
      .first("summary"),
  ).toBe(input.outcome);
  expect(
    await db
      .prepare("SELECT count(*) FROM activity_project_links")
      .first("count(*)"),
  ).toBe(1);
  expect(
    await as("viewer").expectationReviewGet({
      workspaceId: "alpha",
      repositoryId: "repo",
      reviewId: input.reviewId,
    }),
  ).toEqual(result);
});
it("recovers duplicate and concurrent submissions with one recorded outcome", async () => {
  const input = request();
  const results = await Promise.all([
    as().expectationReviewComplete(input),
    as().expectationReviewComplete(input),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await as().expectationReviewComplete(input)).toEqual(results[0]);
  expect(
    await db
      .prepare("SELECT revision FROM repositories WHERE id='repo'")
      .first("revision"),
  ).toBe(2);
  expect(
    await db
      .prepare("SELECT count(*) FROM activity WHERE type='repository.reviewed'")
      .first("count(*)"),
  ).toBe(1);
  await expect(
    as().expectationReviewComplete({ ...input, outcome: "Changed" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    as("operator").expectationReviewComplete(input),
  ).rejects.toMatchObject({ status: 409 });
});
it("enforces role, workspace and publisher boundaries", async () => {
  await expect(
    as("viewer").expectationReviewComplete(request()),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    as("owner", { sourceId: "publisher" }).expectationReviewComplete(request()),
  ).rejects.toMatchObject({ status: 403 });
  const input = request();
  await as().expectationReviewComplete(input);
  await expect(
    as().expectationReviewGet({
      workspaceId: "beta",
      repositoryId: "repo",
      reviewId: input.reviewId,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    as().expectationReviewGet({
      workspaceId: "alpha",
      repositoryId: "another",
      reviewId: input.reviewId,
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it("rejects stale revisions and past dates without recording completion", async () => {
  await expect(
    as().expectationReviewComplete({ ...request(), revision: 2 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    as().expectationReviewComplete({
      ...request(),
      nextReviewDate: "2020-01-01",
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    await db.prepare("SELECT count(*) FROM action_plans").first("count(*)"),
  ).toBe(0);
});
it("rolls the entire completion back when Activity fails", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_review_activity BEFORE INSERT ON activity WHEN NEW.type='repository.reviewed' BEGIN SELECT RAISE(ABORT,'synthetic activity failure'); END",
    )
    .run();
  try {
    await expect(as().expectationReviewComplete(request())).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT revision FROM repositories WHERE id='repo'")
        .first("revision"),
    ).toBe(1);
    expect(
      await db.prepare("SELECT count(*) FROM operations").first("count(*)"),
    ).toBe(0);
  } finally {
    await db.prepare("DROP TRIGGER reject_review_activity").run();
  }
});
it("exposes the same bounded completion and read contracts to CLI and MCP", () => {
  expect(commands.expectation_review_complete.method).toBe(
    "expectationReviewComplete",
  );
  expect(
    commandAnnotations("expectation_review_complete", false),
  ).toMatchObject({ idempotentHint: true, openWorldHint: false });
  expect(
    commands.expectation_review_complete.schema.safeParse({
      ...request(),
      shell: "no",
    }).success,
  ).toBe(false);
});
