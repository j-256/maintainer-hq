import { describe, expect, it } from "vitest";
import { createDateTimeFormatter } from "../shared/date-time";
import { DEFAULT_PREFERENCES, preferencesSchema } from "../shared/preferences";

const instant = "2026-09-06T00:05:09.000Z";
const format = (timeZone = "UTC", clockFormat: "24h" | "12h" = "24h") =>
  createDateTimeFormatter(
    { ...DEFAULT_PREFERENCES, timeZone, clockFormat },
    "America/New_York",
  );

describe("Personal timestamp formatting", () => {
  it("uses midnight zero, explicit clock cycles, and the selected time zone", () => {
    expect(format().dateTime(instant, true)).toBe("2026-09-06 00:05:09");
    expect(format("UTC", "12h").dateTime(instant)).toBe("2026-09-06 12:05 AM");
    expect(format("local").dateTime(instant)).toBe("2026-09-05 20:05");
    expect(format("Asia/Kolkata").dateTime(instant)).toBe("2026-09-06 05:35");
    expect(format("Pacific/Kiritimati").dateTime("2026-09-06T12:05:00Z")).toBe(
      "2026-09-07 02:05",
    );
    expect(format("local").zoneLabel).toBe("Local (America/New_York)");
    expect(format().zoneLabel).toBe("UTC");
    expect(format().date("0099-09-06T00:00:00Z")).toBe("0099-09-06");
    expect(
      createDateTimeFormatter({
        ...DEFAULT_PREFERENCES,
        dateFormat: "MMM d, yyyy",
        timeZone: "UTC",
      }).date("0099-09-06T00:00:00Z"),
    ).toBe("Sep 6, 0099");
  });

  it("follows daylight-saving transitions without ambiguous diagnostic tooltips", () => {
    const local = format("local");
    expect(local.time("2026-03-08T06:59:00Z")).toBe("01:59");
    expect(local.time("2026-03-08T07:00:00Z")).toBe("03:00");
    expect(local.dateTime("2026-11-01T05:30:00Z")).toBe("2026-11-01 01:30");
    expect(local.dateTime("2026-11-01T06:30:00Z")).toBe("2026-11-01 01:30");
    expect(local.tooltip("2026-11-01T05:30:00Z")).toBe(
      "2026-11-01 01:30:00 EDT (America/New_York) | 2026-11-01T05:30:00.000Z",
    );
    expect(local.tooltip("2026-11-01T06:30:00Z")).toBe(
      "2026-11-01 01:30:00 EST (America/New_York) | 2026-11-01T06:30:00.000Z",
    );
  });

  it.each([
    ["yyyy-MM-dd", "2026-09-05"],
    ["MM/dd/yyyy", "09/05/2026"],
    ["dd/MM/yyyy", "05/09/2026"],
    ["dd.MM.yyyy", "05.09.2026"],
    ["MMM d, yyyy", "Sep 5, 2026"],
  ] as const)("renders %s consistently", (dateFormat, expected) => {
    const dates = createDateTimeFormatter(
      { ...DEFAULT_PREFERENCES, dateFormat },
      "America/New_York",
    );
    expect(dates.date(instant)).toBe(expected);
    expect(dates.calendarDate("2026-09-05")).toBe(expected);
  });

  it("keeps calendar-only deadlines on their original day and handles absent values", () => {
    for (const zone of ["America/Los_Angeles", "UTC", "Pacific/Kiritimati"]) {
      expect(format(zone).calendarDate("2026-09-06")).toBe("2026-09-06");
      expect(format(zone).calendarDate("2026-02-30")).toBe("Not set");
      expect(format(zone).calendarDate("not-a-date")).toBe("Not set");
      expect(format(zone).calendarDate(null)).toBe("Not set");
    }
    for (const value of [null, undefined, "", "not-a-date"]) {
      expect(format().dateTime(value)).toBe("Not recorded");
      expect(format().time(value)).toBe("Not recorded");
      expect(format().date(value)).toBe("Not recorded");
      expect(format().tooltip(value)).toBe("Not recorded");
    }
  });

  it("accepts recognized zones and rejects unknown formats, arbitrary fields, and invalid zones", () => {
    for (const timeZone of [
      "UTC",
      "local",
      "America/New_York",
      "Asia/Kathmandu",
      "Etc/GMT+5",
    ])
      expect(
        preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, timeZone })
          .success,
      ).toBe(true);
    for (const timeZone of [
      "Mars/Olympus",
      "https://example.com",
      "UTC\n",
      "",
      "+05:30",
    ])
      expect(
        preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, timeZone })
          .success,
      ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        dateFormat: "arbitrary",
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        clockFormat: "25h",
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...DEFAULT_PREFERENCES,
        subject: "another-user",
      }).success,
    ).toBe(false);
  });
});
