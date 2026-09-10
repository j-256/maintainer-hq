import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const MIGRATION = "0021_goal_lifecycle.sql";
const PRESERVED_TABLES = [
  "goals",
  "activity",
  "activity_order",
  "workspace_sync_clock",
  "workspace_sync_retention",
  "workspace_changes",
  "workspace_push_outbox",
] as const;

it("preserves goal identities, journal history and cursors while restoring lifecycle and push triggers", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    ...["alpha", "beta"].flatMap((workspace) =>
      ["active", "complete", "blocked"].map((status) =>
        db
          .prepare(
            "INSERT INTO goals (id,workspace_id,source_id,actor_subject,actor_name,objective,status,started_at,reported_at,received_at,write_id,reporter_id) VALUES (?,?,'agent','owner','Actor',?,?,'2026-01-01','2026-01-02','2026-01-02',?,'reporter')",
          )
          .bind(
            status,
            workspace,
            "  Verbatim /goal\n" + status + "  ",
            status,
            status,
          ),
      ),
    ),
  ]);
  async function capture() {
    return Promise.all(
      PRESERVED_TABLES.map(async (table) => ({
        table,
        rows: (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
          .results,
      })),
    );
  }
  const original = await capture();
  const triggers = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='goals' ORDER BY name",
      )
      .all()
  ).results;
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  expect(await capture()).toEqual(original);
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='goals' ORDER BY name",
        )
        .all()
    ).results,
  ).toEqual(triggers);

  async function cursor() {
    return db
      .prepare(
        "SELECT cursor FROM workspace_sync_clock WHERE workspace_id='alpha'",
      )
      .first<number>("cursor");
  }
  const beforeUpdate = await cursor();
  await db
    .prepare(
      "UPDATE goals SET status='paused' WHERE workspace_id='alpha' AND id='active'",
    )
    .run();
  expect(await cursor()).toBeGreaterThan(beforeUpdate!);
  await db
    .prepare(
      "UPDATE goals SET status='cleared' WHERE workspace_id='alpha' AND id='blocked'",
    )
    .run();
  const journal = (
    await db
      .prepare(
        "SELECT type,title,summary,goal_id,reporter_id FROM activity WHERE type IN ('goal.paused','goal.cleared') ORDER BY type",
      )
      .all()
  ).results;
  expect(journal).toEqual([
    {
      type: "goal.cleared",
      title: "Goal cleared",
      summary: "  Verbatim /goal\nblocked  ",
      goal_id: "blocked",
      reporter_id: "reporter",
    },
    {
      type: "goal.paused",
      title: "Goal paused",
      summary: "  Verbatim /goal\nactive  ",
      goal_id: "active",
      reporter_id: "reporter",
    },
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT status FROM goals WHERE workspace_id='beta' ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual([
    { status: "active" },
    { status: "blocked" },
    { status: "complete" },
  ]);
  await expect(
    db
      .prepare("UPDATE goals SET status='invented' WHERE workspace_id='alpha'")
      .run(),
  ).rejects.toThrow();
  const beforeInsert = await cursor();
  await db
    .prepare(
      "INSERT INTO goals SELECT 'new-goal',workspace_id,source_id,actor_subject,actor_name,objective,'paused',started_at,reported_at,received_at,'new-write',reporter_id FROM goals WHERE workspace_id='alpha' AND id='active'",
    )
    .run();
  expect(await cursor()).toBeGreaterThan(beforeInsert!);
  expect(
    await db
      .prepare("SELECT title FROM activity WHERE goal_id='new-goal'")
      .first("title"),
  ).toBe("Goal paused");
  const beforeDelete = await cursor();
  await db
    .prepare("DELETE FROM goals WHERE workspace_id='alpha' AND id='new-goal'")
    .run();
  expect(await cursor()).toBeGreaterThan(beforeDelete!);
  expect(
    await db
      .prepare(
        "SELECT cursor FROM workspace_changes WHERE workspace_id='alpha' AND collection='goals' AND record_key='new-goal'",
      )
      .first("cursor"),
  ).toBe(await cursor());
  expect(
    await db
      .prepare(
        "SELECT pending_topics & 2 AS activity FROM workspace_push_outbox WHERE workspace_id='alpha'",
      )
      .first("activity"),
  ).toBe(2);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
