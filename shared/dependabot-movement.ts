import { Temporal } from "@js-temporal/polyfill";
import {
  DEPENDABOT_DAYS,
  DEPENDABOT_TIME,
  dependabotScheduleSchema,
  validDependabotTimezone,
  type DependabotSchedule,
} from "./dependabot";
import { supportedDependabotCron } from "./dependabot-cron";

export const DEPENDABOT_DRAG = Object.freeze({
  STEP_MINUTES: 15,
  MINUTES_PER_HOUR: 60,
  HOURS_PER_DAY: 24,
  MIN_HOUR_WIDTH: 40,
  POINTER_THRESHOLD: 4,
});
export const DEPENDABOT_MOVE_REASONS = Object.freeze({
  clock: "Use the schedule form to assign a time or edit this cron expression.",
  calendar:
    "This recurrence keeps its calendar days. Move its time within the scheduled day.",
  dst: "This time is ambiguous or does not exist in the display or schedule timezone. Choose another time.",
  invalid: "Choose a valid date, time, and timezone.",
  seconds:
    "This target does not align to a minute in the schedule timezone. Choose another time.",
});
export type DependabotMoveTarget = {
  date: string;
  minute: number;
  timeZone: string;
  preserveTime?: boolean;
};
export type DependabotMoveResult =
  | {
      ok: true;
      schedule: DependabotSchedule;
      instant: string;
      date: string;
      minute: number;
    }
  | { ok: false; reason: string };
const CRON_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function clock(schedule: DependabotSchedule | null) {
  if (!schedule) return null;
  if (schedule.interval !== "cron")
    return schedule.time
      ? { fields: null, weekly: schedule.interval === "weekly" }
      : null;
  const fields = schedule.cronjob?.trim().split(/\s+/);
  if (
    !fields ||
    fields.length !== 5 ||
    !supportedDependabotCron(schedule.cronjob!) ||
    !/^\d{1,2}$/.test(fields[0]!) ||
    !/^\d{1,2}$/.test(fields[1]!)
  )
    return null;
  const day = fields[4]!.toUpperCase();
  return {
    fields,
    weekly:
      fields[2] === "*" &&
      fields[3] === "*" &&
      (/^[0-7]$/.test(day) || CRON_DAYS.includes(day)),
  };
}
export function canMoveDependabotSchedule(schedule: DependabotSchedule | null) {
  return clock(schedule) !== null;
}
export function snapDependabotMinute(value: number) {
  if (!Number.isFinite(value)) throw new Error(DEPENDABOT_MOVE_REASONS.invalid);
  return Math.max(
    0,
    Math.min(
      DEPENDABOT_TIME.MINUTES_PER_DAY - DEPENDABOT_DRAG.STEP_MINUTES,
      Math.round(value / DEPENDABOT_DRAG.STEP_MINUTES) *
        DEPENDABOT_DRAG.STEP_MINUTES,
    ),
  );
}
export function moveDependabotSchedule(
  input: DependabotSchedule,
  originInstant: string,
  target: DependabotMoveTarget,
): DependabotMoveResult {
  const basis = clock(input);
  if (!basis) return { ok: false, reason: DEPENDABOT_MOVE_REASONS.clock };
  if (
    !validDependabotTimezone(target.timeZone) ||
    !validDependabotTimezone(input.timezone ?? "UTC") ||
    !Number.isFinite(target.minute) ||
    target.minute < 0 ||
    target.minute >= DEPENDABOT_TIME.MINUTES_PER_DAY
  )
    return { ok: false, reason: DEPENDABOT_MOVE_REASONS.invalid };
  try {
    const date = Temporal.PlainDate.from(target.date);
    const minute = target.preserveTime
      ? target.minute
      : snapDependabotMinute(target.minute);
    if (!Number.isInteger(minute))
      return { ok: false, reason: DEPENDABOT_MOVE_REASONS.invalid };
    const nominal = date.toPlainDateTime({
      hour: Math.floor(minute / DEPENDABOT_DRAG.MINUTES_PER_HOUR),
      minute: minute % DEPENDABOT_DRAG.MINUTES_PER_HOUR,
    });
    let instant: Temporal.Instant;
    try {
      instant = nominal
        .toZonedDateTime(target.timeZone, { disambiguation: "reject" })
        .toInstant();
    } catch {
      return { ok: false, reason: DEPENDABOT_MOVE_REASONS.dst };
    }
    const source = instant.toZonedDateTimeISO(input.timezone ?? "UTC");
    if (source.second !== 0)
      return { ok: false, reason: DEPENDABOT_MOVE_REASONS.seconds };
    try {
      source
        .toPlainDateTime()
        .toZonedDateTime(source.timeZoneId, { disambiguation: "reject" });
    } catch {
      return { ok: false, reason: DEPENDABOT_MOVE_REASONS.dst };
    }
    const original = Temporal.Instant.from(originInstant).toZonedDateTimeISO(
      source.timeZoneId,
    );
    if (!basis.weekly && !source.toPlainDate().equals(original.toPlainDate()))
      return { ok: false, reason: DEPENDABOT_MOVE_REASONS.calendar };
    let schedule: DependabotSchedule;
    if (basis.fields) {
      const fields = [...basis.fields];
      fields[0] = String(source.minute);
      fields[1] = String(source.hour);
      if (basis.weekly && source.dayOfWeek !== original.dayOfWeek)
        fields[4] = /^[A-Za-z]+$/.test(fields[4]!)
          ? CRON_DAYS[source.dayOfWeek % DEPENDABOT_TIME.DAYS_PER_WEEK]!
          : String(source.dayOfWeek % DEPENDABOT_TIME.DAYS_PER_WEEK);
      schedule = { ...input, cronjob: fields.join(" ") };
    } else {
      schedule = {
        ...input,
        time:
          String(source.hour).padStart(2, "0") +
          ":" +
          String(source.minute).padStart(2, "0"),
      };
      if (
        input.interval === "weekly" &&
        source.dayOfWeek !== original.dayOfWeek
      )
        schedule.day = DEPENDABOT_DAYS[source.dayOfWeek - 1]!;
    }
    return {
      ok: true,
      schedule: dependabotScheduleSchema.parse(schedule),
      instant: instant.toString(),
      date: date.toString(),
      minute,
    };
  } catch {
    return { ok: false, reason: DEPENDABOT_MOVE_REASONS.invalid };
  }
}
