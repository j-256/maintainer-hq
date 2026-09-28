import { env, applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const MIGRATION = "0039_permanent_readers.sql";
const PRESERVED_TABLES = [
  "credentials", "members", "connections", "activity", "action_plans",
  "workspace_sync_clock", "workspace_changes", "workspace_push_outbox",
  "workspace_transfer_clock",
] as const;

it("preserves populated credentials and notification state while enforcing Reader-only null expiry", async () => {
  const db = bindings.HQ_DB;
  const index = bindings.TEST_MIGRATIONS.findIndex((migration) => migration.name === MIGRATION);
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare("INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01')"),
    db.prepare("INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner')"),
    db.prepare("INSERT INTO connections (id,workspace_id,name,provider) VALUES ('source','alpha','Source','local')"),
    ...["reader", "reporter", "publisher", "revoked", "expired"].map((kind) => db.prepare(
      "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,source_id,created_at,expires_at,revoked_at,write_id,automation_profile,reporter_id) VALUES (?,'alpha','owner',?,?,?,?,'2026-01-01',?,?,?,?,?)",
    ).bind(kind, kind, "synthetic-hash-" + kind,
      JSON.stringify([kind === "reporter" ? "activity:write" : kind === "publisher" ? "observations:publish" : "read"]),
      kind === "publisher" ? "source" : null,
      kind === "expired" ? "2026-01-02" : "2027-01-01",
      kind === "revoked" ? "2026-01-02" : null, "write-" + kind,
      kind === "publisher" ? null : kind === "reporter" ? "reporter" : "reader",
      kind === "reporter" ? "agent" : null,
    )),
  ]);
  const capture = () => Promise.all(PRESERVED_TABLES.map(async (table) => ({
    table, rows: (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
  })));
  const schema = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY type,name").all();
  const before = await capture();
  const originalSchema = (await schema()).results;
  await applyD1Migrations(db, [bindings.TEST_MIGRATIONS[index]]);
  expect(await capture()).toEqual(before);
  expect((await schema()).results).toEqual(originalSchema);
  const cursor = () => db.prepare("SELECT cursor FROM workspace_sync_clock WHERE workspace_id='alpha'").first<number>("cursor");
  const initialCursor = await cursor();
  await db.prepare("UPDATE credentials SET expires_at=NULL WHERE id='reader'").run();
  expect(await cursor()).toBeGreaterThan(initialCursor!);
  for (const id of ["reporter", "publisher"])
    await expect(db.prepare("UPDATE credentials SET expires_at=NULL WHERE id=?").bind(id).run()).rejects.toThrow();
  await expect(db.prepare("UPDATE credentials SET source_id='source' WHERE id='reader'").run()).rejects.toThrow();
  const beforeMemberUpdate = await cursor();
  await db.prepare("UPDATE members SET display_name='Renamed' WHERE workspace_id='alpha'").run();
  expect(await cursor()).toBeGreaterThan(beforeMemberUpdate!);
  const beforeDelete = await cursor();
  await db.prepare("DELETE FROM credentials WHERE id='publisher'").run();
  expect(await cursor()).toBeGreaterThan(beforeDelete!);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
