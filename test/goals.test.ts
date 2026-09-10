import { describe, expect, it } from "vitest";
import {
  GOAL_FRESHNESS_MS,
  goalStatusSchema,
  isGoalReportStale,
  isOpenGoal,
} from "../shared/goals";

const report = {
  reportedAt: "2026-01-01T00:00:00Z",
  receivedAt: "2026-01-01T00:01:00Z",
};

describe("Goal lifecycle presentation", () => {
  it("distinguishes paused open work from cleared or completed history", () => {
    for (const status of ["active", "blocked", "paused"] as const)
      expect(isOpenGoal(status)).toBe(true);
    for (const status of ["complete", "cleared"] as const)
      expect(isOpenGoal(status)).toBe(false);
    expect(goalStatusSchema.safeParse("unknown").success).toBe(false);
  });
  it("ages execution reports by the earlier source or receipt time, not dashboard refresh", () => {
    const instant = Date.parse(report.reportedAt);
    for (const status of ["active", "blocked"] as const) {
      expect(
        isGoalReportStale({ ...report, status }, instant + GOAL_FRESHNESS_MS),
      ).toBe(false);
      expect(
        isGoalReportStale(
          { ...report, status },
          instant + GOAL_FRESHNESS_MS + 1,
        ),
      ).toBe(true);
      expect(
        isGoalReportStale(
          {
            reportedAt: report.receivedAt,
            receivedAt: report.reportedAt,
            status,
          },
          instant + GOAL_FRESHNESS_MS + 1,
        ),
      ).toBe(true);
    }
  });
  it("does not expect execution confirmations from paused or historical goals", () => {
    for (const status of ["paused", "complete", "cleared"] as const)
      expect(
        isGoalReportStale({ ...report, status }, Date.parse("2026-12-01")),
      ).toBe(false);
  });
});
