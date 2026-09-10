import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

it("preserves stored data and clocks while notifying association readers of later Secrets metadata changes", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === "0027_repository_context.sql",
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES('alpha','secrets','Original','cloudflare-workers','private-ref','[]',0,1,'original')",
    ),
    db.prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES('event','alpha','owner','Owner','update.note','Original','Original journal','2026-01-01')",
    ),
  ]);
  const tables = [
    "secret_connections",
    "activity",
    "activity_order",
    "workspace_sync_clock",
    "workspace_changes",
    "workspace_push_outbox",
    "workspace_transfer_clock",
  ];
  const capture = () =>
    Promise.all(
      tables.map(async (table) => ({
        table,
        rows: (
          await db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()
        ).results,
      })),
    );
  const before = await capture();
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  expect(await capture()).toEqual(before);
  for (const sql of [
    "UPDATE secret_connections SET name='Renamed',revision=2 WHERE id='secrets'",
    "DELETE FROM secret_connections WHERE id='secrets'",
    "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES('alpha','new','New','github-actions','private-ref','[]',0,1,'new')",
  ]) {
    await db
      .prepare(
        "UPDATE workspace_push_outbox SET pending_topics=0 WHERE workspace_id='alpha'",
      )
      .run();
    await db.prepare(sql).run();
    expect(
      await db
        .prepare(
          "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id='alpha'",
        )
        .first(),
    ).toEqual({ pending_topics: 65 });
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
