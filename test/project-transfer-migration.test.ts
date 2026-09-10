import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const MIGRATION = "0024_project_transfers.sql";
const preserved = [
  "projects",
  "repositories",
  "activity",
  "activity_order",
  "activity_project_links",
  "activity_repository_links",
  "github_refreshes",
  "github_refresh_items",
  "connections",
  "source_repositories",
];
async function capture() {
  return Promise.all(
    preserved.map(
      async (table) =>
        (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results,
    ),
  );
}

it("preserves populated history and rejects duplicate global repository identity before any partial migration", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('alpha','project','Project','Retained')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','repo','example/service','Original','project','maintained','active',?,'2026-01-01','original')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS)),
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES ('alpha','github','GitHub','github')",
    ),
    db.prepare(
      "INSERT INTO source_repositories VALUES ('alpha','github','repo')",
    ),
    db.prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) VALUES ('event','alpha','owner','Owner','update.note','Original event','Keep history private','repo','2026-01-02')",
    ),
    db.prepare(
      "INSERT INTO activity_repository_links VALUES ('alpha','event','repo')",
    ),
    db.prepare(
      "INSERT INTO github_refreshes(workspace_id,id,source_id,source_revision,credential_ref,credential_hash,actor_subject,actor_name,trigger,input_hash,status,summary,created_at,completed_at,write_id) VALUES ('alpha','refresh','github',1,'fixture','fixture-hash','owner','Owner','manual','fixture-input','succeeded','Retained refresh','2026-01-01','2026-01-02','original')",
    ),
    db.prepare(
      "INSERT INTO github_refresh_items(workspace_id,refresh_id,repository_id,full_name,status,summary,updated_at,result_json) VALUES ('alpha','refresh','repo','example/service','succeeded','Retained item','2026-01-02','{}')",
    ),
  ]);
  const before = await capture();
  await db
    .prepare(
      "INSERT INTO repositories(workspace_id,id,full_name,description,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('beta','repo','example/duplicate','','watchlist','active',?,'2026-01-01','duplicate')",
    )
    .bind(JSON.stringify(DEFAULT_EXPECTATIONS))
    .run();
  const duplicate = await capture();
  await expect(
    applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]),
  ).rejects.toThrow(/UNIQUE/i);
  expect(await capture()).toEqual(duplicate);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE name='departed_resource_context'",
      )
      .first("total"),
  ).toBe(0);
  await db
    .prepare("DELETE FROM repositories WHERE workspace_id='beta' AND id='repo'")
    .run();
  expect(await capture()).toEqual(before);
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  expect(await capture()).toEqual(before);
  for (const table of [
    "departed_resource_context",
    "project_transfer_reviews",
  ]) {
    expect(
      await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first("total"),
    ).toBe(0);
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    db.prepare(
      "DELETE FROM source_repositories WHERE workspace_id='alpha' AND repository_id='repo'",
    ),
    db.prepare("UPDATE projects SET workspace_id='beta' WHERE id='project'"),
    db.prepare("UPDATE repositories SET workspace_id='beta' WHERE id='repo'"),
  ]);
  expect(
    await db
      .prepare(
        "SELECT workspace_id FROM github_refresh_items WHERE repository_id='repo'",
      )
      .first("workspace_id"),
  ).toBe("alpha");
  expect(
    await db
      .prepare(
        "SELECT workspace_id FROM activity_repository_links WHERE repository_id='repo'",
      )
      .first("workspace_id"),
  ).toBe("alpha");
  expect(
    await db
      .prepare(
        "SELECT summary FROM github_refresh_items WHERE repository_id='repo'",
      )
      .first("summary"),
  ).toBe("Retained item");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
