import { z } from "zod";
import {
  activityFeedInput,
  goalActivityInput,
  type ActivityFeed,
  type ActivityFilters,
  type ActivityGroup,
  type GoalActivity,
} from "../shared/activity";
import type { Activity, Goal } from "../shared/domain";
import { DomainError } from "./errors";

const cursorSchema = z
  .object({
    version: z.literal(1),
    context: z.string().max(2000),
    watermark: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((value) => value.before <= value.watermark + 1);
type Cursor = z.infer<typeof cursorSchema>;
const ACTIVITY_FIELDS =
  "a.id, a.actor_name AS actor, a.type, a.title, a.summary, a.resource_id AS resourceId, a.goal_id AS goalId, a.created_at AS createdAt, a.github_source_id AS githubSourceId, a.github_refresh_id AS githubRefreshId, a.github_source_name AS githubSourceName";

function encodeCursor(cursor: Cursor) {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function context(filters: ActivityFilters, goalId: string | null) {
  return JSON.stringify([
    filters.workspaceId,
    filters.filter,
    filters.search,
    filters.repositoryId,
    goalId,
    ...(filters.projectId ? [filters.projectId] : []),
  ]);
}
function match(filters: ActivityFilters, watermark: number) {
  const conditions = [
    "a.workspace_id = ?",
    "o.workspace_id = a.workspace_id",
    "o.sequence <= ?",
  ];
  const values: (string | number)[] = [filters.workspaceId, watermark];
  if (filters.filter !== "all") {
    conditions.push(
      filters.filter === "goal"
        ? "a.type IN ('goal.active', 'goal.complete', 'goal.blocked', 'goal.paused', 'goal.cleared')"
        : "a.type = ?",
    );
    if (filters.filter !== "goal") values.push("update." + filters.filter);
  }
  if (filters.repositoryId) {
    conditions.push(`(a.resource_id = ? OR EXISTS (SELECT 1 FROM activity_repository_links ar
      WHERE ar.workspace_id=a.workspace_id AND ar.event_id=a.id AND ar.repository_id=?)
      OR (a.resource_id IS NULL AND a.goal_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM activity_repository_links own WHERE own.workspace_id=a.workspace_id AND own.event_id=a.id)
        AND EXISTS (
        SELECT 1 FROM activity related JOIN activity_order ro ON ro.event_id=related.id
        WHERE related.workspace_id=a.workspace_id AND related.goal_id=a.goal_id AND ro.sequence<=?
          AND (related.resource_id=? OR EXISTS (SELECT 1 FROM activity_repository_links rr
            WHERE rr.workspace_id=related.workspace_id AND rr.event_id=related.id AND rr.repository_id=?)))))`);
    values.push(
      filters.repositoryId,
      filters.repositoryId,
      watermark,
      filters.repositoryId,
      filters.repositoryId,
    );
  }
  if (filters.projectId) {
    conditions.push(`(EXISTS (SELECT 1 FROM activity_project_links ap
      WHERE ap.workspace_id=a.workspace_id AND ap.event_id=a.id AND ap.project_id=?)
      OR (a.resource_id IS NULL AND a.goal_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM activity_project_links own WHERE own.workspace_id=a.workspace_id AND own.event_id=a.id)
        AND NOT EXISTS (SELECT 1 FROM activity_repository_links own WHERE own.workspace_id=a.workspace_id AND own.event_id=a.id)
        AND EXISTS (SELECT 1 FROM activity related JOIN activity_order ro ON ro.event_id=related.id
          JOIN activity_project_links rp ON rp.workspace_id=related.workspace_id AND rp.event_id=related.id
          WHERE related.workspace_id=a.workspace_id AND related.goal_id=a.goal_id AND ro.sequence<=? AND rp.project_id=?)))`);
    values.push(filters.projectId, watermark, filters.projectId);
  }
  if (filters.search) {
    conditions.push(
      "instr(lower(a.title || ' ' || a.summary || ' ' || a.actor_name || ' ' || coalesce(g.objective, '')), lower(?)) > 0",
    );
    values.push(filters.search);
  }
  return { sql: conditions.join(" AND "), values };
}

export class ActivityReader {
  constructor(private readonly db: D1Database) {}

  private async cursor(
    filters: ActivityFilters,
    token: string | null,
    goalId: string | null,
  ): Promise<Cursor> {
    const expected = context(filters, goalId);
    if (token) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
        const bytes = Uint8Array.from(
          atob(token.replaceAll("-", "+").replaceAll("_", "/")),
          (character) => character.charCodeAt(0),
        );
        const cursor = cursorSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (cursor.context !== expected) throw new Error();
        return cursor;
      } catch {
        throw new DomainError(
          "invalid_cursor",
          "This activity page does not match the selected workspace or filters. Return to live activity.",
          400,
        );
      }
    }
    const row = await this.db
      .prepare(
        "SELECT coalesce(max(sequence), 0) AS watermark FROM activity_order WHERE workspace_id = ?",
      )
      .bind(filters.workspaceId)
      .first<{ watermark: number }>();
    const watermark = row!.watermark;
    return { version: 1, context: expected, watermark, before: watermark + 1 };
  }

  async feed(input: unknown): Promise<ActivityFeed> {
    const filters = activityFeedInput.parse(input);
    const cursor = await this.cursor(filters, filters.cursor, null);
    const where = match(filters, cursor.watermark);
    const rows = await this.db
      .prepare(
        `
      WITH grouped AS (
        SELECT CASE WHEN g.id IS NULL THEN 'event:' || a.id ELSE 'goal:' || a.goal_id END AS groupKey,
          CASE WHEN g.id IS NULL THEN NULL ELSE a.goal_id END AS goalId,
          count(*) AS eventCount, max(o.sequence) AS latestSequence
        FROM activity a JOIN activity_order o ON o.event_id = a.id
        LEFT JOIN goals g ON g.workspace_id = a.workspace_id AND g.id = a.goal_id
        WHERE ${where.sql} GROUP BY groupKey
      )
      SELECT grouped.eventCount, grouped.latestSequence, ${ACTIVITY_FIELDS}, g.source_id AS sourceId, g.objective,
        g.status, g.actor_name AS goalActor, g.started_at AS startedAt,
        g.reported_at AS reportedAt, g.received_at AS receivedAt
      FROM grouped JOIN activity_order o ON o.sequence = grouped.latestSequence
      JOIN activity a ON a.id = o.event_id
      LEFT JOIN goals g ON g.workspace_id = a.workspace_id AND g.id = grouped.goalId
      WHERE grouped.latestSequence < ? ORDER BY grouped.latestSequence DESC LIMIT ?
    `,
      )
      .bind(...where.values, cursor.before, filters.limit + 1)
      .all<
        Activity & {
          eventCount: number;
          latestSequence: number;
          sourceId: string | null;
          objective: string | null;
          status: Goal["status"] | null;
          goalActor: string | null;
          startedAt: string | null;
          reportedAt: string | null;
          receivedAt: string | null;
        }
      >();
    const selected = rows.results.slice(0, filters.limit);
    const groups: ActivityGroup[] = selected.map((row) =>
      row.objective !== null
        ? {
            kind: "goal",
            goal: {
              id: row.goalId!,
              sourceId: row.sourceId!,
              objective: row.objective,
              status: row.status!,
              actor: row.goalActor!,
              startedAt: row.startedAt!,
              reportedAt: row.reportedAt!,
              receivedAt: row.receivedAt!,
            },
            eventCount: row.eventCount,
            latestAt: row.createdAt,
            eventsCursor: encodeCursor({
              ...cursor,
              context: context(filters, row.goalId!),
              before: cursor.watermark + 1,
            }),
          }
        : {
            kind: "event",
            event: {
              id: row.id,
              actor: row.actor,
              type: row.type,
              title: row.title,
              summary: row.summary,
              resourceId: row.resourceId,
              goalId: row.goalId,
              createdAt: row.createdAt,
              githubSourceId: row.githubSourceId,
              githubRefreshId: row.githubRefreshId,
              githubSourceName: row.githubSourceName,
            },
          },
    );
    return {
      groups,
      viewCursor: encodeCursor(cursor),
      nextCursor:
        rows.results.length > filters.limit
          ? encodeCursor({ ...cursor, before: selected.at(-1)!.latestSequence })
          : null,
    };
  }

  async goal(input: unknown): Promise<GoalActivity> {
    const filters = goalActivityInput.parse(input);
    if (
      !(await this.db
        .prepare("SELECT 1 FROM goals WHERE workspace_id = ? AND id = ?")
        .bind(filters.workspaceId, filters.goalId)
        .first())
    )
      throw new DomainError("not_found", "Goal not found", 404);
    const cursor = await this.cursor(filters, filters.cursor, filters.goalId);
    const where = match(filters, cursor.watermark);
    const rows = await this.db
      .prepare(
        `SELECT ${ACTIVITY_FIELDS}, o.sequence FROM activity a
      JOIN activity_order o ON o.event_id = a.id
      JOIN goals g ON g.workspace_id = a.workspace_id AND g.id = a.goal_id
      WHERE ${where.sql} AND a.goal_id = ? AND o.sequence < ? ORDER BY o.sequence DESC LIMIT ?
    `,
      )
      .bind(...where.values, filters.goalId, cursor.before, filters.limit + 1)
      .all<Activity & { sequence: number }>();
    const selected = rows.results.slice(0, filters.limit);
    return {
      events: selected.map(({ sequence: _sequence, ...event }) => event),
      viewCursor: encodeCursor(cursor),
      nextCursor:
        rows.results.length > filters.limit
          ? encodeCursor({ ...cursor, before: selected.at(-1)!.sequence })
          : null,
    };
  }
}
