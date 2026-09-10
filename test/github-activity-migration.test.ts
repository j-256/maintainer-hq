import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

it("adds nullable GitHub references and change comparisons without rewriting old journals or cursors", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === "0026_github_activity.sql",
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('alpha', 'Alpha', '2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO connections (workspace_id, id, name, provider) VALUES ('alpha', 'github', 'Original source', 'github')",
    ),
    db.prepare(
      "INSERT INTO repositories (workspace_id,id,full_name,description,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','repo','example/one','','maintained','active','{}','2026-01-01','original')",
    ),
    db.prepare(
      "INSERT INTO github_refreshes (workspace_id,id,source_id,source_revision,credential_ref,credential_hash,actor_subject,actor_name,trigger,input_hash,status,summary,created_at,write_id) VALUES ('alpha','receipt','github',1,'credential','synthetic-hash','owner','Owner','scheduled','synthetic-input','partial','Original partial summary','2026-01-01','original')",
    ),
    db.prepare(
      "INSERT INTO github_refresh_items (workspace_id,refresh_id,repository_id,full_name,status,summary,updated_at) VALUES ('alpha','receipt','repo','example/one','partial','Original repository summary','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES ('event','alpha','owner','Owner','github.refresh.completed','Original title','Original summary','2026-01-01')",
    ),
  ]);
  const tables = [
    "activity",
    "github_refresh_items",
    "github_refreshes",
    "activity_order",
    "workspace_sync_clock",
    "workspace_changes",
    "workspace_push_outbox",
  ];
  const capture = () =>
    Promise.all(
      tables.map(async (table) => ({
        table,
        rows: (
          await db
            .prepare("SELECT * FROM " + table + " ORDER BY rowid")
            .all<Record<string, unknown>>()
        ).results,
      })),
    );
  const before = await capture();
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  const after = await capture();
  expect(
    after.map(({ table, rows }) => ({
      table,
      rows: rows.map(
        ({
          github_source_id: _source,
          github_refresh_id: _refresh,
          github_source_name: _name,
          changes_json: _changes,
          ...row
        }) => row,
      ),
    })),
  ).toEqual(before);
  expect(
    await db
      .prepare(
        "SELECT github_source_id,github_refresh_id,github_source_name FROM activity WHERE id='event'",
      )
      .first(),
  ).toEqual({
    github_source_id: null,
    github_refresh_id: null,
    github_source_name: null,
  });
  expect(
    await db
      .prepare(
        "SELECT changes_json FROM github_refresh_items WHERE refresh_id='receipt'",
      )
      .first(),
  ).toEqual({ changes_json: null });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
