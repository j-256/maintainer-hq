import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceService } from "../worker/service";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import {
  SYNC_LIMITS,
  VIEW_COLLECTIONS,
  workspaceChangesInput,
  workspaceViewInput,
} from "../shared/workspace-sync";
import { commands, commandAnnotations } from "../shared/commands";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const service = new WorkspaceService(bindings, {
  subject: "owner",
  displayName: "Owner",
});
const workspace = { workspaceId: "alpha" };
const repoFields = {
  fullName: "example/repo",
  description: "Original",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  expectations: DEFAULT_EXPECTATIONS,
};
beforeAll(async () => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
    db.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
});
async function repo(fullName = "example/repo") {
  return service.createRepository({
    ...workspace,
    repository: { ...repoFields, fullName },
  });
}

it("exposes the same bounded local attention through the shared service while keeping provider previews separate", async () => {
  const repository = await service.createRepository({
    ...workspace,
    repository: {
      ...repoFields,
      expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2026-01-01" },
    },
  });
  const result = await service.workspaceAttention({
    ...workspace,
    category: "review",
  });
  expect(result).toMatchObject({
    total: 1,
    operationalEvidenceIncluded: false,
  });
  expect(result.items[0]).toMatchObject({
    repositoryIds: [repository.id],
    category: "review",
  });
  const viewer = new WorkspaceService(bindings, {
    subject: "viewer",
    displayName: "Viewer",
  });
  expect(
    (await viewer.workspaceAttention({ ...workspace, category: "coverage" }))
      .total,
  ).toBe(1);
  await expect(
    viewer.workspaceAttention({ workspaceId: "beta" }),
  ).rejects.toMatchObject({ status: 404 });
  const reporter = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Reporter",
    reporterId: "reporter",
  });
  await expect(reporter.workspaceAttention(workspace)).rejects.toMatchObject({
    status: 403,
  });
});
async function changes(
  view: Awaited<ReturnType<typeof service.workspaceView>>,
) {
  return service.workspaceChanges({
    ...workspace,
    ...view.scope,
    cursor: view.cursor,
    memberRevision: view.memberRevision,
  });
}

it("loads only the active view collections and retains strict bounded CLI/MCP parity", async () => {
  await repo();
  await service.addActivity({
    ...workspace,
    eventId: "note",
    kind: "note",
    title: "Private activity context",
    summary: "Activity only",
    resourceId: null,
  });
  for (const [view, collections] of Object.entries(VIEW_COLLECTIONS)) {
    if (view.startsWith("repository")) continue;
    const result = await service.workspaceView({ ...workspace, view });
    expect(Object.keys(result.records).sort()).toEqual([...collections].sort());
    expect(JSON.stringify(result)).not.toContain("Private activity context");
  }
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  expect(view.records.repositories).toHaveLength(1);
  expect(view.records).not.toHaveProperty("goals");
  expect(view.records).not.toHaveProperty("activity");
  expect(view.records).not.toHaveProperty("connections");
  expect(
    workspaceViewInput.safeParse({
      ...workspace,
      view: "repositories",
      repositoryId: "repo",
    }).success,
  ).toBe(false);
  expect(
    workspaceViewInput.safeParse({ ...workspace, view: "repository" }).success,
  ).toBe(false);
  expect(
    workspaceChangesInput.safeParse({
      ...workspace,
      view: "repositories",
      cursor: -1,
    }).success,
  ).toBe(false);
  for (const name of ["workspace_view", "workspace_changes"] as const) {
    expect(commands[name].readOnly).toBe(true);
    expect(commandAnnotations(name, commands[name].readOnly).readOnlyHint).toBe(
      true,
    );
  }
});

it("returns just changed repository records, coalesces writes, and retains deletion keys", async () => {
  const first = await repo();
  await repo("example/unrelated");
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  const updated = await service.updateRepository({
    ...workspace,
    repositoryId: first.id,
    revision: first.revision,
    repository: { ...repoFields, description: "Intermediate" },
  });
  await service.updateRepository({
    ...workspace,
    repositoryId: first.id,
    revision: updated.revision,
    repository: { ...repoFields, description: "Latest" },
  });
  const update = await changes(view);
  expect(update).toMatchObject({
    type: "delta",
    from: view.cursor,
    upserts: { repositories: [{ id: first.id, description: "Latest" }] },
    removals: [],
  });
  if (update.type !== "delta") throw new Error("Expected delta");
  expect(update.upserts.repositories).toHaveLength(1);
  expect(Object.keys(update.upserts)).toEqual(["repositories"]);
  await db
    .prepare("DELETE FROM repositories WHERE workspace_id='alpha' AND id=?")
    .bind(first.id)
    .run();
  expect(
    await service.workspaceChanges({
      ...workspace,
      ...view.scope,
      cursor: update.cursor,
      memberRevision: view.memberRevision,
    }),
  ).toMatchObject({
    type: "delta",
    upserts: {},
    removals: [{ collection: "repositories", key: first.id }],
  });
});

it("does not read or transport activity when viewing repositories", async () => {
  await repo();
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  await service.addActivity({
    ...workspace,
    eventId: "activity-only",
    kind: "note",
    title: "Activity should stay there",
    summary: "Not repository data",
    resourceId: null,
  });
  const prepare = vi.spyOn(db, "prepare");
  const update = await changes(view);
  expect(update).toMatchObject({
    type: "delta",
    from: view.cursor,
    cursor: view.cursor,
    upserts: {},
    removals: [],
  });
  expect(prepare.mock.calls.map(([sql]) => sql).join(" ")).not.toMatch(
    /FROM (activity|goals)/,
  );
});

it("pushes paused and cleared goal records only to views that need them", async () => {
  const goal = {
    ...workspace,
    goalId: "goal",
    sourceId: "source",
    objective: "  Keep /goal verbatim\nIncluding whitespace  ",
    status: "active",
    startedAt: "2026-01-01T00:00:00Z",
    reportedAt: "2026-01-01T00:00:01Z",
  };
  await service.syncGoal(goal);
  let view = await service.workspaceView({ ...workspace, view: "activity" });
  const repositories = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  for (const [index, status] of ["paused", "cleared"].entries()) {
    await service.syncGoal({
      ...goal,
      status,
      reportedAt: `2026-01-01T00:00:0${index + 2}Z`,
    });
    const delta = await changes(view);
    expect(delta).toMatchObject({
      type: "delta",
      upserts: {
        goals: [{ id: goal.goalId, objective: goal.objective, status }],
      },
      removals: [],
    });
    if (delta.type !== "delta") throw new Error("Expected lifecycle delta");
    expect(Object.keys(delta.upserts)).toEqual(["goals"]);
    expect(delta.upserts.goals).toHaveLength(1);
    expect(await changes(repositories)).toMatchObject({
      type: "delta",
      upserts: {},
      removals: [],
    });
    view = { ...view, cursor: delta.cursor };
  }
});

it("catches up observation changes and removes evidence after a source loses its repository scope", async () => {
  const repository = await repo();
  await db.batch([
    db.prepare(
      "INSERT INTO connections (workspace_id,id,name,provider) VALUES ('alpha','local','Local','local')",
    ),
    db
      .prepare(
        "INSERT INTO source_repositories (workspace_id,source_id,repository_id) VALUES ('alpha','local',?)",
      )
      .bind(repository.id),
    db
      .prepare(
        "INSERT INTO observations (workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES ('alpha','local','repository',?,'Local repository','healthy','Clean','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')",
      )
      .bind(repository.id),
  ]);
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  expect(view.records.observations).toHaveLength(1);
  await db
    .prepare(
      "UPDATE observations SET summary='Updated',name='Renamed' WHERE workspace_id='alpha'",
    )
    .run();
  const update = await changes(view);
  expect(update).toMatchObject({
    type: "delta",
    upserts: { observations: [{ name: "Renamed", summary: "Updated" }] },
  });
  await db
    .prepare("DELETE FROM source_repositories WHERE workspace_id='alpha'")
    .run();
  expect(await changes(view)).toMatchObject({
    type: "delta",
    upserts: {},
    removals: [
      {
        collection: "observations",
        key: JSON.stringify(["local", "repository", repository.id]),
      },
    ],
  });
});

it("rechecks authorization and denies cross-workspace and reporter reads", async () => {
  await expect(
    service.workspaceView({ workspaceId: "beta", view: "repositories" }),
  ).rejects.toMatchObject({ status: 404 });
  const viewer = new WorkspaceService(bindings, {
    subject: "viewer",
    displayName: "Viewer",
  });
  expect(
    (await viewer.workspaceView({ ...workspace, view: "repositories" }))
      .capabilities,
  ).toEqual(["read", "preferences:write"]);
  const reporter = new WorkspaceService(bindings, {
    subject: "owner",
    displayName: "Reporter",
    reporterId: "agent",
    scopes: ["read"],
  });
  await expect(
    reporter.workspaceView({ ...workspace, view: "repositories" }),
  ).rejects.toMatchObject({ status: 403 });
  const originalBatch = db.batch.bind(db);
  vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
    const result = await originalBatch(statements);
    await db
      .prepare(
        "DELETE FROM members WHERE workspace_id='alpha' AND subject='owner'",
      )
      .run();
    return result;
  });
  await expect(
    service.workspaceView({ ...workspace, view: "repositories" }),
  ).rejects.toMatchObject({ status: 404 });
});

it("keeps the journal atomic with data writes and sees a consistent batch boundary", async () => {
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  await expect(
    db.batch([
      db.prepare(
        "INSERT INTO projects (workspace_id,id,name,description) VALUES ('alpha','rollback','Rollback','')",
      ),
      db.prepare(
        "INSERT INTO projects (workspace_id,id,name,description) VALUES ('missing','invalid','Invalid','')",
      ),
    ]),
  ).rejects.toThrow();
  expect(await changes(view)).toMatchObject({
    type: "delta",
    cursor: view.cursor,
    upserts: {},
    removals: [],
  });
  const result = await db.batch([
    db.prepare(
      "INSERT INTO projects (workspace_id,id,name,description) VALUES ('alpha','committed','Committed','')",
    ),
    db.prepare(
      "SELECT record_key,cursor FROM workspace_changes WHERE workspace_id='alpha' AND collection='projects'",
    ),
    db.prepare(
      "SELECT cursor FROM workspace_sync_clock WHERE workspace_id='alpha'",
    ),
  ]);
  expect(result[1].results[0]).toMatchObject({
    record_key: "committed",
    cursor: (result[2].results[0] as { cursor: number }).cursor,
  });
});

it("requests view-only recovery for a history gap or oversized catch-up", async () => {
  const repository = await repo();
  const repos = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  const activity = await service.workspaceView({
    ...workspace,
    view: "activity",
  });
  const preferences = await service.workspaceView({
    ...workspace,
    view: "preferences",
  });
  await db
    .prepare(
      "INSERT INTO projects (workspace_id,id,name,description) VALUES ('alpha','old','Old','')",
    )
    .run();
  await db
    .prepare(
      "UPDATE workspace_sync_clock SET cursor=cursor+? WHERE workspace_id='alpha'",
    )
    .bind(SYNC_LIMITS.HISTORY)
    .run();
  await db
    .prepare(
      "INSERT INTO projects (workspace_id,id,name,description) VALUES ('alpha','new','New','')",
    )
    .run();
  expect(await changes(repos)).toMatchObject({
    type: "reset",
    reason: "history_expired",
  });
  expect(await changes(activity)).toMatchObject({
    type: "reset",
    reason: "history_expired",
  });
  expect(await changes(preferences)).toMatchObject({
    type: "delta",
    upserts: {},
    removals: [],
  });
  const baseline = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  await db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO projects (workspace_id,id,name,description) SELECT 'alpha','bulk-'||x,'Bulk '||x,'' FROM n",
    )
    .bind(SYNC_LIMITS.CHANGES + 1)
    .run();
  expect(await changes(baseline)).toMatchObject({
    type: "reset",
    reason: "overflow",
  });
  const detail = await service.workspaceView({
    ...workspace,
    view: "repository",
    repositoryId: repository.id,
  });
  expect(detail.records.repositories?.map((item) => item.id)).toEqual([
    repository.id,
  ]);
});
