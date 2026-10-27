import {
  DEPENDABOT_LIMITS as LIMITS,
  dependabotEvidenceSchema,
  dependabotInspectionInput,
  dependabotListInput,
  dependabotPageSchema,
  type DependabotEvidence,
  type DependabotResult,
} from "../shared/dependabot";
import { CAPABILITY } from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import { githubCredentialIdentity } from "./github-credentials";
import { readGitHubContext } from "./github-context";
import { inspectDependabotFile } from "./dependabot-client";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

export async function readRepositoryDependabot(
  context: WorkspaceService,
  input: unknown,
) {
  const { refresh, ...scope } = dependabotInspectionInput.parse(input);
  const attempt = { evidence: null as DependabotEvidence | null };
  const result = await readGitHubContext(context, scope, {
    kind: "dependabot",
    schema: dependabotEvidenceSchema,
    responseBytes: LIMITS.EVIDENCE_BYTES + 4096,
    cachedOnly: !refresh,
    collect: async (fullName, token, options) => {
      attempt.evidence = (
        await inspectDependabotFile(fullName, token, options)
      ).evidence;
      return attempt.evidence;
    },
  });
  if (attempt.evidence)
    emitDiagnostic({
      event: "hq.dependabot.inspected",
      reference: attempt.evidence.inspectionId,
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      repositoryId: scope.repositoryId,
      state: attempt.evidence.read.state,
      reason: attempt.evidence.read.reason,
      configuration: attempt.evidence.configuration,
      requests: attempt.evidence.requests,
      elapsedMs: attempt.evidence.elapsedMs,
    });
  return result;
}

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
export async function listDependabotSchedules(
  context: WorkspaceService,
  input: unknown,
) {
  const { workspaceId, projectId, page } = dependabotListInput.parse(input);
  const memberRevision = await authorizeHooks(context, workspaceId);
  const catalog = context.env.GITHUB_CREDENTIALS;
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
      "This project is not available in this workspace",
      404,
    );
  const filter = `r.workspace_id=? AND (? IS NULL OR r.project_id=?) AND ${guard.sql}`;
  const values = [
    workspaceId,
    projectId ?? null,
    projectId ?? null,
    ...guard.values,
  ];
  const totalsSql = `SELECT count(*) AS total,(SELECT COALESCE(MAX(cursor),0) FROM workspace_sync_clock WHERE workspace_id=?) AS revision FROM repositories r WHERE ${filter}`;
  const totalsValues = [workspaceId, ...values];
  const pageSql = `SELECT r.id,r.full_name,r.project_id,r.revision AS repository_revision,
    s.id AS source_id,s.name AS source_name,s.revision AS source_revision,s.enabled,s.credential_ref,s.configuration_json,
    c.identity,c.result_json,c.next_read_at
    FROM repositories r LEFT JOIN connections s ON s.workspace_id=r.workspace_id AND s.id=
      (SELECT enrolled.id FROM source_repositories sr JOIN connections enrolled ON enrolled.workspace_id=sr.workspace_id AND enrolled.id=sr.source_id
       WHERE sr.workspace_id=r.workspace_id AND sr.repository_id=r.id AND enrolled.provider='github'
       ORDER BY enrolled.enabled DESC,(enrolled.credential_ref IS NOT NULL) DESC,enrolled.id LIMIT 1)
    LEFT JOIN github_dependabot_cache c ON c.workspace_id=r.workspace_id AND c.repository_id=r.id AND c.source_id=s.id
    WHERE ${filter} ORDER BY r.full_name,r.id LIMIT ? OFFSET ?`;
  const pageValues = [
    ...values,
    LIMITS.PAGE_SIZE,
    (page - 1) * LIMITS.PAGE_SIZE,
  ];
  const initial = await context.db.batch([
    context.db.prepare(totalsSql).bind(...totalsValues),
    context.db.prepare(pageSql).bind(...pageValues),
  ]);
  const credentials = new Map<
    string | null,
    Awaited<ReturnType<typeof githubCredentialIdentity>>
  >();
  const rows = [];
  for (const row of initial[1].results as Row[]) {
    let result: DependabotResult | null = null;
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
      result = {
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
          result.state = "not_configured";
        const identity = JSON.stringify([
          row.full_name,
          row.repository_revision,
          row.source_revision,
          credential?.hash ?? null,
        ]);
        if (result.state === "waiting" && identity === row.identity) {
          result.nextReadAt = row.next_read_at;
          if (row.result_json) {
            result.state = "ready";
            result.evidence = dependabotEvidenceSchema.parse(
              JSON.parse(row.result_json),
            );
          }
        }
      } catch {
        result.state = "not_configured";
        result.evidence = null;
      }
    }
    rows.push({
      repository: {
        id: row.id,
        fullName: row.full_name,
        projectId: row.project_id,
      },
      source: result
        ? { id: result.source.id, name: result.source.name }
        : null,
      result,
    });
  }
  const liveGuard = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.READ,
    memberRevision,
  );
  const final = await context.db.batch([
    context.db
      .prepare(`SELECT 1 AS allowed WHERE ${liveGuard.sql}`)
      .bind(...liveGuard.values),
    context.db.prepare(totalsSql).bind(...totalsValues),
    context.db.prepare(pageSql).bind(...pageValues),
  ]);
  if (
    !final[0].results.length ||
    (context.principal.expiresAt !== undefined &&
      context.principal.expiresAt <= context.now())
  )
    throw new DomainError(
      "forbidden",
      "Workspace access changed. Sign in again and reload schedules",
      403,
    );
  if (
    catalog !== context.env.GITHUB_CREDENTIALS ||
    JSON.stringify(final[1].results) !== JSON.stringify(initial[0].results) ||
    JSON.stringify(final[2].results) !== JSON.stringify(initial[1].results)
  )
    throw new DomainError(
      "conflict",
      "Schedule inventory or access changed. Reload schedules",
      409,
    );
  const totals = final[1].results[0] as { total: number; revision: number };
  const result = dependabotPageSchema.parse({
    page,
    pageSize: LIMITS.PAGE_SIZE,
    total: Number(totals.total),
    revision: Number(totals.revision),
    rows,
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    LIMITS.RESPONSE_BYTES
  )
    throw new DomainError(
      "capacity",
      "Schedule inventory exceeds the bounded response size",
      409,
    );
  return result;
}
