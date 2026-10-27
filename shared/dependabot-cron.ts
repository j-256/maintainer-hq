import { CronExpressionParser } from "cron-parser";
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
