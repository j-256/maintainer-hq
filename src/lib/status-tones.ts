import type { Health } from "../../shared/domain";
import type { StatusTone } from "../components/ui/status";

export const HEALTH_TONES = {
  healthy: "success",
  warning: "warning",
  critical: "danger",
  unknown: "neutral",
} as const satisfies Record<Health, StatusTone>;
