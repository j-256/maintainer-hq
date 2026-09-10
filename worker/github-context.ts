import { CAPABILITY } from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import type { z } from "zod";
import {
  GITHUB_CONTEXT_LIMITS as LIMITS,
  githubContextInput,
  githubContextResultSchema,
  type GitHubContextResult,
} from "../shared/github-context";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { githubCredentialIdentity } from "./github-credentials";
import type { WorkspaceService } from "./service";
import { deliverWorkspacePush } from "./workspace-push";

type Scope = {
  full_name: string;
  repository_revision: number;
  source_name: string;
  source_revision: number;
  enabled: number;
  credential_ref: string | null;
  configuration_json: string;
};
type Cache = {
  identity: string;
  lease_id: string | null;
  lease_until: string | null;
  next_read_at: string;
  result_json: string | null;
};
const SCOPE = `SELECT r.full_name, r.revision AS repository_revision, s.name AS source_name,
  s.revision AS source_revision, s.enabled, s.credential_ref, s.configuration_json
  FROM source_repositories sr
  JOIN repositories r ON r.workspace_id = sr.workspace_id AND r.id = sr.repository_id
  JOIN connections s ON s.workspace_id = sr.workspace_id AND s.id = sr.source_id
  WHERE sr.workspace_id = ? AND sr.source_id = ? AND sr.repository_id = ? AND s.provider = 'github'`;
const CACHE_TABLES = Object.freeze({
  releases: "github_release_cache",
  work: "github_work_cache",
  dependencies: "github_dependency_cache",
  dependencyCandidates: "github_dependency_candidate_cache",
});

export async function readGitHubContext<T extends { retryAt: string | null }>(
  context: WorkspaceService,
  input: unknown,
  adapter: {
    kind: keyof typeof CACHE_TABLES;
    schema: z.ZodType<T>;
    responseBytes: number;
    cachedOnly?: boolean;
    identitySuffix?: number;
    collect: (
      fullName: string,
      token: string,
      options: { now: () => number },
    ) => Promise<T>;
  },
): Promise<GitHubContextResult<T>> {
  const { workspaceId, repositoryId, sourceId } =
    githubContextInput.parse(input);
  const table = CACHE_TABLES[adapter.kind];
  const CACHE = `SELECT identity, lease_id, lease_until, next_read_at, result_json FROM ${table}
    WHERE workspace_id = ? AND source_id = ? AND repository_id = ?`;
  const memberRevision = await authorizeHooks(context, workspaceId);
  const actor = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.READ,
    memberRevision,
  );
  const keys = [workspaceId, sourceId, repositoryId];
  async function scope() {
    if (
      context.principal.expiresAt !== undefined &&
      context.principal.expiresAt <= context.now()
    )
      throw new DomainError(
        "unauthorized",
        "Renew your workspace sign-in before reading repository evidence.",
        401,
      );
    const row = await context.db
      .prepare(SCOPE + ` AND ${actor.sql}`)
      .bind(...keys, ...actor.values)
      .first<Scope>();
    if (!row) {
      await authorizeHooks(context, workspaceId);
      throw new DomainError(
        "not_found",
        "This repository is not available through the selected GitHub source.",
        404,
      );
    }
    return row;
  }
  const original = await scope();
  const credential = await githubCredentialIdentity(
    context.env,
    workspaceId,
    original.credential_ref,
  );
  const identity = JSON.stringify([
    original.full_name,
    original.repository_revision,
    original.source_revision,
    credential?.hash ?? null,
    ...(adapter.identitySuffix === undefined ? [] : [adapter.identitySuffix]),
  ]);
  const pin = `EXISTS (${SCOPE} AND r.revision = ? AND s.revision = ? AND s.enabled = 1 AND s.credential_ref IS ? AND ${actor.sql})`;
  const pinValues = [
    ...keys,
    original.repository_revision,
    original.source_revision,
    original.credential_ref,
    ...actor.values,
  ];
  async function finish(
    state: GitHubContextResult<T>["state"],
    nextReadAt: string | null,
    stored: string | null,
  ): Promise<GitHubContextResult<T>> {
    const latest = await scope();
    const latestCredential = await githubCredentialIdentity(
      context.env,
      workspaceId,
      latest.credential_ref,
    );
    if (
      JSON.stringify(latest) !== JSON.stringify(original) ||
      latestCredential?.hash !== credential?.hash
    )
      throw new DomainError(
        "conflict",
        "Repository access or source settings changed. Reload this evidence.",
        409,
      );
    try {
      const result = {
        ...githubContextResultSchema.parse({
          repository: {
            id: repositoryId,
            fullName: original.full_name,
            revision: original.repository_revision,
          },
          source: {
            id: sourceId,
            name: original.source_name,
            revision: original.source_revision,
          },
          state,
          nextReadAt,
        }),
        evidence: stored ? adapter.schema.parse(JSON.parse(stored)) : null,
      };
      if (
        new TextEncoder().encode(JSON.stringify(result)).byteLength >
        adapter.responseBytes
      )
        throw new Error();
      return result;
    } catch {
      throw new DomainError(
        "provider_unavailable",
        "Saved repository evidence could not be verified. Wait for the next bounded read.",
        503,
      );
    }
  }
  if (!original.enabled) return finish("disabled", null, null);
  let configuration: unknown;
  try {
    configuration = JSON.parse(original.configuration_json);
  } catch {
    configuration = null;
  }
  if (
    !credential ||
    !githubConfigurationSchema.safeParse(configuration).success
  )
    return finish("not_configured", null, null);
  const now = context.now();
  const timestamp = new Date(now).toISOString();
  const cached = await context.db
    .prepare(CACHE)
    .bind(...keys)
    .first<Cache>();
  if (adapter.cachedOnly)
    return finish(
      cached?.identity === identity && cached.result_json ? "ready" : "waiting",
      cached?.identity === identity ? cached.next_read_at : null,
      cached?.identity === identity ? cached.result_json : null,
    );
  if (cached?.identity === identity && cached.next_read_at > timestamp)
    return finish(
      cached.result_json
        ? "ready"
        : cached.lease_until && cached.lease_until > timestamp
          ? "collecting"
          : "waiting",
      cached.next_read_at,
      cached.result_json,
    );
  const cooldown = await context.db
    .prepare(
      "SELECT retry_at FROM github_cooldowns WHERE credential_hash = ? AND retry_at > ?",
    )
    .bind(credential.hash, timestamp)
    .first<string>("retry_at");
  if (cooldown)
    return finish(
      "waiting",
      cooldown,
      cached?.identity === identity ? cached.result_json : null,
    );
  const lease = crypto.randomUUID();
  const leaseUntil = new Date(now + LIMITS.LEASE_MS).toISOString();
  const nextReadAt = new Date(now + LIMITS.CACHE_MS).toISOString();
  const windowStart =
    Math.floor(now / LIMITS.BUDGET_WINDOW_MS) * LIMITS.BUDGET_WINDOW_MS;
  await context.db.batch([
    context.db
      .prepare(
        `INSERT INTO github_context_budgets (credential_hash, window_start, reads)
      SELECT ?, ?, 0 WHERE ${pin}
      ON CONFLICT(credential_hash) DO UPDATE SET window_start = excluded.window_start, reads = 0
      WHERE github_context_budgets.window_start < excluded.window_start`,
      )
      .bind(credential.hash, windowStart, ...pinValues),
    context.db
      .prepare(
        `INSERT INTO ${table}
      (workspace_id, source_id, repository_id, identity, lease_id, lease_until, next_read_at, result_json)
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${pin}
        AND EXISTS (SELECT 1 FROM github_context_budgets WHERE credential_hash = ? AND window_start = ? AND reads < ?)
        AND NOT EXISTS (SELECT 1 FROM github_cooldowns WHERE credential_hash = ? AND retry_at > ?)
      ON CONFLICT(workspace_id, source_id, repository_id) DO UPDATE SET
        identity = excluded.identity, lease_id = excluded.lease_id, lease_until = excluded.lease_until,
        next_read_at = excluded.next_read_at, result_json = NULL
      WHERE ${table}.next_read_at <= ? AND (${table}.lease_until IS NULL OR ${table}.lease_until <= ?)`,
      )
      .bind(
        ...keys,
        identity,
        lease,
        leaseUntil,
        nextReadAt,
        ...pinValues,
        credential.hash,
        windowStart,
        LIMITS.READS_PER_WINDOW,
        credential.hash,
        timestamp,
        timestamp,
        timestamp,
      ),
    context.db
      .prepare(
        `UPDATE github_context_budgets SET reads = reads + 1 WHERE credential_hash = ? AND window_start = ?
      AND EXISTS (${CACHE} AND lease_id = ?)`,
      )
      .bind(credential.hash, windowStart, ...keys, lease),
  ]);
  const claimed = await context.db
    .prepare(CACHE)
    .bind(...keys)
    .first<Cache>();
  if (claimed?.lease_id !== lease) {
    const matching = claimed?.identity === identity;
    const deadline =
      claimed?.next_read_at && claimed.next_read_at > timestamp
        ? claimed.next_read_at
        : new Date(windowStart + LIMITS.BUDGET_WINDOW_MS).toISOString();
    return finish(
      matching && claimed.result_json
        ? "ready"
        : matching && claimed.lease_until && claimed.lease_until > timestamp
          ? "collecting"
          : "waiting",
      deadline,
      matching ? claimed.result_json : null,
    );
  }
  // Recheck live authority after the cache lease and before provider I/O
  await finish("collecting", nextReadAt, null);
  const evidence = adapter.schema.parse(
    await adapter.collect(original.full_name, credential.token, {
      now: context.now,
    }),
  );
  const stored = JSON.stringify(evidence);
  const acceptedAt = new Date(context.now()).toISOString();
  const next =
    evidence.retryAt && evidence.retryAt > nextReadAt
      ? evidence.retryAt
      : nextReadAt;
  await finish("collecting", nextReadAt, null);
  const statements = [];
  if (evidence.retryAt)
    statements.push(
      context.db
        .prepare(
          `INSERT INTO github_cooldowns (credential_hash, retry_at)
    SELECT ?, ? WHERE ${pin} ON CONFLICT(credential_hash) DO UPDATE SET retry_at = MAX(github_cooldowns.retry_at, excluded.retry_at)`,
        )
        .bind(credential.hash, evidence.retryAt, ...pinValues),
    );
  statements.push(
    context.db
      .prepare(
        `UPDATE ${table} SET result_json = ?, lease_until = NULL, next_read_at = ?
    WHERE workspace_id = ? AND source_id = ? AND repository_id = ? AND identity = ? AND lease_id = ? AND lease_until > ? AND ${pin}`,
      )
      .bind(stored, next, ...keys, identity, lease, acceptedAt, ...pinValues),
  );
  await context.db.batch(statements);
  const accepted = await context.db
    .prepare(CACHE)
    .bind(...keys)
    .first<Cache>();
  if (
    accepted?.identity !== identity ||
    accepted.lease_id !== lease ||
    accepted.lease_until !== null ||
    accepted.result_json !== stored
  )
    throw new DomainError(
      "conflict",
      "The repository read expired or its source changed. Reload this evidence.",
      409,
    );
  const result = await finish("ready", next, stored);
  await deliverWorkspacePush(context.env, workspaceId);
  return result;
}
