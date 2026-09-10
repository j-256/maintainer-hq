import { z } from "zod";

export const GOAL_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  PAUSED: "paused",
  CLEARED: "cleared",
} as const);
export const goalStatusSchema = z.enum(GOAL_STATUS);
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = Object.freeze({
  active: "In progress",
  complete: "Complete",
  blocked: "Blocked",
  paused: "Paused",
  cleared: "Cleared",
});

export function isOpenGoal(status: GoalStatus) {
  return status !== GOAL_STATUS.COMPLETE && status !== GOAL_STATUS.CLEARED;
}

export const GOAL_FRESHNESS_MS = 5 * 60 * 1000;

export function isGoalReportStale(
  goal: { status: GoalStatus; reportedAt: string; receivedAt: string },
  now: number,
) {
  return (
    (goal.status === GOAL_STATUS.ACTIVE ||
      goal.status === GOAL_STATUS.BLOCKED) &&
    now - Math.min(Date.parse(goal.reportedAt), Date.parse(goal.receivedAt)) >
      GOAL_FRESHNESS_MS
  );
}
