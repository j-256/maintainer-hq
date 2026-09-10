import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import type { Env } from "../worker/types";

it("D1 counts trigger writes without turning a failed conditional write into success", async () => {
  const db = (env as unknown as Env).HQ_DB;
  await db.exec("CREATE TABLE push_probe (id TEXT PRIMARY KEY); CREATE TABLE push_probe_events (id TEXT PRIMARY KEY); CREATE TRIGGER push_probe_notify AFTER INSERT ON push_probe BEGIN INSERT INTO push_probe_events VALUES (NEW.id); END;");
  const result = await db.prepare("INSERT INTO push_probe VALUES (?)").bind("fixture").run();
  expect(result.meta.changes).toBe(2);
  const ignored = await db.prepare("INSERT OR IGNORE INTO push_probe VALUES (?)").bind("fixture").run();
  expect(ignored.meta.changes).toBe(0);
  expect(await db.prepare("SELECT id FROM push_probe_events").first()).toEqual({ id: "fixture" });
});
