import {
  hookPolicySchema,
  type HookPolicy,
  type HookPolicyFilter,
  type HOOK_SEVERITIES,
} from "../../shared/hooks";

export type HookSeverity = (typeof HOOK_SEVERITIES)[number];
export type HookFilterDraft = {
  includeEvents: string;
  excludeEvents: string;
  includeSeverities: HookSeverity[];
  excludeSeverities: HookSeverity[];
};
export type HookPolicyDraft = {
  enabled: boolean;
  sinks: string[];
  filter: HookFilterDraft;
  sinkFilters: Record<string, HookFilterDraft>;
};

export function hookFilterDraft(
  filter?: HookPolicyFilter | null,
): HookFilterDraft {
  return {
    includeEvents: filter?.eventTypes?.include?.join(", ") ?? "",
    excludeEvents: filter?.eventTypes?.exclude?.join(", ") ?? "",
    includeSeverities: [...(filter?.severities?.include ?? [])],
    excludeSeverities: [...(filter?.severities?.exclude ?? [])],
  };
}

export function hookPolicyDraft(policy: HookPolicy): HookPolicyDraft {
  return {
    enabled: policy.enabled,
    sinks: [...policy.sinks],
    filter: hookFilterDraft(policy.filter),
    sinkFilters: Object.fromEntries(
      Object.entries(policy.sinkFilters).map(([name, filter]) => [
        name,
        hookFilterDraft(filter),
      ]),
    ),
  };
}

function filterValue(draft: HookFilterDraft): HookPolicyFilter | null {
  const patterns = (text: string) =>
    text
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  const include = patterns(draft.includeEvents);
  const exclude = patterns(draft.excludeEvents);
  const eventTypes = {
    ...(include.length ? { include } : {}),
    ...(exclude.length ? { exclude } : {}),
  };
  const severities = {
    ...(draft.includeSeverities.length
      ? { include: draft.includeSeverities }
      : {}),
    ...(draft.excludeSeverities.length
      ? { exclude: draft.excludeSeverities }
      : {}),
  };
  if (!Object.keys(eventTypes).length && !Object.keys(severities).length)
    return null;
  return {
    ...(Object.keys(eventTypes).length ? { eventTypes } : {}),
    ...(Object.keys(severities).length ? { severities } : {}),
  };
}

export function hookPolicyValue(draft: HookPolicyDraft): HookPolicy {
  const parsed = hookPolicySchema.safeParse({
    enabled: draft.enabled,
    sinks: draft.sinks,
    filter: filterValue(draft.filter),
    sinkFilters: Object.fromEntries(
      draft.sinks.flatMap((name) => {
        const filter = draft.sinkFilters[name]
          ? filterValue(draft.sinkFilters[name])
          : null;
        return filter ? [[name, filter]] : [];
      }),
    ),
  });
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path;
    const label =
      at?.[0] === "sinkFilters"
        ? "Filters for " + String(at[1])
        : at?.[0] === "sinks"
          ? "Destinations"
          : "Subscription filters";
    throw new Error(
      label +
        ": use unique, comma-separated lowercase event types, prefixes ending in .* or *. Check the field limits and remove duplicates.",
    );
  }
  return parsed.data;
}

export function toggleHookValue<T>(
  values: T[],
  value: T,
  checked: boolean,
): T[] {
  return checked
    ? values.includes(value)
      ? values
      : [...values, value]
    : values.filter((item) => item !== value);
}
