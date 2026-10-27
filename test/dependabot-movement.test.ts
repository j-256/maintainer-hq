import { describe, expect, it } from "vitest";
import {
  canMoveDependabotSchedule,
  moveDependabotSchedule,
  snapDependabotMinute,
} from "../shared/dependabot-movement";
import type { DependabotMoveTarget } from "../shared/dependabot-movement";
import type { DependabotSchedule } from "../shared/dependabot";

const origin = "2026-10-26T08:00:00Z";
const target = { date: "2026-10-26", minute: 566, timeZone: "UTC" };
function moved(
  schedule: DependabotSchedule,
  instant = origin,
  input: DependabotMoveTarget = target,
) {
  const result = moveDependabotSchedule(schedule, instant, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
describe("quarter-hour schedule movements", () => {
  it("snaps to quarter hours and clamps within the day", () => {
    expect(
      [-15, 0, 7, 8, 14, 22, 23, 1439, 1460].map(snapDependabotMinute),
    ).toEqual([0, 0, 0, 15, 15, 15, 30, 1425, 1425]);
    expect(() => snapDependabotMinute(NaN)).toThrow();
  });
  it("updates only time while preserving omitted day/timezone", () => {
    const result = moved({ interval: "weekly", time: "08:00" });
    expect(result.schedule).toEqual({ interval: "weekly", time: "09:30" });
    expect(result.instant).toBe("2026-10-26T09:30:00Z");
  });
  it("moves weekly recurrence across days and keeps day-only time exact", () => {
    const result = moved(
      { interval: "weekly", day: "monday", time: "08:10" },
      "2026-10-26T08:10:00Z",
      { date: "2026-10-27", minute: 490, timeZone: "UTC", preserveTime: true },
    );
    expect(result.schedule).toEqual({
      interval: "weekly",
      day: "tuesday",
      time: "08:10",
    });
  });
  it("converts a displayed target into the unchanged source timezone", () => {
    expect(
      moved(
        {
          interval: "weekly",
          day: "monday",
          time: "08:00",
          timezone: "America/New_York",
        },
        "2026-10-26T12:00:00Z",
        { date: "2026-10-27", minute: 15, timeZone: "Asia/Tokyo" },
      ).schedule,
    ).toEqual({
      interval: "weekly",
      day: "monday",
      time: "11:15",
      timezone: "America/New_York",
    });
  });
  it.each(["daily", "monthly", "quarterly", "semiannually", "yearly"] as const)(
    "changes the %s clock without moving its calendar date",
    (interval) => {
      expect(moved({ interval, time: "08:00" }).schedule).toEqual({
        interval,
        time: "09:30",
      });
      expect(
        moveDependabotSchedule({ interval, time: "08:00" }, origin, {
          ...target,
          date: "2026-10-27",
        }),
      ).toMatchObject({ ok: false });
    },
  );
  it("rejects a display-zone gap or fold without choosing an instant", () => {
    for (const [date, minute] of [
      ["2026-03-08", 150],
      ["2026-11-01", 90],
    ] as const) {
      expect(
        moveDependabotSchedule(
          { interval: "weekly", day: "sunday", time: "08:00" },
          origin,
          { date, minute, timeZone: "America/New_York" },
        ),
      ).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/ambiguous|does not exist/),
      });
    }
  });
  it("also rejects a fold in the source zone even when the display target is unambiguous", () => {
    expect(
      moveDependabotSchedule(
        {
          interval: "weekly",
          day: "sunday",
          time: "08:00",
          timezone: "America/New_York",
        },
        origin,
        { date: "2026-11-01", minute: 330, timeZone: "UTC" },
      ),
    ).toMatchObject({ ok: false });
  });
  it("rewrites only single-clock cron fields and changes single-weekday cron safely", () => {
    expect(moved({ interval: "cron", cronjob: "0 8 1 * *" }).schedule).toEqual({
      interval: "cron",
      cronjob: "30 9 1 * *",
    });
    expect(
      moved(
        { interval: "cron", cronjob: "0 8 * * MON", timezone: "UTC" },
        origin,
        { date: "2026-10-27", minute: 480, timeZone: "UTC" },
      ).schedule,
    ).toEqual({ interval: "cron", cronjob: "0 8 * * TUE", timezone: "UTC" });
    expect(
      moved({ interval: "cron", cronjob: "0 8 * * 1" }, origin, {
        date: "2026-10-28",
        minute: 615,
        timeZone: "UTC",
      }).schedule,
    ).toEqual({ interval: "cron", cronjob: "15 10 * * 3" });
  });
  it("leaves multiple-clock, natural and unknown-time schedules to the form", () => {
    for (const schedule of [
      { interval: "weekly" },
      { interval: "cron", cronjob: "every day" },
      { interval: "cron", cronjob: "0 8,12 * * *" },
      { interval: "cron", cronjob: "*/15 * * * *" },
    ] as DependabotSchedule[]) {
      expect(canMoveDependabotSchedule(schedule)).toBe(false);
      expect(moveDependabotSchedule(schedule, origin, target).ok).toBe(false);
    }
  });
  it("rejects invalid targets and never accepts fractional/ambiguous source seconds", () => {
    expect(
      moveDependabotSchedule({ interval: "weekly", time: "08:00" }, origin, {
        ...target,
        timeZone: "Invalid/Zone",
      }).ok,
    ).toBe(false);
    expect(
      moveDependabotSchedule(
        { interval: "weekly", time: "08:00", timezone: "Africa/Monrovia" },
        "1970-01-01T08:44:30Z",
        { date: "1970-01-01", minute: 600, timeZone: "UTC" },
      ).ok,
    ).toBe(false);
  });
});
