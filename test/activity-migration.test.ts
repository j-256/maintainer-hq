import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const MIGRATION = "0009_activity_pagination.sql";

it("preserves legacy journal content, links only unambiguous goals, and maintains monotonic ordering", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === MIGRATION,
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(
    bindings.HQ_DB,
    bindings.TEST_MIGRATIONS.slice(0, index),
  );
  const db = bindings.HQ_DB;
  await db.batch([
    db.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    ...[
      ["unique", "alpha", "owner", "Exact objective", null],
      ["ambiguous-one", "alpha", "owner", "Shared objective", null],
      ["ambiguous-two", "alpha", "owner", "Shared objective", null],
      ["other-workspace", "beta", "owner", "Exact objective", null],
      ["other-actor", "alpha", "other", "Exact objective", null],
      ["reporter", "alpha", "owner", "Exact objective", "automation"],
    ].map(([id, workspaceId, subject, objective, reporterId]) =>
      db
        .prepare(
          "INSERT INTO goals (id,workspace_id,source_id,actor_subject,actor_name,objective,status,started_at,reported_at,received_at,write_id,reporter_id) VALUES (?,?, 'agent',?, 'Actor',?, 'complete','2026-01-01','2026-01-02','2026-01-02',?,?)",
        )
        .bind(id, workspaceId, subject, objective, id, reporterId),
    ),
    db.prepare(
      "INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES ('note','alpha','owner','Actor','update.note','Retain this note','Exact objective','2026-01-03')",
    ),
  ]);
  const original = (
    await db
      .prepare("SELECT * FROM activity ORDER BY created_at,id")
      .all<Record<string, unknown>>()
  ).results;
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  const migrated = (
    await db
      .prepare("SELECT * FROM activity ORDER BY created_at,id")
      .all<Record<string, unknown>>()
  ).results;
  expect(migrated.map(({ goal_id: _goalId, ...row }) => row)).toEqual(original);
  const expected = new Map([
    ["alpha:owner:Exact objective:null", "unique"],
    ["beta:owner:Exact objective:null", "other-workspace"],
    ["alpha:other:Exact objective:null", "other-actor"],
    ["alpha:owner:Exact objective:automation", "reporter"],
  ]);
  for (const row of migrated)
    expect(row.goal_id).toBe(
      row.type === "update.note"
        ? null
        : (expected.get(
            [
              row.workspace_id,
              row.actor_subject,
              row.summary,
              String(row.reporter_id),
            ].join(":"),
          ) ?? null),
    );
  const ordering = (
    await db
      .prepare(
        "SELECT event_id AS id,sequence FROM activity_order ORDER BY sequence",
      )
      .all<{ id: string; sequence: number }>()
  ).results;
  expect(ordering.map((row) => row.id)).toEqual(original.map((row) => row.id));
  const watermark = ordering.at(-1)!.sequence;
  await db.prepare("DELETE FROM activity WHERE id='note'").run();
  await db
    .prepare(
      "UPDATE goals SET status='active' WHERE id='unique' AND workspace_id='alpha'",
    )
    .run();
  const latest = await db
    .prepare(
      "SELECT o.sequence,a.goal_id FROM activity_order o JOIN activity a ON a.id=o.event_id ORDER BY o.sequence DESC LIMIT 1",
    )
    .first<{ sequence: number; goal_id: string }>();
  expect(latest!.sequence).toBeGreaterThan(watermark);
  expect(latest!.goal_id).toBe("unique");
  expect(
    await db
      .prepare("SELECT 1 FROM activity_order WHERE event_id='note'")
      .first(),
  ).toBeNull();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
