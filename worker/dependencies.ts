import {
  DEPENDENCIES_LIMITS,
  dependencyEvidenceSchema,
  dependencyInspectionInput,
  dependenciesListInput,
  dependenciesPageSchema,
  dependencySummary,
  type DependencyResult,
  type DependencyEvidence,
} from "../shared/dependencies";
import { CAPABILITY } from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import { githubCredentialIdentity } from "./github-credentials";
import { readGitHubContext } from "./github-context";
import { collectDependencies } from "./dependency-client";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";

export async function readRepositoryDependencies(
  context: WorkspaceService,
  input: unknown,
) {
  const { refresh, checkUpstream, pullNumber, ...scope } =
    dependencyInspectionInput.parse(input);
  const attempt = { evidence: null as DependencyEvidence | null };
  const result = await readGitHubContext(context, scope, {
    kind: pullNumber ? "dependencyCandidates" : "dependencies",
    identitySuffix: pullNumber,
    schema: dependencyEvidenceSchema,
    responseBytes: DEPENDENCIES_LIMITS.RESPONSE_BYTES,
    cachedOnly: !refresh,
    collect: async (fullName, token, options) => {
      attempt.evidence = await collectDependencies(fullName, token, {
        ...options,
        checkUpstream,
        pullNumber,
      });
      return attempt.evidence;
    },
  });
  if (attempt.evidence) {
    const evidence = attempt.evidence;
    emitDiagnostic({
      event: "hq.dependencies.inspected",
      reference: evidence.inspectionId,
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      repositoryId: scope.repositoryId,
      state: evidence.read.state,
      reason: evidence.read.reason,
      requests: evidence.requests,
      upstreamRequests: evidence.upstreamRequests,
      elapsedMs: evidence.elapsedMs,
      outcome: evidence.report
        ? evidence.report.analysis.outcome
        : evidence.policy === "absent"
          ? "untracked"
          : "unavailable",
      upstreamIncomplete:
        checkUpstream &&
        Boolean(
          evidence.report?.analysis.findings.some((finding) =>
            ["not_checked", "unavailable", "unsupported"].includes(
              finding.upstream.state,
            ),
          ),
        ),
    });
  }
  return result;
}
export async function listDependencies(
  context: WorkspaceService,
  input: unknown,
) {
  const { workspaceId, projectId, search, page } =
    dependenciesListInput.parse(input);
  const memberRevision = await authorizeHooks(context, workspaceId);
  const guard = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.READ,
    memberRevision,
  );
  if (
    projectId &&
    !(await context.db
      .prepare(
        `SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, projectId, ...guard.values)
      .first())
  )
    throw new DomainError(
      "not_found",
      "This project is not available in this workspace.",
      404,
    );
  const filter = `r.workspace_id=? AND (? IS NULL OR r.project_id=?) AND instr(lower(r.full_name),lower(?))>0 AND ${guard.sql}`;
  const values = [
    workspaceId,
    projectId ?? null,
    projectId ?? null,
    search,
    ...guard.values,
  ];
  const pageSql = `SELECT r.id,r.full_name,r.project_id,r.revision AS repository_revision,
      s.id AS source_id,s.name AS source_name,s.revision AS source_revision,s.enabled,s.credential_ref,s.configuration_json,
      c.identity,c.result_json,c.next_read_at
    FROM repositories r LEFT JOIN connections s ON s.workspace_id=r.workspace_id AND s.id=
      (SELECT enrolled.id FROM source_repositories sr JOIN connections enrolled ON enrolled.workspace_id=sr.workspace_id AND enrolled.id=sr.source_id
       WHERE sr.workspace_id=r.workspace_id AND sr.repository_id=r.id AND enrolled.provider='github'
       ORDER BY enrolled.enabled DESC, (enrolled.credential_ref IS NOT NULL) DESC, enrolled.id LIMIT 1)
    LEFT JOIN github_dependency_cache c ON c.workspace_id=r.workspace_id AND c.repository_id=r.id AND c.source_id=s.id
    WHERE ${filter} ORDER BY r.full_name,r.id LIMIT ? OFFSET ?`;
  const pageValues = [
    ...values,
    DEPENDENCIES_LIMITS.PAGE_SIZE,
    (page - 1) * DEPENDENCIES_LIMITS.PAGE_SIZE,
  ];
  const result = await context.db.batch([
    context.db
      .prepare(`SELECT count(*) AS total FROM repositories r WHERE ${filter}`)
      .bind(...values),
    context.db.prepare(pageSql).bind(...pageValues),
  ]);
  type Row = {
    id: string;
    full_name: string;
    project_id: string | null;
    repository_revision: number;
    source_id: string | null;
    source_name: string;
    source_revision: number;
    enabled: number;
    credential_ref: string | null;
    configuration_json: string;
    identity: string | null;
    result_json: string | null;
    next_read_at: string | null;
  };
  const credentials = new Map<
    string | null,
    Awaited<ReturnType<typeof githubCredentialIdentity>>
  >();
  const rows = [];
  for (const row of result[1].results as Row[]) {
    let cached: DependencyResult | null = null;
    if (row.source_id) {
      if (!credentials.has(row.credential_ref))
        credentials.set(
          row.credential_ref,
          await githubCredentialIdentity(
            context.env,
            workspaceId,
            row.credential_ref,
          ),
        );
      const credential = credentials.get(row.credential_ref);
      cached = {
        repository: {
          id: row.id,
          fullName: row.full_name,
          revision: row.repository_revision,
        },
        source: {
          id: row.source_id,
          name: row.source_name,
          revision: row.source_revision,
        },
        state: !row.enabled
          ? "disabled"
          : !credential
            ? "not_configured"
            : "waiting",
        nextReadAt: null,
        evidence: null,
      };
      try {
        if (
          !githubConfigurationSchema.safeParse(
            JSON.parse(row.configuration_json),
          ).success
        )
          cached.state = "not_configured";
        const identity = JSON.stringify([
          row.full_name,
          row.repository_revision,
          row.source_revision,
          credential?.hash ?? null,
        ]);
        if (
          cached.state === "waiting" &&
          identity === row.identity &&
          row.result_json
        ) {
          cached.state = "ready";
          cached.evidence = dependencyEvidenceSchema.parse(
            JSON.parse(row.result_json),
          );
          cached.nextReadAt = row.next_read_at;
        }
      } catch {
        cached.state = "not_configured";
        cached.evidence = null;
      }
    }
    rows.push({
      repository: {
        id: row.id,
        fullName: row.full_name,
        projectId: row.project_id,
      },
      source: cached
        ? { id: cached.source.id, name: cached.source.name }
        : null,
      summary: dependencySummary(cached, context.now()),
    });
  }
  await authorizeHooks(context, workspaceId);
  const latest = await context.db
    .prepare(pageSql)
    .bind(...pageValues)
    .all();
  if (JSON.stringify(latest.results) !== JSON.stringify(result[1].results))
    throw new DomainError(
      "conflict",
      "Workspace access changed. Reload dependency maintenance.",
      409,
    );
  for (const [reference, original] of credentials) {
    const current = await githubCredentialIdentity(
      context.env,
      workspaceId,
      reference,
    );
    if (current?.hash !== original?.hash)
      throw new DomainError(
        "conflict",
        "GitHub access changed. Reload dependency maintenance.",
        409,
      );
  }
  return dependenciesPageSchema.parse({
    page,
    total: Number((result[0].results[0] as { total: number }).total),
    rows,
  });
}
