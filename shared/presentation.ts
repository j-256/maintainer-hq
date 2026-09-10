import type { Expectations, Health, Repository } from "./domain";
export { reviewIsDue } from "./domain";

export const REQUIREMENT_LABELS: Record<Expectations["ci"], string> = {
  required: "Required",
  optional: "Optional",
  unmanaged: "Not managed here",
};
export const CLASSIFICATION_LABELS: Record<
  Repository["classification"],
  string
> = {
  maintained: "Maintained",
  watchlist: "Watchlist",
  reference: "Reference",
};
export const HEALTH_LABELS: Record<Health, string> = {
  healthy: "Healthy",
  warning: "Needs attention",
  critical: "Critical",
  unknown: "Unverified",
};
export const EXPECTATION_LABELS = {
  ci: "Continuous integration",
  security: "Security checks",
  hooks: "Hook coverage",
  monitoring: "Endpoint monitoring",
} as const;
export const EXPECTATION_HELP = {
  ci: "Expect a passing CI result on the default branch.",
  security: "Expect no open findings from the connected security source.",
  hooks: "Expect this repository to have hook coverage.",
  monitoring: "Expect this repository to have monitoring coverage.",
} as const;
