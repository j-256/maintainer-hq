import { COVERAGE_LIMITS } from "../shared/coverage-evidence";
import { LIMITS } from "../shared/domain";
import {
  callHookProvider,
  hookProvider,
  hookProviderActor,
} from "./hook-client";
import {
  hookCoverageObservation,
  readHookInventory,
  type HookInventory,
} from "./hook-coverage";
import { emitDiagnostic } from "./diagnostics";
import { deliverWorkspacePush } from "./workspace-push";
import type { Env } from "./types";

const iso = (value: number) => new Date(value).toISOString();
const linkContext = `SELECT json_group_array(json_object('key',resource_key,'revision',revision)) FROM (
  SELECT l.resource_key,a.revision FROM repository_resource_links l
  JOIN repository_resource_associations a ON a.workspace_id=l.workspace_id AND a.kind=l.kind
    AND a.connection_id=l.connection_id AND a.resource_key=l.resource_key
  WHERE l.workspace_id=r.workspace_id AND l.repository_id=r.id AND l.connection_id=? AND l.kind='hook'
  ORDER BY l.resource_key)`;
type Source = {
  workspace_id: string;
  id: string;
  revision: number;
  credential_ref: string;
  generation: number;
  repository_cursor: string | null;
};
type Repository = {
  id: string;
  full_name: string;
  revision: number;
  links_json: string;
};

export async function runHookCoverageScheduled(
  env: Env,
  now: () => number = Date.now,
) {
  const db = env.HQ_DB;
  const runId = crypto.randomUUID();
  const started = now();
  let processed = 0;
  let stored = 0;
  let calls = 0;
  let limited = false;
  let failed = false;
  try {
    const sources = (
      await db
        .prepare(
          `SELECT c.workspace_id,c.id,c.revision,c.credential_ref,
      COALESCE(e.generation,0) AS generation,s.repository_cursor FROM connections c
      LEFT JOIN hook_coverage_refreshes s ON s.workspace_id=c.workspace_id AND s.connection_id=c.id
      LEFT JOIN operational_coverage_epochs e ON e.workspace_id=c.workspace_id AND e.connection_id=c.id
      WHERE c.provider='hookrelay' AND c.enabled=1 AND (s.next_read_at IS NULL OR s.next_read_at<=?)
        AND EXISTS(SELECT 1 FROM repository_resource_links l WHERE l.workspace_id=c.workspace_id AND l.connection_id=c.id AND l.kind='hook')
      ORDER BY s.next_read_at,c.workspace_id,c.id LIMIT ?`,
        )
        .bind(iso(started), COVERAGE_LIMITS.SCHEDULE_CONNECTIONS)
        .all<Source>()
    ).results;
    for (const source of sources) {
      if (now() - started >= COVERAGE_LIMITS.ELAPSED_MS) {
        limited = true;
        break;
      }
      const readId = crypto.randomUUID();
      const authority = `EXISTS(SELECT 1 FROM connections c LEFT JOIN operational_coverage_epochs e
        ON e.workspace_id=c.workspace_id AND e.connection_id=c.id
        WHERE c.workspace_id=? AND c.id=? AND c.provider='hookrelay' AND c.enabled=1
          AND c.revision=? AND c.credential_ref=? AND COALESCE(e.generation,0)=?)`;
      const authorityValues = [
        source.workspace_id,
        source.id,
        source.revision,
        source.credential_ref,
        source.generation,
      ];
      const claimed = await db
        .prepare(
          `INSERT INTO hook_coverage_refreshes(workspace_id,connection_id,read_id,next_read_at)
        SELECT ?,?,?,? WHERE ${authority}
        ON CONFLICT(workspace_id,connection_id) DO UPDATE SET read_id=excluded.read_id,next_read_at=excluded.next_read_at,completed_at=NULL
        WHERE next_read_at<=? AND repository_cursor IS ?`,
        )
        .bind(
          source.workspace_id,
          source.id,
          readId,
          iso(now() + COVERAGE_LIMITS.LEASE_MS),
          ...authorityValues,
          iso(now()),
          source.repository_cursor,
        )
        .run();
      if (!claimed.meta.changes) continue;
      processed++;
      const diagnose = (
        state: "complete" | "limited" | "unavailable" | "changed",
        accepted = 0,
      ) =>
        emitDiagnostic({
          event: "hq.hooks.coverage.source",
          runId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          state,
          stored: accepted,
        });
      const readAt = now();
      const page = (
        await db
          .prepare(
            `SELECT r.id,r.full_name,r.revision,(${linkContext}) AS links_json
        FROM repositories r WHERE r.workspace_id=? AND r.id>?
        AND EXISTS(SELECT 1 FROM repository_resource_links l WHERE l.workspace_id=r.workspace_id
          AND l.repository_id=r.id AND l.connection_id=? AND l.kind='hook')
        ORDER BY r.id LIMIT ?`,
          )
          .bind(
            source.id,
            source.workspace_id,
            source.repository_cursor ?? "",
            source.id,
            COVERAGE_LIMITS.SCHEDULE_REPOSITORIES + 1,
          )
          .all<Repository>()
      ).results;
      const repositories = page.slice(0, COVERAGE_LIMITS.SCHEDULE_REPOSITORIES);
      const more = page.length > repositories.length;
      let inventory: HookInventory | null = null;
      let identity: string | null = null;
      try {
        const provider = await hookProvider(
          env,
          source.workspace_id,
          source.credential_ref,
        );
        identity = provider.identity;
        const actor = await hookProviderActor("system:hook-coverage-collector");
        inventory = await readHookInventory(
          async (cursor) => {
            const response = await callHookProvider(
              provider,
              "subscriptions",
              source.workspace_id,
              actor,
              { cursor },
            );
            return response.result;
          },
          () => {
            if (now() - started >= COVERAGE_LIMITS.ELAPSED_MS) return false;
            calls++;
            return true;
          },
          now,
        );
        if (!inventory.complete) limited = true;
      } catch {
        failed = true;
      }
      if (identity) {
        try {
          if (
            (
              await hookProvider(
                env,
                source.workspace_id,
                source.credential_ref,
              )
            ).identity !== identity
          ) {
            limited = true;
            diagnose("changed");
            continue;
          }
        } catch {
          limited = true;
          diagnose("changed");
          continue;
        }
      }
      const completed = now();
      const observations = repositories.map((repository) =>
        hookCoverageObservation({
          connectionId: source.id,
          connectionRevision: source.revision,
          repositoryId: repository.id,
          fullName: repository.full_name,
          resourceKeys: (
            JSON.parse(repository.links_json) as { key: string }[]
          ).map((link) => link.key),
          inventory,
          now: readAt,
          completed,
        }),
      );
      limited ||= observations.some((item) => !item.details.coverage?.complete);
      const accepted = `EXISTS(SELECT 1 FROM hook_coverage_refreshes WHERE workspace_id=? AND connection_id=? AND read_id=? AND completed_at=?)`;
      const acceptedValues = [
        source.workspace_id,
        source.id,
        readId,
        iso(completed),
      ];
      const saved = await db.batch([
        db
          .prepare(
            `UPDATE hook_coverage_refreshes SET completed_at=?,next_read_at=?,repository_cursor=?
          WHERE workspace_id=? AND connection_id=? AND read_id=? AND next_read_at>? AND ${authority}`,
          )
          .bind(
            iso(completed),
            iso(
              completed +
                (more
                  ? COVERAGE_LIMITS.REFRESH_MS
                  : COVERAGE_LIMITS.HOOK_SCHEDULE_MS),
            ),
            more ? repositories.at(-1)!.id : null,
            source.workspace_id,
            source.id,
            readId,
            iso(completed),
            ...authorityValues,
          ),
        ...observations.map((item, index) => {
          const repository = repositories[index]!;
          return db
            .prepare(
              `INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at)
            SELECT ?,?,'repository',?,?,?,?,?,?,?,? WHERE ${accepted}
              AND EXISTS(SELECT 1 FROM repositories r WHERE r.workspace_id=? AND r.id=? AND r.revision=? AND (${linkContext})=?)
              AND ((SELECT COUNT(*) FROM observations WHERE workspace_id=?)<? OR EXISTS(
                SELECT 1 FROM observations WHERE workspace_id=? AND source_id=? AND resource_type='repository' AND resource_id=?))
            ON CONFLICT(workspace_id,source_id,resource_type,resource_id) DO UPDATE SET
              name=excluded.name,health=excluded.health,summary=excluded.summary,details_json=excluded.details_json,
              observed_at=excluded.observed_at,received_at=excluded.received_at,expires_at=excluded.expires_at
            WHERE observations.observed_at<=excluded.observed_at`,
            )
            .bind(
              source.workspace_id,
              source.id,
              item.resourceId,
              item.name,
              item.health,
              item.summary,
              JSON.stringify(item.details),
              item.observedAt,
              item.receivedAt,
              item.expiresAt,
              ...acceptedValues,
              source.workspace_id,
              repository.id,
              repository.revision,
              source.id,
              repository.links_json,
              source.workspace_id,
              LIMITS.MAX_OBSERVATIONS,
              source.workspace_id,
              source.id,
              repository.id,
            );
        }),
      ]);
      const acceptedCount = saved
        .slice(1)
        .filter((result) => result.meta.changes > 0).length;
      stored += acceptedCount;
      limited ||=
        !saved[0]!.meta.changes || acceptedCount < observations.length;
      diagnose(
        !saved[0]!.meta.changes
          ? "changed"
          : !inventory
            ? "unavailable"
            : acceptedCount < observations.length ||
                observations.some((item) => !item.details.coverage?.complete)
              ? "limited"
              : "complete",
        acceptedCount,
      );
      if (acceptedCount) await deliverWorkspacePush(env, source.workspace_id);
    }
  } catch {
    failed = true;
    throw new Error(
      "Scheduled Hook coverage interrupted; inspect its correlated diagnostic and retained evidence",
    );
  } finally {
    emitDiagnostic({
      event: "hq.hooks.coverage.completed",
      runId,
      processed,
      stored,
      requests: calls,
      limited,
      failed,
      elapsedMs: Math.max(0, now() - started),
    });
  }
}
