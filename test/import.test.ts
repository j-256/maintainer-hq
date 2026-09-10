import { env, applyD1Migrations } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  LIMITS,
  type Principal,
} from "../shared/domain";
import { IMPORT_LIMITS, importManifest } from "../shared/import";
import { commandAnnotations, commands } from "../shared/commands";
import { WorkspaceService } from "../worker/service";
import { credentialHash } from "../worker/credential-hash";
import { createApplication } from "../worker/app";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const workspace = { workspaceId: "alpha" };
const owner: Principal = { subject: "owner", displayName: "Test owner" };
let now: number;
const as = (principal = owner) =>
  new WorkspaceService(bindings, principal, false, () => now);
const project = (key = "project") => ({
  key,
  name: key === "project" ? "Imported project" : key,
  description: "Imported project context",
  lifecycle: "active" as const,
  importance: "standard" as const,
  importanceNote: "",
  portfolio: DEFAULT_PORTFOLIO,
});
const repository = (
  fullName = "example/project",
  projectKey = "project",
) => ({
  fullName,
  description: "Imported intent, not health",
  projectKey,
  classification: "maintained" as const,
  lifecycle: "active" as const,
  expectations: {
    ...DEFAULT_EXPECTATIONS,
    note: "Keep this note verbatim\nwith a second line",
  },
});
const projectMetadata = (value = project()) => {
  const { key, ...metadata } = value;
  void key;
  return metadata;
};
const repositoryMetadata = (value = repository()) => {
  const { projectKey, ...metadata } = value;
  void projectKey;
  return metadata;
};
const fields = () => ({
  ...workspace,
  manifest: {
    formatVersion: 2 as const,
    sourceLabel: "Reviewed test metadata",
    projects: [project()],
    repositories: [repository()],
  },
});
const applyFields = (plan: { planId: string; fingerprint: string }) => ({
  ...workspace,
  planId: plan.planId,
  fingerprint: plan.fingerprint,
});
const count = (table: string) =>
  bindings.HQ_DB.prepare(
    "SELECT count(*) AS total FROM " + table,
  ).first<number>("total");

beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  now = Date.now();
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Test owner','owner'),('alpha','second','Second owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','other','Other','owner')",
    ),
  ]);
});

describe("One-time reviewed metadata import", () => {
  it("keeps the maximum supported inventory in one atomic import", async () => {
    const input = fields();
    input.manifest.repositories = Array.from(
      { length: IMPORT_LIMITS.REPOSITORIES },
      (_, index) => repository("example/repository-" + index),
    );
    const plan = await as().metadataImportPlan(input);
    const receipt = await as().metadataImportApply(applyFields(plan));
    expect(receipt.projectCount).toBe(1);
    expect(receipt.repositoryCount).toBe(IMPORT_LIMITS.REPOSITORIES);
    expect(await count("projects")).toBe(1);
    expect(await count("repositories")).toBe(IMPORT_LIMITS.REPOSITORIES);
  });
  it("rejects authority revoked after preflight but before the transaction", async () => {
    const plan = await as().metadataImportPlan(fields());
    const batch = bindings.HQ_DB.batch.bind(bindings.HQ_DB);
    vi.spyOn(bindings.HQ_DB, "batch").mockImplementationOnce(
      async (statements) => {
        await bindings.HQ_DB.prepare(
          "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
        ).run();
        return batch(statements);
      },
    );
    await expect(
      as().metadataImportApply(applyFields(plan)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("repositories")).toBe(0);
    expect(await count("metadata_imports")).toBe(0);
    expect(await count("activity")).toBe(0);
  });
  it("preserves exact intent, never imports authority or evidence, and returns the same receipt after expiry", async () => {
    const service = as();
    expect(await service.metadataImportStatus(workspace)).toEqual({
      projectCount: 0,
      repositoryCount: 0,
      receipt: null,
    });
    const plan = await service.metadataImportPlan(fields());
    expect(plan).toMatchObject({
      ...fields(),
      workspaceName: "Alpha",
      actor: owner.displayName,
    });
    expect(Date.parse(plan.expiresAt) - now).toBe(LIMITS.PLAN_TTL_MS);
    expect(await count("repositories")).toBe(0);
    const receipt = await service.metadataImportApply(applyFields(plan));
    expect(receipt).toMatchObject({
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      projectCount: 1,
      repositoryCount: 1,
      sourceLabel: fields().manifest.sourceLabel,
    });
    const [savedProject] = await service.projects(workspace);
    expect(savedProject).toMatchObject(projectMetadata());
    const [savedRepository] = await service.repositories(workspace);
    expect(savedRepository).toMatchObject({
      fullName: repository().fullName,
      description: repository().description,
      classification: repository().classification,
      lifecycle: repository().lifecycle,
      expectations: repository().expectations,
      projectId: savedProject.id,
    });
    now += LIMITS.PLAN_TTL_MS * 2;
    expect(await service.metadataImportApply(applyFields(plan))).toEqual(
      receipt,
    );
    expect(await service.metadataImportStatus(workspace)).toEqual({
      projectCount: 1,
      repositoryCount: 1,
      receipt,
    });
    expect(await count("repositories")).toBe(1);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "metadata.imported",
      ),
    ).toHaveLength(1);
    for (const table of [
      "credentials",
      "observations",
      "goals",
      "connections",
    ])
      expect(await count(table)).toBe(0);
    expect(await count("projects")).toBe(1);
    expect(await count("members")).toBe(5);
    await expect(service.metadataImportPlan(fields())).rejects.toMatchObject({
      status: 409,
    });
  });
  it("rejects unexpected documents, copied access, duplicates, invalid project references, legacy formats, and oversized files", () => {
    const valid = fields().manifest;
    for (const field of [
      "credentials",
      "members",
      "observations",
      "sources",
      "github",
      "workspace",
    ])
      expect(importManifest.safeParse({ ...valid, [field]: {} }).success).toBe(
        false,
      );
    expect(
      importManifest.safeParse({
        ...valid,
        repositories: [repository(), repository("EXAMPLE/PROJECT")],
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        repositories: [{ ...repository(), projectId: "legacy-project" }],
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        formatVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        projects: [project(), { ...project("second"), key: "project" }],
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        projects: [project(), { ...project("second"), name: "IMPORTED PROJECT" }],
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        repositories: [repository("example/project", "missing")],
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        projects: Array.from(
          { length: IMPORT_LIMITS.PROJECTS + 1 },
          (_, i) => project("p" + i),
        ),
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        repositories: Array.from(
          { length: IMPORT_LIMITS.REPOSITORIES + 1 },
          (_, i) => repository("example/p" + i),
        ),
      }).success,
    ).toBe(false);
    expect(
      importManifest.safeParse({
        ...valid,
        repositories: Array.from(
          { length: IMPORT_LIMITS.REPOSITORIES },
          (_, i) => ({
            ...repository("example/p" + i),
            expectations: { ...DEFAULT_EXPECTATIONS, note: "x".repeat(1500) },
          }),
        ),
      }).success,
    ).toBe(false);
  });
  it("refuses viewers, operators, other workspaces, edited fingerprints, other owners, and expired reviews", async () => {
    for (const subject of ["viewer", "operator", "other"]) {
      await expect(
        as({ subject, displayName: subject }).metadataImportPlan(fields()),
      ).rejects.toMatchObject({ status: subject === "other" ? 404 : 403 });
      await expect(
        as({ subject, displayName: subject }).metadataImportStatus(workspace),
      ).rejects.toMatchObject({ status: subject === "other" ? 404 : 403 });
    }
    const plan = await as().metadataImportPlan(fields());
    await expect(
      as({ subject: "second", displayName: "Second" }).metadataImportApply(
        applyFields(plan),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as().metadataImportApply({
        ...applyFields(plan),
        fingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(
      as().metadataImportApply(applyFields(plan)),
    ).rejects.toMatchObject({ status: 409 });
    const renewed = await as().metadataImportPlan(fields());
    now += LIMITS.PLAN_TTL_MS;
    await expect(
      as().metadataImportApply(applyFields(renewed)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("metadata_imports")).toBe(0);
    expect(await count("repositories")).toBe(0);
  });
  it("refuses enrollment drift and conflicting imports without partial effects", async () => {
    const service = as();
    const plan = await service.metadataImportPlan(fields());
    const manualProject = await service.createProject({
      ...workspace,
      name: "Manual project",
      description: "Created after import review",
    });
    await service.createRepository({
      ...workspace,
      repository: {
        ...repositoryMetadata(repository("example/manual")),
        projectId: manualProject.id,
      },
    });
    await expect(
      service.metadataImportApply(applyFields(plan)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await count("metadata_imports")).toBe(0);
    expect(
      (await service.repositories(workspace)).map((repo) => repo.fullName),
    ).toEqual(["example/manual"]);
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare("DELETE FROM activity"),
      bindings.HQ_DB.prepare("DELETE FROM repositories"),
      bindings.HQ_DB.prepare("DELETE FROM projects"),
    ]);
    const second = await service.metadataImportPlan({
      ...fields(),
      manifest: {
        ...fields().manifest,
        repositories: [repository("example/second")],
      },
    });
    const results = await Promise.allSettled([
      service.metadataImportApply(applyFields(plan)),
      service.metadataImportApply(applyFields(second)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await count("repositories")).toBe(1);
    expect(await count("projects")).toBe(1);
    expect(await count("metadata_imports")).toBe(1);
    expect(
      (await service.activity(workspace)).filter(
        (event) => event.type === "metadata.imported",
      ),
    ).toHaveLength(1);
  });
  it("retries concurrent identical applies safely and rolls back the entire batch on a database constraint failure", async () => {
    const service = as();
    const plan = await service.metadataImportPlan(fields());
    await bindings.HQ_DB.prepare(
      "CREATE TRIGGER reject_import_test BEFORE INSERT ON repositories WHEN NEW.full_name='example/project' BEGIN SELECT RAISE(ABORT,'synthetic constraint'); END",
    ).run();
    try {
      await expect(
        service.metadataImportApply(applyFields(plan)),
      ).rejects.toThrow();
      expect(await count("metadata_imports")).toBe(0);
      expect(await count("repositories")).toBe(0);
      expect(await count("activity")).toBe(0);
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT applied_at FROM action_plans WHERE id=?",
        )
          .bind(plan.planId)
          .first("applied_at"),
      ).toBeNull();
    } finally {
      await bindings.HQ_DB.prepare("DROP TRIGGER reject_import_test").run();
    }
    const results = await Promise.all([
      service.metadataImportApply(applyFields(plan)),
      service.metadataImportApply(applyFields(plan)),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await count("repositories")).toBe(1);
  });
  it("binds reviews to credential identity and checks live scope, revocation, and expiry on cached principals", async () => {
    const scopes = [CAPABILITY.READ, CAPABILITY.ADMIN, CAPABILITY.EDIT];
    const tokenId = "importer";
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES (?,'alpha','owner','Test importer',?,?,?,?)",
    )
      .bind(
        tokenId,
        await credentialHash("synthetic-import-token"),
        JSON.stringify(scopes),
        new Date(now).toISOString(),
        new Date(now + 86400000).toISOString(),
      )
      .run();
    const machine = as({ ...owner, tokenId, workspaceId: "alpha", scopes });
    const plan = await machine.metadataImportPlan(fields());
    await expect(
      as().metadataImportApply(applyFields(plan)),
    ).rejects.toMatchObject({ status: 409 });
    await bindings.HQ_DB.prepare(
      'UPDATE credentials SET scopes_json=\'["read","workspace:admin"]\' WHERE id=?',
    )
      .bind(tokenId)
      .run();
    await expect(
      machine.metadataImportApply(applyFields(plan)),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json=?,revoked_at=? WHERE id=?",
    )
      .bind(JSON.stringify(scopes), new Date(now).toISOString(), tokenId)
      .run();
    await expect(machine.metadataImportPlan(fields())).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET revoked_at=NULL,expires_at=? WHERE id=?",
    )
      .bind(new Date(now - 1).toISOString(), tokenId)
      .run();
    await expect(machine.metadataImportStatus(workspace)).rejects.toMatchObject(
      { status: 403, code: "forbidden" },
    );
    expect(await count("metadata_imports")).toBe(0);
  });
  it("exposes the same bounded review and apply through the authenticated command surface", async () => {
    const app = createApplication(async () => owner);
    const invoke = (name: string, body: unknown) =>
      app.fetch(
        new Request("https://hq.example/api/commands/" + name, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://hq.example",
          },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    const response = await invoke("metadata_import_plan", fields());
    expect(response.status).toBe(200);
    const plan = (await response.json()) as {
      planId: string;
      fingerprint: string;
    };
    const applied = await invoke("metadata_import_apply", applyFields(plan));
    expect(applied.status).toBe(200);
    const mcp = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "metadata_import_apply",
            arguments: applyFields(plan),
          },
        }),
      }),
      bindings,
    );
    expect(mcp.status).toBe(200);
    const responseBody = (await mcp.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(responseBody.result.isError).not.toBe(true);
    expect(JSON.parse(responseBody.result.content[0]!.text)).toMatchObject({
      planId: plan.planId,
      fingerprint: plan.fingerprint,
      projectCount: 1,
      repositoryCount: 1,
    });
    expect(
      await (await invoke("metadata_import_apply", applyFields(plan))).json(),
    ).toEqual(await applied.json());
    expect(commands.metadata_import_apply.method).toBe("metadataImportApply");
    expect(commandAnnotations("metadata_import_apply", false)).toMatchObject({
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
