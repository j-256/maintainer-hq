import {
  CAPABILITY,
  LIMITS,
  observationSchema,
  type Observation,
} from "../shared/domain";
import {
  COVERAGE_LIMITS,
  coverageAssessment,
  coverageEvidenceSchema,
  type CoverageResource,
} from "../shared/coverage-evidence";
import {
  repositoryCoverageInput,
  type RepositoryCoverage,
} from "../shared/repository-coverage";
import {
  monitorCheckState,
  monitorExecutionState,
} from "../shared/monitoring-freshness";
import { RESOURCE_LINK_LIMITS } from "../shared/resource-links";
import type { HookSubscription } from "../shared/hooks";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import { HooksService } from "./hooks";
import { MonitoringService } from "./monitoring";
import { MonitorProviderError } from "./monitoring-client";
import type { WorkspaceService } from "./service";
import { deliverWorkspacePush } from "./workspace-push";

type Link = {
  kind: "hook" | "monitor";
  connectionId: string;
  connectionName: string;
  enabled: number;
  connectionRevision: number;
  resourceKey: string;
  associationRevision: number;
  generation: number;
};
type Lease = {
  read_id: string;
  context_json: string;
  next_read_at: string;
  completed_at: string | null;
};
const linksSql = `SELECT l.kind,l.connection_id AS connectionId,c.name AS connectionName,c.enabled,
  c.revision AS connectionRevision,l.resource_key AS resourceKey,a.revision AS associationRevision,
  COALESCE(e.generation,0) AS generation FROM repository_resource_links l
  JOIN connections c ON c.workspace_id=l.workspace_id AND c.id=l.connection_id
    AND c.provider=CASE l.kind WHEN 'hook' THEN 'hookrelay' ELSE 'endpoint-monitor' END
  JOIN repository_resource_associations a ON a.workspace_id=l.workspace_id AND a.kind=l.kind
    AND a.connection_id=l.connection_id AND a.resource_key=l.resource_key
  LEFT JOIN operational_coverage_epochs e ON e.workspace_id=l.workspace_id AND e.connection_id=l.connection_id
  WHERE l.workspace_id=? AND l.repository_id=? ORDER BY l.kind,l.connection_id,l.resource_key`;
const contextSql = `SELECT json_group_array(json_object('kind',kind,'connectionId',connectionId,
  'connectionName',connectionName,'enabled',enabled,'connectionRevision',connectionRevision,
  'resourceKey',resourceKey,'associationRevision',associationRevision,'generation',generation)) AS value FROM (${linksSql})`;
const iso = (value: number) => new Date(value).toISOString();

export class RepositoryCoverageService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }

  async read(input: unknown, collect = true): Promise<RepositoryCoverage> {
    const { workspaceId, repositoryId } = repositoryCoverageInput.parse(input);
    const memberRevision = await authorizeHooks(this.context, workspaceId);
    const repository = await this.context.repository({
      workspaceId,
      repositoryId,
    });
    const links = (
      await this.db
        .prepare(linksSql + " LIMIT ?")
        .bind(workspaceId, repositoryId, RESOURCE_LINK_LIMITS.ASSOCIATIONS + 1)
        .all<Link>()
    ).results;
    if (links.length > RESOURCE_LINK_LIMITS.ASSOCIATIONS)
      throw new DomainError(
        "capacity",
        "This repository has too many operational links to inspect safely.",
        409,
      );
    const serialized = JSON.stringify(links);
    if (
      new Set(links.map((link) => link.connectionId)).size >
      COVERAGE_LIMITS.CONNECTIONS
    )
      throw new DomainError(
        "capacity",
        "This repository links more connections than one bounded coverage check can inspect. Inspect the resources in their provider workspaces; no new coverage was accepted.",
        409,
      );
    const existing = await this.db
      .prepare(
        "SELECT * FROM operational_coverage_reads WHERE workspace_id=? AND repository_id=?",
      )
      .bind(workspaceId, repositoryId)
      .first<Lease>();
    const now = this.context.now();
    if (!links.length)
      return this.result(workspaceId, repositoryId, links, "ready", null);
    if (existing && Date.parse(existing.next_read_at) > now)
      return this.result(
        workspaceId,
        repositoryId,
        links,
        existing.context_json !== serialized
          ? "cooldown"
          : existing.completed_at
            ? "ready"
            : "pending",
        existing.next_read_at,
      );
    if (!collect)
      return this.result(workspaceId, repositoryId, links, "ready", null);

    const readId = crypto.randomUUID();
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.READ,
      memberRevision,
    );
    const leaseUntil = iso(now + COVERAGE_LIMITS.LEASE_MS);
    const windowAt = iso(
      Math.floor(now / COVERAGE_LIMITS.REFRESH_MS) * COVERAGE_LIMITS.REFRESH_MS,
    );
    const acquired = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO operational_coverage_budgets(workspace_id,window_at,used)
        SELECT ?,?,1 WHERE ${guard.sql}
        ON CONFLICT(workspace_id) DO UPDATE SET window_at=excluded.window_at,
          used=CASE WHEN window_at<>excluded.window_at THEN 1 ELSE used+1 END
        WHERE window_at<>excluded.window_at OR used<?`,
        )
        .bind(
          workspaceId,
          windowAt,
          ...guard.values,
          COVERAGE_LIMITS.WORKSPACE_READS,
        ),
      this.db
        .prepare(
          `INSERT INTO operational_coverage_reads(workspace_id,repository_id,read_id,context_json,next_read_at,completed_at)
        SELECT ?,?,?,?,?,NULL WHERE changes()>0 AND ${guard.sql}
          AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=? AND revision=?)
          AND (${contextSql})=?
        ON CONFLICT(workspace_id,repository_id) DO UPDATE SET read_id=excluded.read_id,
          context_json=excluded.context_json,next_read_at=excluded.next_read_at,completed_at=NULL
        WHERE next_read_at<=?`,
        )
        .bind(
          workspaceId,
          repositoryId,
          readId,
          serialized,
          leaseUntil,
          ...guard.values,
          workspaceId,
          repositoryId,
          repository.revision,
          workspaceId,
          repositoryId,
          serialized,
          iso(now),
        ),
    ]);
    if (!acquired[1]!.meta.changes) {
      await authorizeHooks(this.context, workspaceId);
      return this.result(
        workspaceId,
        repositoryId,
        links,
        "cooldown",
        iso(Date.parse(windowAt) + COVERAGE_LIMITS.REFRESH_MS),
      );
    }

    let calls = 0;
    const reserve = () => {
      if (
        calls >= COVERAGE_LIMITS.PROVIDER_CALLS ||
        this.context.now() - now >= COVERAGE_LIMITS.ELAPSED_MS
      )
        return false;
      calls += 1;
      return true;
    };
    const selected = links.slice(0, COVERAGE_LIMITS.RESOURCES);
    const results = new Map<Link, CoverageResource>();
    const subscriptions = new Map<
      string,
      Promise<{
        items: HookSubscription[];
        complete: boolean;
        observedAt: string;
      }>
    >();
    const monitors = new Map<
      string,
      ReturnType<MonitoringService["snapshot"]>
    >();
    const readMonitor = (connectionId: string) => {
      let pending = monitors.get(connectionId);
      if (!pending && reserve()) {
        pending = new MonitoringService(this.context).snapshot({
          workspaceId,
          connectionId,
        });
        monitors.set(connectionId, pending);
      }
      return pending;
    };
    const readSubscriptions = (connectionId: string) => {
      let pending = subscriptions.get(connectionId);
      if (!pending) {
        pending = (async () => {
          const items: HookSubscription[] = [];
          let cursor: string | null = null;
          let observedAt = iso(now);
          for (
            let page = 0;
            page < COVERAGE_LIMITS.SUBSCRIPTION_PAGES;
            page++
          ) {
            if (!reserve()) return { items, complete: false, observedAt };
            const response = await new HooksService(this.context).subscriptions(
              { workspaceId, connectionId, cursor },
            );
            items.push(...response.result.items);
            observedAt = response.result.observedAt;
            if (response.result.disappeared)
              return { items, complete: false, observedAt };
            cursor = response.result.nextCursor;
            if (!cursor) return { items, complete: true, observedAt };
          }
          return { items, complete: false, observedAt };
        })();
        subscriptions.set(connectionId, pending);
      }
      return pending;
    };
    const inspect = async (link: Link): Promise<CoverageResource> => {
      const result: CoverageResource = {
        resourceKey: link.resourceKey,
        state: "unavailable",
        observedAt: null,
        freshUntil: null,
      };
      if (!link.enabled) return result;
      try {
        if (link.kind === "hook") {
          const response = await readSubscriptions(link.connectionId);
          const matches = response.items.filter(
            (item) => item.name === link.resourceKey,
          );
          const found = matches[0];
          result.state = !response.complete
            ? "limited"
            : matches.length > 1
              ? "ambiguous"
              : found
                ? found.enabled && found.sinks.length
                  ? "configured"
                  : "disabled"
                : "missing";
          result.observedAt = response.observedAt;
          result.freshUntil = iso(
            Math.min(
              now + COVERAGE_LIMITS.REFRESH_MS,
              Date.parse(response.observedAt) + COVERAGE_LIMITS.REFRESH_MS,
            ),
          );
        } else {
          const snapshot = await readMonitor(link.connectionId);
          if (!snapshot || !reserve()) return { ...result, state: "limited" };
          const response = await new MonitoringService(this.context).target({
            workspaceId,
            connectionId: link.connectionId,
            targetId: link.resourceKey,
          });
          const target = response.result.items[0]!;
          const state = monitorCheckState(target.evidence, this.context.now());
          result.state =
            state === "passed"
              ? "passing"
              : state === "failed"
                ? "failing"
                : state === "exceptional" || state === "incident"
                  ? state
                  : state === "stale"
                    ? "stale"
                    : state === "configuration_changed"
                      ? "changed"
                      : "unverified";
          result.observedAt = target.evidence.check.observedAt;
          result.freshUntil = target.evidence.check.freshUntil;
          if (
            target.evidence.state === "incident" &&
            target.evidence.configurationMatches === true &&
            target.evidence.incidentId
          )
            result.state = "incident";
          if (snapshot.result.enabled === false) result.state = "disabled";
          else if (
            snapshot.result.configuration?.revision !==
              response.result.configuration?.revision ||
            snapshot.result.configuration?.configFingerprint !==
              response.result.configuration?.configFingerprint
          )
            result.state = "changed";
          else if (result.state === "passing") {
            const execution = monitorExecutionState(
              snapshot.result.execution,
              this.context.now(),
            );
            const run = snapshot.result.execution.lastRun;
            if (
              !snapshot.result.configuration ||
              !response.result.configuration ||
              !snapshot.result.runtimeConfigured ||
              !snapshot.result.enabled ||
              !run?.enabled ||
              execution !== "fresh"
            )
              result.state = execution === "stale" ? "stale" : "unverified";
            else if (
              run.configurationRevision !==
                snapshot.result.configuration.revision ||
              run.configFingerprint !==
                snapshot.result.configuration.configFingerprint
            )
              result.state = "changed";
            else if (snapshot.result.execution.freshUntil && result.freshUntil)
              result.freshUntil = iso(
                Math.min(
                  Date.parse(result.freshUntil),
                  Date.parse(snapshot.result.execution.freshUntil),
                ),
              );
          }
          if (
            ["failing", "incident", "exceptional"].includes(result.state) &&
            target.evidence.observedAt &&
            (!result.observedAt ||
              target.evidence.observedAt > result.observedAt)
          )
            result.observedAt = target.evidence.observedAt;
        }
      } catch (error) {
        if (
          error instanceof DomainError &&
          ["forbidden", "revision_conflict"].includes(error.code)
        )
          throw error;
        result.state =
          error instanceof MonitorProviderError &&
          error.providerCode === "not_found"
            ? "missing"
            : "unavailable";
      }
      return result;
    };
    let index = 0;
    await Promise.all(
      Array.from({ length: COVERAGE_LIMITS.CONCURRENCY }, async () => {
        while (index < selected.length) {
          const link = selected[index++]!;
          results.set(link, await inspect(link));
        }
      }),
    );
    const completed = this.context.now();
    const freshUntil = iso(now + COVERAGE_LIMITS.REFRESH_MS);
    const nextReadAt = iso(completed + COVERAGE_LIMITS.REFRESH_MS);
    const groups = new Map<string, Link[]>();
    for (const link of links) {
      const group = groups.get(link.connectionId) ?? [];
      group.push(link);
      groups.set(link.connectionId, group);
    }
    const observations: Observation[] = [...groups.values()].map((group) => {
      const link = group[0]!;
      const resources = group.flatMap((item) =>
        results.has(item) ? [results.get(item)!] : [],
      );
      const coverage = coverageEvidenceSchema.parse({
        version: 1,
        connectionRevision: link.connectionRevision,
        readAt: iso(now),
        freshUntil,
        total: group.length,
        complete:
          resources.length === group.length &&
          resources.every(
            (item) => item.state !== "limited" && item.state !== "unavailable",
          ),
        resources,
      });
      const assessment = coverageAssessment(coverage, completed);
      const label = link.kind === "hook" ? "Hookrelay" : "Monitoring";
      const expiresAt = iso(
        Math.min(
          Date.parse(freshUntil),
          ...resources.flatMap((resource) =>
            ["passing", "failing", "configured"].includes(resource.state) &&
            resource.freshUntil
              ? [Date.parse(resource.freshUntil)]
              : [],
          ),
        ),
      );
      return {
        ...observationSchema.parse({
          sourceId: link.connectionId,
          resourceType: "repository",
          resourceId: repositoryId,
          name: repository.fullName,
          health: assessment.health,
          summary:
            assessment.health === "warning"
              ? label + " has a failing or missing linked resource."
              : assessment.satisfied
                ? label + " coverage verified from linked resources."
                : label + " coverage needs inspection.",
          observedAt: iso(now),
          expiresAt,
          details: { coverage },
        }),
        provider:
          link.kind === "hook"
            ? ("hookrelay" as const)
            : ("endpoint-monitor" as const),
        receivedAt: iso(completed),
      };
    });
    await authorizeHooks(this.context, workspaceId);
    const finalGuard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.READ,
      memberRevision,
    );
    const accepted = `EXISTS(SELECT 1 FROM operational_coverage_reads WHERE workspace_id=? AND repository_id=? AND read_id=? AND completed_at=?)`;
    const acceptedValues = [workspaceId, repositoryId, readId, iso(completed)];
    const saved = await this.db.batch([
      this.db
        .prepare(
          `UPDATE operational_coverage_reads SET completed_at=?,next_read_at=?
        WHERE workspace_id=? AND repository_id=? AND read_id=? AND next_read_at>? AND ${finalGuard.sql}
          AND EXISTS(SELECT 1 FROM repositories WHERE workspace_id=? AND id=? AND revision=?)
          AND (${contextSql})=?
          AND (SELECT COUNT(*) FROM observations WHERE workspace_id=?) + ? -
            (SELECT COUNT(*) FROM observations WHERE workspace_id=? AND resource_type='repository' AND resource_id=?
              AND source_id IN (SELECT value FROM json_each(?))) <= ?`,
        )
        .bind(
          iso(completed),
          nextReadAt,
          workspaceId,
          repositoryId,
          readId,
          iso(completed),
          ...finalGuard.values,
          workspaceId,
          repositoryId,
          repository.revision,
          workspaceId,
          repositoryId,
          serialized,
          workspaceId,
          observations.length,
          workspaceId,
          repositoryId,
          JSON.stringify([...groups.keys()]),
          LIMITS.MAX_OBSERVATIONS,
        ),
      ...observations.map((item) =>
        this.db
          .prepare(
            `INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${accepted}
        ON CONFLICT(workspace_id,source_id,resource_type,resource_id) DO UPDATE SET name=excluded.name,health=excluded.health,
          summary=excluded.summary,details_json=excluded.details_json,observed_at=excluded.observed_at,
          received_at=excluded.received_at,expires_at=excluded.expires_at`,
          )
          .bind(
            workspaceId,
            item.sourceId,
            item.resourceType,
            item.resourceId,
            item.name,
            item.health,
            item.summary,
            JSON.stringify(item.details),
            item.observedAt,
            item.receivedAt,
            item.expiresAt,
            ...acceptedValues,
          ),
      ),
    ]);
    if (!saved[0]!.meta.changes)
      throw new DomainError(
        "revision_conflict",
        "Access, resource links, provider configuration, or evidence capacity changed. No coverage result was accepted; inspect the saved settings before checking again.",
        409,
      );
    await deliverWorkspacePush(this.context.env, workspaceId);
    return this.result(workspaceId, repositoryId, links, "ready", nextReadAt);
  }

  private async result(
    workspaceId: string,
    repositoryId: string,
    links: Link[],
    phase: RepositoryCoverage["phase"],
    nextReadAt: string | null,
  ): Promise<RepositoryCoverage> {
    const memberRevision = await authorizeHooks(this.context, workspaceId);
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.READ,
      memberRevision,
    );
    const rows = await this.db
      .prepare(
        `SELECT json_object('sourceId',o.source_id,'resourceType',o.resource_type,
      'resourceId',o.resource_id,'name',o.name,'health',o.health,'summary',o.summary,'details',json(o.details_json),
      'observedAt',o.observed_at,'receivedAt',o.received_at,'expiresAt',o.expires_at,'provider',c.provider) AS value
      FROM observations o JOIN connections c ON c.workspace_id=o.workspace_id AND c.id=o.source_id
      WHERE o.workspace_id=? AND o.resource_type='repository' AND o.resource_id=? AND json_type(o.details_json,'$.coverage')='object'
        AND ${guard.sql} ORDER BY o.source_id LIMIT ?`,
      )
      .bind(
        workspaceId,
        repositoryId,
        ...guard.values,
        RESOURCE_LINK_LIMITS.ASSOCIATIONS,
      )
      .all<{ value: string }>();
    const observations = rows.results.map(
      (row) => JSON.parse(row.value) as Observation,
    );
    if (
      (await authorizeHooks(this.context, workspaceId)) !== memberRevision ||
      (await this.db
        .prepare(contextSql)
        .bind(workspaceId, repositoryId)
        .first<string>("value")) !== JSON.stringify(links)
    )
      throw new DomainError(
        "revision_conflict",
        "Workspace access or operational links changed during this read.",
        409,
      );
    await this.context.repository({ workspaceId, repositoryId });
    const connections = new Map(links.map((link) => [link.connectionId, link]));
    const result: RepositoryCoverage = {
      repositoryId,
      phase,
      nextReadAt,
      generatedAt: iso(this.context.now()),
      links: {
        hooks: links.filter((link) => link.kind === "hook").length,
        monitoring: links.filter((link) => link.kind === "monitor").length,
      },
      evidence: observations.flatMap((observation) => {
        const link = connections.get(observation.sourceId);
        const coverage = observation.details.coverage;
        if (
          observation.resourceType !== "repository" ||
          observation.resourceId !== repositoryId ||
          !link ||
          !coverage
        )
          return [];
        return [
          {
            connectionId: link.connectionId,
            connectionName: link.connectionName,
            kind: link.kind,
            observation: { ...observation, details: { coverage } },
          },
        ];
      }),
    };
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      COVERAGE_LIMITS.RESPONSE_BYTES
    )
      throw new DomainError(
        "capacity",
        "This coverage result exceeds the response limit. Inspect the resources individually.",
        409,
      );
    return result;
  }
}
