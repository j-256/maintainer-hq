import { z } from "zod";
import type { Observation } from "../shared/domain";
import { githubEvidenceSchema } from "../shared/github-evidence";
import {
  GITHUB_COVERAGE_LIMITS,
  githubCoverageInput,
  githubCoverageRepositories,
  type GitHubCoverage,
  type GitHubCoverageRepository,
} from "../shared/github-coverage";
import { GITHUB_REFRESH_STATES } from "../shared/github";
import { SOURCE_LIMITS } from "../shared/sources";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  describeGitHubSources,
  GITHUB_SOURCE_SELECT,
  type GitHubSourceRow,
} from "./github-sources";
import type { WorkspaceService } from "./service";

type ObservationRow = {
  source_id: string;
  resource_id: string;
  name: string;
  github_json: string | null;
  observed_at: string;
  received_at: string;
  expires_at: string;
};
const receiptRowSchema = z.object({
  source_id: z.string(),
  repository_id: z.string(),
  refresh_id: z.string(),
  source_revision: z.number().int().positive(),
  full_name: z.string(),
  created_at: z.string(),
  status: z.enum(GITHUB_REFRESH_STATES),
  attempts: z.number().int().nonnegative(),
  updated_at: z.string(),
  observed_at: z.string().nullable(),
});

export async function githubCoverage(
  context: WorkspaceService,
  input: unknown,
): Promise<GitHubCoverage> {
  const { workspaceId, repositoryIds, sourceId } =
    githubCoverageInput.parse(input);
  const memberRevision = await authorizeHooks(context, workspaceId);
  const guard = hookActorGuard(context, workspaceId, undefined, memberRevision);
  const ids = JSON.stringify(repositoryIds);
  const selection = "SELECT value FROM json_each(?)";
  const cap = GITHUB_COVERAGE_LIMITS.SOURCE_ROWS + 1;
  const [repositories, sources, scopes, observations, attempts] =
    await context.db.batch([
      context.db
        .prepare(
          `SELECT id,full_name AS fullName,revision,lifecycle,classification FROM repositories
       WHERE workspace_id=? AND id IN (${selection}) AND ${guard.sql}`,
        )
        .bind(workspaceId, ids, ...guard.values),
      context.db
        .prepare(
          `${GITHUB_SOURCE_SELECT} AND (? IS NULL OR s.id=?) AND ${guard.sql}
       AND (? IS NOT NULL OR EXISTS (SELECT 1 FROM source_repositories sr WHERE sr.workspace_id=s.workspace_id
         AND sr.source_id=s.id AND sr.repository_id IN (${selection}))) LIMIT ?`,
        )
        .bind(
          workspaceId,
          sourceId,
          sourceId,
          ...guard.values,
          sourceId,
          ids,
          SOURCE_LIMITS.SOURCES + 1,
        ),
      context.db
        .prepare(
          `SELECT sr.source_id,sr.repository_id FROM source_repositories sr
       JOIN connections s ON s.workspace_id=sr.workspace_id AND s.id=sr.source_id AND s.provider='github'
       WHERE sr.workspace_id=? AND sr.repository_id IN (${selection})
         AND (? IS NULL OR s.id=?) AND ${guard.sql} LIMIT ?`,
        )
        .bind(workspaceId, ids, sourceId, sourceId, ...guard.values, cap),
      context.db
        .prepare(
          `SELECT o.source_id,o.resource_id,o.name,json_extract(o.details_json,'$.github') AS github_json,
         o.observed_at,o.received_at,o.expires_at
       FROM observations o JOIN connections s ON s.workspace_id=o.workspace_id
         AND s.id=o.source_id AND s.provider='github'
       JOIN source_repositories sr ON sr.workspace_id=o.workspace_id AND sr.source_id=o.source_id
         AND sr.repository_id=o.resource_id
       WHERE o.workspace_id=? AND o.resource_type='repository' AND o.resource_id IN (${selection})
         AND (? IS NULL OR s.id=?) AND ${guard.sql} LIMIT ?`,
        )
        .bind(workspaceId, ids, sourceId, sourceId, ...guard.values, cap),
      context.db
        .prepare(
          `SELECT s.id AS source_id,i.repository_id,j.id AS refresh_id,j.source_revision,i.full_name,
         j.created_at,i.status,i.attempts,i.updated_at,i.observed_at
       FROM connections s JOIN github_refreshes j ON j.workspace_id=s.workspace_id
         AND j.source_id=s.id AND j.id=s.last_refresh_id
       JOIN github_refresh_items i ON i.workspace_id=j.workspace_id AND i.refresh_id=j.id
       JOIN source_repositories sr ON sr.workspace_id=s.workspace_id AND sr.source_id=s.id
         AND sr.repository_id=i.repository_id
       WHERE s.workspace_id=? AND s.provider='github' AND i.repository_id IN (${selection})
         AND (? IS NULL OR s.id=?) AND ${guard.sql} LIMIT ?`,
        )
        .bind(workspaceId, ids, sourceId, sourceId, ...guard.values, cap),
    ]);
  if (repositories.results.length !== repositoryIds.length)
    throw new DomainError(
      "not_found",
      "A selected repository is unavailable in this workspace.",
      404,
    );
  if (sourceId && sources.results.length === 0)
    throw new DomainError(
      "not_found",
      "The selected GitHub connection is unavailable in this workspace.",
      404,
    );
  if (
    sources.results.length > SOURCE_LIMITS.SOURCES ||
    [scopes, observations, attempts].some(
      (result) => result.results.length >= cap,
    )
  )
    throw new DomainError(
      "capacity",
      "This selection has too many GitHub connections. Choose one connection or fewer repositories.",
      409,
    );
  const repositoryRows =
    repositories.results as GitHubCoverageRepository["repository"][];
  const sourceRows = sources.results as GitHubSourceRow[];
  const connections = await describeGitHubSources(
    context.env,
    workspaceId,
    sourceRows,
    scopes.results as { source_id: string; repository_id: string }[],
    context.now(),
  );
  const evidence = (observations.results as ObservationRow[]).map(
    (row): Observation => {
      let github;
      try {
        github =
          row.github_json === null
            ? undefined
            : githubEvidenceSchema.parse(JSON.parse(row.github_json));
      } catch {
        throw new DomainError(
          "evidence_unavailable",
          "Stored GitHub evidence could not be read. Inspect the source's latest receipt.",
          503,
        );
      }
      return {
        sourceId: row.source_id,
        resourceId: row.resource_id,
        resourceType: "repository",
        provider: "github",
        name: row.name,
        health: "unknown",
        summary: "",
        observedAt: row.observed_at,
        receivedAt: row.received_at,
        expiresAt: row.expires_at,
        details: github ? { github } : {},
      };
    },
  );
  const parsed = z.array(receiptRowSchema).safeParse(attempts.results);
  if (!parsed.success)
    throw new DomainError(
      "receipt_unavailable",
      "Stored GitHub refresh progress could not be read. Open the source's refresh history.",
      503,
    );
  const receipts = new Map(
    parsed.data.map((row) => [
      JSON.stringify([row.repository_id, row.source_id]),
      row,
    ]),
  );

  if ((await authorizeHooks(context, workspaceId)) !== memberRevision)
    throw new DomainError(
      "forbidden",
      "Your workspace access changed while reading coverage. Refresh to try again.",
      403,
    );
  const [currentRepositories, currentSources] = await context.db.batch([
    context.db
      .prepare(
        `SELECT id,revision FROM repositories WHERE workspace_id=? AND id IN (${selection}) AND ${guard.sql}`,
      )
      .bind(workspaceId, ids, ...guard.values),
    context.db
      .prepare(
        `SELECT id,revision FROM connections WHERE workspace_id=? AND id IN (${selection}) AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        JSON.stringify(sourceRows.map((source) => source.id)),
        ...guard.values,
      ),
  ]);
  function sameRevisions(
    before: { id: string; revision: number }[],
    after: unknown[],
  ) {
    const revisions = new Map(
      (after as { id: string; revision: number }[]).map((row) => [
        row.id,
        row.revision,
      ]),
    );
    return (
      revisions.size === before.length &&
      before.every((row) => revisions.get(row.id) === row.revision)
    );
  }
  if (
    !sameRevisions(repositoryRows, currentRepositories.results) ||
    !sameRevisions(sourceRows, currentSources.results)
  )
    throw new DomainError(
      "conflict",
      "The selected repositories or sources changed while reading coverage. Refresh to try again.",
      409,
    );
  const now = context.now();
  const rows = githubCoverageRepositories(
    repositoryRows,
    connections,
    evidence,
    now,
  );
  for (const row of rows) {
    for (const source of row.sources) {
      const receipt = receipts.get(
        JSON.stringify([row.repository.id, source.id]),
      );
      if (receipt)
        source.latestRefresh = {
          refreshId: receipt.refresh_id,
          sourceRevision: receipt.source_revision,
          currentRevision: receipt.source_revision === source.revision,
          identityMatches:
            receipt.full_name.toLowerCase() ===
            row.repository.fullName.toLowerCase(),
          createdAt: receipt.created_at,
          status: receipt.status,
          attempts: receipt.attempts,
          updatedAt: receipt.updated_at,
          observedAt: receipt.observed_at,
        };
    }
  }
  const ordered = new Map(rows.map((row) => [row.repository.id, row]));
  const result = {
    generatedAt: new Date(now).toISOString(),
    sourceId,
    repositories: repositoryIds.map((id) => ordered.get(id)!),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    GITHUB_COVERAGE_LIMITS.RESPONSE_BYTES
  )
    throw new DomainError(
      "capacity",
      "Coverage exceeds the response limit. Choose one connection or fewer repositories.",
      409,
    );
  return result;
}
