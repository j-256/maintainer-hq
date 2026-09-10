import { CAPABILITY, type Project } from "../shared/domain";
import {
  TRANSFER_LIMITS,
  TRANSFER_VERSION,
  departedResourceInput,
  projectTransferApplyInput,
  projectTransferPlanInput,
  projectTransferPreviewInput,
  projectTransferReviewInput,
  type DepartedResourceContext,
  type TransferFields,
  type TransferPreview,
  type TransferReceipt,
  type TransferReview,
} from "../shared/project-transfers";
import { DomainError } from "./errors";
import { credentialHash } from "./credential-hash";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  buildTransferPreview,
  transferClocks,
  transferConflict,
  transferDestinations,
  transferOwner,
} from "./transfer-preview";
import type { WorkspaceService } from "./service";

type ReviewRow = {
  id: string;
  workspace_id: string;
  destination_workspace_id: string;
  project_id: string;
  actor_subject: string;
  actor_token_id: string | null;
  request_json: string;
  snapshot_json: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  receipt_json: string | null;
};
const REVIEW_COLUMNS =
  "id,workspace_id,destination_workspace_id,project_id,actor_subject,actor_token_id,request_json,snapshot_json,fingerprint,created_at,expires_at,applied_at,receipt_json";

export class ProjectTransfers {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  destinations(input: unknown) {
    return transferDestinations(this.context, input);
  }
  preview(input: unknown) {
    return buildTransferPreview(this.context, input);
  }
  private guard(
    fields: TransferFields,
    revisions: TransferPreview["revisions"],
  ) {
    const source = hookActorGuard(
      this.context,
      fields.workspaceId,
      CAPABILITY.ADMIN,
    );
    const destination = hookActorGuard(
      this.context,
      fields.destinationWorkspaceId,
      CAPABILITY.ADMIN,
    );
    return {
      sql: `${source.sql} AND ${destination.sql}
        AND EXISTS(SELECT 1 FROM workspace_transfer_clock WHERE workspace_id=? AND revision=?)
        AND EXISTS(SELECT 1 FROM workspace_transfer_clock WHERE workspace_id=? AND revision=?)`,
      values: [
        ...source.values,
        ...destination.values,
        fields.workspaceId,
        revisions.source,
        fields.destinationWorkspaceId,
        revisions.destination,
      ],
    };
  }
  private fingerprint(
    reviewId: string,
    fields: TransferFields,
    preview: TransferPreview,
    actorSubject = this.context.principal.subject,
    actorTokenId = this.context.principal.tokenId ?? null,
  ) {
    return credentialHash(
      JSON.stringify({
        version: TRANSFER_VERSION,
        reviewId,
        actorSubject,
        actorTokenId,
        fields,
        preview,
      }),
    );
  }
  private async row(workspaceId: string, reviewId: string): Promise<ReviewRow> {
    await transferOwner(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM project_transfer_reviews WHERE workspace_id=? AND id=? AND actor_subject=?`,
      )
      .bind(workspaceId, reviewId, this.context.principal.subject)
      .first<ReviewRow>();
    if (!row)
      throw new DomainError("not_found", "Transfer review not found", 404);
    await transferOwner(this.context, row.destination_workspace_id);
    if (row.actor_token_id !== (this.context.principal.tokenId ?? null))
      transferConflict();
    return row;
  }
  private async contents(row: ReviewRow) {
    const fields = projectTransferPreviewInput.parse(
      JSON.parse(row.request_json),
    );
    const preview = JSON.parse(row.snapshot_json) as TransferPreview;
    if (
      fields.workspaceId !== row.workspace_id ||
      fields.destinationWorkspaceId !== row.destination_workspace_id ||
      fields.projectId !== row.project_id ||
      preview.version !== TRANSFER_VERSION ||
      !preview.ready ||
      preview.blockers.length ||
      row.fingerprint !==
        (await this.fingerprint(
          row.id,
          fields,
          preview,
          row.actor_subject,
          row.actor_token_id,
        ))
    )
      transferConflict();
    return { fields, preview };
  }
  async get(input: unknown): Promise<TransferReview> {
    const { workspaceId, reviewId } = projectTransferReviewInput.parse(input);
    const row = await this.row(workspaceId, reviewId);
    const { fields, preview } = await this.contents(row);
    const clocks = await transferClocks(
      this.context,
      fields.workspaceId,
      fields.destinationWorkspaceId,
    );
    const receipt = row.receipt_json
      ? (JSON.parse(row.receipt_json) as TransferReceipt)
      : null;
    await transferOwner(this.context, fields.workspaceId);
    await transferOwner(this.context, fields.destinationWorkspaceId);
    return {
      reviewId: row.id,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actor: this.context.principal.displayName,
      fields,
      preview,
      state: receipt
        ? "applied"
        : Date.parse(row.expires_at) <= this.context.now()
          ? "expired"
          : clocks.source !== preview.revisions.source ||
              clocks.destination !== preview.revisions.destination
            ? "stale"
            : "reviewed",
      receipt,
    };
  }
  async plan(input: unknown): Promise<TransferReview> {
    const { reviewId, ...fields } = projectTransferPlanInput.parse(input);
    await transferOwner(this.context, fields.workspaceId);
    await transferOwner(this.context, fields.destinationWorkspaceId);
    const existing = await this.db
      .prepare(
        "SELECT id,request_json,actor_subject,actor_token_id FROM project_transfer_reviews WHERE id=?",
      )
      .bind(reviewId)
      .first<
        Pick<
          ReviewRow,
          "id" | "request_json" | "actor_subject" | "actor_token_id"
        >
      >();
    if (existing) {
      if (
        existing.actor_subject !== this.context.principal.subject ||
        existing.actor_token_id !== (this.context.principal.tokenId ?? null) ||
        existing.request_json !== JSON.stringify(fields)
      )
        transferConflict();
      return this.get({ workspaceId: fields.workspaceId, reviewId });
    }
    const preview = await this.preview(fields);
    if (!preview.ready)
      throw new DomainError(
        "transfer_blocked",
        "Resolve every blocker in the transfer preview before creating a confirmation plan. No metadata was moved.",
        409,
      );
    const guard = this.guard(fields, preview.revisions);
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + TRANSFER_LIMITS.REVIEW_TTL_MS,
    ).toISOString();
    const fingerprint = await this.fingerprint(reviewId, fields, preview);
    const result = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM project_transfer_reviews WHERE workspace_id=? AND actor_subject=? AND applied_at IS NULL AND expires_at<? AND ${guard.sql}`,
        )
        .bind(
          fields.workspaceId,
          this.context.principal.subject,
          new Date(
            this.context.now() - TRANSFER_LIMITS.REVIEW_RETENTION_MS,
          ).toISOString(),
          ...guard.values,
        ),
      this.db
        .prepare(
          `INSERT INTO project_transfer_reviews(id,workspace_id,destination_workspace_id,project_id,actor_subject,actor_token_id,request_json,snapshot_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND (SELECT COUNT(*) FROM project_transfer_reviews WHERE workspace_id=? AND actor_subject=? AND applied_at IS NULL AND expires_at>?)<?
        AND (SELECT COUNT(*) FROM project_transfer_reviews WHERE workspace_id=?)<? ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          reviewId,
          fields.workspaceId,
          fields.destinationWorkspaceId,
          fields.projectId,
          this.context.principal.subject,
          this.context.principal.tokenId ?? null,
          JSON.stringify(fields),
          JSON.stringify(preview),
          fingerprint,
          createdAt,
          expiresAt,
          ...guard.values,
          fields.workspaceId,
          this.context.principal.subject,
          createdAt,
          TRANSFER_LIMITS.PENDING_REVIEWS,
          fields.workspaceId,
          TRANSFER_LIMITS.RETAINED_REVIEWS,
        ),
    ]);
    if (!result[1].meta.changes) {
      const saved = await this.row(fields.workspaceId, reviewId).catch(
        () => null,
      );
      if (!saved || saved.request_json !== JSON.stringify(fields))
        transferConflict();
    }
    return this.get({ workspaceId: fields.workspaceId, reviewId });
  }
  async apply(input: unknown): Promise<TransferReceipt> {
    const { workspaceId, reviewId, fingerprint } =
      projectTransferApplyInput.parse(input);
    const row = await this.row(workspaceId, reviewId);
    if (row.fingerprint !== fingerprint) transferConflict();
    const { fields, preview } = await this.contents(row);
    if (row.receipt_json)
      return JSON.parse(row.receipt_json) as TransferReceipt;
    if (Date.parse(row.expires_at) <= this.context.now()) transferConflict();
    let fresh: TransferPreview;
    try {
      fresh = await this.preview(fields);
    } catch (error) {
      const saved = await this.row(workspaceId, reviewId);
      if (saved.fingerprint === fingerprint && saved.receipt_json)
        return JSON.parse(saved.receipt_json) as TransferReceipt;
      throw error;
    }
    if (
      !fresh.ready ||
      fresh.revisions.source !== preview.revisions.source ||
      fresh.revisions.destination !== preview.revisions.destination
    )
      transferConflict();
    const guard = this.guard(fields, preview.revisions);
    const writeId = crypto.randomUUID();
    const completedAt = this.timestamp();
    const repositoryIds = preview.repositories.map(
      (repository) => repository.id,
    );
    const repositoriesJson = JSON.stringify(repositoryIds);
    const sourceIdsJson = JSON.stringify(
      preview.sources.map((source) => source.id),
    );
    const destinationIdsJson = JSON.stringify([
      ...new Set(
        fields.sourceBindings.map((binding) => binding.destinationSourceId),
      ),
    ]);
    const destination = fields.destinationWorkspaceId;
    const receipt: TransferReceipt = {
      reviewId,
      projectId: fields.projectId,
      sourceWorkspaceId: workspaceId,
      destinationWorkspaceId: destination,
      projectRevision: preview.project.revision + 1,
      repositoryIds,
      completedAt,
      status: "succeeded",
    };
    const claimed =
      "EXISTS(SELECT 1 FROM project_transfer_reviews WHERE id=? AND write_id=? AND applied_at IS NOT NULL)";
    const claimValues = [reviewId, writeId];
    const statements = [
      this.db.prepare("PRAGMA defer_foreign_keys = ON"),
      this.db
        .prepare(
          `UPDATE project_transfer_reviews SET applied_at=?,receipt_json=?,write_id=? WHERE id=? AND workspace_id=? AND destination_workspace_id=? AND actor_subject=? AND actor_token_id IS ? AND fingerprint=? AND applied_at IS NULL
        AND expires_at>? AND julianday(expires_at)>julianday('now') AND request_json=? AND snapshot_json=? AND ${guard.sql}
        AND EXISTS(SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND revision=?)`,
        )
        .bind(
          completedAt,
          JSON.stringify(receipt),
          writeId,
          reviewId,
          workspaceId,
          destination,
          this.context.principal.subject,
          this.context.principal.tokenId ?? null,
          fingerprint,
          completedAt,
          row.request_json,
          row.snapshot_json,
          ...guard.values,
          workspaceId,
          fields.projectId,
          fields.projectRevision,
        ),
      this.db
        .prepare(
          `INSERT INTO departed_resource_context(workspace_id,kind,resource_id,name,project_id,moved_at,transfer_id)
        SELECT workspace_id,'project',id,name,id,?,? FROM projects WHERE workspace_id=? AND id=? AND ${claimed}
        ON CONFLICT(workspace_id,kind,resource_id) DO UPDATE SET name=excluded.name,project_id=excluded.project_id,moved_at=excluded.moved_at,transfer_id=excluded.transfer_id`,
        )
        .bind(
          completedAt,
          reviewId,
          workspaceId,
          fields.projectId,
          ...claimValues,
        ),
      this.db
        .prepare(
          `INSERT INTO departed_resource_context(workspace_id,kind,resource_id,name,project_id,moved_at,transfer_id)
        SELECT workspace_id,'repository',id,full_name,project_id,?,? FROM repositories WHERE workspace_id=? AND project_id=? AND ${claimed}
        ON CONFLICT(workspace_id,kind,resource_id) DO UPDATE SET name=excluded.name,project_id=excluded.project_id,moved_at=excluded.moved_at,transfer_id=excluded.transfer_id`,
        )
        .bind(
          completedAt,
          reviewId,
          workspaceId,
          fields.projectId,
          ...claimValues,
        ),
      this.db
        .prepare(
          `DELETE FROM source_repositories WHERE workspace_id=? AND repository_id IN (SELECT value FROM json_each(?)) AND ${claimed}`,
        )
        .bind(workspaceId, repositoriesJson, ...claimValues),
      this.db
        .prepare(
          `UPDATE connections SET revision=revision+1,write_id=?,enabled=CASE WHEN EXISTS(SELECT 1 FROM source_repositories s WHERE s.workspace_id=connections.workspace_id AND s.source_id=connections.id) THEN enabled ELSE 0 END,
        next_refresh_at=CASE WHEN EXISTS(SELECT 1 FROM source_repositories s WHERE s.workspace_id=connections.workspace_id AND s.source_id=connections.id) THEN next_refresh_at ELSE NULL END
        WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?)) AND ${claimed}`,
        )
        .bind(writeId, workspaceId, sourceIdsJson, ...claimValues),
      this.db
        .prepare(
          `UPDATE connections SET configuration_json=json_set(configuration_json,'$.projectId',NULL),revision=revision+1,write_id=? WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?)) AND ${claimed}`,
        )
        .bind(
          writeId,
          workspaceId,
          JSON.stringify(
            preview.clearConnectionContext.map((connection) => connection.id),
          ),
          ...claimValues,
        ),
      this.db
        .prepare(
          `UPDATE projects SET workspace_id=?,revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id=? AND ${claimed}`,
        )
        .bind(
          destination,
          completedAt,
          writeId,
          workspaceId,
          fields.projectId,
          ...claimValues,
        ),
      this.db
        .prepare(
          `UPDATE repositories SET workspace_id=?,revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND project_id=? AND ${claimed}`,
        )
        .bind(
          destination,
          completedAt,
          writeId,
          workspaceId,
          fields.projectId,
          ...claimValues,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO source_repositories(workspace_id,source_id,repository_id)
        SELECT ?,json_extract(source.value,'$.destinationSourceId'),repository.value FROM json_each(?) source,json_each(source.value,'$.repositoryIds') repository WHERE ${claimed}`,
        )
        .bind(destination, JSON.stringify(preview.sources), ...claimValues),
      this.db
        .prepare(
          `UPDATE connections SET revision=revision+1,write_id=? WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?)) AND ${claimed}`,
        )
        .bind(writeId, destination, destinationIdsJson, ...claimValues),
    ];
    for (const [auditWorkspace, direction] of [
      [workspaceId, "out"],
      [destination, "in"],
    ] as const) {
      const eventId = reviewId + "_" + direction;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${claimed}`,
          )
          .bind(
            eventId,
            auditWorkspace,
            this.context.principal.subject,
            this.context.principal.displayName,
            "project.transfer." + direction,
            direction === "out"
              ? "Project moved out of this workspace"
              : "Project moved into this workspace",
            preview.project.name +
              " and its repository metadata moved with stable identities. Provider credentials and prior history remain in their original workspace.",
            fields.projectId,
            completedAt,
            ...claimValues,
          ),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id) SELECT ?,?,? WHERE ${claimed}`,
          )
          .bind(auditWorkspace, eventId, fields.projectId, ...claimValues),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity_repository_links(workspace_id,event_id,repository_id) SELECT ?,?,value FROM json_each(?) WHERE ${claimed}`,
          )
          .bind(auditWorkspace, eventId, repositoriesJson, ...claimValues),
      );
    }
    const result = await this.db.batch(statements);
    if (!result[1].meta.changes) {
      const saved = await this.row(workspaceId, reviewId);
      if (saved.fingerprint === fingerprint && saved.receipt_json)
        return JSON.parse(saved.receipt_json) as TransferReceipt;
      transferConflict();
    }
    await transferOwner(this.context, workspaceId);
    await transferOwner(this.context, destination);
    return receipt;
  }
  async departed(input: unknown): Promise<DepartedResourceContext | null> {
    const { workspaceId, kind, resourceId } =
      departedResourceInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const table = kind === "project" ? "projects" : "repositories";
    const guard = hookActorGuard(this.context, workspaceId);
    const result = await this.db
      .prepare(
        `SELECT kind,resource_id AS resourceId,name,project_id AS projectId,moved_at AS movedAt FROM departed_resource_context
      WHERE workspace_id=? AND kind=? AND resource_id=? AND ${guard.sql} AND NOT EXISTS(SELECT 1 FROM ${table} WHERE workspace_id=? AND id=?)`,
      )
      .bind(
        workspaceId,
        kind,
        resourceId,
        ...guard.values,
        workspaceId,
        resourceId,
      )
      .first<Omit<DepartedResourceContext, "historyPolicy">>();
    await authorizeHooks(this.context, workspaceId);
    return result
      ? { ...result, historyPolicy: "original-workspace-only" }
      : null;
  }
  async historyProject(
    workspaceId: string,
    projectId: string,
  ): Promise<Project | DepartedResourceContext> {
    try {
      return await this.context.project({ workspaceId, projectId });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found")
        throw error;
      const departed = await this.departed({
        workspaceId,
        kind: "project",
        resourceId: projectId,
      });
      if (!departed) throw error;
      return departed;
    }
  }
}
