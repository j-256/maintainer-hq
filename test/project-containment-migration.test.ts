import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const MIGRATION = "0036_project_containment.sql";

it("fails atomically on orphan metadata and enforces project containment after remediation", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('alpha','project','Project','')",
    ),
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES ('alpha','hooks','Hooks','hookrelay'),('alpha','monitors','Monitors','endpoint-monitor')",
    ),
    db.prepare(
      "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES ('alpha','secrets','Secrets','github-actions','private','[]',1,1,'seed')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','repository','example/repository','',NULL,'maintained','active',?,'2026-01-01','seed')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS)),
    db.prepare(
      "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id,updated_at) VALUES ('alpha','hooks','subscription',NULL,1,'seed','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO monitor_project_associations(workspace_id,connection_id,target_id,project_id,revision,write_id,updated_at) VALUES ('alpha','monitors','target',NULL,1,'seed','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO secret_project_associations(workspace_id,connection_id,resource_id,project_id,revision,write_id,updated_at) VALUES ('alpha','secrets','resource',NULL,1,'seed','2026-01-01')",
    ),
  ]);

  await expect(
    applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]),
  ).rejects.toThrow(/CHECK constraint failed/i);
  expect(
    (
      await db.prepare("PRAGMA table_info(metadata_imports)").all<{
        name: string;
      }>()
    ).results.map((column) => column.name),
  ).not.toContain("project_count");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='trigger' AND name LIKE '%project_required_%'",
      )
      .first("total"),
  ).toBe(0);

  await db.batch([
    db.prepare(
      "UPDATE repositories SET project_id='project' WHERE workspace_id='alpha'",
    ),
    db.prepare(
      "UPDATE hook_associations SET project_id='project' WHERE workspace_id='alpha'",
    ),
    db.prepare(
      "UPDATE monitor_project_associations SET project_id='project' WHERE workspace_id='alpha'",
    ),
    db.prepare(
      "UPDATE secret_project_associations SET project_id='project' WHERE workspace_id='alpha'",
    ),
  ]);
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  expect(
    (
      await db.prepare("PRAGMA table_info(metadata_imports)").all<{
        name: string;
      }>()
    ).results.map((column) => column.name),
  ).toContain("project_count");

  const nullUpdates = [
    "UPDATE repositories SET project_id=NULL WHERE id='repository'",
    "UPDATE hook_associations SET project_id=NULL WHERE subscription='subscription'",
    "UPDATE monitor_project_associations SET project_id=NULL WHERE target_id='target'",
    "UPDATE secret_project_associations SET project_id=NULL WHERE resource_id='resource'",
  ];
  for (const sql of nullUpdates)
    await expect(db.prepare(sql).run()).rejects.toThrow(/project is required/i);
  await expect(
    db
      .prepare(
        "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','orphan','example/orphan','',NULL,'maintained','active',?,'2026-01-01','orphan')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS))
      .run(),
  ).rejects.toThrow(/project is required/i);
  const nullAssociationInserts = [
    "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id,updated_at) VALUES ('alpha','hooks','orphan',NULL,1,'orphan','2026-01-01')",
    "INSERT INTO monitor_project_associations(workspace_id,connection_id,target_id,project_id,revision,write_id,updated_at) VALUES ('alpha','monitors','orphan',NULL,1,'orphan','2026-01-01')",
    "INSERT INTO secret_project_associations(workspace_id,connection_id,resource_id,project_id,revision,write_id,updated_at) VALUES ('alpha','secrets','orphan',NULL,1,'orphan','2026-01-01')",
  ];
  for (const sql of nullAssociationInserts)
    await expect(db.prepare(sql).run()).rejects.toThrow(/project is required/i);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
