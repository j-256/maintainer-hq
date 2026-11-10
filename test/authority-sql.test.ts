import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { combineSqlGuards } from "../worker/authority-sql";
import type { Env } from "../worker/types";
const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
it("checks every captured guard while bounding D1 parameters", async () => {
  const guards = Array.from({ length: 100 }, (_, index) => ({
    sql: "EXISTS(SELECT 1 WHERE ?=?)",
    values: [index, index],
  }));
  const guard = combineSqlGuards(guards);
  expect(guard.values.length).toBeLessThanOrEqual(32);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
      .bind(...guard.values)
      .first("allowed"),
  ).toBe(1);
  guards[72].values[1] = -1;
  const denied = combineSqlGuards(guards);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 WHERE ${denied.sql}`)
      .bind(...denied.values)
      .first(),
  ).toBeNull();
});
it("rejects unknown predicates and preserves separate SQL shapes and literal values", async () => {
  const guards: { sql: string; values: unknown[] }[] = Array.from(
    { length: 20 },
    () => ({ sql: "?=?", values: ["literal ? ' SQL", "literal ? ' SQL"] }),
  );
  guards.push({ sql: "? IS NULL", values: [null] });
  const allowed = combineSqlGuards(guards);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 WHERE ${allowed.sql}`)
      .bind(...allowed.values)
      .first(),
  ).not.toBeNull();
  guards.push({ sql: "?=?", values: [null, null] });
  const denied = combineSqlGuards(guards);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 WHERE ${denied.sql}`)
      .bind(...denied.values)
      .first(),
  ).toBeNull();
});

it("preserves nested guard scopes when a large group contains packed guards", async () => {
  const inner = combineSqlGuards(
    Array.from({ length: 20 }, (_, index) => ({
      sql: "?=?",
      values: [index, index],
    })),
  );
  const guards = Array.from({ length: 40 }, () => inner);
  const allowed = combineSqlGuards(guards);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 WHERE ${allowed.sql}`)
      .bind(...allowed.values)
      .first(),
  ).not.toBeNull();
  guards[30] = combineSqlGuards(
    Array.from({ length: 20 }, (_, index) => ({
      sql: "?=?",
      values: [index, index === 11 ? -1 : index],
    })),
  );
  const denied = combineSqlGuards(guards);
  expect(
    await bindings.HQ_DB.prepare(`SELECT 1 WHERE ${denied.sql}`)
      .bind(...denied.values)
      .first(),
  ).toBeNull();
});
