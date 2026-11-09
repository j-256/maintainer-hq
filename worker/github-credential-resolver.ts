import { CAPABILITY, type Capability } from "../shared/domain";
import {
  GITHUB_APP_LIMITS as LIMITS,
  GITHUB_CAPABILITY,
  type GitHubCapability,
  githubAppGrantSchema,
  githubAppMetadataSchema,
  githubAppPermissions,
  githubAppPermissionsSchema,
  type GitHubAuthReference,
  type GitHubAppPermissions,
} from "../shared/github-apps";
import { PROVIDER_CREDENTIAL_KIND } from "../shared/provider-credentials";
import { credentialHash } from "./credential-hash";
import { credentialIsCurrentSql } from "./credential-expiry";
import { DomainError } from "./errors";
import {
  verifyGitHubAppAuthority,
  githubAppQuotaKey,
  assertGitHubAppCooldown,
  recordGitHubAppCooldown,
} from "./github-app-authority";
import { openGitHubAppClient } from "./github-app-material-store";
import {
  githubAppConflict,
  type GitHubAppRegistrationRow,
} from "./github-app-registrations";
import { githubCredentialIdentity } from "./github-credentials";
import {
  openGuardedProviderCredential,
  managedCredentialReference,
  providerCredentialGuard,
} from "./provider-credential-store";
import { secretProvider } from "./secret-github-client";
import type {
  GitHubAuthorityFence,
  GitHubCredentialContext,
  GitHubCredentialLease,
  GitHubCredentialRequest,
} from "./github-app-types";

type TokenEntry = { token: string; expiresAt: number };
type TokenCache = {
  entries: Map<string, TokenEntry>;
  pending: Map<string, Promise<TokenEntry>>;
};
const caches = new WeakMap<object, TokenCache>();
export function evictGitHubAppToken(
  context: GitHubCredentialContext,
  lease: GitHubCredentialLease,
) {
  if (lease.fence.kind !== "app") return;
  const cache = caches.get(context.env);
  if (!cache) return;
  for (const [key, entry] of cache.entries)
    if (entry.token === lease.token) cache.entries.delete(key);
}
export async function readGitHubAuthReference(
  context: GitHubCredentialContext,
  workspaceId: string,
  referenceId: string,
): Promise<GitHubAuthReference> {
  const row = await context.db
    .prepare(
      "SELECT grant_id FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?",
    )
    .bind(workspaceId, referenceId)
    .first<{ grant_id: string }>();
  return row
    ? { kind: "app", grantId: row.grant_id }
    : { kind: "token", reference: referenceId };
}
function referenceId(request: GitHubCredentialRequest) {
  return request.reference.kind === "app"
    ? request.reference.grantId
    : request.reference.reference;
}
function actorCapability(request: GitHubCredentialRequest): Capability {
  return (
    request.actorCapability ??
    (request.capability === GITHUB_CAPABILITY.COLLECTION
      ? CAPABILITY.READ
      : request.capability === GITHUB_CAPABILITY.MAINTENANCE
        ? CAPABILITY.OPERATE
        : CAPABILITY.SECRETS)
  );
}
function baseFence(
  context: GitHubCredentialContext,
  request: GitHubCredentialRequest,
) {
  return {
    workspaceId: request.workspaceId,
    connectionId: request.connectionId,
    connectionRevision: request.connectionRevision,
    connectionKind:
      request.connectionKind ??
      (request.capability === GITHUB_CAPABILITY.CONFIGURATION_READ ||
      request.capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE
        ? ("configuration" as const)
        : ("source" as const)),
    repositoryId: request.repositoryId,
    repositoryFullName: request.repositoryFullName,
    capability: request.capability,
    binding: request.binding,
    actorCapability: actorCapability(request),
    actorExpiresAt:
      request.binding.kind === "actor"
        ? (context.principal?.expiresAt ?? null)
        : null,
  };
}
export function githubAuthorityFenceSql(fence: GitHubAuthorityFence) {
  return localFenceSql(fence);
}
function localFenceSql(
  fence: GitHubAuthorityFence,
  options: { providerAuthority?: boolean; tokenIdentity?: boolean } = {},
) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, ...items: unknown[]) => {
    clauses.push(sql);
    values.push(...items);
  };
  const reference = fence.kind === "app" ? fence.grantId : fence.reference;
  const configuration = fence.connectionKind === "configuration";
  if (configuration) {
    add(
      `EXISTS(SELECT 1 FROM secret_connections s WHERE s.workspace_id=? AND s.id=? AND s.revision=? AND s.enabled=1 AND s.provider_kind='github-actions' AND s.credential_ref=?
      AND EXISTS(SELECT 1 FROM json_each(s.resources_json) WHERE json_extract(value,'$.id')=? AND lower(json_extract(value,'$.fullName'))=lower(?)))`,
      fence.workspaceId,
      fence.connectionId,
      fence.connectionRevision,
      reference,
      fence.repositoryId,
      fence.repositoryFullName,
    );
  } else {
    add(
      `EXISTS(SELECT 1 FROM connections s WHERE s.workspace_id=? AND s.id=? AND s.revision=? AND s.enabled=1 AND s.provider='github' AND (?='repository-maintenance' OR s.credential_ref=?))`,
      fence.workspaceId,
      fence.connectionId,
      fence.connectionRevision,
      fence.capability,
      reference,
    );
  }
  if (fence.repositoryId !== null) {
    add(
      "EXISTS(SELECT 1 FROM repositories r WHERE r.workspace_id=? AND r.id=? AND lower(r.full_name)=lower(?))",
      fence.workspaceId,
      fence.repositoryId,
      fence.repositoryFullName,
    );
    if (!configuration)
      add(
        "EXISTS(SELECT 1 FROM source_repositories WHERE workspace_id=? AND source_id=? AND repository_id=?)",
        fence.workspaceId,
        fence.connectionId,
        fence.repositoryId,
      );
  } else if (configuration || fence.capability !== GITHUB_CAPABILITY.COLLECTION)
    add("0");
  if (fence.binding.kind === "actor") {
    const binding = fence.binding;
    const roles =
      fence.actorCapability === CAPABILITY.ADMIN ||
      fence.actorCapability === CAPABILITY.SECRETS
        ? ["owner"]
        : fence.actorCapability === CAPABILITY.READ
          ? ["owner", "operator", "viewer"]
          : ["owner", "operator"];
    add(
      `EXISTS(SELECT 1 FROM members m WHERE m.workspace_id=? AND m.subject=? AND m.revision=? AND m.role IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM credentials c WHERE c.id=? AND c.workspace_id=m.workspace_id AND c.owner_subject=m.subject AND c.revoked_at IS NULL AND c.source_id IS NULL AND c.reporter_id IS NULL AND ${credentialIsCurrentSql("strftime('%Y-%m-%dT%H:%M:%fZ','now')", true)}
        AND EXISTS(SELECT 1 FROM json_each(c.scopes_json) WHERE value='read') AND EXISTS(SELECT 1 FROM json_each(c.scopes_json) WHERE value=?))))`,
      fence.workspaceId,
      binding.subject,
      binding.membershipRevision,
      JSON.stringify(roles),
      binding.tokenId,
      binding.tokenId,
      fence.actorCapability,
    );
    const identityExpiry =
      fence.actorExpiresAt === null
        ? null
        : new Date(fence.actorExpiresAt).toISOString();
    add(
      "(? IS NULL OR ?>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      identityExpiry,
      identityExpiry,
    );
  } else {
    const binding = fence.binding;
    add(
      `EXISTS(SELECT 1 FROM github_refreshes j WHERE j.workspace_id=? AND j.id=? AND j.source_id=? AND j.source_revision=? AND j.credential_ref=? AND j.credential_kind=? AND j.trigger='scheduled' AND j.status IN ('queued','running')
      AND EXISTS(SELECT 1 FROM connections s WHERE s.workspace_id=j.workspace_id AND s.id=j.source_id AND s.enabled=1 AND s.revision=j.source_revision)
      AND EXISTS(SELECT 1 FROM github_refresh_items i WHERE i.workspace_id=j.workspace_id AND i.refresh_id=j.id AND i.repository_id=? AND i.status IN ('queued','running')))`,
      fence.workspaceId,
      binding.jobId,
      binding.sourceId,
      binding.sourceRevision,
      reference,
      fence.kind,
      fence.repositoryId,
    );
    if (
      binding.sourceId !== fence.connectionId ||
      binding.sourceRevision !== fence.connectionRevision ||
      configuration ||
      fence.capability !== GITHUB_CAPABILITY.COLLECTION ||
      fence.repositoryId === null
    )
      add("0");
  }
  if (fence.kind === "app") {
    const authorityJoin =
      options.providerAuthority === false
        ? ""
        : "JOIN github_app_authority a ON a.registration_id=r.id AND a.installation_id=g.installation_id AND a.repository_id=?";
    const authorityPin =
      options.providerAuthority === false
        ? ""
        : "AND a.registration_revision=r.revision AND a.key_revision=r.key_revision AND a.generation=? AND a.state='allowed' AND a.valid_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    add(
      `EXISTS(SELECT 1 FROM github_app_credential_references ref JOIN github_app_grants g ON g.id=ref.grant_id JOIN github_app_registrations r ON r.id=g.registration_id
      ${authorityJoin}
      WHERE ref.workspace_id=? AND ref.reference_id=? AND g.workspace_id=ref.workspace_id AND g.id=? AND g.revision=? AND g.state='active'
        AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND g.installation_id=?
        AND r.id=? AND r.revision=? AND r.key_revision=? AND json_extract(r.metadata_json,'$.state')='active'
        AND EXISTS(SELECT 1 FROM json_each(g.metadata_json,'$.capabilities') WHERE value=?)
        AND EXISTS(SELECT 1 FROM json_each(r.metadata_json,'$.capabilities') WHERE value=?)
        AND EXISTS(SELECT 1 FROM json_each(g.metadata_json,'$.repositories') WHERE json_extract(value,'$.id')=? AND lower(json_extract(value,'$.fullName'))=lower(?))
        ${authorityPin})`,
      ...(options.providerAuthority === false
        ? []
        : [fence.providerRepositoryId]),
      fence.workspaceId,
      reference,
      fence.grantId,
      fence.grantRevision,
      fence.installationId,
      fence.registrationId,
      fence.registrationRevision,
      fence.keyRevision,
      fence.capability,
      fence.capability,
      fence.providerRepositoryId,
      fence.repositoryFullName,
      ...(options.providerAuthority === false
        ? []
        : [fence.observedAuthorityGeneration]),
    );
  } else {
    add(
      "NOT EXISTS(SELECT 1 FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?)",
      fence.workspaceId,
      reference,
    );
    if (
      managedCredentialReference(reference) &&
      options.tokenIdentity !== false
    ) {
      const kind =
        fence.capability === GITHUB_CAPABILITY.MAINTENANCE
          ? PROVIDER_CREDENTIAL_KIND.REPOSITORY
          : PROVIDER_CREDENTIAL_KIND.GITHUB;
      const guard = providerCredentialGuard(
        fence.workspaceId,
        kind,
        reference,
        fence.credentialIdentity,
      );
      add(guard.sql, ...guard.values);
    }
  }
  return { sql: clauses.join(" AND "), values };
}
export async function assertGitHubAuthorityFence(
  context: GitHubCredentialContext,
  fence: GitHubAuthorityFence,
) {
  if (fence.actorExpiresAt !== null && fence.actorExpiresAt <= context.now())
    githubAppConflict();
  const guard = githubAuthorityFenceSql(fence);
  if (
    !(await context.db
      .prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.values)
      .first())
  )
    githubAppConflict();
  if (fence.kind === "app") {
    const row = await context.db
      .prepare(
        "SELECT valid_until FROM github_app_authority WHERE registration_id=? AND installation_id=? AND repository_id=? AND generation=? AND state='allowed'",
      )
      .bind(
        fence.registrationId,
        fence.installationId,
        fence.providerRepositoryId,
        fence.observedAuthorityGeneration,
      )
      .first<{ valid_until: string }>();
    if (!row || Date.parse(row.valid_until) <= context.now())
      githubAppConflict();
    const grant = await context.db
      .prepare(
        "SELECT expires_at FROM github_app_grants WHERE id=? AND workspace_id=?",
      )
      .bind(fence.grantId, fence.workspaceId)
      .first<{ expires_at: string | null }>();
    if (
      !grant ||
      (grant.expires_at && Date.parse(grant.expires_at) <= context.now())
    )
      githubAppConflict();
  } else {
    const current = await readToken(context, {
      ...fence,
      reference: { kind: "token", reference: fence.reference },
      phase: "read",
    });
    if (current.identity !== fence.credentialIdentity) githubAppConflict();
  }
}
async function readToken(
  context: GitHubCredentialContext,
  request: GitHubCredentialRequest,
) {
  if (request.reference.kind !== "token") githubAppConflict();
  const reference = request.reference.reference;
  if (request.capability === GITHUB_CAPABILITY.COLLECTION) {
    const value = await githubCredentialIdentity(
      context.env,
      request.workspaceId,
      reference,
    );
    if (!value)
      throw new DomainError(
        "not_configured",
        "No workspace-bound manual GitHub token is configured.",
        409,
      );
    return {
      token: value.token,
      identity: value.hash,
      expiresAt: Infinity,
      quotaKey: value.hash,
    };
  }
  if (managedCredentialReference(reference)) {
    const kind =
      request.capability === GITHUB_CAPABILITY.MAINTENANCE
        ? PROVIDER_CREDENTIAL_KIND.REPOSITORY
        : PROVIDER_CREDENTIAL_KIND.GITHUB;
    const base = baseFence(context, request);
    const guard = localFenceSql(
      { ...base, kind: "token", reference, credentialIdentity: "pending" },
      { tokenIdentity: false },
    );
    const value = await openGuardedProviderCredential(
      context,
      request.workspaceId,
      reference,
      kind,
      guard,
    );
    if (
      value.settings.providerKind !== kind ||
      !value.settings.scope.repositoryNames.some(
        (name) =>
          name.toLowerCase() === request.repositoryFullName.toLowerCase(),
      ) ||
      ((request.capability === GITHUB_CAPABILITY.MAINTENANCE ||
        request.capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE) &&
        !value.settings.writable)
    )
      githubAppConflict();
    return {
      token: value.token,
      identity: value.identity,
      expiresAt: Date.parse(value.settings.expiresAt),
      quotaKey: await credentialHash(value.token),
    };
  }
  if (request.capability === GITHUB_CAPABILITY.MAINTENANCE) githubAppConflict();
  const value = await secretProvider(
    context.env,
    request.workspaceId,
    reference,
    context.now(),
  );
  if (
    !value.descriptor.repositoryNames.some(
      (name) => name.toLowerCase() === request.repositoryFullName.toLowerCase(),
    ) ||
    (request.capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE &&
      !value.descriptor.writable)
  )
    githubAppConflict();
  return {
    token: value.descriptor.token,
    identity: value.identity,
    expiresAt: Date.parse(value.descriptor.expiresAt),
    quotaKey: await credentialHash(value.descriptor.token),
  };
}
function requiredPermissions(
  request: GitHubCredentialRequest,
): GitHubAppPermissions {
  const defaults: Record<GitHubCapability, GitHubAppPermissions> = {
    [GITHUB_CAPABILITY.COLLECTION]: { metadata: "read", contents: "read" },
    [GITHUB_CAPABILITY.MAINTENANCE]: {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
    },
    [GITHUB_CAPABILITY.CONFIGURATION_READ]: {
      metadata: "read",
      secrets: "read",
    },
    [GITHUB_CAPABILITY.CONFIGURATION_WRITE]: {
      metadata: "read",
      secrets: "write",
    },
  };
  const selected = githubAppPermissionsSchema.parse(
    request.permissions ?? defaults[request.capability],
  );
  const ceiling = githubAppPermissions([request.capability]);
  for (const [name, level] of Object.entries(selected)) {
    const permitted = ceiling[name as keyof GitHubAppPermissions];
    if (!permitted || (level === "write" && permitted !== "write"))
      githubAppConflict();
  }
  return githubAppPermissionsSchema.parse(
    Object.fromEntries(
      Object.entries({ metadata: "read", ...selected }).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  );
}
export async function resolveGitHubCredential(
  context: GitHubCredentialContext,
  request: GitHubCredentialRequest,
): Promise<GitHubCredentialLease> {
  if (
    request.binding.kind === "actor" &&
    context.principal &&
    (context.principal.subject !== request.binding.subject ||
      (context.principal.tokenId ?? null) !== request.binding.tokenId ||
      context.principal.sourceId ||
      context.principal.reporterId)
  )
    githubAppConflict();
  const resolved = await readGitHubAuthReference(
    context,
    request.workspaceId,
    referenceId(request),
  );
  if (JSON.stringify(resolved) !== JSON.stringify(request.reference))
    githubAppConflict();
  const base = baseFence(context, request);
  const configurationCapability =
    request.capability === GITHUB_CAPABILITY.CONFIGURATION_READ ||
    request.capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE;
  if (
    base.connectionKind !==
    (configurationCapability ? "configuration" : "source")
  )
    githubAppConflict();
  if (base.actorExpiresAt !== null && base.actorExpiresAt <= context.now())
    githubAppConflict();
  if (
    request.capability === GITHUB_CAPABILITY.MAINTENANCE &&
    base.actorCapability !== CAPABILITY.OPERATE &&
    base.actorCapability !== CAPABILITY.ADMIN
  )
    githubAppConflict();
  if (
    (request.capability === GITHUB_CAPABILITY.CONFIGURATION_READ ||
      request.capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE) &&
    base.actorCapability !== CAPABILITY.SECRETS &&
    base.actorCapability !== CAPABILITY.ADMIN
  )
    githubAppConflict();
  if (
    request.binding.kind === "actor" &&
    context.principal?.scopes &&
    !context.principal.scopes.includes(base.actorCapability)
  )
    githubAppConflict();
  if (request.reference.kind === "token") {
    const token = await readToken(context, request);
    const fence: GitHubAuthorityFence = {
      ...base,
      kind: "token",
      reference: request.reference.reference,
      credentialIdentity: token.identity,
    };
    await assertGitHubAuthorityFence(context, fence);
    return {
      token: token.token,
      authorityIdentity: token.identity,
      quotaKey: token.quotaKey,
      observedAuthorityGeneration: null,
      validUntil: Math.min(
        token.expiresAt,
        base.actorExpiresAt ?? Infinity,
        context.now() + LIMITS.AUTHORITY_MAX_AGE_MS,
      ),
      fence,
    };
  }
  const row = await context.db
    .prepare(
      "SELECT metadata_json FROM github_app_grants WHERE id=? AND workspace_id=? AND state='active'",
    )
    .bind(request.reference.grantId, request.workspaceId)
    .first<{ metadata_json: string }>();
  if (!row) githubAppConflict();
  const grant = githubAppGrantSchema.parse(JSON.parse(row.metadata_json));
  const repository = grant.repositories.find(
    (value) =>
      value.fullName.toLowerCase() === request.repositoryFullName.toLowerCase(),
  );
  if (
    !repository ||
    !grant.capabilities.includes(request.capability) ||
    (grant.expiresAt && Date.parse(grant.expiresAt) <= context.now())
  )
    githubAppConflict();
  const registration = await context.db
    .prepare(
      "SELECT * FROM github_app_registrations WHERE id=? AND json_extract(metadata_json,'$.state')='active'",
    )
    .bind(grant.registrationId)
    .first<GitHubAppRegistrationRow>();
  if (
    !registration ||
    !githubAppMetadataSchema
      .parse(JSON.parse(registration.metadata_json))
      .capabilities.includes(request.capability)
  )
    githubAppConflict();
  const permissions = requiredPermissions(request);
  // Local access is checked before any provider request and again after the asynchronous checks
  const provisional: GitHubAuthorityFence = {
    ...base,
    kind: "app",
    registrationId: grant.registrationId,
    registrationRevision: registration.revision,
    keyRevision: registration.key_revision,
    installationId: grant.installationId,
    grantId: grant.id,
    grantRevision: grant.revision,
    providerRepositoryId: repository.id,
    observedAuthorityGeneration: 0,
  };
  const preflight = localFenceSql(provisional, { providerAuthority: false });
  if (
    !(await context.db
      .prepare(`SELECT 1 WHERE ${preflight.sql}`)
      .bind(...preflight.values)
      .first())
  )
    githubAppConflict();
  const observation = await verifyGitHubAppAuthority(
    context,
    {
      workspaceId: request.workspaceId,
      registrationId: grant.registrationId,
      installationId: grant.installationId,
      grantId: grant.id,
      grantRevision: grant.revision,
      repositoryId: repository.id,
    },
    request.phase === "effect" ? "fresh_effect" : "bounded_read",
  );
  for (const [name, level] of Object.entries(permissions)) {
    if (name === "metadata" && level === "read") continue;
    if (
      !observation.installation.permissions[name] ||
      (level === "write" &&
        observation.installation.permissions[name] !== "write" &&
        observation.installation.permissions[name] !== "admin")
    )
      throw new DomainError(
        "github_app_permission_missing",
        "GitHub has not granted the permission required for this operation. Review the installation's permissions.",
        403,
      );
  }
  const fence = {
    ...provisional,
    observedAuthorityGeneration: observation.generation,
  };
  await assertGitHubAuthorityFence(context, fence);
  const authorityIdentity = await credentialHash(
    JSON.stringify(["github-app", fence, observation.digest]),
  );
  const quotaKey = await githubAppQuotaKey(
    context,
    grant.appId,
    grant.installationId,
  );
  await assertGitHubAppCooldown(context, quotaKey);
  const cacheKey = JSON.stringify([
    authorityIdentity,
    request.capability,
    permissions,
  ]);
  let cache = caches.get(context.env);
  if (!cache) {
    cache = { entries: new Map(), pending: new Map() };
    caches.set(context.env, cache);
  }
  for (const [key, value] of cache.entries)
    if (value.expiresAt <= context.now() + LIMITS.TOKEN_MARGIN_MS)
      cache.entries.delete(key);
  let entry = cache.entries.get(cacheKey);
  if (!entry) {
    let pending = cache.pending.get(cacheKey);
    if (!pending) {
      if (cache.pending.size >= LIMITS.CACHE_ENTRIES)
        throw new DomainError(
          "github_app_busy",
          "Too many App token requests are already running. Retry this bounded request.",
          503,
        );
      const selectedCache = cache;
      pending = (async () => {
        try {
          const client = await openGitHubAppClient(context, registration);
          const value = await client.mintToken({
            installationId: grant.installationId,
            repositoryIds: [repository.id],
            permissions,
          });
          if (
            value.repositories[0].fullName.toLowerCase() !==
              repository.fullName.toLowerCase() ||
            value.repositories[0].ownerId !== repository.ownerId
          )
            githubAppConflict();
          await assertGitHubAuthorityFence(context, fence);
          const token = {
            token: value.token,
            expiresAt: Date.parse(value.expiresAt),
          };
          if (selectedCache.entries.size >= LIMITS.CACHE_ENTRIES)
            selectedCache.entries.delete(
              selectedCache.entries.keys().next().value!,
            );
          selectedCache.entries.set(cacheKey, token);
          return token;
        } catch (error) {
          await recordGitHubAppCooldown(context, quotaKey, error);
          throw error;
        }
      })();
      cache.pending.set(cacheKey, pending);
    }
    try {
      entry = await pending;
    } finally {
      if (cache.pending.get(cacheKey) === pending)
        cache.pending.delete(cacheKey);
    }
  }
  await assertGitHubAuthorityFence(context, fence);
  return {
    token: entry.token,
    authorityIdentity,
    quotaKey,
    observedAuthorityGeneration: observation.generation,
    validUntil: Math.min(
      entry.expiresAt - LIMITS.TOKEN_MARGIN_MS,
      Date.parse(observation.validUntil),
      base.actorExpiresAt ?? Infinity,
      grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity,
    ),
    fence,
  };
}
