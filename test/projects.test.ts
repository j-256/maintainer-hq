import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  projectFields,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const workspace = { workspaceId: "alpha" };
const principal: Principal = { subject: "owner", displayName: "Owner" };
const service = new WorkspaceService(bindings, principal);
const initial = {
  name: "Independent service",
  description: "A project does not need a repository",
};
const firstRepository = {
  fullName: "example/service",
  description: "Source repository",
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
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01T00:00:00.000Z'),('beta','Beta','2026-01-01T00:00:00.000Z')",
    ),
    db.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
  ]);
});
async function counts() {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM projects) AS projects,(SELECT COUNT(*) FROM repositories) AS repositories,(SELECT COUNT(*) FROM activity) AS activity",
    )
    .first<{ projects: number; repositories: number; activity: number }>();
}

it("creates independent stable projects with explicit defaults and bounded shared command parity", async () => {
  const project = await service.createProject({ ...workspace, ...initial });
  expect(project).toMatchObject({
    ...initial,
    workspaceId: "alpha",
    lifecycle: "active",
    importance: "standard",
    importanceNote: "",
    portfolio: DEFAULT_PORTFOLIO,
    revision: 1,
  });
  expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    await service.project({ ...workspace, projectId: project.id }),
  ).toEqual(project);
  expect(await service.projects(workspace)).toEqual([project]);
  expect(await service.repositories(workspace)).toEqual([]);
  expect(await counts()).toEqual({ projects: 1, repositories: 0, activity: 1 });
  for (const name of [
    "projects_list",
    "project_get",
    "project_create",
    "project_update",
  ] as const) {
    expect(typeof service[commands[name].method]).toBe("function");
    expect(
      commands[name].schema.safeParse({
        workspaceId: "alpha",
        arbitrarySql: "forbidden",
      }).success,
    ).toBe(false);
  }
  expect(
    commandAnnotations("project_get", commands.project_get.readOnly),
  ).toMatchObject({ readOnlyHint: true });
  expect(
    commandAnnotations("project_update", commands.project_update.readOnly),
  ).toMatchObject({ readOnlyHint: false });
  await expect(
    db
      .prepare(
        "INSERT INTO projects (workspace_id,id,name,description) VALUES ('beta',?,'Duplicate identity','')",
      )
      .bind(project.id)
      .run(),
  ).rejects.toThrow();
});

it("atomically creates a project with its first repository and allows additional distinct repositories", async () => {
  const project = await service.createProject({
    ...workspace,
    ...initial,
    firstRepository,
  });
  const [repository] = await service.repositories(workspace);
  expect(repository).toMatchObject({
    ...firstRepository,
    projectId: project.id,
    revision: 1,
  });
  expect(repository.id).not.toBe(project.id);
  await service.createRepository({
    ...workspace,
    repository: {
      ...firstRepository,
      fullName: "example/second",
      projectId: project.id,
    },
  });
  expect(
    (await service.repositories(workspace)).map((row) => row.projectId),
  ).toEqual([project.id, project.id]);
  expect(
    await service.project({ ...workspace, projectId: project.id }),
  ).toEqual(project);
  expect(await counts()).toEqual({ projects: 1, repositories: 2, activity: 3 });
});

it("does not leave an empty project when the first repository already exists or its insertion fails", async () => {
  await db
    .prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('existing','alpha','Existing','')",
    )
    .run();
  await service.createRepository({
    ...workspace,
    repository: { ...firstRepository, projectId: "existing" },
  });
  await expect(
    service.createProject({ ...workspace, ...initial, firstRepository }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await counts()).toEqual({ projects: 1, repositories: 1, activity: 1 });
  await db
    .prepare(
      "CREATE TRIGGER fail_project_repository BEFORE INSERT ON repositories WHEN NEW.full_name='example/failure' BEGIN SELECT RAISE(ABORT,'Synthetic repository failure'); END",
    )
    .run();
  try {
    await expect(
      service.createProject({
        ...workspace,
        ...initial,
        firstRepository: { ...firstRepository, fullName: "example/failure" },
      }),
    ).rejects.toThrow();
    expect(await counts()).toEqual({
      projects: 1,
      repositories: 1,
      activity: 1,
    });
  } finally {
    await db.prepare("DROP TRIGGER fail_project_repository").run();
  }
});

it("serializes concurrent duplicate project and first-repository creation without extra journal entries", async () => {
  const results = await Promise.allSettled([
    service.createProject({ ...workspace, ...initial, firstRepository }),
    service.createProject({ ...workspace, ...initial, firstRepository }),
    service.createProject({
      ...workspace,
      ...initial,
      name: "Another candidate",
      firstRepository,
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await counts()).toEqual({ projects: 1, repositories: 1, activity: 2 });
});

it("enforces project capacity in the same transaction as creation", async () => {
  await db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO projects (workspace_id,id,name,description) SELECT 'alpha','capacity-'||x,'Capacity '||x,'' FROM n",
    )
    .run();
  await expect(
    service.createProject({ ...workspace, ...initial, firstRepository }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await counts()).toEqual({
    projects: 1000,
    repositories: 0,
    activity: 0,
  });
});

it("preserves the winning revision when project editors save concurrently", async () => {
  const project = await service.createProject({ ...workspace, ...initial });
  const results = await Promise.allSettled(
    ["First edit", "Second edit"].map((name) =>
      service.updateProject({
        ...workspace,
        projectId: project.id,
        revision: 1,
        project: { ...initial, name },
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    (await service.project({ ...workspace, projectId: project.id })).revision,
  ).toBe(2);
  expect(await counts()).toEqual({ projects: 1, repositories: 0, activity: 2 });
});

it("updates project metadata once while preserving identity, repository expectations and provider state", async () => {
  const project = await service.createProject({
    ...workspace,
    ...initial,
    firstRepository,
  });
  const repositories = await service.repositories(workspace);
  const fields = projectFields.parse({
    ...initial,
    name: "Renamed service",
    lifecycle: "archived",
    importance: "high",
    importanceNote: "Public reputation and dependency",
    portfolio: {
      status: "listed",
      reason: "Maintainer confirmed inclusion",
      url: "https://example.com/projects/service",
      reviewDate: "2026-12-01",
    },
  });
  const updated = await service.updateProject({
    ...workspace,
    projectId: project.id,
    revision: project.revision,
    project: fields,
  });
  expect(updated).toMatchObject({
    ...fields,
    id: project.id,
    workspaceId: "alpha",
    revision: 2,
  });
  expect(await service.repositories(workspace)).toEqual(repositories);
  expect(await service.connections(workspace)).toEqual([]);
  expect(
    await service.updateProject({
      ...workspace,
      projectId: project.id,
      revision: 2,
      project: fields,
    }),
  ).toEqual(updated);
  expect(await counts()).toEqual({ projects: 1, repositories: 1, activity: 3 });
  await expect(
    service.updateProject({
      ...workspace,
      projectId: project.id,
      revision: 1,
      project: fields,
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("denies viewers, reporters, foreign workspaces and membership changes at the write boundary", async () => {
  const viewer = new WorkspaceService(bindings, {
    subject: "viewer",
    displayName: "Viewer",
  });
  const reporter = new WorkspaceService(bindings, {
    ...principal,
    reporterId: "reporter",
  });
  await expect(
    viewer.createProject({ ...workspace, ...initial }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    reporter.createProject({ ...workspace, ...initial }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service.createProject({ ...workspace, ...initial, workspaceId: "beta" }),
  ).rejects.toMatchObject({ status: 404 });
  const project = await service.createProject({ ...workspace, ...initial });
  await expect(
    viewer.updateProject({
      ...workspace,
      projectId: project.id,
      revision: 1,
      project: initial,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service.project({ workspaceId: "beta", projectId: project.id }),
  ).rejects.toMatchObject({ status: 404 });
  const batch = db.batch.bind(db);
  vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
    await db
      .prepare(
        "UPDATE members SET revision=revision+1,role='viewer' WHERE workspace_id='alpha' AND subject='owner'",
      )
      .run();
    return batch(statements);
  });
  await expect(
    service.createProject({
      ...workspace,
      name: "Revoked during create",
      description: "",
      firstRepository,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(await counts()).toEqual({ projects: 1, repositories: 0, activity: 1 });
});

it("requires an exclusion reason and rejects unsafe listing URLs and unbounded metadata", () => {
  const fields = {
    ...initial,
    portfolio: { ...DEFAULT_PORTFOLIO, status: "excluded" },
  };
  expect(projectFields.safeParse(fields).success).toBe(false);
  expect(
    projectFields.safeParse({
      ...fields,
      portfolio: { ...fields.portfolio, reason: "Internal-only service" },
    }).success,
  ).toBe(true);
  for (const url of [
    "http://example.com",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "not a URL",
  ]) {
    expect(
      projectFields.safeParse({
        ...initial,
        portfolio: { ...DEFAULT_PORTFOLIO, url },
      }).success,
    ).toBe(false);
  }
  expect(
    projectFields.safeParse({ ...initial, importanceNote: "x".repeat(1001) })
      .success,
  ).toBe(false);
});

it("pushes the complete project metadata record without unrelated Activity data", async () => {
  const view = await service.workspaceView({
    ...workspace,
    view: "repositories",
  });
  const project = await service.createProject({ ...workspace, ...initial });
  const update = await service.workspaceChanges({
    ...workspace,
    ...view.scope,
    cursor: view.cursor,
    memberRevision: view.memberRevision,
  });
  expect(update).toMatchObject({
    type: "delta",
    upserts: { projects: [project] },
  });
  expect(update).not.toHaveProperty("activity");
});
