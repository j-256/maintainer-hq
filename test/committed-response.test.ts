import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";
import { createApplication } from "../worker/app";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

it("does not promise unchanged data when a committed metadata save loses its response read", async () => {
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha','2026-01-01')"),
    bindings.HQ_DB.prepare("INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner')"),
    bindings.HQ_DB.prepare("INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')"),
  ]);
  vi.spyOn(WorkspaceService.prototype, "repository").mockRejectedValueOnce(new Error("synthetic-private-storage-error"));
  const app = createApplication(async () => ({ subject: "owner", displayName: "Owner" }));
  const response = await app.fetch(new Request("https://hq.example/api/commands/repository_create", {
    method: "POST",
    headers: { Origin: "https://hq.example", "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "alpha",
      repository: {
        fullName: "example/committed",
        description: "Synthetic saved metadata",
        projectId: "project",
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    }),
  }), bindings);
  expect(response.status).toBe(503);
  expect(await bindings.HQ_DB.prepare("SELECT full_name FROM repositories").first()).toEqual({ full_name: "example/committed" });
  expect(await bindings.HQ_DB.prepare("SELECT COUNT(*) AS total FROM operations").first("total")).toBe(0);
  const result = await response.json() as { error: { message: string; reference: string } };
  expect(result.error.message).not.toMatch(/unchanged|synthetic-private-storage-error/);
  expect(result.error.message).toMatch(/may have succeeded/i);
  expect(result.error.reference).toMatch(/^[a-f0-9-]{36}$/);
});
