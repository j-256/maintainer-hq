import { expect, it } from "vitest";
import {
  hookFilterDraft,
  hookPolicyDraft,
  hookPolicyValue,
  toggleHookValue,
} from "../src/lib/hook-policy-draft";
import type { HookPolicy } from "../shared/hooks";

const policy: HookPolicy = {
  enabled: true,
  sinks: ["phone"],
  filter: { eventTypes: { include: ["github.*"], exclude: ["github.ping"] } },
  sinkFilters: {
    phone: {
      severities: { include: ["error", "critical"], exclude: ["debug"] },
    },
  },
};
it("round trips every editable routing field without private configuration", () => {
  expect(hookPolicyValue(hookPolicyDraft(policy))).toEqual(policy);
});
it("preserves unfinished pattern text and normalizes only on review", () => {
  const draft = hookPolicyDraft(policy);
  draft.filter.includeEvents = "github.*, ";
  expect(hookPolicyValue(draft).filter?.eventTypes?.include).toEqual([
    "github.*",
  ]);
  expect(draft.filter.includeEvents).toBe("github.*, ");
  draft.filter.includeEvents = "github.*,\npush";
  expect(hookPolicyValue(draft).filter?.eventTypes?.include).toEqual([
    "github.*",
    "push",
  ]);
});
it("blank filters mean no restriction and removed destinations cannot leave active filters", () => {
  const draft = hookPolicyDraft(policy);
  draft.filter = hookFilterDraft();
  draft.sinks = [];
  expect(hookPolicyValue(draft)).toEqual({
    enabled: true,
    sinks: [],
    filter: null,
    sinkFilters: {},
  });
});
it.each(["Push", "push*", "push.", "push pull", "push, push"])(
  "rejects ambiguous or duplicate pattern %s",
  (text) => {
    const draft = hookPolicyDraft(policy);
    draft.filter.includeEvents = text;
    expect(() => hookPolicyValue(draft)).toThrow("Subscription filters");
  },
);
it("names invalid destination filters and avoids duplicate selections", () => {
  const draft = hookPolicyDraft(policy);
  draft.sinkFilters.phone!.excludeEvents = "INVALID";
  expect(() => hookPolicyValue(draft)).toThrow("Filters for phone");
  expect(toggleHookValue(["phone"], "phone", true)).toEqual(["phone"]);
  expect(toggleHookValue(["phone"], "phone", false)).toEqual([]);
});
