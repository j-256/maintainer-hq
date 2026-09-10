import { z } from "zod";
import { workspaceInput } from "./domain";

export const DATE_FORMATS = [
  "yyyy-MM-dd",
  "MM/dd/yyyy",
  "dd/MM/yyyy",
  "dd.MM.yyyy",
  "MMM d, yyyy",
] as const;
export const CLOCK_FORMATS = ["24h", "12h"] as const;
export const LOCAL_TIME_ZONE = "local";
export function validTimeZone(value: string): boolean {
  if (value === LOCAL_TIME_ZONE) return true;
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export const preferencesSchema = z
  .object({
    dateFormat: z.enum(DATE_FORMATS),
    clockFormat: z.enum(CLOCK_FORMATS),
    timeZone: z.string().min(1).max(80).refine(validTimeZone, {
      message: "Choose Local, UTC, or a supported IANA time zone",
    }),
  })
  .strict();
export type UserPreferences = z.infer<typeof preferencesSchema>;
export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = Object.freeze({
  dateFormat: "yyyy-MM-dd",
  clockFormat: "24h",
  timeZone: LOCAL_TIME_ZONE,
});
export type PreferenceRecord = {
  preferences: UserPreferences;
  revision: number;
  updatedAt: string | null;
};
export const updatePreferencesInput = workspaceInput
  .extend({
    revision: z.number().int().min(0),
    preferences: preferencesSchema,
  })
  .strict();
