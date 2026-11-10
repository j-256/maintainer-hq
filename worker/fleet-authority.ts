import { GITHUB_CAPABILITY } from "../shared/github-apps";
import type { z } from "zod";
import { CAPABILITY, type Capability } from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import { GITHUB_CONTEXT_LIMITS as LIMITS } from "../shared/github-context";
import {
  type FleetProviderResult,
  FLEET_DISCOVERY_LIMITS,
} from "../shared/fleet-discovery";
import {
  githubCredentialDescriptor,
  type GitHubCredentialDescriptor,
} from "./github-credential-descriptors";
import {
  resolveGitHubDiscoveryAuthority,
  resolveGitHubDiscoveryToken,
  resolveGitHubManualCollectionToken,
  assertGitHubDiscoveryAuthority,
  githubDiscoveryAuthoritySql,
  type GitHubDiscoveryAuthority,
} from "./github-credential-resolver";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

type Source = {
  name: string;
  revision: number;
  enabled: number;
  credential_ref: string | null;
  configuration_json: string;
};
type Credential = GitHubCredentialDescriptor | null;
type Cache = {
  identity: string;
  lease_id: string | null;
  lease_until: string | null;
  next_read_at: string;
  result_json: string | null;
};
const SOURCE =
  "SELECT name, revision, enabled, credential_ref, configuration_json FROM connections WHERE workspace_id=? AND id=? AND provider='github'";
const CACHE =
  "SELECT identity, lease_id, lease_until, next_read_at, result_json FROM github_discovery_cache WHERE workspace_id=? AND source_id=?";

function assertSession(context: WorkspaceService) {
  if (
    context.principal.expiresAt !== undefined &&
    context.principal.expiresAt <= context.now()
  )
    throw new DomainError(
      "unauthorized",
      "Renew your workspace sign-in before reviewing fleet enrollment.",
      401,
    );
}

export function fleetActorGuard(
  context: WorkspaceService,
  workspaceId: string,
  capability: Capability = CAPABILITY.READ,
  memberRevision: number | null = null,
) {
  const actor = hookActorGuard(
    context,
    workspaceId,
    capability,
    memberRevision,
  );
  const expiry =
    context.principal.expiresAt === undefined
      ? null
      : new Date(context.principal.expiresAt).toISOString();
  return {
    sql: `${actor.sql} AND (? IS NULL OR (? > ? AND julianday(?) > julianday('now')))`,
    values: [
      ...actor.values,
      expiry,
      expiry,
      new Date(context.now()).toISOString(),
      expiry,
    ],
  };
}

export async function authorizeFleet(
  context: WorkspaceService,
  workspaceId: string,
  capability: Capability = CAPABILITY.READ,
) {
  assertSession(context);
  const revision = await authorizeHooks(context, workspaceId, capability);
  assertSession(context);
  return revision;
}

export class FleetAuthority {
  discoveryAuthority: GitHubDiscoveryAuthority | null = null;
  private constructor(
    readonly context: WorkspaceService,
    readonly workspaceId: string,
    readonly sourceId: string,
    readonly source: Source,
    readonly credential: Credential,
    readonly memberRevision: number,
  ) {}
  static async open(
    context: WorkspaceService,
    workspaceId: string,
    sourceId: string,
    revision: number,
  ) {
    const memberRevision = await authorizeFleet(
      context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const actor = fleetActorGuard(
      context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const source = await context.db
      .prepare(SOURCE + ` AND ${actor.sql}`)
      .bind(workspaceId, sourceId, ...actor.values)
      .first<Source>();
    if (!source) {
      await authorizeFleet(context, workspaceId, CAPABILITY.ADMIN);
      throw new DomainError(
        "not_found",
        "The selected GitHub source is not available in this workspace.",
        404,
      );
    }
    if (source.revision !== revision)
      throw new DomainError(
        "revision_conflict",
        "GitHub source settings changed. Reload the source before reviewing enrollment.",
        409,
      );
    const credential = await githubCredentialDescriptor(
      context,
      workspaceId,
      source.credential_ref,
    );
    const authority = new FleetAuthority(
      context,
      workspaceId,
      sourceId,
      source,
      credential,
      memberRevision,
    );
    await authority.assertLive();
    return authority;
  }
  get configured() {
    try {
      return Boolean(
        this.credential?.available &&
        this.credential.capabilities.includes(GITHUB_CAPABILITY.COLLECTION) &&
        githubConfigurationSchema.safeParse(
          JSON.parse(this.source.configuration_json),
        ).success,
      );
    } catch {
      return false;
    }
  }
  guard() {
    const actor = fleetActorGuard(
      this.context,
      this.workspaceId,
      CAPABILITY.ADMIN,
      this.memberRevision,
    );
    const observed = this.discoveryAuthority
      ? githubDiscoveryAuthoritySql(this.discoveryAuthority)
      : { sql: "1", values: [] };
    return {
      sql: `EXISTS (${SOURCE} AND revision=? AND enabled=? AND credential_ref IS ? AND configuration_json=? AND ${actor.sql}) AND ${observed.sql}`,
      values: [
        this.workspaceId,
        this.sourceId,
        this.source.revision,
        this.source.enabled,
        this.source.credential_ref,
        this.source.configuration_json,
        ...actor.values,
        ...observed.values,
      ],
    };
  }
  async prepareRead() {
    if (this.credential?.kind !== "app") return;
    this.discoveryAuthority = await resolveGitHubDiscoveryAuthority(
      this.context,
      {
        workspaceId: this.workspaceId,
        reference: this.credential.reference,
        connectionId: this.sourceId,
        connectionRevision: this.source.revision,
        binding: {
          kind: "actor",
          subject: this.context.principal.subject,
          tokenId: this.context.principal.tokenId ?? null,
          membershipRevision: this.memberRevision,
        },
      },
    );
  }
  restrictProviderResult(result: FleetProviderResult): FleetProviderResult {
    if (!this.discoveryAuthority) return result;
    const names = new Set(
      this.discoveryAuthority.repositories.map((repository) =>
        repository.fullName.toLowerCase(),
      ),
    );
    let denied = false;
    const records = result.records.flatMap((record) => {
      if (
        (!record.lookupFullName ||
          names.has(record.lookupFullName.toLowerCase())) &&
        (!record.repository ||
          names.has(record.repository.fullName.toLowerCase()))
      )
        return [record];
      denied = true;
      return record.repositoryId === null
        ? []
        : [
            {
              ...record,
              repository: null,
              read: {
                state: "unavailable" as const,
                reason: "permission" as const,
              },
            },
          ];
    });
    return {
      ...result,
      records,
      total: result.owner ? null : result.total,
      read: denied
        ? {
            state: records.length ? "limited" : "unavailable",
            reason: "permission",
          }
        : result.read,
    };
  }
  async privateToken() {
    if (!this.credential || !this.source.credential_ref)
      throw new DomainError(
        "not_configured",
        "Choose a GitHub credential.",
        409,
      );
    await this.assertLive();
    return this.discoveryAuthority
      ? resolveGitHubDiscoveryToken(this.context, this.discoveryAuthority)
      : resolveGitHubManualCollectionToken(
          this.context,
          this.workspaceId,
          this.source.credential_ref,
          this.credential.hash,
        );
  }
  async assertLive() {
    const { context, workspaceId, sourceId } = this;
    assertSession(context);
    const actor = fleetActorGuard(
      context,
      workspaceId,
      CAPABILITY.ADMIN,
      this.memberRevision,
    );
    const latest = await context.db
      .prepare(SOURCE + ` AND ${actor.sql}`)
      .bind(workspaceId, sourceId, ...actor.values)
      .first<Source>();
    if (!latest) {
      await authorizeFleet(context, workspaceId, CAPABILITY.ADMIN);
      throw new DomainError(
        "revision_conflict",
        "Your membership or GitHub source changed. Reload fleet enrollment.",
        409,
      );
    }
    const credential = await githubCredentialDescriptor(
      context,
      workspaceId,
      latest.credential_ref,
    );
    assertSession(context);
    if (this.discoveryAuthority)
      await assertGitHubDiscoveryAuthority(context, this.discoveryAuthority);
    if (
      JSON.stringify(latest) !== JSON.stringify(this.source) ||
      credential?.hash !== this.credential?.hash
    )
      throw new DomainError(
        "revision_conflict",
        "GitHub source access changed. Reload fleet enrollment.",
        409,
      );
  }
}

export type FleetProviderRead<T> = {
  state: "ready" | "collecting" | "waiting" | "disabled" | "not_configured";
  nextReadAt: string | null;
  evidence: T | null;
};

export async function readFleetProvider<T extends { retryAt: string | null }>(
  authority: FleetAuthority,
  key: unknown,
  schema: z.ZodType<T>,
  collect: (token: string) => Promise<T>,
  validate: () => Promise<void> = async () => {},
): Promise<FleetProviderRead<T>> {
  const { context, workspaceId, sourceId } = authority;
  const { db } = context;
  const keys = [workspaceId, sourceId];
  const finish = async (
    state: FleetProviderRead<T>["state"],
    nextReadAt: string | null,
    stored: string | null,
  ): Promise<FleetProviderRead<T>> => {
    await validate();
    await authority.assertLive();
    try {
      return {
        state,
        nextReadAt,
        evidence: stored ? schema.parse(JSON.parse(stored)) : null,
      };
    } catch {
      throw new DomainError(
        "provider_unavailable",
        "Saved fleet discovery could not be verified. Retry the bounded read after its cooldown.",
        503,
      );
    }
  };
  if (!authority.source.enabled) return finish("disabled", null, null);
  if (!authority.configured || !authority.credential)
    return finish("not_configured", null, null);
  const credential = authority.credential;
  await authority.prepareRead();
  const authorityIdentity =
    authority.discoveryAuthority?.authorityIdentity ?? credential.hash;
  const quotaKey = credential.quotaKey;
  const identity = JSON.stringify([
    authority.source.revision,
    authorityIdentity,
    key,
  ]);
  if (
    new TextEncoder().encode(identity).byteLength >
    FLEET_DISCOVERY_LIMITS.IDENTITY_BYTES
  )
    throw new DomainError(
      "capacity",
      "The selected discovery page is too large.",
      422,
    );
  const cached = await db
    .prepare(CACHE)
    .bind(...keys)
    .first<Cache>();
  const now = context.now();
  const timestamp = new Date(now).toISOString();
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
  const cooldown = await db
    .prepare(
      "SELECT retry_at FROM github_cooldowns WHERE credential_hash=? AND retry_at>?",
    )
    .bind(quotaKey, timestamp)
    .first<string>("retry_at");
  if (cooldown)
    return finish(
      "waiting",
      cooldown,
      cached?.identity === identity ? cached.result_json : null,
    );
  await validate();
  await authority.assertLive();
  const guard = authority.guard();
  const lease = crypto.randomUUID();
  const leaseUntil = new Date(now + LIMITS.LEASE_MS).toISOString();
  const nextReadAt = new Date(now + LIMITS.CACHE_MS).toISOString();
  const windowStart =
    Math.floor(now / LIMITS.BUDGET_WINDOW_MS) * LIMITS.BUDGET_WINDOW_MS;
  await db.batch([
    db
      .prepare(
        `INSERT INTO github_context_budgets(credential_hash,window_start,reads) SELECT ?,?,0 WHERE ${guard.sql}
      ON CONFLICT(credential_hash) DO UPDATE SET window_start=excluded.window_start,reads=0 WHERE github_context_budgets.window_start<excluded.window_start`,
      )
      .bind(quotaKey, windowStart, ...guard.values),
    db
      .prepare(
        `INSERT INTO github_discovery_cache(workspace_id,source_id,identity,lease_id,lease_until,next_read_at,result_json)
      SELECT ?,?,?,?,?,?,NULL WHERE ${guard.sql}
      AND EXISTS(SELECT 1 FROM github_context_budgets WHERE credential_hash=? AND window_start=? AND reads<?)
      AND NOT EXISTS(SELECT 1 FROM github_cooldowns WHERE credential_hash=? AND retry_at>?)
      ON CONFLICT(workspace_id,source_id) DO UPDATE SET identity=excluded.identity,lease_id=excluded.lease_id,lease_until=excluded.lease_until,next_read_at=excluded.next_read_at,result_json=NULL
      WHERE (github_discovery_cache.identity<>excluded.identity OR github_discovery_cache.next_read_at<=?) AND (github_discovery_cache.lease_until IS NULL OR github_discovery_cache.lease_until<=?)`,
      )
      .bind(
        ...keys,
        identity,
        lease,
        leaseUntil,
        nextReadAt,
        ...guard.values,
        quotaKey,
        windowStart,
        LIMITS.READS_PER_WINDOW,
        quotaKey,
        timestamp,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `UPDATE github_context_budgets SET reads=reads+1 WHERE credential_hash=? AND window_start=? AND EXISTS(${CACHE} AND lease_id=?)`,
      )
      .bind(quotaKey, windowStart, ...keys, lease),
  ]);
  const claimed = await db
    .prepare(CACHE)
    .bind(...keys)
    .first<Cache>();
  if (claimed?.lease_id !== lease) {
    const matching = claimed?.identity === identity;
    const deadline =
      claimed?.lease_until && claimed.lease_until > timestamp
        ? claimed.lease_until
        : matching && claimed.next_read_at > timestamp
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
  await validate();
  await authority.assertLive();
  const evidence = schema.parse(await collect(await authority.privateToken()));
  const stored = JSON.stringify(evidence);
  if (
    new TextEncoder().encode(stored).byteLength >
    FLEET_DISCOVERY_LIMITS.PROVIDER_BYTES
  )
    throw new DomainError(
      "capacity",
      "The provider discovery result exceeded its bounded storage allowance.",
      503,
    );
  await validate();
  await authority.assertLive();
  const next =
    evidence.retryAt && evidence.retryAt > nextReadAt
      ? evidence.retryAt
      : nextReadAt;
  const statements = [];
  if (evidence.retryAt)
    statements.push(
      db
        .prepare(
          `INSERT INTO github_cooldowns(credential_hash,retry_at) SELECT ?,? WHERE ${guard.sql}
      ON CONFLICT(credential_hash) DO UPDATE SET retry_at=MAX(github_cooldowns.retry_at,excluded.retry_at)`,
        )
        .bind(quotaKey, evidence.retryAt, ...guard.values),
    );
  statements.push(
    db
      .prepare(
        `UPDATE github_discovery_cache SET result_json=?,lease_until=NULL,next_read_at=?
    WHERE workspace_id=? AND source_id=? AND identity=? AND lease_id=? AND lease_until>? AND ${guard.sql}`,
      )
      .bind(
        stored,
        next,
        ...keys,
        identity,
        lease,
        new Date(context.now()).toISOString(),
        ...guard.values,
      ),
  );
  await db.batch(statements);
  const accepted = await db
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
      "revision_conflict",
      "The discovery read expired or its source changed. Reload fleet enrollment.",
      409,
    );
  return finish("ready", next, stored);
}
