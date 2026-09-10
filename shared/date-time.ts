import {
  DEFAULT_PREFERENCES,
  LOCAL_TIME_ZONE,
  type UserPreferences,
} from "./preferences";

const UNKNOWN_TIME = "Not recorded";
const partsRecord = (parts: Intl.DateTimeFormatPart[]) =>
  Object.fromEntries(parts.map((part) => [part.type, part.value]));

export function createDateTimeFormatter(
  preferences: Readonly<UserPreferences> = DEFAULT_PREFERENCES,
  localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const timeZone =
    preferences.timeZone === LOCAL_TIME_ZONE
      ? localTimeZone
      : preferences.timeZone;
  const date = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const namedDate = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const namedCalendarDate = new Intl.DateTimeFormat(
    "en-US-u-ca-gregory-nu-latn",
    {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    },
  );
  const clock = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: preferences.clockFormat === "24h" ? "h23" : "h12",
    timeZoneName: "short",
  });
  function valid(value: string | null | undefined): Date | null {
    if (!value) return null;
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  function dateParts(year: string, month: string, day: string, named?: string) {
    year = year.padStart(4, "0");
    switch (preferences.dateFormat) {
      case "MM/dd/yyyy":
        return `${month}/${day}/${year}`;
      case "dd/MM/yyyy":
        return `${day}/${month}/${year}`;
      case "dd.MM.yyyy":
        return `${day}.${month}.${year}`;
      case "MMM d, yyyy":
        return named ?? `${year}-${month}-${day}`;
      default:
        return `${year}-${month}-${day}`;
    }
  }
  function formatDate(value: string | null | undefined): string {
    const instant = valid(value);
    if (!instant) return UNKNOWN_TIME;
    const parts = partsRecord(date.formatToParts(instant));
    const named = partsRecord(namedDate.formatToParts(instant));
    return dateParts(
      parts.year!,
      parts.month!,
      parts.day!,
      `${named.month} ${named.day}, ${parts.year!.padStart(4, "0")}`,
    );
  }
  function formatTime(
    value: string | null | undefined,
    seconds = false,
  ): string {
    const instant = valid(value);
    if (!instant) return UNKNOWN_TIME;
    const parts = partsRecord(clock.formatToParts(instant));
    return `${parts.hour}:${parts.minute}${seconds ? ":" + parts.second : ""}${parts.dayPeriod ? " " + parts.dayPeriod : ""}`;
  }
  function formatDateTime(
    value: string | null | undefined,
    seconds = false,
  ): string {
    return valid(value)
      ? `${formatDate(value)} ${formatTime(value, seconds)}`
      : UNKNOWN_TIME;
  }
  function tooltip(value: string | null | undefined): string {
    const instant = valid(value);
    if (!instant) return UNKNOWN_TIME;
    const parts = partsRecord(clock.formatToParts(instant));
    return `${formatDateTime(value, true)} ${parts.timeZoneName} (${timeZone}) | ${instant.toISOString()}`;
  }
  function calendarDate(value: string | null | undefined): string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Not set";
    const instant = new Date(value + "T12:00:00Z");
    if (
      !Number.isFinite(instant.getTime()) ||
      instant.toISOString().slice(0, 10) !== value
    )
      return "Not set";
    const [year, month, day] = value.split("-");
    const named = partsRecord(namedCalendarDate.formatToParts(instant));
    return dateParts(
      year!,
      month!,
      day!,
      `${named.month} ${named.day}, ${year}`,
    );
  }
  return {
    date: formatDate,
    time: formatTime,
    dateTime: formatDateTime,
    tooltip,
    calendarDate,
    timeZone,
    zoneLabel:
      preferences.timeZone === LOCAL_TIME_ZONE
        ? `Local (${timeZone})`
        : timeZone,
  };
}
