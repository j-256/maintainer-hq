import { Temporal } from "@js-temporal/polyfill";
import { CronExpressionParser } from "cron-parser";
import {
  DEPENDABOT_DAYS,
  DEPENDABOT_LIMITS as LIMITS,
  DEPENDABOT_TIME as TIME,
  validDependabotTimezone,
  type DependabotSchedule,
} from "./dependabot";

export type DependabotProjectionInput = {
  key: string;
  schedule: DependabotSchedule | null;
  stale?: boolean;
};
export type DependabotOccurrence = {
  key: string;
  instant: string;
  day: number;
  minute: number;
  position: number;
  overlap: number;
  stale: boolean;
};
export type DependabotNotice = {
  key: string;
  code:
    | "unknown_time"
    | "unsupported_schedule"
    | "unsupported_cron"
    | "invalid_timezone"
    | "dst_uncertain"
    | "limited"
    | "outside_range";
};
export const DEPENDABOT_NOTICE_LABELS: Record<
  DependabotNotice["code"],
  string
> = {
  unknown_time: "Time assigned by GitHub",
  unsupported_schedule: "Unsupported schedule",
  unsupported_cron: "Timeline unavailable for this cron expression",
  invalid_timezone: "Invalid schedule timezone",
  dst_uncertain: "Ambiguous or nonexistent local time",
  limited: "Too many occurrences to plot completely",
  outside_range: "No start in this date range",
};
export function supportedDependabotCron(expression: string) {
  const trimmed = expression.trim();
  if (
    trimmed.split(/\s+/).length !== 5 ||
    /[^\d*,/\-\s]/.test(
      trimmed
        .toUpperCase()
        .replace(
          /SUN|MON|TUE|WED|THU|FRI|SAT|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/g,
          "",
        ),
    )
  )
    return false;
  try {
    CronExpressionParser.parse(trimmed, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}
function expression(schedule: DependabotSchedule) {
  if (schedule.interval === "cron")
    return supportedDependabotCron(schedule.cronjob!)
      ? schedule.cronjob!
      : null;
  if (!schedule.time) return null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const suffix = {
    daily: "* * 1-5",
    weekly:
      "* * " +
      ((DEPENDABOT_DAYS.indexOf(schedule.day ?? "monday") + 1) %
        TIME.DAYS_PER_WEEK),
    monthly: "1 * *",
    quarterly: "1 1,4,7,10 *",
    semiannually: "1 1,7 *",
    yearly: "1 1 *",
  }[schedule.interval];
  return minute + " " + hour + " " + suffix;
}
export function projectDependabotSchedules(
  inputs: DependabotProjectionInput[],
  window: { date: string; mode: "week" | "day"; timeZone: string },
) {
  if (!validDependabotTimezone(window.timeZone))
    throw new Error("Choose a valid display timezone");
  const date = Temporal.PlainDate.from(window.date);
  const days = window.mode === "week" ? TIME.DAYS_PER_WEEK : 1;
  const start = date.toZonedDateTime(window.timeZone).toInstant();
  const end = date.add({ days }).toZonedDateTime(window.timeZone).toInstant();
  const nominalStart =
    date.subtract({ days: TIME.WINDOW_MARGIN_DAYS }).toString() + "T00:00:00Z";
  const nominalEnd =
    date.add({ days: days + TIME.WINDOW_MARGIN_DAYS }).toString() +
    "T00:00:00Z";
  const occurrences: DependabotOccurrence[] = [];
  const notices: DependabotNotice[] = [];
  let limited = inputs.length > LIMITS.PROJECTION_ENTRIES;
  for (const input of inputs.slice(0, LIMITS.PROJECTION_ENTRIES)) {
    const notice = (code: DependabotNotice["code"]) => {
      if (!notices.some((item) => item.key === input.key && item.code === code))
        notices.push({ key: input.key, code });
    };
    const schedule = input.schedule;
    if (!schedule) {
      notice("unsupported_schedule");
      continue;
    }
    const zone = schedule.timezone ?? "UTC";
    if (!validDependabotTimezone(zone)) {
      notice("invalid_timezone");
      continue;
    }
    const cron = expression(schedule);
    if (!cron) {
      notice(
        schedule.interval === "cron" ? "unsupported_cron" : "unknown_time",
      );
      continue;
    }
    let generated = 0;
    let candidates = 0;
    const parser = CronExpressionParser.parse(cron, {
      currentDate: new Date(Date.parse(nominalStart) - 1),
      endDate: nominalEnd,
      tz: "UTC",
    });
    while (parser.hasNext()) {
      if (
        ++candidates > LIMITS.CANDIDATES_PER_ENTRY ||
        generated >= LIMITS.OCCURRENCES_PER_ENTRY ||
        occurrences.length >= LIMITS.OCCURRENCES_TOTAL
      ) {
        notice("limited");
        limited = true;
        break;
      }
      const next = parser.next().toISOString();
      if (!next) break;
      const nominal = Temporal.Instant.from(next)
        .toZonedDateTimeISO("UTC")
        .toPlainDateTime();
      let instant: Temporal.Instant;
      try {
        instant = nominal
          .toZonedDateTime(zone, { disambiguation: "reject" })
          .toInstant();
      } catch {
        if (
          Temporal.PlainDate.compare(nominal.toPlainDate(), date) >= 0 &&
          Temporal.PlainDate.compare(
            nominal.toPlainDate(),
            date.add({ days }),
          ) < 0
        )
          notice("dst_uncertain");
        continue;
      }
      if (
        Temporal.Instant.compare(instant, start) < 0 ||
        Temporal.Instant.compare(instant, end) >= 0
      )
        continue;
      const local = instant.toZonedDateTimeISO(window.timeZone);
      const day = date.until(local.toPlainDate()).days;
      const minute = local.hour * 60 + local.minute;
      occurrences.push({
        key: input.key,
        instant: instant.toString(),
        day,
        minute,
        position: (day + minute / TIME.MINUTES_PER_DAY) / days,
        overlap: 0,
        stale: Boolean(input.stale),
      });
      generated++;
    }
    if (!generated && !notices.some((item) => item.key === input.key))
      notice("outside_range");
  }
  const utcMinute = (instant: string) =>
    Math.floor(Date.parse(instant) / TIME.MINUTE_MS);
  const counts = new Map<number, number>();
  for (const item of occurrences)
    if (!item.stale)
      counts.set(
        utcMinute(item.instant),
        (counts.get(utcMinute(item.instant)) ?? 0) + 1,
      );
  for (const item of occurrences)
    item.overlap = item.stale ? 0 : counts.get(utcMinute(item.instant))!;
  return {
    start: start.toString(),
    end: end.toString(),
    occurrences: occurrences.sort(
      (a, b) =>
        a.instant.localeCompare(b.instant) || a.key.localeCompare(b.key),
    ),
    notices,
    limited,
  };
}
