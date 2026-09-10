import {
  CAPABILITY,
  LIMITS,
  workspaceInput,
  type Capability,
  type Principal,
  type Workspace,
} from "../shared/domain";
import {
  IMPORT_LIMITS,
  importApplyInput,
  importPlanInput,
  type ImportPlan,
  type ImportReceipt,
  type ImportStatus,
} from "../shared/import";
import { credentialHash } from "./credential-hash";
import { membershipActorGuard } from "./membership-authority";
import { DomainError } from "./errors";

type Context = {
  db: D1Database;
  principal: Principal;
  now: () => number;
  authorize: (
    workspaceId: string,
    capability?: Capability,
  ) => Promise<Workspace>;
};
type Reviewed = {
  fields: ReturnType<typeof importPlanInput.parse>;
  memberRevision: number;
  tokenId: string | null;
};
const PLAN_KIND = "metadata.import";
const RECEIPT_FIELDS =
  "plan_id AS planId, fingerprint, source_label AS sourceLabel, project_count AS projectCount, repository_count AS repositoryCount, applied_at AS appliedAt";

export class ImportService {
  constructor(readonly context: Context) {}
  get db() {
    return this.context.db;
  }
  get principal() {
    return this.context.principal;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private async admin(workspaceId: string) {
    await this.context.authorize(workspaceId, CAPABILITY.READ);
    await this.context.authorize(workspaceId, CAPABILITY.EDIT);
    return this.context.authorize(workspaceId, CAPABILITY.ADMIN);
  }
  private guard(workspaceId: string) {
    const actor = membershipActorGuard(
      workspaceId,
      this.principal.subject,
      this.principal.tokenId ?? null,
      this.timestamp(),
    );
    return {
      sql: `${actor.sql} AND (? IS NULL OR EXISTS (SELECT 1 FROM credentials c, json_each(c.scopes_json) s WHERE c.id=? AND s.value=?))`,
      values: [
        ...actor.values,
        this.principal.tokenId ?? null,
        this.principal.tokenId ?? null,
        CAPABILITY.EDIT,
      ],
    };
  }
  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "Import could not be confirmed: the review expired, access changed, or this workspace is no longer empty. Refresh import status before reviewing again.",
      409,
    );
  }
  private receipt(workspaceId: string) {
    const guard = this.guard(workspaceId);
    return this.db
      .prepare(
        `SELECT ${RECEIPT_FIELDS} FROM metadata_imports WHERE workspace_id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, ...guard.values)
      .first<ImportReceipt>();
  }
  async status(input: unknown): Promise<ImportStatus> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.admin(workspaceId);
    const guard = this.guard(workspaceId);
    const authorized = await this.db
      .prepare(
        `SELECT
          (SELECT count(*) FROM projects WHERE workspace_id=?) AS projectCount,
          (SELECT count(*) FROM repositories WHERE workspace_id=?) AS repositoryCount
        WHERE ${guard.sql}`,
      )
      .bind(workspaceId, workspaceId, ...guard.values)
      .first<{ projectCount: number; repositoryCount: number }>();
    if (!authorized) this.conflict();
    return { ...authorized, receipt: await this.receipt(workspaceId) };
  }
  async plan(input: unknown): Promise<ImportPlan> {
    const fields = importPlanInput.parse(input);
    fields.manifest.projects.sort((a, b) =>
      a.key.localeCompare(b.key, "en"),
    );
    fields.manifest.repositories.sort((a, b) =>
      a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase(), "en"),
    );
    const { workspaceId } = fields;
    const workspace = await this.admin(workspaceId);
    const member = await this.db
      .prepare(
        "SELECT revision FROM members WHERE workspace_id=? AND subject=?",
      )
      .bind(workspaceId, this.principal.subject)
      .first<{ revision: number }>();
    if (!member) this.conflict();
    const reviewed: Reviewed = {
      fields,
      memberRevision: member.revision,
      tokenId: this.principal.tokenId ?? null,
    };
    const serialized = JSON.stringify(reviewed);
    const fingerprint = await credentialHash(serialized);
    const planId = crypto.randomUUID();
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + LIMITS.PLAN_TTL_MS,
    ).toISOString();
    const guard = this.guard(workspaceId);
    const result = await this.db
      .prepare(
        `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
      AND EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND revision=?)
      AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=?)
      AND NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id=?)
      AND NOT EXISTS (SELECT 1 FROM metadata_imports WHERE workspace_id=?)
      AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?) < ?`,
      )
      .bind(
        planId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        serialized,
        fingerprint,
        createdAt,
        expiresAt,
        ...guard.values,
        workspaceId,
        this.principal.subject,
        member.revision,
        workspaceId,
        workspaceId,
        workspaceId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        createdAt,
        IMPORT_LIMITS.PENDING_PLANS,
      )
      .run();
    if (!result.meta.changes) this.conflict();
    return {
      ...fields,
      planId,
      fingerprint,
      expiresAt,
      workspaceName: workspace.name,
      actor: this.principal.displayName,
    };
  }
  async apply(input: unknown): Promise<ImportReceipt> {
    const { workspaceId, planId, fingerprint } = importApplyInput.parse(input);
    await this.admin(workspaceId);
    const plan = await this.db
      .prepare(
        "SELECT input_json AS input, expires_at AS expiresAt FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND fingerprint=?",
      )
      .bind(planId, workspaceId, this.principal.subject, PLAN_KIND, fingerprint)
      .first<{ input: string; expiresAt: string }>();
    if (!plan) this.conflict();
    const reviewed = JSON.parse(plan.input) as Reviewed;
    const fields = importPlanInput.parse(reviewed.fields);
    if (
      fields.workspaceId !== workspaceId ||
      reviewed.tokenId !== (this.principal.tokenId ?? null) ||
      (await credentialHash(plan.input)) !== fingerprint
    )
      this.conflict();
    const guard = this.guard(workspaceId);
    const member = await this.db
      .prepare(
        `SELECT 1 AS allowed FROM members WHERE workspace_id=? AND subject=? AND revision=? AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        this.principal.subject,
        reviewed.memberRevision,
        ...guard.values,
      )
      .first();
    if (!member) this.conflict();
    const prior = await this.receipt(workspaceId);
    if (prior) {
      if (prior.planId !== planId || prior.fingerprint !== fingerprint)
        this.conflict();
      return prior;
    }
    if (Date.parse(plan.expiresAt) <= this.context.now()) this.conflict();
    const writeId = crypto.randomUUID();
    const appliedAt = this.timestamp();
    const projects = fields.manifest.projects.map((project) => ({
      ...project,
      id: crypto.randomUUID(),
    }));
    const projectIds = new Map(
      projects.map((project) => [project.key, project.id]),
    );
    const repositories = fields.manifest.repositories.map((repository) => ({
      ...repository,
      id: crypto.randomUUID(),
      projectId: projectIds.get(repository.projectKey)!,
    }));
    const eventId = crypto.randomUUID();
    const written =
      "EXISTS (SELECT 1 FROM metadata_imports WHERE workspace_id=? AND write_id=?)";
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO metadata_imports (workspace_id,plan_id,fingerprint,source_label,project_count,repository_count,applied_at,write_id)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND revision=?)
        AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND fingerprint=? AND input_json=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))
        AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=?)
        AND NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id=?)
        ON CONFLICT (workspace_id) DO NOTHING`,
        )
        .bind(
          workspaceId,
          planId,
          fingerprint,
          fields.manifest.sourceLabel,
          fields.manifest.projects.length,
          fields.manifest.repositories.length,
          appliedAt,
          writeId,
          ...guard.values,
          workspaceId,
          this.principal.subject,
          reviewed.memberRevision,
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          fingerprint,
          plan.input,
          appliedAt,
          workspaceId,
          workspaceId,
        ),
      this.db
        .prepare(
          `INSERT INTO projects (id,workspace_id,name,description,lifecycle,importance,importance_note,portfolio_json,revision,updated_at,write_id)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.description'),json_extract(value,'$.lifecycle'),json_extract(value,'$.importance'),json_extract(value,'$.importanceNote'),json_extract(value,'$.portfolio'),1,?,?
        FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          appliedAt,
          writeId,
          JSON.stringify(projects),
          workspaceId,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.fullName'),json_extract(value,'$.description'),json_extract(value,'$.projectId'),json_extract(value,'$.classification'),json_extract(value,'$.lifecycle'),json_extract(value,'$.expectations'),?,?
        FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          appliedAt,
          writeId,
          JSON.stringify(repositories),
          workspaceId,
          writeId,
        ),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE id=? AND ${written}`,
        )
        .bind(appliedAt, planId, workspaceId, writeId),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${written}`,
        )
        .bind(
          eventId,
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          "metadata.imported",
          "Project metadata imported",
          `${fields.manifest.projects.length} projects and ${fields.manifest.repositories.length} repositories from ${fields.manifest.sourceLabel}. No credentials, members, sources, or health observations were imported.`,
          appliedAt,
          workspaceId,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_project_links(workspace_id,event_id,project_id)
        SELECT ?,?,json_extract(value,'$.id') FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          eventId,
          JSON.stringify(projects),
          workspaceId,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT ?,?,json_extract(value,'$.id') FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          eventId,
          JSON.stringify(repositories),
          workspaceId,
          writeId,
        ),
    ]);
    const receipt = await this.receipt(workspaceId);
    if (
      !receipt ||
      receipt.planId !== planId ||
      receipt.fingerprint !== fingerprint
    )
      this.conflict();
    return receipt;
  }
}
