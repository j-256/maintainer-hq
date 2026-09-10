import { z } from "zod";

export const COVERAGE_LIMITS = Object.freeze({
  RESOURCES: 12,
  CONNECTIONS: 12,
  PROVIDER_CALLS: 12,
  SUBSCRIPTION_PAGES: 8,
  CONCURRENCY: 2,
  REFRESH_MS: 60_000,
  LEASE_MS: 120_000,
  ELAPSED_MS: 60_000,
  WORKSPACE_READS: 10,
  RESPONSE_BYTES: 64 * 1024,
});
export const COVERAGE_STATES = [
  "passing",
  "configured",
  "failing",
  "disabled",
  "missing",
  "unverified",
  "stale",
  "changed",
  "unavailable",
  "limited",
  "ambiguous",
  "incident",
  "exceptional",
] as const;
export const COVERAGE_LABELS = Object.freeze({
  passing: "Check passing",
  configured: "Subscription configured",
  failing: "Check failing",
  disabled: "Disabled at provider",
  missing: "Not found at provider",
  unverified: "No matching check",
  stale: "Check evidence expired",
  changed: "Awaiting check after configuration change",
  unavailable: "Provider read unavailable",
  limited: "Not inspected within this read",
  ambiguous: "Duplicate resource name",
  incident: "Open incident",
  exceptional: "Failure recorded",
});
export const coverageResourceSchema = z
  .object({
    resourceKey: z.string().min(1).max(160),
    state: z.enum(COVERAGE_STATES),
    observedAt: z.iso.datetime().nullable(),
    freshUntil: z.iso.datetime().nullable(),
  })
  .strict();
export const coverageEvidenceSchema = z
  .object({
    version: z.literal(1),
    connectionRevision: z.number().int().positive(),
    readAt: z.iso.datetime(),
    freshUntil: z.iso.datetime(),
    total: z.number().int().positive().max(1000),
    complete: z.boolean(),
    resources: z.array(coverageResourceSchema).max(COVERAGE_LIMITS.RESOURCES),
  })
  .strict()
  .refine(
    (value) =>
      value.resources.length <= value.total &&
      (!value.complete || value.resources.length === value.total),
  );
export type CoverageResource = z.infer<typeof coverageResourceSchema>;
export type CoverageEvidence = z.infer<typeof coverageEvidenceSchema>;

export function coverageState(resource: CoverageResource, now: number) {
  if (resource.state !== "passing" && resource.state !== "configured")
    return resource.state;
  if (
    !resource.observedAt ||
    !resource.freshUntil ||
    Date.parse(resource.observedAt) > now ||
    Date.parse(resource.freshUntil) <= now
  )
    return "stale";
  return resource.state;
}

export function coverageAssessment(evidence: CoverageEvidence, now: number) {
  const states = evidence.resources.map((resource) =>
    coverageState(resource, now),
  );
  const failed = states.some((state) =>
    ["failing", "missing", "incident", "exceptional"].includes(state),
  );
  const disabled = states.includes("disabled");
  const fresh =
    Date.parse(evidence.readAt) <= now && Date.parse(evidence.freshUntil) > now;
  const satisfied =
    fresh &&
    evidence.complete &&
    states.length > 0 &&
    states.every((state) => state === "passing" || state === "configured");
  return {
    satisfied,
    disabled,
    health: failed
      ? ("warning" as const)
      : satisfied
        ? ("healthy" as const)
        : ("unknown" as const),
  };
}
