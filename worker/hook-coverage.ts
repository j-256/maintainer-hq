import {
  COVERAGE_LIMITS,
  HOOK_INVENTORY_LIMIT_REASONS,
  coverageAssessment,
  coverageEvidenceSchema,
  type CoverageResource,
} from "../shared/coverage-evidence";
import { observationSchema, type Observation } from "../shared/domain";
import type { HookResult, HookSubscription } from "../shared/hooks";

const iso = (value: number) => new Date(value).toISOString();
export type HookInventory = {
  items: HookSubscription[];
  complete: boolean;
  observedAt: string;
  limitReason: (typeof HOOK_INVENTORY_LIMIT_REASONS)[number] | null;
  clockSkewMs: number;
};

export async function readHookInventory(
  read: (cursor: string | null) => Promise<HookResult<"subscriptions">>,
  reserve: () => boolean,
  now: () => number,
): Promise<HookInventory> {
  const items: HookSubscription[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let observedAt = iso(now());
  let limitReason: HookInventory["limitReason"] = "page-limit";
  let clockSkewMs = 0;
  for (let page = 0; page < COVERAGE_LIMITS.SUBSCRIPTION_PAGES; page++) {
    if (!reserve()) {
      limitReason = "read-budget";
      break;
    }
    const response = await read(cursor);
    const responseTime = Date.parse(response.observedAt);
    const skew = Math.max(0, responseTime - now());
    clockSkewMs = Math.max(clockSkewMs, skew);
    items.push(...response.items);
    observedAt = iso(Math.min(Date.parse(observedAt), responseTime));
    if (response.disappeared) {
      limitReason = "records-disappeared";
      break;
    }
    if (skew > COVERAGE_LIMITS.HOOK_CLOCK_SKEW_MS) {
      limitReason = "future-timestamp";
      break;
    }
    cursor = response.nextCursor;
    if (!cursor)
      return { items, complete: true, observedAt, limitReason: null, clockSkewMs };
    if (cursors.has(cursor)) {
      limitReason = "repeated-cursor";
      break;
    }
    cursors.add(cursor);
  }
  return { items, complete: false, observedAt, limitReason, clockSkewMs };
}

export function hookCoverageResource(
  resourceKey: string,
  inventory: HookInventory | null,
  now: number,
): CoverageResource {
  if (!inventory)
    return {
      resourceKey,
      state: "unavailable",
      observedAt: null,
      freshUntil: null,
    };
  const matches = inventory.items.filter((item) => item.name === resourceKey);
  const found = matches[0];
  return {
    resourceKey,
    state: !inventory.complete
      ? "limited"
      : matches.length > 1
        ? "ambiguous"
        : found
          ? found.enabled && found.sinks.length
            ? "configured"
            : "disabled"
          : "missing",
    observedAt: inventory.observedAt,
    freshUntil: iso(
      Math.min(now, Date.parse(inventory.observedAt)) +
        (inventory.complete
          ? COVERAGE_LIMITS.HOOK_FRESH_MS
          : COVERAGE_LIMITS.REFRESH_MS),
    ),
  };
}

export function hookCoverageObservation(input: {
  connectionId: string;
  connectionRevision: number;
  repositoryId: string;
  fullName: string;
  resourceKeys: string[];
  inventory: HookInventory | null;
  now: number;
  completed: number;
}): Observation {
  const resources = input.resourceKeys
    .slice(0, COVERAGE_LIMITS.RESOURCES)
    .map((key) => hookCoverageResource(key, input.inventory, input.now));
  const expiresAt = iso(
    Math.min(
      input.now + COVERAGE_LIMITS.HOOK_FRESH_MS,
      ...resources.flatMap((resource) =>
        resource.freshUntil ? [Date.parse(resource.freshUntil)] : [],
      ),
    ),
  );
  const coverage = coverageEvidenceSchema.parse({
    version: 1,
    connectionRevision: input.connectionRevision,
    readAt: iso(input.now),
    freshUntil: expiresAt,
    total: input.resourceKeys.length,
    complete:
      resources.length === input.resourceKeys.length &&
      resources.every(
        (item) => item.state !== "limited" && item.state !== "unavailable",
      ),
    resources,
  });
  const assessment = coverageAssessment(coverage, input.completed);
  return {
    ...observationSchema.parse({
      sourceId: input.connectionId,
      resourceType: "repository",
      resourceId: input.repositoryId,
      name: input.fullName,
      health: assessment.health,
      summary:
        assessment.health === "warning"
          ? "Hookrelay has a failing or missing linked resource."
          : assessment.satisfied
            ? "Hookrelay coverage verified from linked resources."
            : "Hookrelay coverage needs inspection.",
      observedAt: iso(input.now),
      expiresAt,
      details: { coverage },
    }),
    provider: "hookrelay",
    receivedAt: iso(input.completed),
  };
}
