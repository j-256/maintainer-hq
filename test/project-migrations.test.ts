import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const PROJECT_MIGRATION = "0022_projects.sql";
const RESOURCE_MIGRATION = "0023_project_resources.sql";
const PRESERVED_QUERIES = [
  "SELECT id,workspace_id,name,description FROM projects ORDER BY workspace_id,id",
  "SELECT * FROM repositories ORDER BY workspace_id,id",
  "SELECT * FROM activity ORDER BY workspace_id,id",
  "SELECT * FROM activity_order ORDER BY sequence",
  "SELECT * FROM goals ORDER BY workspace_id,id",
  "SELECT workspace_id,connection_id,subscription,project_id,revision,write_id FROM hook_associations ORDER BY workspace_id,connection_id,subscription",
];

async function legacy() {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === PROJECT_MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-02-01')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('alpha','recorded','Recorded project','Keep this description'),('alpha','fallback','Without creation event',''),('beta','foreign','Other workspace','')",
    ),
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider,configuration_json) VALUES ('alpha','hooks','Hooks','hookrelay','{}')",
    ),
    db.prepare(
      "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id) VALUES ('alpha','hooks','retained-hook','recorded',3,'original-link')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('repo','alpha','example/retained','Retain metadata','recorded','maintained','active',?,'2026-01-04','original-repository')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS)),
    db.prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) VALUES ('creation','alpha','owner','Owner','project.created','Created','Original project note','recorded','2026-01-03'),('old-note','alpha','owner','Owner','update.note','Retained note','Exact historical context','repo','2026-01-05')",
    ),
    db.prepare(
      "INSERT INTO goals(id,workspace_id,source_id,actor_subject,actor_name,objective,status,started_at,reported_at,received_at,write_id,reporter_id) VALUES ('goal','alpha','agent','owner','Owner','  Verbatim /goal\nwith whitespace  ','paused','2026-01-01','2026-01-02','2026-01-02','goal-write','reporter')",
    ),
  ]);
  return index;
}

async function capture() {
  return Promise.all(
    PRESERVED_QUERIES.map(async (sql) => (await db.prepare(sql).all()).results),
  );
}

it("preserves legacy identities, relationships and history while publishing initialized project metadata", async () => {
  const index = await legacy();
  const before = await capture();
  await db
    .prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('beta','recorded','Duplicate identity','')",
    )
    .run();
  const duplicate = await capture();
  await expect(
    applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]),
  ).rejects.toThrow(/UNIQUE/);
  expect(await capture()).toEqual(duplicate);
  expect(
    (
      await db.prepare("PRAGMA table_info(projects)").all<{ name: string }>()
    ).results.some((column) => column.name === "revision"),
  ).toBe(false);
  await db
    .prepare("DELETE FROM projects WHERE workspace_id='beta' AND id='recorded'")
    .run();
  expect(await capture()).toEqual(before);
  const clocks = (
    await db
      .prepare("SELECT workspace_id,cursor FROM workspace_sync_clock")
      .all<{
        workspace_id: string;
        cursor: number;
      }>()
  ).results;
  const migrations = bindings.TEST_MIGRATIONS.slice(index, index + 2);
  expect(migrations.map((migration) => migration.name)).toEqual([
    PROJECT_MIGRATION,
    RESOURCE_MIGRATION,
  ]);
  await applyD1Migrations(db, migrations);
  expect(await capture()).toEqual(before);
  expect(
    (
      await db
        .prepare(
          "SELECT id,revision,updated_at,lifecycle,importance,portfolio_json FROM projects ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual(
    [
      ["fallback", "2026-01-01T00:00:00.000Z"],
      ["foreign", "2026-02-01T00:00:00.000Z"],
      ["recorded", "2026-01-03T00:00:00.000Z"],
    ].map(([id, updated_at]) => ({
      id,
      updated_at,
      revision: 1,
      lifecycle: "active",
      importance: "standard",
      portfolio_json:
        '{"status":"undecided","reason":"","url":null,"reviewDate":null}',
    })),
  );
  for (const clock of clocks) {
    expect(
      await db
        .prepare("SELECT cursor FROM workspace_sync_clock WHERE workspace_id=?")
        .bind(clock.workspace_id)
        .first<number>("cursor"),
    ).toBeGreaterThan(clock.cursor);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_changes WHERE workspace_id=? AND collection='projects' AND cursor>?",
        )
        .bind(clock.workspace_id, clock.cursor)
        .first<number>("count"),
    ).toBeGreaterThan(0);
  }
  expect(
    await db
      .prepare("SELECT updated_at FROM hook_associations")
      .first("updated_at"),
  ).toBeNull();
  for (const table of [
    "activity_project_links",
    "monitor_project_associations",
    "secret_project_associations",
  ]) {
    expect(
      await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
    ).toBe(0);
  }
  await db
    .prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) VALUES ('new-note','alpha','owner','Owner','update.note','New note','Captured at write time','repo','2026-01-06')",
    )
    .run();
  expect(
    (await db.prepare("SELECT * FROM activity_project_links").all()).results,
  ).toEqual([
    { workspace_id: "alpha", event_id: "new-note", project_id: "recorded" },
  ]);
  await expect(
    db
      .prepare(
        "INSERT INTO activity_project_links(workspace_id,event_id,project_id) VALUES ('alpha','new-note','foreign')",
      )
      .run(),
  ).rejects.toThrow(/workspace/);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
