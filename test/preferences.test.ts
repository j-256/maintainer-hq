import { env, applyD1Migrations } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  afterEach,
} from "vitest";
import { CAPABILITY, type Principal } from "../shared/domain";
import { DEFAULT_PREFERENCES } from "../shared/preferences";
import { commands, commandAnnotations } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const preferences = { ...DEFAULT_PREFERENCES, timeZone: "UTC" };
const as = (subject: string, extra: Partial<Principal> = {}) =>
  new WorkspaceService(bindings, { subject, displayName: subject, ...extra });

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM user_preferences"),
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','viewer','Viewer','viewer'),('alpha','operator','Operator','operator'),('beta','owner','Owner','viewer'),('beta','other','Other','owner')",
    ),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("Personal preferences", () => {
  it("returns defaults without writing during session or preference reads", async () => {
    const service = as("owner");
    const expected = {
      preferences: DEFAULT_PREFERENCES,
      revision: 0,
      updatedAt: null,
    };
    expect(await service.preferencesGet(workspace)).toEqual(expected);
    expect((await service.session()).preferences).toEqual(expected);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM user_preferences",
      ).first("n"),
    ).toBe(0);
  });

  it.each(["owner", "operator", "viewer"])(
    "lets a %s save only their own account preferences",
    async (subject) => {
      const service = as(subject);
      const record = await service.preferencesUpdate({
        ...workspace,
        preferences,
        revision: 0,
      });
      expect(record).toMatchObject({ preferences, revision: 1 });
      expect((await service.session()).preferences).toEqual(record);
      expect(
        (await as("other").preferencesGet({ workspaceId: "beta" })).preferences,
      ).toEqual(DEFAULT_PREFERENCES);
      await expect(
        service.preferencesUpdate({
          ...workspace,
          preferences,
          revision: 1,
          subject: "other",
        }),
      ).rejects.toThrow();
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT count(*) AS n FROM activity",
        ).first("n"),
      ).toBe(0);
    },
  );

  it("shares the user's choice across their workspaces, but does not grant cross-workspace access", async () => {
    const owner = as("owner");
    const record = await owner.preferencesUpdate({
      ...workspace,
      preferences,
      revision: 0,
    });
    expect(await owner.preferencesGet({ workspaceId: "beta" })).toEqual(record);
    await expect(
      as("viewer").preferencesGet({ workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as("other").preferencesUpdate({ ...workspace, preferences, revision: 0 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as("owner", { workspaceId: "alpha" }).preferencesGet({
        workspaceId: "beta",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("protects initial creation and updates from concurrent stale writes", async () => {
    const service = as("owner");
    for (const revision of [0, 1]) {
      const results = await Promise.allSettled(
        ["UTC", "America/New_York"].map((timeZone) =>
          service.preferencesUpdate({
            ...workspace,
            revision,
            preferences: { ...preferences, timeZone },
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected"),
      ).toMatchObject({ reason: { status: 409 } });
      expect((await service.preferencesGet(workspace)).revision).toBe(
        revision + 1,
      );
    }
    await expect(
      as("viewer").preferencesUpdate({
        ...workspace,
        preferences,
        revision: 999,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("denies read-only and reporting credentials and rechecks credentials at the write boundary", async () => {
    const input = { ...workspace, preferences, revision: 0 };
    await expect(
      as("owner", { scopes: [CAPABILITY.READ] }).preferencesUpdate(input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as("owner", { scopes: [CAPABILITY.ACTIVITY] }).preferencesGet(workspace),
    ).rejects.toMatchObject({ status: 403 });
    const scopes = [CAPABILITY.READ, CAPABILITY.PREFERENCES];
    const principal = { scopes, tokenId: "personal", workspaceId: "alpha" };
    await expect(
      as("owner", principal).preferencesUpdate(input),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('personal','alpha','owner','Synthetic credential','synthetic-hash',?,?,?)",
    )
      .bind(
        JSON.stringify(scopes),
        new Date().toISOString(),
        new Date(Date.now() + 60000).toISOString(),
      )
      .run();
    const record = await as("owner", principal).preferencesUpdate(input);
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE id='personal'",
    )
      .bind(new Date().toISOString())
      .run();
    await expect(
      as("owner", principal).preferencesUpdate({
        ...input,
        revision: record.revision,
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await as("owner").preferencesGet(workspace)).toEqual(record);
  });

  it("rechecks live membership after preliminary authorization", async () => {
    const service = as("viewer");
    const original = service.authorize.bind(service);
    vi.spyOn(service, "authorize").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === CAPABILITY.PREFERENCES)
        await bindings.HQ_DB.prepare(
          "DELETE FROM members WHERE subject='viewer'",
        ).run();
      return result;
    });
    await expect(
      service.preferencesUpdate({ ...workspace, preferences, revision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM user_preferences",
      ).first("n"),
    ).toBe(0);
  });

  it("uses the shared command boundary for browser, CLI, and MCP", async () => {
    expect(commands.preferences_get.method).toBe("preferencesGet");
    expect(commands.preferences_update.method).toBe("preferencesUpdate");
    expect(
      commandAnnotations("preferences_get", commands.preferences_get.readOnly)
        .readOnlyHint,
    ).toBe(true);
    expect(
      commandAnnotations(
        "preferences_update",
        commands.preferences_update.readOnly,
      ).readOnlyHint,
    ).toBe(false);
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    const response = await app.fetch(
      new Request("https://hq.example/api/commands/preferences_update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
        },
        body: JSON.stringify({ ...workspace, preferences, revision: 0 }),
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preferences, revision: 1 });
  });
});
