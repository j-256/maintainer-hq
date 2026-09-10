import { afterEach, expect, it, vi } from "vitest";
import { pendingReview } from "../src/lib/pending-review";

afterEach(() => vi.unstubAllGlobals());

it("retains only a versioned marker bound to operation, workspace and review", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  expect(pendingReview("expectations", "alpha", "review")).toBe(false);
  expect(pendingReview("expectations", "alpha", "review", true)).toBe(true);
  expect([...values]).toEqual([
    ["hq.expectations.pending.v1.alpha.review", "1"],
  ]);
  expect(pendingReview("organization", "alpha", "review")).toBe(false);
  expect(pendingReview("expectations", "beta", "review")).toBe(false);
  expect(pendingReview("expectations", "alpha", "different")).toBe(false);
  expect(pendingReview("expectations", "alpha", "review", false)).toBe(false);
  expect(values.size).toBe(0);
});

it("treats unavailable storage as an unresolved attempt, not proof of failure", () => {
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw new Error("Blocked");
    },
    setItem: () => {
      throw new Error("Blocked");
    },
    removeItem: () => {
      throw new Error("Blocked");
    },
  });
  for (const value of [undefined, true, false])
    expect(pendingReview("expectations", "alpha", "review", value)).toBe(true);
});
