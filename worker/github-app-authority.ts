import { emitDiagnostic } from "./diagnostics";
import type { GitHubAppClient } from "./github-app-client";
import { z } from "zod";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppGrantSchema,
  githubAppMetadataSchema,
  githubAppRepositoryIdentitySchema,
} from "../shared/github-apps";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import {
  GitHubAppProviderError,
  type GitHubInstallationMetadata,
} from "./github-app-client";
import { openGitHubAppClient } from "./github-app-material-store";
import {
  githubAppConflict,
  type GitHubAppRegistrationRow,
} from "./github-app-registrations";
import type { GitHubCredentialContext } from "./github-app-types";
export type GitHubAppAuthorityScope = {
  workspaceId: string;
  registrationId: string;
  installationId: number;
  grantId: string;
  grantRevision: number;
  repositoryId: number;
};
export type GitHubAuthorityObservation = {
  generation: number;
  digest: string;
  observedAt: string;
  validUntil: string;
  repository: z.infer<typeof githubAppRepositoryIdentitySchema>;
  installation: GitHubInstallationMetadata;
};
type AuthorityRow = {
  registration_revision: number | null;
  key_revision: number | null;
  generation: number;
  state: "unknown" | "allowed" | "denied";
  digest: string | null;
  observation_json: string | null;
  observed_at: string | null;
  valid_until: string | null;
};
const observationSchema = z.object({
  repository: githubAppRepositoryIdentitySchema,
  installation: z.object({
    id: z.number().int().positive(),
    appId: z.number().int().positive(),
    account: githubAppGrantSchema.shape.account,
    permissions: z.record(z.string(), z.enum(["read", "write", "admin"])),
    repositorySelection: z.enum(["all", "selected"]),
    suspendedAt: z.string().nullable(),
  }),
});
const checks = new WeakMap<
  object,
  Map<string, Promise<GitHubAuthorityObservation>>
>();
export async function githubAppQuotaKey(
  context: GitHubCredentialContext,
  appId: number,
  installationId: number,
) {
  return (
    "github-app:" +
    (await credentialHash(
      JSON.stringify([
        context.env.GITHUB_APP_DEPLOYMENT_ID,
        appId,
        installationId,
      ]),
    ))
  );
}
export async function assertGitHubAppCooldown(
  context: GitHubCredentialContext,
  quotaKey: string,
) {
  const now = new Date(context.now()).toISOString();
  const row = await context.db
    .prepare(
      "SELECT retry_at FROM github_cooldowns WHERE credential_hash=? AND retry_at>?",
    )
    .bind(quotaKey, now)
    .first<{ retry_at: string }>();
  if (row)
    throw new GitHubAppProviderError(
      "github_app_rate_limited",
      "This GitHub installation has a shared provider cooldown. Retry after its recorded time.",
      429,
      row.retry_at,
    );
}
export async function recordGitHubAppCooldown(
  context: GitHubCredentialContext,
  quotaKey: string,
  error: unknown,
) {
  if (
    !(error instanceof GitHubAppProviderError) ||
    error.code !== "github_app_rate_limited"
  )
    return;
  const requestedRetryAt =
    error.retryAt && Date.parse(error.retryAt) > context.now()
      ? error.retryAt
      : new Date(context.now() + LIMITS.AUTHORITY_MAX_AGE_MS).toISOString();
  const retryAt = new Date(
    Math.min(
      Date.parse(requestedRetryAt),
      context.now() + LIMITS.COOLDOWN_MAX_MS,
    ),
  ).toISOString();
  await context.db
    .prepare(
      "INSERT INTO github_cooldowns(credential_hash,retry_at) VALUES (?,?) ON CONFLICT(credential_hash) DO UPDATE SET retry_at=max(retry_at,excluded.retry_at)",
    )
    .bind(quotaKey, retryAt)
    .run();
}
export async function invalidateGitHubAppAuthority(
  context: GitHubCredentialContext,
  registrationId: string,
  installationId?: number,
) {
  await context.db
    .prepare(
      "UPDATE github_app_authority SET generation=generation+1,state='unknown',digest=NULL,observation_json=NULL,observed_at=NULL,valid_until=NULL,write_id=? WHERE registration_id=? AND (? IS NULL OR installation_id=?)",
    )
    .bind(
      crypto.randomUUID(),
      registrationId,
      installationId ?? null,
      installationId ?? null,
    )
    .run();
}
export async function readGitHubAppAuthorityScope(
  context: GitHubCredentialContext,
  scope: GitHubAppAuthorityScope,
) {
  const now = new Date(context.now()).toISOString();
  const row = await context.db
    .prepare(
      `SELECT r.*,g.metadata_json AS grant_json FROM github_app_registrations r JOIN github_app_grants g ON g.registration_id=r.id
    WHERE g.workspace_id=? AND g.id=? AND g.revision=? AND g.installation_id=? AND r.id=? AND g.state='active'
      AND (g.expires_at IS NULL OR g.expires_at>?) AND json_extract(r.metadata_json,'$.state')='active'
      AND EXISTS(SELECT 1 FROM json_each(g.metadata_json,'$.repositories') WHERE json_extract(value,'$.id')=?)`,
    )
    .bind(
      scope.workspaceId,
      scope.grantId,
      scope.grantRevision,
      scope.installationId,
      scope.registrationId,
      now,
      scope.repositoryId,
    )
    .first<GitHubAppRegistrationRow & { grant_json: string }>();
  if (!row) githubAppConflict();
  return row;
}
export async function verifyGitHubAppAuthority(
  context: GitHubCredentialContext,
  scope: GitHubAppAuthorityScope,
  freshness: "bounded_read" | "fresh_effect",
): Promise<GitHubAuthorityObservation> {
  if (freshness === "fresh_effect") return verify(context, scope, freshness);
  let pending = checks.get(context.env);
  if (!pending) {
    pending = new Map();
    checks.set(context.env, pending);
  }
  const key = JSON.stringify(scope);
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= LIMITS.CACHE_ENTRIES)
    throw new DomainError(
      "github_app_busy",
      "Too many App authority checks are already running. Retry this bounded request.",
      503,
    );
  const promise = verify(context, scope, freshness);
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
  }
}
async function verify(
  context: GitHubCredentialContext,
  scope: GitHubAppAuthorityScope,
  freshness: "bounded_read" | "fresh_effect",
): Promise<GitHubAuthorityObservation> {
  const registration = await readGitHubAppAuthorityScope(context, scope);
  const metadata = githubAppMetadataSchema.parse(
    JSON.parse(registration.metadata_json),
  );
  const grant = githubAppGrantSchema.parse(JSON.parse(registration.grant_json));
  const expected = grant.repositories.find(
    (value) => value.id === scope.repositoryId,
  );
  if (!expected) githubAppConflict();
  const quotaKey = await githubAppQuotaKey(
    context,
    metadata.appId,
    scope.installationId,
  );
  await assertGitHubAppCooldown(context, quotaKey);
  const keys = [scope.registrationId, scope.installationId, scope.repositoryId];
  await context.db
    .prepare(
      "INSERT OR IGNORE INTO github_app_authority(registration_id,installation_id,repository_id,state,write_id) VALUES (?,?,?,'unknown',?)",
    )
    .bind(...keys, crypto.randomUUID())
    .run();
  const original = await context.db
    .prepare(
      "SELECT registration_revision,key_revision,generation,state,digest,observation_json,observed_at,valid_until FROM github_app_authority WHERE registration_id=? AND installation_id=? AND repository_id=?",
    )
    .bind(...keys)
    .first<AuthorityRow>();
  if (!original) githubAppConflict();
  const now = new Date(context.now()).toISOString();
  if (
    freshness === "bounded_read" &&
    original.registration_revision === registration.revision &&
    original.key_revision === registration.key_revision &&
    original.valid_until &&
    original.valid_until > now &&
    original.observed_at &&
    Date.parse(original.observed_at) <= context.now() &&
    Date.parse(original.observed_at) >
      context.now() - LIMITS.AUTHORITY_MAX_AGE_MS
  ) {
    if (original.state === "denied")
      throw new GitHubAppProviderError(
        "github_app_denied",
        "The selected installation or repository authority was denied. Review its GitHub access.",
        403,
      );
    if (
      original.state === "allowed" &&
      original.observation_json &&
      original.digest
    ) {
      const observed = observationSchema.parse(
        JSON.parse(original.observation_json),
      );
      if (
        JSON.stringify(expected) === JSON.stringify(observed.repository) &&
        grant.account.id === observed.installation.account.id &&
        grant.account.type === observed.installation.account.type
      )
        return {
          ...observed,
          generation: original.generation,
          digest: original.digest,
          observedAt: original.observed_at,
          validUntil: original.valid_until,
        };
    }
  }
  const writeId = crypto.randomUUID();
  const started = performance.now();
  let client: GitHubAppClient | null = null;
  const diagnostic = (
    state: "verified" | "denied" | "limited" | "conflict" | "unavailable",
    generation: number,
    code: string | null,
  ) =>
    emitDiagnostic({
      event: "hq.github.app.authority",
      correlationId: writeId,
      workspaceId: scope.workspaceId,
      registrationId: scope.registrationId,
      installationId: scope.installationId,
      repositoryId: scope.repositoryId,
      grantId: scope.grantId,
      freshness,
      state,
      generation,
      requests: client?.requests ?? 0,
      code,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    });
  try {
    client = await openGitHubAppClient(context, registration);
    const installation = await client.getInstallation(scope.installationId);
    if (installation.suspendedAt)
      throw new GitHubAppProviderError(
        "github_app_denied",
        "The selected GitHub installation is suspended.",
        403,
      );
    const token = await client.mintToken({
      installationId: scope.installationId,
      repositoryIds: [scope.repositoryId],
      permissions: { metadata: "read" },
    });
    const repository = githubAppRepositoryIdentitySchema.parse(
      token.repositories[0],
    );
    if (
      !expected ||
      JSON.stringify(expected) !== JSON.stringify(repository) ||
      grant.account.id !== installation.account.id ||
      grant.account.type !== installation.account.type ||
      repository.ownerId !== installation.account.id
    )
      throw new GitHubAppProviderError(
        "github_app_denied",
        "This repository or installation identity changed. Review the exact workspace grant again.",
        403,
      );
    const observed = {
      repository,
      installation: {
        ...installation,
        permissions: Object.fromEntries(
          Object.entries(installation.permissions).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      },
    };
    const digest = await credentialHash(JSON.stringify(observed));
    const generation =
      original.digest === digest && original.state === "allowed"
        ? original.generation
        : original.generation + 1;
    const observedAt = new Date(context.now()).toISOString();
    const validUntil = new Date(
      Math.min(
        context.now() + LIMITS.AUTHORITY_MAX_AGE_MS,
        Date.parse(token.expiresAt) - LIMITS.TOKEN_MARGIN_MS,
      ),
    ).toISOString();
    const result = await context.db
      .prepare(
        `UPDATE github_app_authority SET generation=?,state='allowed',registration_revision=?,key_revision=?,digest=?,observation_json=?,observed_at=?,valid_until=?,write_id=?
      WHERE registration_id=? AND installation_id=? AND repository_id=? AND generation=?
      AND EXISTS(SELECT 1 FROM github_app_registrations WHERE id=? AND revision=? AND key_revision=? AND json_extract(metadata_json,'$.state')='active')
      AND EXISTS(SELECT 1 FROM github_app_grants WHERE id=? AND workspace_id=? AND revision=? AND state='active' AND (expires_at IS NULL OR expires_at>?))`,
      )
      .bind(
        generation,
        registration.revision,
        registration.key_revision,
        digest,
        JSON.stringify(observed),
        observedAt,
        validUntil,
        writeId,
        ...keys,
        original.generation,
        registration.id,
        registration.revision,
        registration.key_revision,
        scope.grantId,
        scope.workspaceId,
        scope.grantRevision,
        observedAt,
      )
      .run();
    if (!result.meta.changes) githubAppConflict();
    diagnostic("verified", generation, null);
    return { ...observed, generation, digest, observedAt, validUntil };
  } catch (error) {
    await recordGitHubAppCooldown(context, quotaKey, error);
    if (
      error instanceof GitHubAppProviderError &&
      error.code === "github_app_denied"
    ) {
      const observedAt = new Date(context.now()).toISOString();
      await context.db
        .prepare(
          "UPDATE github_app_authority SET generation=generation+1,state='denied',digest=NULL,observation_json=NULL,observed_at=?,valid_until=?,write_id=? WHERE registration_id=? AND installation_id=? AND repository_id=? AND generation=?",
        )
        .bind(
          observedAt,
          new Date(context.now() + LIMITS.AUTHORITY_MAX_AGE_MS).toISOString(),
          writeId,
          ...keys,
          original.generation,
        )
        .run();
    }
    const code =
      error instanceof DomainError ? error.code : "github_app_unavailable";
    diagnostic(
      code === "github_app_denied"
        ? "denied"
        : code === "github_app_rate_limited"
          ? "limited"
          : code === "github_app_conflict"
            ? "conflict"
            : "unavailable",
      original.generation,
      code,
    );
    throw error;
  }
}
