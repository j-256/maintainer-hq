import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import { CAPABILITY, type Principal } from "../shared/domain";
import { ACTIVITY_LIMITS } from "../shared/activity";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const owner: Principal = { subject: "owner", displayName: "Test owner" };
const service = new WorkspaceService(bindings, owner, false, () =>
  Date.parse("2026-01-01T00:00:05Z"),
);
const workspace = { workspaceId: "alpha" };
const goal = {
  ...workspace,
  goalId: "goal-one",
  sourceId: "agent",
  objective: "  An exact /goal\nwith retained whitespace  ",
  status: "active",
  startedAt: "2026-01-01T00:00:00Z",
  reportedAt: "2026-01-01T00:00:01Z",
};
const note = {
  ...workspace,
  eventId: "note",
  kind: "note",
  title: "A note",
  summary: "Useful context",
  resourceId: null,
};

beforeAll(async () => {
  await applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM activity"),
    bindings.HQ_DB.prepare("DELETE FROM goals"),
    bindings.HQ_DB.prepare("DELETE FROM credentials"),
    bindings.HQ_DB.prepare("DELETE FROM members"),
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Test owner','owner'),('alpha','other','Other writer','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
});

describe("Goal-associated activity", () => {
  it("includes relevant goal lifecycle and general updates while excluding another repository's events", async () => {
    const repository = {
      fullName: "example/one",
      description: "",
      projectId: "project",
      classification: "maintained",
      lifecycle: "active",
      expectations: {
        ci: "unmanaged",
        security: "unmanaged",
        monitoring: "unmanaged",
        hooks: "unmanaged",
        visibility: "any",
        reviewDate: null,
        note: "",
      },
    };
    const first = await service.createRepository({ ...workspace, repository });
    const second = await service.createRepository({
      ...workspace,
      repository: { ...repository, fullName: "example/two" },
    });
    await service.syncGoal(goal);
    await service.addActivity({
      ...note,
      eventId: "general",
      goalId: goal.goalId,
    });
    const before = await service.activityFeed({
      ...workspace,
      repositoryId: first.id,
    });
    await service.addActivity({
      ...note,
      eventId: "one",
      resourceId: first.id,
      goalId: goal.goalId,
    });
    await service.addActivity({
      ...note,
      eventId: "two",
      resourceId: second.id,
      goalId: goal.goalId,
    });
    const events = await service.goalActivity({
      ...workspace,
      repositoryId: first.id,
      goalId: goal.goalId,
    });
    expect(events.events).toHaveLength(3);
    expect(events.events.slice(0, 2).map((event) => event.id)).toEqual([
      "one",
      "general",
    ]);
    expect(events.events[2]).toMatchObject({
      type: "goal.active",
      goalId: goal.goalId,
    });
    expect(
      await service.activityFeed({
        ...workspace,
        repositoryId: first.id,
        cursor: before.viewCursor,
      }),
    ).toEqual(before);
    const feed = await service.activityFeed({
      ...workspace,
      repositoryId: first.id,
    });
    expect(feed.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "goal",
          goal: expect.objectContaining({ objective: goal.objective }),
        }),
      ]),
    );
  });
  it("links transitions and explicit notes without guessing at other activity", async () => {
    await service.syncGoal(goal);
    const linked = await service.addActivity({ ...note, goalId: goal.goalId });
    expect(await service.addActivity({ ...note, goalId: goal.goalId })).toEqual(
      linked,
    );
    await expect(service.addActivity(note)).rejects.toMatchObject({
      status: 409,
    });
    await service.addActivity({ ...note, eventId: "unrelated" });
    await service.syncGoal({
      ...goal,
      status: "complete",
      reportedAt: "2026-01-01T00:00:04Z",
    });
    const feed = await service.activityFeed(workspace);
    expect(feed.groups).toHaveLength(2);
    expect(feed.groups[0]).toMatchObject({
      kind: "goal",
      eventCount: 3,
      goal: { id: goal.goalId, objective: goal.objective, status: "complete" },
    });
    expect(feed.groups[1]).toMatchObject({
      kind: "event",
      event: { id: "unrelated", goalId: null },
    });
    const events = await service.goalActivity({
      ...workspace,
      goalId: goal.goalId,
    });
    expect(events.events.map((event) => event.goalId)).toEqual([
      goal.goalId,
      goal.goalId,
      goal.goalId,
    ]);
  });

  it("rejects missing, cross-workspace, and another reporter's goal associations", async () => {
    await expect(
      service.addActivity({ ...note, goalId: "missing" }),
    ).rejects.toMatchObject({ status: 404 });
    await new WorkspaceService(
      bindings,
      { subject: "outside", displayName: "Outside" },
      false,
      service.now,
    ).syncGoal({ ...goal, workspaceId: "beta" });
    await expect(
      service.addActivity({ ...note, goalId: goal.goalId }),
    ).rejects.toMatchObject({ status: 404 });
    const first = new WorkspaceService(
      bindings,
      {
        ...owner,
        reporterId: "first",
        workspaceId: "alpha",
        scopes: [CAPABILITY.GOALS, CAPABILITY.ACTIVITY],
      },
      false,
      service.now,
    );
    const second = new WorkspaceService(
      bindings,
      {
        ...owner,
        reporterId: "second",
        workspaceId: "alpha",
        scopes: [CAPABILITY.GOALS, CAPABILITY.ACTIVITY],
      },
      false,
      service.now,
    );
    await first.syncGoal({ ...goal, sourceId: "first" });
    await expect(
      second.addActivity({ ...note, goalId: goal.goalId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await first.addActivity({ ...note, goalId: goal.goalId })).goalId,
    ).toBe(goal.goalId);
  });
});

describe("Activity pagination", () => {
  it("traverses the entire journal once with tied timestamps and concurrent new inserts", async () => {
    const count = 121;
    for (let index = 0; index < count; index++)
      await service.addActivity({
        ...note,
        eventId: "event-" + index,
        title: "Journal " + index,
      });
    expect(await service.activity(workspace)).toHaveLength(100);
    const first = await service.activityFeed({ ...workspace, limit: 11 });
    await service.addActivity({ ...note, eventId: "arrived-later" });
    expect(
      await service.activityFeed({
        ...workspace,
        limit: 11,
        cursor: first.viewCursor,
      }),
    ).toEqual(first);
    const ids: string[] = [];
    let page = first;
    while (true) {
      for (const group of page.groups) {
        expect(group.kind).toBe("event");
        if (group.kind === "event") ids.push(group.event.id);
      }
      if (!page.nextCursor) break;
      page = await service.activityFeed({
        ...workspace,
        limit: 11,
        cursor: page.nextCursor,
      });
    }
    expect(ids).toEqual(
      Array.from(
        { length: count },
        (_, index) => "event-" + (count - index - 1),
      ),
    );
    expect((await service.activityFeed(workspace)).groups[0]).toMatchObject({
      kind: "event",
      event: { id: "arrived-later" },
    });
  });

  it("paginates whole goal groups and lazy entries against the same snapshot", async () => {
    for (let index = 0; index < 4; index++) {
      await service.syncGoal({ ...goal, goalId: "goal-" + index });
      for (let event = 0; event < 5; event++)
        await service.addActivity({
          ...note,
          eventId: `goal-${index}-event-${event}`,
          goalId: "goal-" + index,
        });
    }
    const first = await service.activityFeed({ ...workspace, limit: 2 });
    expect(
      first.groups.map((group) =>
        group.kind === "goal" ? group.goal.id : null,
      ),
    ).toEqual(["goal-3", "goal-2"]);
    const group = first.groups[0];
    if (group.kind !== "goal") throw new Error("Expected a goal group");
    await service.addActivity({
      ...note,
      eventId: "new-in-old-goal",
      goalId: "goal-0",
    });
    await service.addActivity({
      ...note,
      eventId: "new-in-visible-goal",
      goalId: "goal-3",
    });
    const second = await service.activityFeed({
      ...workspace,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(
      second.groups.map((value) =>
        value.kind === "goal" ? value.goal.id : null,
      ),
    ).toEqual(["goal-1", "goal-0"]);
    expect(second.nextCursor).toBeNull();
    let cursor: string | null = group.eventsCursor;
    const ids: string[] = [];
    do {
      const page = await service.goalActivity({
        ...workspace,
        goalId: group.goal.id,
        limit: 2,
        cursor,
      });
      ids.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(group.eventCount);
    expect(new Set(ids).size).toBe(group.eventCount);
    expect(ids).not.toContain("new-in-visible-goal");
  });

  it("searches all authorized history literally and binds cursors to filters and mode", async () => {
    await service.syncGoal(goal);
    await service.addActivity({
      ...note,
      goalId: goal.goalId,
      title: "100%_literal",
    });
    await service.addActivity({ ...note, eventId: "ordinary" });
    const filtered = { ...workspace, filter: "note", search: "%_", limit: 1 };
    const page = await service.activityFeed(filtered);
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]).toMatchObject({ kind: "goal", eventCount: 1 });
    await expect(
      service.activityFeed({ ...workspace, cursor: page.viewCursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.goalActivity({
        ...filtered,
        goalId: goal.goalId,
        cursor: page.viewCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    for (const cursor of ["not-a-cursor", "!", "x".repeat(4097)])
      await expect(
        service.activityFeed({ ...workspace, cursor }),
      ).rejects.toThrow();
    await expect(
      service.activityFeed({
        ...workspace,
        limit: ACTIVITY_LIMITS.MAX_PAGE_SIZE + 1,
      }),
    ).rejects.toThrow();
    await expect(
      service.activityFeed({
        ...workspace,
        search: "x".repeat(ACTIVITY_LIMITS.SEARCH_LENGTH + 1),
      }),
    ).rejects.toThrow();
    expect(
      (await service.activityFeed({ ...workspace, repositoryId: "missing" }))
        .groups,
    ).toEqual([]);
  });

  it("rechecks workspace read authority on every page and exposes the shared HTTP contract", async () => {
    await service.addActivity(note);
    const first = await service.activityFeed({ ...workspace, limit: 1 });
    await expect(
      service.activityFeed({ workspaceId: "beta", cursor: first.viewCursor }),
    ).rejects.toMatchObject({ status: 404 });
    const app = createApplication(async () => owner);
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/activity_feed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify(workspace),
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groups: [{ kind: "event", event: { id: note.eventId } }],
    });
    await bindings.HQ_DB.prepare(
      "DELETE FROM members WHERE subject='owner'",
    ).run();
    await expect(
      service.activityFeed({ ...workspace, cursor: first.viewCursor }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.goalActivity({ ...workspace, goalId: goal.goalId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
