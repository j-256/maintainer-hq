import { describe, expect, it } from "vitest";
import {
  dependabotScheduleSchema,
  DEPENDABOT_LIMITS,
} from "../shared/dependabot";
import { projectDependabotSchedules } from "../shared/dependabot-projection";

const week = { date: "2026-10-26", mode: "week" as const, timeZone: "UTC" };
describe("Dependabot dated nominal starts", () => {
  it("groups equal UTC minutes even when historical zone offsets include seconds", () => {
    const result = projectDependabotSchedules(
      [
        {
          key: "historical",
          schedule: {
            interval: "weekly",
            day: "thursday",
            time: "00:00",
            timezone: "Africa/Monrovia",
          },
        },
        {
          key: "utc",
          schedule: { interval: "weekly", day: "thursday", time: "00:44" },
        },
      ],
      { date: "1970-01-01", mode: "day", timeZone: "UTC" },
    );
    expect(result.occurrences.map((item) => item.overlap)).toEqual([2, 2]);
  });
  it("projects weekday daily and Monday-default weekly starts, keeping unset time unknown", () => {
    const result = projectDependabotSchedules(
      [
        { key: "daily", schedule: { interval: "daily", time: "08:00" } },
        { key: "weekly", schedule: { interval: "weekly", time: "08:00" } },
        { key: "unknown", schedule: { interval: "weekly" } },
      ],
      week,
    );
    expect(
      result.occurrences
        .filter((item) => item.key === "daily")
        .map((item) => item.instant),
    ).toEqual([26, 27, 28, 29, 30].map((day) => `2026-10-${day}T08:00:00Z`));
    expect(
      result.occurrences.find((item) => item.key === "weekly"),
    ).toMatchObject({ instant: "2026-10-26T08:00:00Z", overlap: 2 });
    expect(result.notices).toContainEqual({
      key: "unknown",
      code: "unknown_time",
    });
  });
  it.each([
    ["monthly", "2026-11-01"],
    ["quarterly", "2027-01-01"],
    ["semiannually", "2027-07-01"],
    ["yearly", "2027-01-01"],
  ])("projects %s on the first calendar day", (interval, date) => {
    const result = projectDependabotSchedules(
      [
        {
          key: "entry",
          schedule: { interval: interval as "monthly", time: "01:20" },
        },
      ],
      { date, mode: "day", timeZone: "UTC" },
    );
    expect(result.occurrences.map((item) => item.instant)).toEqual([
      date + "T01:20:00Z",
    ]);
  });
  it("projects one IANA zone into another without changing the stored schedule", () => {
    const result = projectDependabotSchedules(
      [
        {
          key: "entry",
          schedule: {
            interval: "weekly",
            day: "monday",
            time: "00:30",
            timezone: "Asia/Tokyo",
          },
        },
      ],
      { date: "2026-10-25", mode: "day", timeZone: "America/Chicago" },
    );
    expect(result.occurrences[0]).toMatchObject({
      instant: "2026-10-25T15:30:00Z",
      day: 0,
      minute: 630,
    });
  });
  it.each([
    ["2026-03-08", "02:30"],
    ["2026-11-01", "01:30"],
  ])("does not invent an instant for a DST gap or fold on %s", (date, time) => {
    const result = projectDependabotSchedules(
      [
        {
          key: "entry",
          schedule: {
            interval: "weekly",
            day: "sunday",
            time,
            timezone: "America/New_York",
          },
        },
      ],
      { date, mode: "day", timeZone: "America/New_York" },
    );
    expect(result.occurrences).toHaveLength(0);
    expect(result.notices).toContainEqual({
      key: "entry",
      code: "dst_uncertain",
    });
  });
  it.each([
    ["2026-10-31", "01:30"],
    ["2026-03-07", "02:30"],
  ])(
    "keeps cross-date DST uncertainty in the %s display window",
    (date, time) => {
      const result = projectDependabotSchedules(
        [
          {
            key: "uncertain",
            schedule: {
              interval: "weekly",
              day: "sunday",
              time,
              timezone: "America/New_York",
            },
          },
        ],
        { date, mode: "day", timeZone: "Pacific/Honolulu" },
      );
      expect(result.occurrences).toHaveLength(0);
      expect(result.notices).toContainEqual({
        key: "uncertain",
        code: "dst_uncertain",
      });
    },
  );
  it("bounds cron expansion and preserves natural expressions as unprojectable", () => {
    const result = projectDependabotSchedules(
      [
        { key: "dense", schedule: { interval: "cron", cronjob: "* * * * *" } },
        {
          key: "natural",
          schedule: { interval: "cron", cronjob: "every day at 5pm" },
        },
      ],
      week,
    );
    expect(result.occurrences.length).toBeLessThanOrEqual(
      DEPENDABOT_LIMITS.OCCURRENCES_PER_ENTRY,
    );
    expect(result.notices).toContainEqual({ key: "dense", code: "limited" });
    expect(result.notices).toContainEqual({
      key: "natural",
      code: "unsupported_cron",
    });
  });
  it("marks same UTC minutes across independent entries and excludes stale evidence from fresh overlap counts", () => {
    const result = projectDependabotSchedules(
      [
        { key: "same-repo-a", schedule: { interval: "weekly", time: "08:00" } },
        {
          key: "same-repo-b",
          schedule: {
            interval: "cron",
            cronjob: "0 10 * * 1",
            timezone: "Europe/Paris",
          },
        },
        {
          key: "stale",
          stale: true,
          schedule: { interval: "weekly", time: "08:00" },
        },
      ],
      week,
    );
    expect(
      result.occurrences
        .filter((item) => item.key !== "stale")
        .map((item) => item.overlap),
    ).toEqual([1, 1]);
    const equal = projectDependabotSchedules(
      [
        { key: "a", schedule: { interval: "weekly", time: "08:00" } },
        {
          key: "b",
          schedule: {
            interval: "cron",
            cronjob: "0 9 * * 1",
            timezone: "Europe/Paris",
          },
        },
      ],
      week,
    );
    expect(equal.occurrences.map((item) => item.overlap)).toEqual([2, 2]);
  });
  it("validates structured edits without supplying omitted fields or accepting irrelevant schedule options", () => {
    expect(dependabotScheduleSchema.parse({ interval: "weekly" })).toEqual({
      interval: "weekly",
    });
    for (const value of [
      { interval: "daily", day: "monday" },
      { interval: "weekly", time: "25:00" },
      { interval: "cron" },
      { interval: "weekly", cronjob: "0 8 * * *" },
      { interval: "weekly", arbitrary: "value" },
    ])
      expect(dependabotScheduleSchema.safeParse(value).success).toBe(false);
    const invalid = projectDependabotSchedules(
      [
        {
          key: "invalid",
          schedule: {
            interval: "weekly",
            time: "08:00",
            timezone: "Invalid/Zone",
          },
        },
      ],
      week,
    );
    expect(invalid.notices).toContainEqual({
      key: "invalid",
      code: "invalid_timezone",
    });
  });
});
