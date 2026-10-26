import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
it("adds derived schedule storage without rewriting populated authority, reviews, receipts or clocks", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === "0041_dependabot.sql",
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES('alpha','Alpha','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES('alpha','owner','Owner','owner')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES('alpha','project','Project','')",
    ),
    db.prepare(
      "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES('alpha','repo','example/repo','','project','watchlist','active','{}','2026-01-01','fixture')",
    ),
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES('alpha','github','Source','github')",
    ),
    db.prepare(
      "INSERT INTO source_repositories(workspace_id,source_id,repository_id) VALUES('alpha','github','repo')",
    ),
    db.prepare(
      "INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) VALUES('review','alpha','owner','dependency.change','{}','fixture','2026-01-01','2099-01-01')",
    ),
    db.prepare(
      "INSERT INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at) VALUES('operation','alpha','review','owner','dependency.change','indeterminate','Retained uncertain outcome','2026-01-01','2026-01-01')",
    ),
  ]);
  const tables = [
    "members",
    "repositories",
    "connections",
    "source_repositories",
    "action_plans",
    "operations",
    "workspace_sync_clock",
    "workspace_push_outbox",
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
  await db
    .prepare(
      "INSERT INTO github_dependabot_cache(workspace_id,source_id,repository_id,identity,next_read_at) VALUES('alpha','github','repo','fixture','2026-01-01')",
    )
    .run();
  await db
    .prepare(
      "UPDATE workspace_push_outbox SET pending_topics=0 WHERE workspace_id='alpha'",
    )
    .run();
  await db
    .prepare(
      "UPDATE github_dependabot_cache SET result_json='{}' WHERE workspace_id='alpha'",
    )
    .run();
  expect(
    await db
      .prepare(
        "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id='alpha'",
      )
      .first<number>("pending_topics"),
  ).toBe(4);
  await expect(
    db
      .prepare("UPDATE github_dependabot_cache SET result_json=?")
      .bind("x".repeat(131073))
      .run(),
  ).rejects.toThrow();
  await db
    .prepare("DELETE FROM source_repositories WHERE workspace_id='alpha'")
    .run();
  expect(
    await db
      .prepare("SELECT count(*) AS total FROM github_dependabot_cache")
      .first<number>("total"),
  ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
