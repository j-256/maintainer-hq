import { CAPABILITY, LIMITS, projectFields } from "../shared/domain";
import {
  PROJECT_ORGANIZATION_LIMITS,
  changedProjectPresentation,
  projectOrganizationApplyInput,
  projectOrganizationPlanInput,
  projectOrganizationReviewInput,
  type OrganizationProject,
  type OrganizationRepository,
  type ProjectOrganizationFields,
  type ProjectOrganizationReceipt,
  type ProjectOrganizationReview,
} from "../shared/project-organization";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { PROJECT_FIELDS_SQL, projectFromRow } from "./projects";
import type { WorkspaceService } from "./service";

const PLAN_KIND = "projects.organize";
type Reviewed = {
  fields: ProjectOrganizationFields;
  repositories: OrganizationRepository[];
  projects: OrganizationProject[];
  projectVersions: { id: string; revision: number }[];
  workspaceName: string;
  actor: string;
  memberRevision: number;
  tokenId: string | null;
};
type PlanRow = { input: string; fingerprint: string; expiresAt: string };

export class ProjectOrganizationService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  get principal() {
    return this.context.principal;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "This review expired, a selected repository or project changed, or project names, capacity or workspace access changed. No organization changes were applied. Keep your choices and prepare a fresh review.",
      409,
    );
  }
  private boundary(workspaceId: string, reviewed: Reviewed) {
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      reviewed.memberRevision,
    );
    const created = reviewed.projects
      .filter((project) => !project.before)
      .map((project) => ({ id: project.projectId, name: project.after.name }));
    return {
      sql: `${guard.sql}
        AND NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN repositories r
          ON r.workspace_id=? AND r.id=json_extract(selected.value,'$.repositoryId')
          WHERE r.id IS NULL OR r.revision<>json_extract(selected.value,'$.revision') OR r.project_id IS NOT json_extract(selected.value,'$.before.id'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN projects p
          ON p.workspace_id=? AND p.id=json_extract(selected.value,'$.id')
          WHERE p.id IS NULL OR p.revision<>json_extract(selected.value,'$.revision'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) proposed JOIN projects p
          ON p.id=json_extract(proposed.value,'$.id') OR (p.workspace_id=? AND p.name=json_extract(proposed.value,'$.name')))
        AND (SELECT count(*) FROM projects WHERE workspace_id=?)+?<=?`,
      values: [
        ...guard.values,
        JSON.stringify(reviewed.repositories),
        workspaceId,
        JSON.stringify(reviewed.projectVersions),
        workspaceId,
        JSON.stringify(created),
        workspaceId,
        workspaceId,
        created.length,
        LIMITS.MAX_PROJECTS,
      ],
    };
  }
  private async matching(workspaceId: string, reviewed: Reviewed) {
    const guard = this.boundary(workspaceId, reviewed);
    return Boolean(
      await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first(),
    );
  }
  private async load(workspaceId: string, planId: string) {
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.EDIT);
    const plan = await this.db
      .prepare(
        `SELECT input_json AS input,fingerprint,expires_at AS expiresAt FROM action_plans
      WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND ${guard.sql}`,
      )
      .bind(
        planId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<PlanRow>();
    if (!plan)
      throw new DomainError(
        "not_found",
        "This organization review is not available to this workspace and identity.",
        404,
      );
    const reviewed = JSON.parse(plan.input) as Reviewed;
    projectOrganizationPlanInput.parse(reviewed.fields);
    if (
      reviewed.fields.workspaceId !== workspaceId ||
      reviewed.tokenId !== (this.principal.tokenId ?? null) ||
      (await credentialHash(plan.input)) !== plan.fingerprint
    )
      this.conflict();
    return { plan, reviewed };
  }
  private async receipt(workspaceId: string, planId: string) {
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.EDIT);
    const row = await this.db
      .prepare(
        `SELECT result_json AS result FROM operations
      WHERE workspace_id=? AND plan_id=? AND actor_subject=? AND kind=? AND status='succeeded' AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<{ result: string }>();
    return row ? (JSON.parse(row.result) as ProjectOrganizationReceipt) : null;
  }
  private async response(
    workspaceId: string,
    planId: string,
    plan: PlanRow,
    reviewed: Reviewed,
  ): Promise<ProjectOrganizationReview> {
    let receipt = await this.receipt(workspaceId, planId);
    let state: ProjectOrganizationReview["state"] = receipt
      ? "applied"
      : Date.parse(plan.expiresAt) <= this.context.now()
        ? "expired"
        : (await this.matching(workspaceId, reviewed))
          ? "ready"
          : "stale";
    if (!receipt && state !== "ready") {
      receipt = await this.receipt(workspaceId, planId);
      if (receipt) state = "applied";
    }
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    return {
      workspaceId,
      planId,
      fingerprint: plan.fingerprint,
      expiresAt: plan.expiresAt,
      workspaceName: reviewed.workspaceName,
      actor: reviewed.actor,
      fields: reviewed.fields,
      repositories: reviewed.repositories,
      projects: reviewed.projects,
      state,
      receipt,
    };
  }
  async review(input: unknown) {
    const { workspaceId, planId } = projectOrganizationReviewInput.parse(input);
    const { plan, reviewed } = await this.load(workspaceId, planId);
    return this.response(workspaceId, planId, plan, reviewed);
  }
  async plan(input: unknown) {
    const fields = projectOrganizationPlanInput.parse(input);
    const { workspaceId } = fields;
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const workspace = await this.context.authorize(
      workspaceId,
      CAPABILITY.EDIT,
    );
    fields.repositories.sort((a, b) =>
      a.repositoryId.localeCompare(b.repositoryId, "en"),
    );
    fields.targets.sort((a, b) => a.key.localeCompare(b.key, "en"));
    const authority = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const selected = await this.db
      .prepare(
        `SELECT id,full_name AS fullName,project_id AS projectId,revision FROM repositories
      WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${authority.sql}`,
      )
      .bind(
        workspaceId,
        JSON.stringify(fields.repositories),
        ...authority.values,
      )
      .all<{
        id: string;
        fullName: string;
        projectId: string | null;
        revision: number;
      }>();
    if (selected.results.length !== fields.repositories.length) this.conflict();
    const projectIds = [
      ...new Set([
        ...selected.results.flatMap((row) =>
          row.projectId ? [row.projectId] : [],
        ),
        ...fields.targets.flatMap((target) =>
          target.kind === "existing" ? [target.projectId] : [],
        ),
      ]),
    ];
    const projectRows = await this.db
      .prepare(
        `SELECT ${PROJECT_FIELDS_SQL} FROM projects WHERE workspace_id=?
      AND id IN (SELECT value FROM json_each(?)) AND ${authority.sql}`,
      )
      .bind(workspaceId, JSON.stringify(projectIds), ...authority.values)
      .all<Parameters<typeof projectFromRow>[0]>();
    const existing = projectRows.results.map(projectFromRow);
    if (existing.length !== projectIds.length) this.conflict();
    const counts = await this.db
      .prepare(
        `SELECT project_id AS id,count(*) AS total FROM repositories WHERE workspace_id=?
      AND project_id IN (SELECT value FROM json_each(?)) GROUP BY project_id`,
      )
      .bind(workspaceId, JSON.stringify(projectIds))
      .all<{ id: string; total: number }>();
    const projects = fields.targets.map((target): OrganizationProject => {
      const before =
        target.kind === "existing"
          ? existing.find((project) => project.id === target.projectId)
          : null;
      if (
        target.kind === "existing" &&
        (!before || before.revision !== target.revision)
      )
        this.conflict();
      const after = projectFields.parse(
        before
          ? {
              ...projectFields.strip().parse(before),
              ...(target.kind === "existing" ? target.patch : {}),
            }
          : {
              ...(target.kind === "new" ? target.project : {}),
              description: "",
              lifecycle: "active",
            },
      );
      return {
        key: target.key,
        projectId: before?.id ?? crypto.randomUUID(),
        before: before ?? null,
        after,
        changed: before ? changedProjectPresentation(before, after) : [],
        linkedRepositoryCount:
          counts.results.find((row) => row.id === before?.id)?.total ?? 0,
      };
    });
    const repositories = fields.repositories.map(
      (row): OrganizationRepository => {
        const before = selected.results.find(
          (repo) => repo.id === row.repositoryId,
        );
        if (!before || before.revision !== row.revision) this.conflict();
        const project = before.projectId
          ? existing.find((project) => project.id === before.projectId)!
          : null;
        const target = projects.find((target) => target.key === row.targetKey)!;
        return {
          repositoryId: before.id,
          fullName: before.fullName,
          revision: before.revision,
          before: project ? { id: project.id, name: project.name } : null,
          after: { id: target.projectId, name: target.after.name },
        };
      },
    );
    const reviewed: Reviewed = {
      fields,
      repositories,
      projects,
      projectVersions: existing.map((project) => ({
        id: project.id,
        revision: project.revision,
      })),
      workspaceName: workspace.name,
      actor: this.principal.displayName,
      memberRevision,
      tokenId: this.principal.tokenId ?? null,
    };
    const serialized = JSON.stringify(reviewed);
    if (
      new TextEncoder().encode(serialized).byteLength >
      PROJECT_ORGANIZATION_LIMITS.REVIEW_BYTES
    )
      throw new DomainError(
        "too_large",
        "Select fewer projects for this review",
        413,
      );
    const guard = this.boundary(workspaceId, reviewed);
    const planId = crypto.randomUUID(),
      fingerprint = await credentialHash(serialized);
    const createdAt = this.timestamp(),
      expiresAt = new Date(
        this.context.now() + LIMITS.PLAN_TTL_MS,
      ).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM action_plans WHERE id IN (SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=?
        AND applied_at IS NULL AND expires_at<=? AND NOT EXISTS (SELECT 1 FROM operations WHERE plan_id=action_plans.id) LIMIT ?) AND ${authority.sql}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          createdAt,
          PROJECT_ORGANIZATION_LIMITS.CLEANUP_ROWS,
          ...authority.values,
        ),
      this.db
        .prepare(
          `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
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
          PLAN_KIND,
          createdAt,
          PROJECT_ORGANIZATION_LIMITS.PENDING_PLANS,
        ),
    ]);
    if (!results[1]?.meta.changes) {
      if (!(await this.matching(workspaceId, reviewed))) this.conflict();
      throw new DomainError(
        "capacity",
        "Too many open organization reviews. Finish a review or wait for it to expire before preparing another.",
        409,
      );
    }
    return this.response(
      workspaceId,
      planId,
      { input: serialized, fingerprint, expiresAt },
      reviewed,
    );
  }
  async apply(input: unknown): Promise<ProjectOrganizationReceipt> {
    const { workspaceId, planId, fingerprint } =
      projectOrganizationApplyInput.parse(input);
    const { plan, reviewed } = await this.load(workspaceId, planId);
    if (fingerprint !== plan.fingerprint) this.conflict();
    const prior = await this.receipt(workspaceId, planId);
    if (prior) {
      await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
      return prior;
    }
    if (Date.parse(plan.expiresAt) <= this.context.now()) this.conflict();
    const guard = this.boundary(workspaceId, reviewed);
    const writeId = crypto.randomUUID(),
      appliedAt = this.timestamp();
    const projects = reviewed.projects
      .filter((project) => !project.before || project.changed.length)
      .map((project) => ({ ...project, eventId: crypto.randomUUID() }));
    const repositories = reviewed.repositories
      .filter((row) => row.before?.id !== row.after.id)
      .map((row) => ({
        ...row,
        eventId: crypto.randomUUID(),
        summary: `${row.fullName}: ${row.before?.name ?? "Unavailable project"} to ${row.after.name}. Reviewed project assignment; provider configuration and expectations are unchanged.`,
      }));
    const receipt: ProjectOrganizationReceipt = {
      workspaceId,
      planId,
      fingerprint,
      appliedAt,
      createdProjectIds: projects
        .filter((project) => !project.before)
        .map((project) => project.projectId),
      updatedProjectIds: projects
        .filter((project) => project.before)
        .map((project) => project.projectId),
      assignedRepositoryIds: repositories.map((row) => row.repositoryId),
      unchangedRepositoryIds: reviewed.repositories
        .filter((row) => row.before?.id === row.after.id)
        .map((row) => row.repositoryId),
    };
    const newJson = JSON.stringify(
      projects.filter((project) => !project.before),
    );
    const updatedJson = JSON.stringify(
      projects.filter((project) => project.before),
    );
    const repositoryJson = JSON.stringify(repositories);
    const written =
      "EXISTS (SELECT 1 FROM operations WHERE id=? AND workspace_id=? AND plan_id=? AND status='succeeded')";
    const writtenValues = [writeId, workspaceId, planId];
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
        SELECT ?,?,?,?,?,'succeeded',?,?,?,? WHERE ${guard.sql}
        AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND input_json=? AND fingerprint=? AND applied_at IS NULL
          AND expires_at>? AND julianday(expires_at)>julianday('now')) ON CONFLICT(plan_id) DO NOTHING`,
        )
        .bind(
          writeId,
          workspaceId,
          planId,
          this.principal.subject,
          PLAN_KIND,
          "Reviewed project organization",
          JSON.stringify(receipt),
          appliedAt,
          appliedAt,
          ...guard.values,
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          plan.input,
          fingerprint,
          appliedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO projects (id,workspace_id,name,description,lifecycle,importance,importance_note,portfolio_json,revision,updated_at,write_id)
        SELECT json_extract(value,'$.projectId'),?,json_extract(value,'$.after.name'),'', 'active',json_extract(value,'$.after.importance'),
          json_extract(value,'$.after.importanceNote'),json_extract(value,'$.after.portfolio'),1,?,? FROM json_each(?) WHERE ${written}`,
        )
        .bind(workspaceId, appliedAt, writeId, newJson, ...writtenValues),
      this.db
        .prepare(
          `UPDATE projects SET importance=(SELECT json_extract(value,'$.after.importance') FROM json_each(?) WHERE json_extract(value,'$.projectId')=projects.id),
        importance_note=(SELECT json_extract(value,'$.after.importanceNote') FROM json_each(?) WHERE json_extract(value,'$.projectId')=projects.id),
        portfolio_json=(SELECT json_extract(value,'$.after.portfolio') FROM json_each(?) WHERE json_extract(value,'$.projectId')=projects.id),
        revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.projectId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          updatedJson,
          updatedJson,
          updatedJson,
          appliedAt,
          writeId,
          workspaceId,
          updatedJson,
          ...writtenValues,
        ),
      this.db
        .prepare(
          `UPDATE repositories SET project_id=(SELECT json_extract(value,'$.after.id') FROM json_each(?) WHERE json_extract(value,'$.repositoryId')=repositories.id),
        revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          repositoryJson,
          appliedAt,
          writeId,
          workspaceId,
          repositoryJson,
          ...writtenValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT json_extract(value,'$.eventId'),?,?,?,CASE WHEN json_extract(value,'$.before') IS NULL THEN 'project.created' ELSE 'project.updated' END,
          CASE WHEN json_extract(value,'$.before') IS NULL THEN 'Project created' ELSE 'Project priorities updated' END,
          json_extract(value,'$.after.name')||': reviewed project organization',json_extract(value,'$.projectId'),? FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          appliedAt,
          JSON.stringify(projects),
          ...writtenValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT json_extract(value,'$.eventId'),?,?,?,'repository.updated','Repository project changed',json_extract(value,'$.summary'),json_extract(value,'$.repositoryId'),?
        FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          appliedAt,
          repositoryJson,
          ...writtenValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.repositoryId') FROM json_each(?) WHERE ${written}`,
        )
        .bind(workspaceId, repositoryJson, ...writtenValues),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
        SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.before.id') FROM json_each(?)
        WHERE json_extract(value,'$.before.id') IS NOT NULL AND ${written}`,
        )
        .bind(workspaceId, repositoryJson, ...writtenValues),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE id=? AND workspace_id=? AND ${written}`,
        )
        .bind(appliedAt, planId, workspaceId, ...writtenValues),
    ]);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    const committed = await this.receipt(workspaceId, planId);
    if (!committed) this.conflict();
    await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
    return committed;
  }
}
