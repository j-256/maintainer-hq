import { z } from "zod";
import { idSchema, workspaceInput, type Activity, type Goal } from "./domain";

export const ACTIVITY_LIMITS = Object.freeze({
  PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 50,
  SEARCH_LENGTH: 200,
  CURSOR_LENGTH: 4096,
});
export const activityFeedInput = workspaceInput
  .extend({
    filter: z.enum(["all", "goal", "verification", "note"]).default("all"),
    search: z.string().trim().max(ACTIVITY_LIMITS.SEARCH_LENGTH).default(""),
    repositoryId: idSchema.nullable().default(null),
    projectId: idSchema.nullable().default(null),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_LIMITS.MAX_PAGE_SIZE)
      .default(ACTIVITY_LIMITS.PAGE_SIZE),
    cursor: z
      .string()
      .min(1)
      .max(ACTIVITY_LIMITS.CURSOR_LENGTH)
      .nullable()
      .default(null),
  })
  .strict();
export const goalActivityInput = activityFeedInput
  .extend({ goalId: idSchema })
  .strict();
export type ActivityFilters = Pick<
  z.infer<typeof activityFeedInput>,
  "workspaceId" | "filter" | "search" | "repositoryId" | "projectId"
>;
export type ActivityGroup =
  | {
      kind: "goal";
      goal: Goal;
      eventCount: number;
      latestAt: string;
      eventsCursor: string;
    }
  | { kind: "event"; event: Activity };
export type ActivityFeed = {
  groups: ActivityGroup[];
  nextCursor: string | null;
  viewCursor: string;
};
export type GoalActivity = {
  events: Activity[];
  nextCursor: string | null;
  viewCursor: string;
};
