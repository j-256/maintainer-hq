import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
beforeAll(async () => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM workspaces"),
    db.prepare("DELETE FROM workspace_transfer_clock"),
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO projects(workspace_id,id,name,description) VALUES ('alpha','project','Project','Retained description')",
    ),
    db
      .prepare(
        "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','repo','example/project','','project','maintained','active',?,'2026-01-01','seed')",
      )
      .bind(JSON.stringify(DEFAULT_EXPECTATIONS)),
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES ('alpha','source','Source','local')",
    ),
    db.prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) VALUES ('event','alpha','owner','Owner','update.note','Original note','Original source-only history','repo','2026-01-02')",
    ),
    db.prepare(
      "INSERT INTO activity_repository_links(workspace_id,event_id,repository_id) VALUES ('alpha','event','repo')",
    ),
  ]);
});

async function clocks() {
  return (
    await db
      .prepare("SELECT * FROM workspace_transfer_clock ORDER BY workspace_id")
      .all()
  ).results;
}

function moveStatements() {
  return [
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    db.prepare(
      "INSERT INTO departed_resource_context(workspace_id,kind,resource_id,name,project_id,moved_at,transfer_id) VALUES ('alpha','project','project','Project','project','2026-01-03','move'),('alpha','repository','repo','example/project','project','2026-01-03','move')",
    ),
    db.prepare(
      "UPDATE projects SET workspace_id='beta',revision=revision+1 WHERE workspace_id='alpha' AND id='project'",
    ),
    db.prepare(
      "UPDATE repositories SET workspace_id='beta',revision=revision+1 WHERE workspace_id='alpha' AND project_id='project'",
    ),
  ];
}

it("defers dependent workspace foreign keys within a real D1 batch while retaining source history", async () => {
  await db.batch(moveStatements());
  expect(
    await db
      .prepare("SELECT workspace_id FROM projects WHERE id='project'")
      .first("workspace_id"),
  ).toBe("beta");
  expect(
    await db
      .prepare("SELECT workspace_id FROM repositories WHERE id='repo'")
      .first("workspace_id"),
  ).toBe("beta");
  expect(
    (await db.prepare("SELECT * FROM activity_repository_links").all()).results,
  ).toEqual([
    { workspace_id: "alpha", event_id: "event", repository_id: "repo" },
  ]);
  expect(
    (await db.prepare("SELECT * FROM activity_project_links").all()).results,
  ).toEqual([
    { workspace_id: "alpha", event_id: "event", project_id: "project" },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM activity WHERE workspace_id='beta'",
      )
      .first("total"),
  ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    await db.prepare("PRAGMA defer_foreign_keys").first("defer_foreign_keys"),
  ).toBe(0);
});

it("rolls back a batch whose final foreign keys are invalid, including notifications and structural clocks", async () => {
  const before = await clocks();
  const changes = (
    await db
      .prepare(
        "SELECT * FROM workspace_changes ORDER BY workspace_id,collection,record_key",
      )
      .all()
  ).results;
  await expect(db.batch(moveStatements().slice(0, -1))).rejects.toThrow(
    /FOREIGN KEY/i,
  );
  expect(
    await db
      .prepare("SELECT workspace_id FROM projects WHERE id='project'")
      .first("workspace_id"),
  ).toBe("alpha");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM departed_resource_context")
      .first("total"),
  ).toBe(0);
  expect(await clocks()).toEqual(before);
  expect(
    (
      await db
        .prepare(
          "SELECT * FROM workspace_changes ORDER BY workspace_id,collection,record_key",
        )
        .all()
    ).results,
  ).toEqual(changes);
});

it("records source tombstones and destination upserts without changing the original Activity workspace", async () => {
  const cursor = await db
    .prepare(
      "SELECT cursor FROM workspace_sync_clock WHERE workspace_id='alpha'",
    )
    .first<number>("cursor");
  await db.batch(moveStatements());
  for (const workspaceId of ["alpha", "beta"]) {
    const keys = (
      await db
        .prepare(
          "SELECT collection,record_key FROM workspace_changes WHERE workspace_id=? AND collection IN ('projects','repositories') ORDER BY collection",
        )
        .bind(workspaceId)
        .all()
    ).results;
    expect(keys).toEqual([
      { collection: "projects", record_key: "project" },
      { collection: "repositories", record_key: "repo" },
    ]);
    expect(
      Number(
        await db
          .prepare(
            "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id=?",
          )
          .bind(workspaceId)
          .first("pending_topics"),
      ) & 65,
    ).toBe(65);
  }
  expect(
    await db
      .prepare(
        "SELECT cursor FROM workspace_sync_clock WHERE workspace_id='alpha'",
      )
      .first<number>("cursor"),
  ).toBeGreaterThan(cursor!);
  expect(
    await db
      .prepare("SELECT workspace_id FROM activity WHERE id='event'")
      .first("workspace_id"),
  ).toBe("alpha");
});

it("keeps transfer revisions stable during routine observations and source telemetry", async () => {
  const before = await clocks();
  await db.batch([
    db.prepare(
      "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES ('alpha','source','repository','repo','Local state','unknown','Evidence only','{}','2026-01-01','2026-01-01','2026-01-02')",
    ),
    db.prepare(
      "UPDATE connections SET last_attempt_at='2026-01-02',last_success_at='2026-01-02',last_error=NULL,next_refresh_at='2026-01-03' WHERE workspace_id='alpha' AND id='source'",
    ),
  ]);
  expect(await clocks()).toEqual(before);
  await db
    .prepare(
      "UPDATE connections SET enabled=0,revision=revision+1 WHERE workspace_id='alpha' AND id='source'",
    )
    .run();
  expect(await clocks()).not.toEqual(before);
});

it("rejects new foreign attribution and preserves explicit historical attribution after a move", async () => {
  await db
    .prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES ('foreign','beta','other','Other','update.note','Foreign','','2026-01-02')",
    )
    .run();
  await expect(
    db
      .prepare(
        "INSERT INTO activity_repository_links VALUES ('beta','foreign','repo')",
      )
      .run(),
  ).rejects.toThrow(/attribution/i);
  await expect(
    db
      .prepare(
        "INSERT INTO activity_project_links VALUES ('beta','foreign','project')",
      )
      .run(),
  ).rejects.toThrow(/attribution/i);
  await db.batch(moveStatements());
  await db.batch([
    db.prepare(
      "INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES ('historical','alpha','owner','Owner','operation.reconciled','Historical reconciliation','','2026-01-04')",
    ),
    db.prepare(
      "INSERT INTO activity_repository_links VALUES ('alpha','historical','repo')",
    ),
    db.prepare(
      "INSERT INTO activity_project_links VALUES ('alpha','historical','project')",
    ),
  ]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
