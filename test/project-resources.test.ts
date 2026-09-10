import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  repositoryFields,
  type Principal,
} from "../shared/domain";
import { commands } from "../shared/commands";
import {
  PROJECT_RESOURCE_LIMITS,
  type ResourceProjectReference,
} from "../shared/project-resources";
import { WorkspaceService } from "../worker/service";
import {
  captureResourceActivity,
  copyActivityContext,
} from "../worker/resource-links";
import { captureSecretProjectActivity } from "../worker/project-resources";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const workspace = { workspaceId: "alpha" };
const now = new Date().toISOString();
const hook: ResourceProjectReference = {
  ...workspace,
  kind: "hook",
  connectionId: "hooks",
  resourceKey: "shared-hook",
};
const monitor: ResourceProjectReference = {
  ...workspace,
  kind: "monitor",
  connectionId: "monitors",
  resourceKey: "service-health",
};
const secret: ResourceProjectReference = {
  ...workspace,
  kind: "secret",
  connectionId: "secrets",
  resourceKey: "service",
};
function as(subject = "owner", extra: Partial<Principal> = {}) {
  return new WorkspaceService(bindings, {
    subject,
    displayName: subject,
    ...extra,
  });
}
function save(
  reference = hook,
  projectId = "p1",
  revision = 0,
  fields = {},
) {
  return as().resourceProjectSave({
    ...reference,
    projectId,
    revision,
    connectionRevision: 1,
    projectRevision: 1,
    ...fields,
  });
}
function resources(projectId = "p1", fields = {}) {
  return as().projectResources({ ...workspace, projectId, ...fields });
}
function note(eventId: string, resourceId: string | null = null, fields = {}) {
  return as().addActivity({
    ...workspace,
    eventId,
    resourceId,
    kind: "note",
    title: eventId,
    summary: "Synthetic project activity",
    ...fields,
  });
}
async function eventIds(projectId: string) {
  return (
    await as().activityFeed({ ...workspace, projectId, limit: 50 })
  ).groups.flatMap((group) => (group.kind === "event" ? [group.event.id] : []));
}
beforeAll(() => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db
      .prepare(
        "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
      )
      .bind(now, now),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','foreign','Foreign','owner')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('alpha','p1','Service',''),('alpha','p2','Other service',''),('beta','p3','Foreign project','')",
    ),
    db.prepare(`INSERT INTO connections(workspace_id,id,name,provider,configuration_json) VALUES
      ('alpha','hooks','Hooks','hookrelay','{"projectId":"p1"}'),('alpha','monitors','Monitoring','endpoint-monitor','{"projectId":"p1"}'),('beta','hooks','Foreign','hookrelay','{}')`),
    db
      .prepare(
        `INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id)
      VALUES ('alpha','secrets','Secrets','github-actions','private-reference',?,1,1,'initial')`,
      )
      .bind(
        JSON.stringify([
          {
            id: "service",
            label: "Service secret resource",
            identity: { private: "must-not-leak" },
            repositories: [],
          },
          {
            id: "second",
            label: "Second resource",
            identity: { private: "must-not-leak" },
            repositories: [],
          },
        ]),
      ),
    ...["r1", "r2", "ungrouped"].map((id) =>
      db
        .prepare(
          `INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
      VALUES (?,'alpha',?,'',?,'maintained','active',?,?,'initial')`,
        )
        .bind(
          id,
          "example/" + id,
          id === "r2" ? "p2" : "p1",
          JSON.stringify(DEFAULT_EXPECTATIONS),
          now,
        ),
    ),
  ]);
});

it("links individual resources without a repository, provider fan-out, or inherited connection ownership", async () => {
  await db.prepare("DELETE FROM repositories WHERE workspace_id='alpha'").run();
  expect(await resources()).toEqual({ items: [], nextCursor: null });
  for (const reference of [hook, monitor, secret]) {
    expect(await as().resourceProject(reference)).toMatchObject({
      projectId: null,
      revision: 0,
      connectionRevision: 1,
    });
    expect(await save(reference)).toMatchObject({
      ...reference,
      projectId: "p1",
      revision: 1,
      updatedAt: expect.any(String),
    });
  }
  const page = await resources();
  expect(page.items).toHaveLength(3);
  expect(
    page.items.every(
      (item) =>
        item.direct &&
        item.repositoryCount === 0 &&
        item.sharedRepositoryCount === 0,
    ),
  ).toBe(true);
  expect(page.items.find((item) => item.kind === "secret")?.label).toBe(
    "Service secret resource",
  );
  expect(JSON.stringify(page)).not.toMatch(
    /must-not-leak|private-reference|credential|identity|healthy/,
  );
  expect(
    await db
      .prepare(
        "SELECT revision FROM connections WHERE workspace_id='alpha' ORDER BY id",
      )
      .all(),
  ).toMatchObject({ results: [{ revision: 1 }, { revision: 1 }] });
  await db
    .prepare(
      "UPDATE connections SET enabled=0 WHERE workspace_id='alpha' AND id='monitors'",
    )
    .run();
  expect(
    (await resources()).items.find((item) => item.kind === "monitor"),
  ).toMatchObject({ connectionEnabled: false, direct: true });
  for (const name of [
    "resource_project",
    "resource_project_save",
    "project_resources",
  ] as const) {
    expect(typeof as()[commands[name].method]).toBe("function");
    expect(
      commands[name].schema.safeParse({ ...hook, arbitrarySql: "forbidden" })
        .success,
    ).toBe(false);
  }
});

it("distinguishes direct membership and shared repository context without duplicate provider records", async () => {
  await as().resourceRepositoriesSave({
    ...hook,
    revision: 0,
    connectionRevision: 1,
    repositoryIds: ["r1", "r2", "ungrouped"],
  });
  await save(hook, "p2");
  expect((await resources()).items).toMatchObject([
    {
      kind: "hook",
      projectId: "p2",
      direct: false,
      repositoryCount: 2,
      sharedRepositoryCount: 1,
    },
  ]);
  expect((await resources("p2")).items).toMatchObject([
    {
      kind: "hook",
      projectId: "p2",
      direct: true,
      repositoryCount: 1,
      sharedRepositoryCount: 2,
    },
  ]);
  await db
    .prepare(
      `UPDATE secret_connections SET resources_json=json_set(resources_json,'$[0].repositories',json(?)) WHERE workspace_id='alpha' AND id='secrets'`,
    )
    .bind(
      JSON.stringify([
        { id: "r1", fullName: "example/r1" },
        { id: "r2", fullName: "example/r2" },
      ]),
    )
    .run();
  expect(
    (await resources()).items.find((item) => item.kind === "secret"),
  ).toMatchObject({
    direct: false,
    projectId: null,
    repositoryCount: 1,
    sharedRepositoryCount: 1,
  });
  await expect(
    as().resourceProjectSave({
      ...hook,
      projectId: null,
      revision: 1,
      connectionRevision: 1,
      projectRevision: null,
    }),
  ).rejects.toThrow();
  expect(
    (await resources("p2")).items.find((item) => item.kind === "hook"),
  ).toMatchObject({ direct: true, projectId: "p2" });
  expect((await as().resourceRepositories(hook)).repositoryIds).toEqual([
    "r1",
    "r2",
    "ungrouped",
  ]);
});

it("uses the existing Hookrelay association as the single canonical authority", async () => {
  await as().hooksAssociationSave({
    ...workspace,
    connectionId: "hooks",
    subscription: hook.resourceKey,
    projectId: "p1",
    revision: 0,
  });
  expect(await as().resourceProject(hook)).toMatchObject({
    projectId: "p1",
    revision: 1,
    updatedAt: expect.any(String),
  });
  await save(hook, "p2", 1);
  expect(
    await as().hooksAssociationGet({
      ...workspace,
      connectionId: "hooks",
      subscription: hook.resourceKey,
    }),
  ).toEqual({ subscription: hook.resourceKey, projectId: "p2", revision: 2 });
  await expect(
    as().hooksAssociationSave({
      ...workspace,
      connectionId: "hooks",
      subscription: hook.resourceKey,
      projectId: "p1",
      revision: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const changed = await db
    .prepare(
      "SELECT id FROM activity WHERE type='resource.project.updated' ORDER BY rowid DESC LIMIT 1",
    )
    .first<{ id: string }>();
  expect(await eventIds("p1")).toContain(changed!.id);
  expect(await eventIds("p2")).toContain(changed!.id);
});

it("denies cross-workspace, viewer, reporter, wrong-provider and unenrolled resource writes", async () => {
  const input = {
    ...hook,
    projectId: "p1",
    revision: 0,
    connectionRevision: 1,
    projectRevision: 1,
  };
  await expect(as("viewer").resourceProjectSave(input)).rejects.toMatchObject({
    status: 403,
  });
  await expect(as("foreign").resourceProject(hook)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    as("owner", { reporterId: "reporter" }).resourceProjectSave(input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    as("owner", { sourceId: "source" }).projectResources({
      ...workspace,
      projectId: "p1",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(save(hook, "p3")).rejects.toMatchObject({ status: 409 });
  await expect(resources("p3")).rejects.toMatchObject({ status: 404 });
  await expect(save({ ...hook, kind: "monitor" })).rejects.toMatchObject({
    status: 404,
  });
  await expect(save({ ...monitor, resourceKey: "bad-" })).rejects.toMatchObject(
    { status: 400 },
  );
  await expect(
    save({ ...secret, resourceKey: "missing" }),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM activity").first())?.count,
  ).toBe(0);
  await expect(
    as("operator").resourceProjectSave(input),
  ).resolves.toMatchObject({ projectId: "p1", revision: 1 });
  await expect(as("viewer").resourceProject(hook)).resolves.toMatchObject({
    projectId: "p1",
  });
});

it("rejects stale association, connection, and project revisions without overwriting saved context", async () => {
  await save();
  await expect(save(hook, "p2")).rejects.toMatchObject({ status: 409 });
  await db
    .prepare(
      "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha' AND id='hooks'",
    )
    .run();
  await expect(save(hook, "p2", 1)).rejects.toMatchObject({ status: 409 });
  await db
    .prepare("UPDATE projects SET revision=revision+1 WHERE id='p2'")
    .run();
  await expect(
    save(hook, "p2", 1, { connectionRevision: 2 }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await as().resourceProject(hook)).toMatchObject({
    revision: 1,
    projectId: "p1",
  });
  await save(hook, "p2", 1, { connectionRevision: 2, projectRevision: 2 });
  await save(secret);
  await db
    .prepare(
      "UPDATE secret_connections SET resources_json='[]',revision=revision+1 WHERE workspace_id='alpha'",
    )
    .run();
  await expect(as().resourceProject(secret)).rejects.toMatchObject({
    status: 404,
  });
  expect((await resources()).items.some((item) => item.kind === "secret")).toBe(
    false,
  );
});

it.each(["membership", "project", "connection"])(
  "checks %s revision inside the resource write transaction",
  async (changed) => {
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await db
        .prepare(
          changed === "membership"
            ? "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'"
            : changed === "project"
              ? "UPDATE projects SET revision=revision+1 WHERE id='p1'"
              : "UPDATE connections SET revision=revision+1 WHERE workspace_id='alpha' AND id='hooks'",
        )
        .run();
      return batch(statements);
    });
    await expect(save()).rejects.toMatchObject({ status: 409 });
    expect(await as().resourceProject(hook)).toMatchObject({
      projectId: null,
      revision: 0,
    });
    expect(
      (await db.prepare("SELECT COUNT(*) AS count FROM activity").first())
        ?.count,
    ).toBe(0);
  },
);

it("bounds resource pages and binds cursors to the exact project, workspace and kind", async () => {
  await db.batch(
    Array.from({ length: PROJECT_RESOURCE_LIMITS.PAGE_SIZE + 4 }, (_, index) =>
      db
        .prepare(
          `INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id,updated_at)
    VALUES ('alpha','hooks',?,'p1',1,?,?)`,
        )
        .bind("hook-" + String(index).padStart(3, "0"), String(index), now),
    ),
  );
  const first = await resources();
  expect(first.items).toHaveLength(PROJECT_RESOURCE_LIMITS.PAGE_SIZE);
  const second = await resources("p1", { cursor: first.nextCursor });
  expect(second.items).toHaveLength(4);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.items, ...second.items].map((item) => item.resourceKey))
      .size,
  ).toBe(PROJECT_RESOURCE_LIMITS.PAGE_SIZE + 4);
  await expect(
    resources("p2", { cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  await expect(
    resources("p1", { cursor: first.nextCursor, kind: "hook" }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  await expect(
    resources("p1", { cursor: { ...first.nextCursor, workspaceId: "beta" } }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  expect((await resources("p1", { kind: "monitor" })).items).toEqual([]);
});

it.each(["create", "update"])(
  "rechecks repository %s authority inside its project association transaction",
  async (action) => {
    const repository = await as().repository({
      ...workspace,
      repositoryId: "r1",
    });
    const fields = {
      ...repositoryFields.strip().parse(repository),
      projectId: "p2",
    };
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await db
        .prepare(
          "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        )
        .run();
      return batch(statements);
    });
    await expect(
      action === "create"
        ? as().createRepository({
            ...workspace,
            repository: { ...fields, fullName: "example/new" },
          })
        : as().updateRepository({
            ...workspace,
            repositoryId: "r1",
            revision: repository.revision,
            repository: fields,
          }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(
      await as().repository({ ...workspace, repositoryId: "r1" }),
    ).toMatchObject({ revision: 1, projectId: "p1" });
    expect(
      (await db.prepare("SELECT COUNT(*) AS count FROM repositories").first())
        ?.count,
    ).toBe(3);
    expect(
      (await db.prepare("SELECT COUNT(*) AS count FROM activity").first())
        ?.count,
    ).toBe(0);
  },
);

it("enforces association capacity while still allowing existing associations to be edited", async () => {
  await db
    .prepare(
      `WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<?)
    INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id,updated_at)
    SELECT 'alpha','hooks','hook-'||n,'p1',1,'fixture',? FROM entries`,
    )
    .bind(PROJECT_RESOURCE_LIMITS.ASSOCIATIONS, now)
    .run();
  await expect(save()).rejects.toMatchObject({ status: 409 });
  await expect(
    save({ ...hook, resourceKey: "hook-1" }, "p2", 1),
  ).resolves.toMatchObject({ projectId: "p2", revision: 2 });
});

it("freezes activity attribution when repositories are regrouped and copies original operation context", async () => {
  await note("before", "r1");
  await as().resourceRepositoriesSave({
    ...hook,
    revision: 0,
    connectionRevision: 1,
    repositoryIds: ["r1"],
  });
  await note("operation");
  await db.batch(
    captureResourceActivity(
      db,
      "alpha",
      "operation",
      "hooks",
      "hook",
      hook.resourceKey,
    ),
  );
  const repository = await as().repository({
    ...workspace,
    repositoryId: "r1",
  });
  await as().updateRepository({
    ...workspace,
    repositoryId: "r1",
    revision: repository.revision,
    repository: {
      ...repositoryFields.strip().parse(repository),
      projectId: "p2",
    },
  });
  await note("after", "r1");
  await note("result");
  await db.batch(copyActivityContext(db, "alpha", "operation", "result"));
  expect(await eventIds("p1")).toEqual(
    expect.arrayContaining(["before", "operation", "result"]),
  );
  expect(await eventIds("p1")).not.toContain("after");
  expect(await eventIds("p2")).toContain("after");
  for (const id of ["before", "operation", "result"])
    expect(await eventIds("p2")).not.toContain(id);
  const move = await db
    .prepare("SELECT id FROM activity WHERE type='repository.updated'")
    .first<{ id: string }>();
  expect(await eventIds("p1")).toContain(move!.id);
  expect(await eventIds("p2")).toContain(move!.id);
});

it("supports repository-free project notes and contextual goal lifecycle pagination", async () => {
  const goal = {
    ...workspace,
    goalId: "work",
    sourceId: "agent",
    objective: "A project goal",
    startedAt: "2026-01-01T00:00:00Z",
    status: "active",
    reportedAt: "2026-01-01T00:00:01Z",
  };
  await as().syncGoal(goal);
  await note("project-note", "p1", { goalId: goal.goalId });
  await note("other-note", "p2", { goalId: goal.goalId });
  await as().syncGoal({
    ...goal,
    status: "paused",
    reportedAt: "2026-01-01T00:00:02Z",
  });
  await as().syncGoal({
    ...goal,
    status: "cleared",
    reportedAt: "2026-01-01T00:00:03Z",
  });
  const page = await as().goalActivity({
    ...workspace,
    projectId: "p1",
    goalId: goal.goalId,
    limit: 50,
  });
  expect(page.events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["goal.active", "goal.paused", "goal.cleared"]),
  );
  expect(page.events.map((event) => event.id)).toContain("project-note");
  expect(page.events.map((event) => event.id)).not.toContain("other-note");
  const filtered = await as().goalActivity({
    ...workspace,
    projectId: "p1",
    goalId: goal.goalId,
    filter: "goal",
  });
  expect(filtered.events).toHaveLength(3);
  await expect(
    as().goalActivity({
      ...workspace,
      projectId: "p2",
      goalId: goal.goalId,
      cursor: page.viewCursor,
    }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  await expect(note("foreign-note", "p3")).rejects.toMatchObject({
    status: 404,
  });
  expect(
    await note("project-note", "p1", { goalId: goal.goalId }),
  ).toMatchObject({ id: "project-note" });
  await expect(
    note("project-note", "p2", { goalId: goal.goalId }),
  ).rejects.toMatchObject({ status: 409 });
});

it("attributes Secrets reviews through exact destinations, source and captured repository context without values", async () => {
  await save(secret);
  await save({ ...secret, resourceKey: "second" }, "p2");
  const target = (resourceId: string) => ({
    connectionId: "secrets",
    connectionRevision: 1,
    target: { resourceId, scope: { kind: "repository" } },
    name: "SYNTHETIC",
  });
  await db
    .prepare(
      `INSERT INTO secret_reviews(workspace_id,id,actor_subject,actor_name,member_revision,request_json,request_hash,captured_json,draft_fingerprint,stage,created_at,expires_at,input_expires_at,write_id)
    VALUES ('alpha','review','owner','Owner',1,?,'hash','{}','fingerprint','awaiting-input',?,?,?,'write')`,
    )
    .bind(
      JSON.stringify({
        destinations: [target("service")],
        source: target("second"),
      }),
      now,
      now,
      now,
    )
    .run();
  await note("secret-event");
  await db.batch([
    captureSecretProjectActivity(db, "alpha", "secret-event", "review"),
  ]);
  expect(await eventIds("p1")).toContain("secret-event");
  expect(await eventIds("p2")).toContain("secret-event");
  await expect(
    db
      .prepare(
        "UPDATE secret_project_associations SET project_id=NULL WHERE workspace_id='alpha'",
      )
      .run(),
  ).rejects.toThrow(/primary project is required/);
  expect(await eventIds("p1")).toContain("secret-event");
  expect(
    JSON.stringify(await as().activityFeed({ ...workspace, projectId: "p1" })),
  ).not.toMatch(/must-not-leak|private-reference/);
  await note("secret-repository-context");
  await db.batch([
    db.prepare(
      "INSERT INTO activity_repository_links(workspace_id,event_id,repository_id) VALUES ('alpha','secret-repository-context','r1')",
    ),
    captureSecretProjectActivity(
      db,
      "alpha",
      "secret-repository-context",
      "review",
    ),
  ]);
  expect(await eventIds("p1")).toContain("secret-repository-context");
  expect(await eventIds("p2")).toContain("secret-repository-context");
});

it("preserves workspace isolation and foreign keys when attribution and associations are removed by cascade", async () => {
  await save();
  await note("scope-test", "p1");
  await expect(
    db
      .prepare(
        "INSERT INTO activity_project_links(workspace_id,event_id,project_id) VALUES ('alpha','scope-test','p3')",
      )
      .run(),
  ).rejects.toThrow();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  await db.prepare("DELETE FROM workspaces WHERE id='alpha'").run();
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM activity_project_links")
        .first()
    )?.count,
  ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
