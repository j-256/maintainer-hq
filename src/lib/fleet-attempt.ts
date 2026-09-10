import { LIMITS } from "../../shared/domain";
import {
  fleetReconciliationPlanInput,
  type FleetReconciliationInput,
} from "../../shared/fleet-discovery";

export function fleetAttempt(
  workspaceId: string,
  subject: string,
  reviewId: string,
  value?: FleetReconciliationInput | null,
) {
  const key =
    "hq.fleet.attempt.v1." + JSON.stringify([workspaceId, subject, reviewId]);
  try {
    if (value === null) sessionStorage.removeItem(key);
    if (value)
      sessionStorage.setItem(
        key,
        JSON.stringify(fleetReconciliationPlanInput.parse(value)),
      );
    const saved = sessionStorage.getItem(key);
    if (!saved || saved.length > LIMITS.BODY_BYTES) return null;
    const parsed = fleetReconciliationPlanInput.safeParse(JSON.parse(saved));
    return parsed.success &&
      parsed.data.workspaceId === workspaceId &&
      parsed.data.reviewId === reviewId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
