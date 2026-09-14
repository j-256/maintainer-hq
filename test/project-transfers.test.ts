import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { commands, commandAnnotations } from "../shared/commands";
import { HOOK_SETUP_KIND } from "../shared/hook-setup";
import {
  TRANSFER_LIMITS,
  type TransferFields,
} from "../shared/project-transfers";
import { managedDestinationKey } from "../shared/managed-configurations";
import { sourceFields } from "../shared/sources";
import { githubSourceFields } from "../shared/github";
import { WorkspaceService } from "../worker/service";
import { createApplication } from "../worker/app";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.HQ_DB;
const owner: Principal = { subject: "owner", displayName: "Owner" };
const service = new WorkspaceService(bindings, owner);
const firstRepository = {
  fullName: "example/service",
  description: "Original description",
  classification: "maintained",
  lifecycle: "active",
  expectations: DEFAULT_EXPECTATIONS,
};
beforeAll(async () => applyD1Migrations(db, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare("DROP TRIGGER IF EXISTS fail_transfer_repository"),
    db.prepare("DELETE FROM workspaces"),
    db.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01'),('foreign','Private name','2026-01-01')",
    ),
    db.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('beta','owner','Owner','owner'),('alpha','source-reader','Source reader','viewer'),('beta','destination-reader','Destination reader','viewer'),('alpha','operator','Operator','operator'),('foreign','other','Other','owner')",
    ),
  ]);
});
async function create(repository = true) {
  const project = await service.createProject({
    workspaceId: "alpha",
    name: "Service",
    description: "Retained project",
    importance: "high",
    importanceNote: "An operational dependency",
    portfolio: {
      status: "listed",
      reason: "Maintainer decision",
      url: "https://example.test/projects/service",
      reviewDate: null,
    },
    ...(repository ? { firstRepository } : {}),
  });
  const fields: TransferFields = {
    workspaceId: "alpha",
    projectId: project.id,
    projectRevision: project.revision,
    destinationWorkspaceId: "beta",
    sourceBindings: [],
  };
  return { project, fields };
}
async function plan(fields: TransferFields) {
  return service.projectTransferPlan({
    ...fields,
    reviewId: crypto.randomUUID(),
  });
}
async function apply(fields: TransferFields) {
  const review = await plan(fields);
  return service.projectTransferApply({
    workspaceId: fields.workspaceId,
    reviewId: review.reviewId,
    fingerprint: review.fingerprint,
  });
}
async function location(projectId: string) {
  return db
    .prepare("SELECT workspace_id FROM projects WHERE id=?")
    .bind(projectId)
    .first("workspace_id");
}

it("previews access changes and exposes the same bounded command contract without metadata writes", async () => {
  const { fields } = await create();
  const before = (await db.prepare("SELECT * FROM activity ORDER BY id").all())
    .results;
  const preview = await service.projectTransferPreview(fields);
  expect(preview.ready).toBe(true);
  expect(preview.access).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: "owner",
        effect: "retain",
        sourceRole: "owner",
        destinationRole: "owner",
      }),
      expect.objectContaining({
        subject: "source-reader",
        effect: "lose",
        destinationRole: null,
      }),
      expect.objectContaining({
        subject: "destination-reader",
        effect: "gain",
        sourceRole: null,
      }),
    ]),
  );
  expect(preview.historyPolicy).toBe("original-workspace-only");
  expect(
    (await db.prepare("SELECT * FROM activity ORDER BY id").all()).results,
  ).toEqual(before);
  expect(
    await service.projectTransferDestinations({ workspaceId: "alpha" }),
  ).toEqual({
    workspaces: [{ id: "beta", name: "Beta", role: "owner" }],
    restriction: null,
  });
  for (const name of [
    "project_transfer_destinations",
    "project_transfer_preview",
    "project_transfer_plan",
    "project_transfer_review",
    "project_transfer_apply",
    "departed_resource_context",
  ] as const) {
    expect(typeof service[commands[name].method]).toBe("function");
    expect(
      commands[name].schema.safeParse({
        workspaceId: "alpha",
        sql: "forbidden",
      }).success,
    ).toBe(false);
  }
  expect(commandAnnotations("project_transfer_apply", false)).toMatchObject({
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});

it("moves a standalone project once and returns the original receipt after a lost response", async () => {
  const { project, fields } = await create(false);
  const review = await plan(fields);
  const command = {
    workspaceId: "alpha",
    reviewId: review.reviewId,
    fingerprint: review.fingerprint,
  };
  const receipt = await service.projectTransferApply(command);
  expect(receipt.status).toBe("succeeded");
  expect(await service.projectTransferApply(command)).toEqual(receipt);
  expect(
    await service.project({ workspaceId: "beta", projectId: project.id }),
  ).toMatchObject({
    ...project,
    workspaceId: "beta",
    revision: project.revision + 1,
    updatedAt: receipt.completedAt,
  });
  expect(await location(project.id)).toBe("beta");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM activity WHERE type LIKE 'project.transfer.%'",
      )
      .first("total"),
  ).toBe(2);
  expect(
    (
      await service.projectTransferReview({
        workspaceId: "alpha",
        reviewId: review.reviewId,
      })
    ).state,
  ).toBe("applied");
});

it("preserves repository identities, expectations and source-only history while emitting both sides of the move", async () => {
  const { project, fields } = await create();
  const [repository] = await service.repositories({ workspaceId: "alpha" });
  await service.addActivity({
    workspaceId: "alpha",
    eventId: "old-project-note",
    kind: "note",
    title: "Source-private note",
    summary: "This must not travel",
    resourceId: project.id,
  });
  await service.createRepository({
    workspaceId: "alpha",
    repository: {
      ...firstRepository,
      fullName: "example/second",
      projectId: project.id,
    },
  });
  const before = await service.workspaceView({
    workspaceId: "alpha",
    view: "projects",
  });
  const receipt = await apply(fields);
  expect(receipt.repositoryIds).toHaveLength(2);
  expect(
    await service.repository({
      workspaceId: "beta",
      repositoryId: repository.id,
    }),
  ).toMatchObject({
    ...repository,
    workspaceId: "beta",
    revision: repository.revision + 1,
    updatedAt: receipt.completedAt,
  });
  const sourceReader = new WorkspaceService(bindings, {
    subject: "source-reader",
    displayName: "Source reader",
  });
  const destinationReader = new WorkspaceService(bindings, {
    subject: "destination-reader",
    displayName: "Destination reader",
  });
  const historical = await sourceReader.departedResourceContext({
    workspaceId: "alpha",
    kind: "project",
    resourceId: project.id,
  });
  expect(historical).toMatchObject({
    name: project.name,
    projectId: project.id,
    historyPolicy: "original-workspace-only",
  });
  expect(JSON.stringify(historical)).not.toContain("beta");
  expect(
    JSON.stringify(
      await sourceReader.activityFeed({
        workspaceId: "alpha",
        projectId: project.id,
      }),
    ),
  ).toContain("Source-private note");
  expect(
    JSON.stringify(
      await destinationReader.activityFeed({
        workspaceId: "beta",
        projectId: project.id,
      }),
    ),
  ).not.toContain("Source-private note");
  await expect(
    sourceReader.project({ workspaceId: "beta", projectId: project.id }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    service.addActivity({
      workspaceId: "alpha",
      eventId: "late-report",
      kind: "note",
      title: "Not enrolled",
      summary: "",
      resourceId: project.id,
    }),
  ).rejects.toMatchObject({ status: 404 });
  const changes = await service.workspaceChanges({
    workspaceId: "alpha",
    view: "projects",
    cursor: before.cursor,
    memberRevision: before.memberRevision,
  });
  expect(changes.type).toBe("delta");
  if (changes.type === "delta") {
    expect(changes.removals).toEqual(
      expect.arrayContaining([
        { collection: "projects", key: project.id },
        { collection: "repositories", key: repository.id },
      ]),
    );
    expect(changes.upserts.projects ?? []).toEqual([]);
    expect(changes.upserts.repositories ?? []).toEqual([]);
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("moves a metadata-only repository without transferring its credential-backed discovery identity", async () => {
  const { fields } = await create();
  const [repository] = await service.repositories({ workspaceId: "alpha" });
  await db.batch([
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider,enabled) VALUES ('alpha','discovery-source','Discovery authority','github',0)",
    ),
    db
      .prepare(
        "INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at) VALUES ('alpha','discovery-source',?,'node-service',?,?)",
      )
      .bind(repository.id, repository.fullName, new Date().toISOString()),
  ]);
  const receipt = await apply(fields);
  expect(receipt.repositoryIds).toEqual([repository.id]);
  expect(await location(fields.projectId)).toBe("beta");
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM github_repository_identities")
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT workspace_id FROM connections WHERE id='discovery-source'",
      )
      .first("workspace_id"),
  ).toBe("alpha");
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("requires explicit same-provider source rebinding and disables the emptied source without moving credentials or observations", async () => {
  const { fields } = await create();
  const [repository] = await service.repositories({ workspaceId: "alpha" });
  await db.batch([
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider,enabled) VALUES ('alpha','local-source','Original source','local',1),('beta','local-destination','Prepared source','local',0)",
    ),
    db
      .prepare(
        "INSERT INTO source_repositories VALUES ('alpha','local-source',?)",
      )
      .bind(repository.id),
    db
      .prepare(
        "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES ('alpha','local-source','repository',?,'Old evidence','healthy','Source evidence','{}','2026-01-01','2026-01-01','2026-01-02')",
      )
      .bind(repository.id),
  ]);
  expect((await service.projectTransferPreview(fields)).blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "missing_source_binding" }),
    ]),
  );
  await expect(plan(fields)).rejects.toMatchObject({
    code: "transfer_blocked",
  });
  fields.sourceBindings = [
    { sourceId: "local-source", destinationSourceId: "local-destination" },
  ];
  const preview = await service.projectTransferPreview(fields);
  expect(preview.sources[0]).toMatchObject({
    willDisable: true,
    destinationSourceId: "local-destination",
  });
  await apply(fields);
  expect(
    (await db.prepare("SELECT * FROM source_repositories").all()).results,
  ).toEqual([
    {
      workspace_id: "beta",
      source_id: "local-destination",
      repository_id: repository.id,
    },
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT workspace_id,id,enabled,revision FROM connections ORDER BY workspace_id",
        )
        .all()
    ).results,
  ).toEqual([
    { workspace_id: "alpha", id: "local-source", enabled: 0, revision: 2 },
    { workspace_id: "beta", id: "local-destination", enabled: 0, revision: 2 },
  ]);
  expect(
    await db
      .prepare("SELECT workspace_id FROM observations WHERE resource_id=?")
      .bind(repository.id)
      .first("workspace_id"),
  ).toBe("alpha");
});

it("allows preparing an empty disabled destination source but never enables an empty source", () => {
  const source = {
    name: "Prepared",
    repositoryIds: [],
    freshnessMinutes: 30,
    enabled: false,
  };
  expect(sourceFields.safeParse(source).success).toBe(true);
  expect(sourceFields.safeParse({ ...source, enabled: true }).success).toBe(
    false,
  );
  expect(
    githubSourceFields.safeParse({
      ...source,
      credentialRef: null,
      refreshIntervalMinutes: 15,
    }).success,
  ).toBe(true);
  expect(
    githubSourceFields.safeParse({
      ...source,
      enabled: true,
      credentialRef: null,
      refreshIntervalMinutes: 15,
    }).success,
  ).toBe(false);
});

it("blocks provider and shared resource dependencies without touching their connections", async () => {
  const { fields } = await create();
  const [repository] = await service.repositories({ workspaceId: "alpha" });
  const sharedProject = await service.createProject({
    workspaceId: "alpha",
    name: "Shared dependency",
    description: "Separate ownership context",
  });
  await service.createRepository({
    workspaceId: "alpha",
    repository: {
      ...firstRepository,
      fullName: "example/shared",
      projectId: sharedProject.id,
    },
  });
  const other = (await service.repositories({ workspaceId: "alpha" })).find(
    (item) => item.id !== repository.id,
  )!;
  await db.batch([
    db.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES ('alpha','hooks','Hooks','hookrelay')",
    ),
    db
      .prepare(
        "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id) VALUES ('alpha','hooks','shared',?,1,'seed')",
      )
      .bind(fields.projectId),
    db.prepare(
      "INSERT INTO repository_resource_associations(workspace_id,kind,connection_id,resource_key,revision,write_id,updated_at) VALUES ('alpha','hook','hooks','shared',1,'seed','2026-01-01')",
    ),
    db
      .prepare(
        "INSERT INTO repository_resource_links VALUES ('alpha','hook','hooks','shared',?),('alpha','hook','hooks','shared',?)",
      )
      .bind(repository.id, other.id),
  ]);
  const preview = await service.projectTransferPreview(fields);
  expect(preview.resources).toEqual([
    expect.objectContaining({
      kind: "hook",
      resourceKey: "shared",
      direct: true,
      sharedRepositoryCount: 1,
    }),
  ]);
  expect(
    preview.blockers.some((issue) => issue.code === "shared_provider_resource"),
  ).toBe(true);
  await expect(plan(fields)).rejects.toMatchObject({
    code: "transfer_blocked",
  });
  expect(await location(fields.projectId)).toBe("alpha");
});

it("invalidates plans on membership and structural edits but not on ordinary Activity", async () => {
  const { fields } = await create();
  const review = await plan(fields);
  await service.addActivity({
    workspaceId: "alpha",
    eventId: "progress",
    kind: "progress",
    title: "Actual work",
    summary: "Still working",
    resourceId: fields.projectId,
  });
  expect(
    (
      await service.projectTransferReview({
        workspaceId: "alpha",
        reviewId: review.reviewId,
      })
    ).state,
  ).toBe("reviewed");
  await db
    .prepare(
      "UPDATE members SET role='operator',revision=revision+1 WHERE workspace_id='beta' AND subject='destination-reader'",
    )
    .run();
  expect(
    (
      await service.projectTransferReview({
        workspaceId: "alpha",
        reviewId: review.reviewId,
      })
    ).state,
  ).toBe("stale");
  await expect(
    service.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: review.fingerprint,
    }),
  ).rejects.toMatchObject({ code: "transfer_conflict" });
  expect(await location(fields.projectId)).toBe("alpha");
});

it("denies foreign destinations, non-owners, reporter credentials and actor or fingerprint substitution", async () => {
  const { fields } = await create();
  for (const subject of ["operator", "source-reader"]) {
    const denied = new WorkspaceService(bindings, {
      subject,
      displayName: subject,
    });
    await expect(denied.projectTransferPreview(fields)).rejects.toMatchObject({
      status: 403,
    });
  }
  await expect(
    service.projectTransferPreview({
      ...fields,
      destinationWorkspaceId: "foreign",
    }),
  ).rejects.toMatchObject({ status: 404 });
  const reporter = new WorkspaceService(bindings, {
    ...owner,
    workspaceId: "alpha",
    tokenId: "reporter",
    reporterId: "agent",
    scopes: [CAPABILITY.ACTIVITY, CAPABILITY.GOALS],
  });
  await expect(reporter.projectTransferPreview(fields)).rejects.toMatchObject({
    status: 403,
  });
  const review = await plan(fields);
  await expect(
    service.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "transfer_conflict" });
  await db
    .prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','other','Other owner','owner'),('beta','other','Other owner','owner')",
    )
    .run();
  const other = new WorkspaceService(bindings, {
    subject: "other",
    displayName: "Other owner",
  });
  await expect(
    other.projectTransferReview({
      workspaceId: "alpha",
      reviewId: review.reviewId,
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await location(fields.projectId)).toBe("alpha");
});

it("does not apply an expired review or overwrite a destination name conflict", async () => {
  const { fields } = await create();
  const review = await plan(fields);
  const future = new WorkspaceService(
    bindings,
    owner,
    false,
    () => Date.now() + TRANSFER_LIMITS.REVIEW_TTL_MS + 1000,
  );
  await expect(
    future.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: review.fingerprint,
    }),
  ).rejects.toMatchObject({ code: "transfer_conflict" });
  await service.createProject({
    workspaceId: "beta",
    name: "Service",
    description: "Existing",
  });
  expect(
    (await service.projectTransferPreview(fields)).blockers.some(
      (issue) => issue.code === "project_name_conflict",
    ),
  ).toBe(true);
  expect(await location(fields.projectId)).toBe("alpha");
});

it("rolls back all metadata and the receipt if a later statement fails", async () => {
  const { fields } = await create();
  const review = await plan(fields);
  const before = (await db.prepare("SELECT * FROM activity ORDER BY id").all())
    .results;
  await db
    .prepare(
      "CREATE TRIGGER fail_transfer_repository BEFORE UPDATE OF workspace_id ON repositories WHEN OLD.workspace_id<>NEW.workspace_id BEGIN SELECT RAISE(ABORT,'Synthetic transfer failure'); END",
    )
    .run();
  await expect(
    service.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: review.fingerprint,
    }),
  ).rejects.toThrow(/Synthetic transfer failure/);
  expect(await location(fields.projectId)).toBe("alpha");
  expect(
    (
      await service.projectTransferReview({
        workspaceId: "alpha",
        reviewId: review.reviewId,
      })
    ).receipt,
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS total FROM departed_resource_context")
      .first("total"),
  ).toBe(0);
  expect(
    (await db.prepare("SELECT * FROM activity ORDER BY id").all()).results,
  ).toEqual(before);
});

it("serializes simultaneous applications into one original receipt", async () => {
  const { fields } = await create();
  const review = await plan(fields);
  const input = {
    workspaceId: "alpha",
    reviewId: review.reviewId,
    fingerprint: review.fingerprint,
  };
  const receipts = await Promise.all([
    service.projectTransferApply(input),
    service.projectTransferApply(input),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS total FROM activity WHERE type LIKE 'project.transfer.%'",
      )
      .first("total"),
  ).toBe(2);
});

it("retains both workspaces' history through a move back and preserves the first receipt", async () => {
  const { fields } = await create();
  const first = await plan(fields);
  const command = {
    workspaceId: "alpha",
    reviewId: first.reviewId,
    fingerprint: first.fingerprint,
  };
  const receipt = await service.projectTransferApply(command);
  const reverse = await apply({
    ...fields,
    workspaceId: "beta",
    destinationWorkspaceId: "alpha",
    projectRevision: receipt.projectRevision,
  });
  expect(reverse.projectRevision).toBe(receipt.projectRevision + 1);
  expect(await service.projectTransferApply(command)).toEqual(receipt);
  expect(await location(fields.projectId)).toBe("alpha");
  expect(
    await service.departedResourceContext({
      workspaceId: "alpha",
      kind: "project",
      resourceId: fields.projectId,
    }),
  ).toBeNull();
  expect(
    await service.departedResourceContext({
      workspaceId: "beta",
      kind: "project",
      resourceId: fields.projectId,
    }),
  ).toMatchObject({
    name: "Service",
    historyPolicy: "original-workspace-only",
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("keeps a live workspace-admin credential inside its original workspace", async () => {
  const { fields } = await create();
  const scopes = [CAPABILITY.READ, CAPABILITY.ADMIN];
  await db
    .prepare(
      "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('admin','alpha','owner','Scoped admin','fixture',?,?,?)",
    )
    .bind(
      JSON.stringify(scopes),
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
  const scoped = new WorkspaceService(bindings, {
    ...owner,
    workspaceId: "alpha",
    tokenId: "admin",
    scopes,
  });
  expect(
    await scoped.projectTransferDestinations({ workspaceId: "alpha" }),
  ).toEqual({ workspaces: [], restriction: "workspace-credential" });
  await expect(scoped.projectTransferPreview(fields)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    plan({
      ...fields,
      sourceBindings: [
        { sourceId: "unrelated", destinationSourceId: "unknown" },
      ],
    }),
  ).rejects.toMatchObject({ code: "transfer_blocked" });
  expect(await location(fields.projectId)).toBe("alpha");
});

it("clears descriptive connection context without moving or activating its authority", async () => {
  const { fields } = await create(false);
  await db
    .prepare(
      "INSERT INTO connections(workspace_id,id,name,provider,enabled,configuration_json) VALUES ('alpha','context-only','Connection context','local',0,?)",
    )
    .bind(
      JSON.stringify({
        projectId: fields.projectId,
        credentialRef: "source-owned-reference",
      }),
    )
    .run();
  const preview = await service.projectTransferPreview(fields);
  expect(preview.clearConnectionContext).toEqual([
    expect.objectContaining({ id: "context-only" }),
  ]);
  await apply(fields);
  const connection = await db
    .prepare(
      "SELECT workspace_id,enabled,configuration_json,revision FROM connections WHERE id='context-only'",
    )
    .first();
  expect(connection).toMatchObject({
    workspace_id: "alpha",
    enabled: 0,
    revision: 2,
  });
  expect(JSON.parse(connection!.configuration_json as string)).toEqual({
    projectId: null,
    credentialRef: "source-owned-reference",
  });
  expect(JSON.stringify(preview)).not.toContain("source-owned-reference");
});

it("refuses a newly associated resource discovered between preview and commit", async () => {
  const { fields } = await create();
  await db
    .prepare(
      "INSERT INTO connections(workspace_id,id,name,provider) VALUES ('alpha','late-hooks','Late hooks','hookrelay')",
    )
    .run();
  const review = await plan(fields);
  const batch = db.batch.bind(db);
  let calls = 0;
  vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    if (++calls === 2)
      await db
        .prepare(
          "INSERT INTO hook_associations(workspace_id,connection_id,subscription,project_id,revision,write_id) VALUES ('alpha','late-hooks','late',?,1,'seed')",
        )
        .bind(fields.projectId)
        .run();
    return batch(statements);
  });
  await expect(
    service.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: review.fingerprint,
    }),
  ).rejects.toMatchObject({ code: "transfer_conflict" });
  expect(await location(fields.projectId)).toBe("alpha");
  expect(
    await db
      .prepare("SELECT receipt_json FROM project_transfer_reviews WHERE id=?")
      .bind(review.reviewId)
      .first("receipt_json"),
  ).toBeNull();
});

it("rechecks destination authority inside the committing batch", async () => {
  const { fields } = await create();
  const review = await plan(fields);
  const batch = db.batch.bind(db);
  let calls = 0;
  vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    calls++;
    if (calls === 2)
      await db
        .prepare(
          "UPDATE members SET role='viewer',revision=revision+1 WHERE workspace_id='beta' AND subject='owner'",
        )
        .run();
    return batch(statements);
  });
  await expect(
    service.projectTransferApply({
      workspaceId: "alpha",
      reviewId: review.reviewId,
      fingerprint: review.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(2);
  expect(await location(fields.projectId)).toBe("alpha");
  expect(
    await db
      .prepare("SELECT receipt_json FROM project_transfer_reviews WHERE id=?")
      .bind(review.reviewId)
      .first("receipt_json"),
  ).toBeNull();
});

it("shows pending invitations and credential access without exposing bearer material", async () => {
  const { fields } = await create();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO invitations(id,workspace_id,email,role,inviter_subject,duration_days,created_at,expires_at,state,write_id) VALUES ('invite','beta','invited@example.test','operator','owner',1,?,?,'pending','seed')",
      )
      .bind(new Date().toISOString(), expires),
    db
      .prepare(
        "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at,automation_profile) VALUES ('reader','beta','owner','Destination reader','PRIVATE-HASH',?, ?,?,'reader')",
      )
      .bind(
        JSON.stringify([CAPABILITY.READ]),
        new Date().toISOString(),
        expires,
      ),
  ]);
  const preview = await service.projectTransferPreview(fields);
  expect(preview.invitations).toEqual([
    expect.objectContaining({
      workspaceId: "beta",
      email: "invited@example.test",
      role: "operator",
    }),
  ]);
  expect(preview.credentials).toEqual([
    expect.objectContaining({
      workspaceId: "beta",
      name: "Destination reader",
      scopes: [CAPABILITY.READ],
    }),
  ]);
  expect(JSON.stringify(preview)).not.toContain("PRIVATE-HASH");
});

it.each([
  "hookrelay.delivery.retry",
  "hookrelay.subscription.policy",
  HOOK_SETUP_KIND,
])(
  "blocks live %s reviews and unresolved operations",
  async (kind) => {
    const { fields } = await create();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db
      .prepare(
        "INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) VALUES ('provider-review','alpha','owner',?,?,'fixture',?,?)",
      )
      .bind(
        kind,
        JSON.stringify({ connectionId: "provider-hooks" }),
        new Date().toISOString(),
        expires,
      )
      .run();
    expect(
      (await service.projectTransferPreview(fields)).blockers.some(
        (issue) => issue.code === "provider_review_pending",
      ),
    ).toBe(true);
    await db.batch([
      db.prepare(
        "INSERT INTO connections(id,workspace_id,name,provider) VALUES ('provider-hooks','alpha','Synthetic hooks','hookrelay')",
      ),
      db
        .prepare(
          "UPDATE action_plans SET applied_at=? WHERE id='provider-review'",
        )
        .bind(new Date().toISOString()),
      db
        .prepare(
          "INSERT INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at) VALUES ('uncertain','alpha','provider-review','owner',?,'indeterminate','Inspect provider receipt',?,?)",
        )
        .bind(kind, new Date().toISOString(), new Date().toISOString()),
    ]);
    expect(
      (await service.projectTransferPreview(fields)).blockers.some(
        (issue) => issue.code === "provider_operation_unresolved",
      ),
    ).toBe(true);
  },
);

it("blocks retained secret custody without reading or copying its private payload", async () => {
  const { fields } = await create();
  const now = new Date().toISOString();
  const expired = new Date(Date.now() - 1000).toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO secret_reviews(workspace_id,id,actor_subject,actor_name,member_revision,request_json,request_hash,captured_json,draft_fingerprint,stage,created_at,expires_at,input_expires_at,write_id) VALUES ('alpha','secret-review','owner','Owner',1,'{}','fixture','{}','fixture','cancelled',?,?,?,'seed')",
      )
      .bind(now, expired, expired),
    db.prepare(
      "INSERT INTO secret_payloads VALUES ('alpha','secret-review',0,'PRIVATE-SEALED-PAYLOAD')",
    ),
  ]);
  const preview = await service.projectTransferPreview(fields);
  expect(
    preview.blockers.some((issue) => issue.code === "secret_custody"),
  ).toBe(true);
  expect(JSON.stringify(preview)).not.toContain("PRIVATE-SEALED-PAYLOAD");
  await expect(plan(fields)).rejects.toMatchObject({
    code: "transfer_blocked",
  });
  expect(
    await db
      .prepare(
        "SELECT ciphertext FROM secret_payloads WHERE review_id='secret-review'",
      )
      .first("ciphertext"),
  ).toBe("PRIVATE-SEALED-PAYLOAD");
});

it("blocks project transfers that would orphan managed destinations", async () => {
  const { fields } = await create();
  const [repository] = await service.repositories({ workspaceId: "alpha" });
  const review = await plan(fields);
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO secret_connections(workspace_id,id,name,provider_kind,credential_ref,resources_json,enabled,revision,write_id) VALUES ('alpha','managed-github','GitHub','github-actions','credential','[]',1,1,'seed')",
      ),
    db
      .prepare(
        "INSERT INTO managed_configurations(workspace_id,id,label,entry_kind,custody,desired_value,state,revision,created_at,updated_at,write_id) VALUES ('alpha','managed-variable','Runtime mode','variable','none','production','active',1,?,?, 'seed')",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO managed_configuration_destinations(workspace_id,configuration_id,destination_index,destination_key,entry_kind,provider_kind,connection_id,resource_id,scope_kind,scope_name,provider_name,desired_state) VALUES ('alpha','managed-variable',0,?,'variable','github-actions','managed-github',?,'repository','','RUNTIME_MODE','present')",
      )
      .bind(
        managedDestinationKey("github-actions", "variable", {
          connectionId: "managed-github",
          connectionRevision: 1,
          target: { resourceId: repository.id, scope: { kind: "repository" } },
          name: "RUNTIME_MODE",
        }),
        repository.id,
      ),
  ]);
  expect(
    (
      await service.projectTransferReview({
        workspaceId: "alpha",
        reviewId: review.reviewId,
      })
    ).state,
  ).toBe("stale");
  const preview = await service.projectTransferPreview(fields);
  expect(
    preview.blockers.some(
      (issue) => issue.code === "managed_configuration_active",
    ),
  ).toBe(true);
  await expect(plan(fields)).rejects.toMatchObject({
    code: "transfer_blocked",
  });
});

it("uses identical MCP review/apply semantics and publishes both workspace updates", async () => {
  const { fields } = await create(false);
  const published: string[] = [];
  const appBindings = {
    ...bindings,
    WORKSPACE_EVENTS: {
      getByName: (id: string) => ({
        publish: async () => {
          published.push(id);
        },
      }),
    },
  } as unknown as Env;
  const app = createApplication(async () => owner);
  async function rpc(name: string, args: unknown) {
    const response = await app.fetch(
      new Request("https://hq.example/mcp", {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      appBindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).not.toBe(true);
    return JSON.parse(body.result.content[0].text);
  }
  const review = await rpc("project_transfer_plan", {
    ...fields,
    reviewId: crypto.randomUUID(),
  });
  published.length = 0;
  const receipt = await rpc("project_transfer_apply", {
    workspaceId: "alpha",
    reviewId: review.reviewId,
    fingerprint: review.fingerprint,
  });
  expect(receipt).toMatchObject({
    status: "succeeded",
    sourceWorkspaceId: "alpha",
    destinationWorkspaceId: "beta",
  });
  expect(published.sort()).toEqual(["alpha", "beta"]);
});
