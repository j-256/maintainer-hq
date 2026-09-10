import {
  CAPABILITY,
  LIMITS,
  createProjectInput,
  getProjectInput,
  projectSchema,
  updateProjectInput,
  workspaceInput,
  type Project,
  type ProjectFields,
} from "../shared/domain";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";

export const PROJECT_FIELDS_SQL =
  "id,workspace_id AS workspaceId,name,description,lifecycle,importance,importance_note AS importanceNote,portfolio_json AS portfolioJson,revision,updated_at AS updatedAt";
type ProjectRow = Omit<Project, "portfolio"> & { portfolioJson: string };
export function projectFromRow(row: ProjectRow): Project {
  const { portfolioJson, ...fields } = row;
  return projectSchema.parse({
    ...fields,
    portfolio: JSON.parse(portfolioJson),
  });
}

export class ProjectService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }

  async list(input: unknown): Promise<Project[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT ${PROJECT_FIELDS_SQL} FROM projects WHERE workspace_id=? ORDER BY name,id LIMIT ?`,
      )
      .bind(workspaceId, LIMITS.MAX_PROJECTS + 1)
      .all<ProjectRow>();
    if (rows.results.length > LIMITS.MAX_PROJECTS)
      throw new DomainError(
        "capacity",
        "Project inventory exceeds the supported workspace limit",
        409,
      );
    await authorizeHooks(this.context, workspaceId);
    return rows.results.map(projectFromRow);
  }

  async get(input: unknown): Promise<Project> {
    const { workspaceId, projectId } = getProjectInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const guard = hookActorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${PROJECT_FIELDS_SQL} FROM projects WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, projectId, ...guard.values)
      .first<ProjectRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Project not found or workspace access changed",
        404,
      );
    return projectFromRow(row);
  }

  private audit(
    workspaceId: string,
    resourceId: string,
    writeId: string,
    table: "projects" | "repositories",
    type: string,
    title: string,
    summary: string,
    timestamp: string,
  ) {
    return this.db
      .prepare(
        `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ${table} WHERE workspace_id=? AND id=? AND write_id=?)`,
      )
      .bind(
        crypto.randomUUID(),
        workspaceId,
        this.context.principal.subject,
        this.context.principal.displayName,
        type,
        title,
        summary,
        resourceId,
        timestamp,
        workspaceId,
        resourceId,
        writeId,
      );
  }

  async create(input: unknown): Promise<Project> {
    const { workspaceId, firstRepository, ...project } =
      createProjectInput.parse(input);
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const id = crypto.randomUUID();
    const writeId = crypto.randomUUID();
    const timestamp = new Date(this.context.now()).toISOString();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO projects
      (id,workspace_id,name,description,lifecycle,importance,importance_note,portfolio_json,revision,updated_at,write_id)
      SELECT ?,?,?,?,?,?,?,?,1,?,? WHERE ${guard.sql}
        AND (SELECT COUNT(*) FROM projects WHERE workspace_id=?) < ?
        AND (? IS NULL OR ((SELECT COUNT(*) FROM repositories WHERE workspace_id=?) < ?
          AND NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id=? AND full_name=?)))
      ON CONFLICT(workspace_id,name) DO NOTHING`,
        )
        .bind(
          id,
          workspaceId,
          project.name,
          project.description,
          project.lifecycle,
          project.importance,
          project.importanceNote,
          JSON.stringify(project.portfolio),
          timestamp,
          writeId,
          ...guard.values,
          workspaceId,
          LIMITS.MAX_PROJECTS,
          firstRepository?.fullName ?? null,
          workspaceId,
          LIMITS.MAX_REPOSITORIES,
          workspaceId,
          firstRepository?.fullName ?? null,
        ),
      this.audit(
        workspaceId,
        id,
        writeId,
        "projects",
        "project.created",
        "Project created",
        project.name,
        timestamp,
      ),
    ];
    if (firstRepository) {
      const repositoryId = crypto.randomUUID();
      statements.push(
        this.db
          .prepare(
            `INSERT INTO repositories
        (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,revision,updated_at,write_id)
        SELECT ?,?,?,?,?,?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND write_id=?)`,
          )
          .bind(
            repositoryId,
            workspaceId,
            firstRepository.fullName,
            firstRepository.description,
            id,
            firstRepository.classification,
            firstRepository.lifecycle,
            JSON.stringify(firstRepository.expectations),
            timestamp,
            writeId,
            workspaceId,
            id,
            writeId,
          ),
        this.audit(
          workspaceId,
          repositoryId,
          writeId,
          "repositories",
          "repository.created",
          "Repository enrolled",
          firstRepository.fullName,
          timestamp,
        ),
      );
    }
    const result = await this.db.batch(statements);
    if (!result[0].meta.changes) {
      await authorizeHooks(this.context, workspaceId, CAPABILITY.EDIT);
      const duplicate = await this.db
        .prepare("SELECT id FROM projects WHERE workspace_id=? AND name=?")
        .bind(workspaceId, project.name)
        .first();
      throw new DomainError(
        "conflict",
        duplicate
          ? "A project with this name already exists"
          : "Project creation was not applied. Workspace capacity, access, or the first repository changed; review the saved inventory before retrying.",
        409,
      );
    }
    return this.get({ workspaceId, projectId: id });
  }

  async update(input: unknown): Promise<Project> {
    const { workspaceId, projectId, revision, project } =
      updateProjectInput.parse(input);
    const memberRevision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const before = await this.get({ workspaceId, projectId });
    if (before.revision !== revision) throw this.conflict();
    const changed = (Object.keys(project) as (keyof ProjectFields)[]).filter(
      (key) => JSON.stringify(project[key]) !== JSON.stringify(before[key]),
    );
    if (!changed.length) return before;
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const writeId = crypto.randomUUID();
    const timestamp = new Date(this.context.now()).toISOString();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE projects SET name=?,description=?,lifecycle=?,importance=?,importance_note=?,portfolio_json=?,
        revision=revision+1,updated_at=?,write_id=? WHERE workspace_id=? AND id=? AND revision=? AND ${guard.sql}
          AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND name=? AND id!=?)`,
        )
        .bind(
          project.name,
          project.description,
          project.lifecycle,
          project.importance,
          project.importanceNote,
          JSON.stringify(project.portfolio),
          timestamp,
          writeId,
          workspaceId,
          projectId,
          revision,
          ...guard.values,
          workspaceId,
          project.name,
          projectId,
        ),
      this.audit(
        workspaceId,
        projectId,
        writeId,
        "projects",
        "project.updated",
        "Project updated",
        project.name + ": " + changed.join(", "),
        timestamp,
      ),
    ]);
    if (!result[0].meta.changes) throw this.conflict();
    return this.get({ workspaceId, projectId });
  }

  private conflict() {
    return new DomainError(
      "revision_conflict",
      "This project, its name, or your access changed while editing. Your draft has been preserved; load saved metadata before trying again.",
      409,
    );
  }
}
