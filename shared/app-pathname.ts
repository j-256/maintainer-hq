import { idSchema } from "./domain";

export function normalizeAppPathname(pathname: string) {
  const segments = pathname.replace(/\/+$/, "").split("/");
  if (segments[1]) segments[1] = segments[1].toLowerCase();
  if (segments[1] === "settings" && segments[2])
    segments[2] = segments[2].toLowerCase();
  return segments.join("/") || "/";
}

export function resourceIdFromPath(encoded: string) {
  try {
    const parsed = idSchema.safeParse(decodeURIComponent(encoded));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
