import {
  CAPABILITY,
  LIMITS as WORKSPACE_LIMITS,
  workspaceInput,
} from "../shared/domain";
import {
  FLEET_DISCOVERY_LIMITS as LIMITS,
  fleetDiscoveryInput,
  fleetProviderResultSchema,
  type FleetDiscoveryResult,
  type FleetDiscoverySource,
  type FleetLookup,
  type FleetProviderRecord,
} from "../shared/fleet-discovery";
import {
  FleetAuthority,
  readFleetProvider,
  authorizeFleet,
  fleetActorGuard,
} from "./fleet-authority";
import {
  compareFleetRecords,
  type FleetInventoryRow,
} from "./fleet-comparison";
import { collectFleetDiscovery } from "./fleet-discovery-client";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";
import { SOURCE_LIMITS } from "../shared/sources";
import { githubConfigurationSchema } from "../shared/github";
import { githubCredential } from "./github-credentials";

export async function fleetInventory(
  authority: FleetAuthority,
): Promise<FleetInventoryRow[]> {
  const { context, workspaceId, sourceId } = authority;
  const guard = authority.guard();
  const rows = await context.db
    .prepare(
      `SELECT r.id,r.full_name AS fullName,r.project_id AS projectId,r.revision,r.classification,r.lifecycle,
    EXISTS(SELECT 1 FROM source_repositories sr WHERE sr.workspace_id=r.workspace_id AND sr.repository_id=r.id AND sr.source_id=?) AS collected,
    MIN(g.github_id) AS firstIdentity,MAX(g.github_id) AS lastIdentity
    FROM repositories r LEFT JOIN github_repository_identities g ON g.workspace_id=r.workspace_id AND g.repository_id=r.id AND g.full_name=r.full_name
    WHERE r.workspace_id=? AND ${guard.sql} GROUP BY r.id ORDER BY r.id LIMIT ?`,
    )
    .bind(
      sourceId,
      workspaceId,
      ...guard.values,
      WORKSPACE_LIMITS.MAX_REPOSITORIES + 1,
    )
    .all<
      Omit<FleetInventoryRow, "githubIds" | "collected"> & {
        collected: number;
        firstIdentity: string | null;
        lastIdentity: string | null;
      }
    >();
  if (rows.results.length > WORKSPACE_LIMITS.MAX_REPOSITORIES)
    throw new DomainError(
      "capacity",
      "HQ inventory exceeds the bounded enrollment allowance. Review workspace capacity first.",
      422,
    );
  await authority.assertLive();
  return rows.results.map(
    ({ firstIdentity, lastIdentity, collected, ...row }) => ({
      ...row,
      collected: Boolean(collected),
      githubIds: [
        ...new Set(
          [firstIdentity, lastIdentity].filter(
            (id): id is string => id !== null,
          ),
        ),
      ],
    }),
  );
}

export function fleetLookup(row: FleetInventoryRow): FleetLookup {
  return {
    repositoryId: row.id,
    fullName: row.fullName,
    githubId: row.githubIds.length === 1 ? row.githubIds[0] : null,
  };
}

export async function assertFleetLookups(
  authority: FleetAuthority,
  lookups: FleetLookup[],
) {
  if (!lookups.length) return;
  const guard = authority.guard();
  const matching = await authority.context.db
    .prepare(
      `SELECT 1 WHERE ${guard.sql}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) selected LEFT JOIN repositories r
      ON r.workspace_id=? AND r.id=json_extract(selected.value,'$.repositoryId')
      WHERE r.id IS NULL OR r.full_name<>json_extract(selected.value,'$.fullName'))`,
    )
    .bind(...guard.values, JSON.stringify(lookups), authority.workspaceId)
    .first();
  if (!matching) {
    await authority.assertLive();
    throw new DomainError(
      "revision_conflict",
      "A repository on this page moved or its name changed. Reload the discovery page.",
      409,
    );
  }
}

async function rememberFleetIdentities(
  authority: FleetAuthority,
  candidates: ReturnType<typeof compareFleetRecords>,
  observedAt: string,
) {
  const accepted = candidates.flatMap((row) =>
    row.repository &&
    row.provider &&
    row.read.state === "observed" &&
    row.state !== "conflict"
      ? [
          {
            repositoryId: row.repository.id,
            fullName: row.repository.fullName,
            githubId: row.provider.githubId,
          },
        ]
      : [],
  );
  if (!accepted.length) return;
  await authority.assertLive();
  const guard = authority.guard();
  await authority.context.db
    .prepare(
      `INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at)
    SELECT ?,?,r.id,json_extract(value,'$.githubId'),r.full_name,? FROM json_each(?) selected JOIN repositories r
      ON r.workspace_id=? AND r.id=json_extract(selected.value,'$.repositoryId') AND r.full_name=json_extract(selected.value,'$.fullName')
    WHERE ${guard.sql}
      AND NOT EXISTS(SELECT 1 FROM github_repository_identities g WHERE g.workspace_id=r.workspace_id AND g.repository_id=r.id AND g.full_name=r.full_name AND g.github_id<>json_extract(selected.value,'$.githubId'))
    ON CONFLICT(workspace_id,source_id,repository_id) DO UPDATE SET github_id=excluded.github_id,full_name=excluded.full_name,observed_at=excluded.observed_at
    WHERE github_repository_identities.full_name<>excluded.full_name OR (github_repository_identities.github_id=excluded.github_id AND github_repository_identities.observed_at<excluded.observed_at)`,
    )
    .bind(
      authority.workspaceId,
      authority.sourceId,
      observedAt,
      JSON.stringify(accepted),
      authority.workspaceId,
      ...guard.values,
    )
    .run();
}

export class FleetDiscoveryService {
  constructor(readonly context: WorkspaceService) {}
  async sources(input: unknown): Promise<FleetDiscoverySource[]> {
    const { workspaceId } = workspaceInput.parse(input);
    const revision = await authorizeFleet(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const guard = fleetActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      revision,
    );
    const rows = await this.context.db
      .prepare(
        `SELECT id,name,revision,enabled,credential_ref,configuration_json FROM connections WHERE workspace_id=? AND provider='github' AND ${guard.sql} ORDER BY name,id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, SOURCE_LIMITS.SOURCES)
      .all<{
        id: string;
        name: string;
        revision: number;
        enabled: number;
        credential_ref: string | null;
        configuration_json: string;
      }>();
    const sources = rows.results.map((row) => {
      let configured = false;
      try {
        configured = Boolean(
          githubCredential(this.context.env, workspaceId, row.credential_ref) &&
            githubConfigurationSchema.safeParse(
              JSON.parse(row.configuration_json),
            ).success,
        );
      } catch {
        configured = false;
      }
      return {
        id: row.id,
        name: row.name,
        revision: row.revision,
        enabled: Boolean(row.enabled),
        configured,
      };
    });
    if (
      (await authorizeFleet(this.context, workspaceId, CAPABILITY.ADMIN)) !==
      revision
    )
      throw new DomainError(
        "revision_conflict",
        "Workspace access changed. Reload the available GitHub sources.",
        409,
      );
    return sources;
  }
  async discover(input: unknown): Promise<FleetDiscoveryResult> {
    const fields = fleetDiscoveryInput.parse(input);
    const { workspaceId, sourceId, sourceRevision, scope } = fields;
    const authority = await FleetAuthority.open(
      this.context,
      workspaceId,
      sourceId,
      sourceRevision,
    );
    const initial = await fleetInventory(authority);
    const remaining =
      scope.kind === "enrolled"
        ? initial.filter(
            (row) => !scope.cursor || row.id > scope.cursor.repositoryId,
          )
        : [];
    const lookups = remaining.slice(0, LIMITS.PAGE_SIZE).map(fleetLookup);
    const result = await readFleetProvider(
      authority,
      {
        kind: "discover",
        scope,
        lookups: lookups.map(({ repositoryId, fullName }) => ({
          repositoryId,
          fullName,
        })),
      },
      fleetProviderResultSchema,
      (token) =>
        collectFleetDiscovery(scope, lookups, token, { now: this.context.now }),
      () => assertFleetLookups(authority, lookups),
    );
    let inventory = await fleetInventory(authority);
    const records: FleetProviderRecord[] = result.evidence?.records.length
      ? result.evidence.records
      : result.evidence && scope.kind === "enrolled"
        ? lookups.map((lookup) => ({
            repositoryId: lookup.repositoryId,
            lookupFullName: lookup.fullName,
            lookupGithubId: lookup.githubId,
            repository: null,
            read: result.evidence!.read,
          }))
        : [];
    let candidates = compareFleetRecords(records, inventory);
    if (result.evidence) {
      await rememberFleetIdentities(
        authority,
        candidates,
        result.evidence.observedAt,
      );
      inventory = await fleetInventory(authority);
      candidates = compareFleetRecords(records, inventory);
    }
    let nextScope: FleetDiscoveryResult["nextScope"] = null;
    if (
      result.evidence &&
      scope.kind === "owner" &&
      result.evidence.hasMore &&
      result.evidence.nextCursor
    )
      nextScope = {
        ...scope,
        cursor: {
          sourceId,
          sourceRevision,
          owner: scope.owner,
          after: result.evidence.nextCursor,
        },
      };
    if (
      result.evidence &&
      scope.kind === "enrolled" &&
      remaining.length > LIMITS.PAGE_SIZE
    )
      nextScope = {
        kind: "enrolled",
        cursor: {
          sourceId,
          sourceRevision,
          repositoryId: lookups[lookups.length - 1].repositoryId,
        },
      };
    const { records: omitted, ...evidence } = result.evidence ?? {
      records: [],
    };
    void omitted;
    const response: FleetDiscoveryResult = {
      workspaceId,
      source: {
        id: sourceId,
        name: authority.source.name,
        revision: sourceRevision,
      },
      scope,
      state: result.state,
      nextReadAt: result.nextReadAt,
      evidence: result.evidence
        ? {
            ...(evidence as NonNullable<FleetDiscoveryResult["evidence"]>),
            ...(scope.kind === "enrolled"
              ? { total: initial.length, hasMore: nextScope !== null }
              : {}),
          }
        : null,
      candidates,
      nextScope,
    };
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      LIMITS.RESPONSE_BYTES
    )
      throw new DomainError(
        "capacity",
        "The discovery page exceeded its bounded response allowance.",
        503,
      );
    await assertFleetLookups(authority, lookups);
    await authority.assertLive();
    return response;
  }
}
