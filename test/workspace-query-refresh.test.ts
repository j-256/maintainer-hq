import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createWorkspaceQueryRefresh,
  QUERY_REFRESH_LIMITS,
} from "../src/lib/workspace-query-refresh";
import { PUSH_TOPICS } from "../shared/workspace-push";

let cache: QueryClient;
let active = true;
let coordinator: ReturnType<typeof createWorkspaceQueryRefresh>;
const subscriptions: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  active = true;
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  coordinator = createWorkspaceQueryRefresh(cache, "alpha", () => active);
});
afterEach(() => {
  coordinator.stop();
  subscriptions.splice(0).forEach((stop) => stop());
  cache.clear();
  vi.useRealTimers();
});
function observe(key: readonly unknown[], initialData: unknown = 0) {
  const ends: (() => void)[] = [];
  const failures: (() => void)[] = [];
  const aborts = vi.fn();
  const queryFn = vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<number>((resolve, reject) => {
        const version = queryFn.mock.calls.length;
        signal.addEventListener("abort", aborts);
        ends.push(() => resolve(version));
        failures.push(() => reject(new Error("Synthetic read interrupted")));
      }),
  );
  const observer = new QueryObserver(cache, {
    queryKey: key,
    initialData,
    staleTime: Infinity,
    queryFn,
  });
  const unsubscribe = observer.subscribe(() => {});
  subscriptions.push(unsubscribe);
  return { queryFn, ends, failures, aborts, unsubscribe, observer };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
it.each(["repository-coverage", "repository-coverage-cache"])(
  "keeps %s idle for source chatter, hidden tabs and unmounted repositories",
  async (prefix) => {
    const selected = observe([prefix, "alpha", "first"]);
    const inactive = observe([prefix, "alpha", "second"]);
    inactive.unsubscribe();
    coordinator.enqueue(["activity", "sources"]);
    await settle();
    expect(selected.queryFn).not.toHaveBeenCalled();
    coordinator.enqueue(["associations"]);
    await settle();
    selected.ends[0]!();
    await vi.advanceTimersByTimeAsync(60000);
    expect(selected.queryFn).toHaveBeenCalledTimes(1);
    expect(inactive.queryFn).not.toHaveBeenCalled();
    active = false;
    coordinator.enqueue(["associations", "access"]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(selected.queryFn).toHaveBeenCalledTimes(1);
  },
);
it.each(["repository-releases", "repository-work"])(
  "settles active %s reads without polling or keeping another repository mounted",
  async (prefix) => {
    const selected = observe([prefix, "alpha", "first"]);
    const inactive = observe([prefix, "alpha", "second"]);
    inactive.unsubscribe();
    coordinator.enqueue(["activity", "hooks", "monitoring"]);
    await settle();
    expect(selected.queryFn).not.toHaveBeenCalled();
    coordinator.enqueue(["sources"], true);
    await settle();
    selected.ends[0]!();
    await vi.advanceTimersByTimeAsync(60000);
    expect(selected.queryFn).toHaveBeenCalledTimes(1);
    expect(inactive.queryFn).not.toHaveBeenCalled();
    active = false;
    coordinator.enqueue(["sources"]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(selected.queryFn).toHaveBeenCalledTimes(1);
  },
);

it("keeps the latest dirty signal after a failed read and stops after recovery", async () => {
  const query = observe(["github-coverage", "alpha"]);
  coordinator.enqueue(["sources"]);
  await settle();
  coordinator.enqueue(["sources"]);
  query.failures[0]!();
  await vi.advanceTimersByTimeAsync(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS);
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  query.ends[1]!();
  await vi.advanceTimersByTimeAsync(
    QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 3,
  );
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  expect(cache.getQueryData(["github-coverage", "alpha"])).toBe(2);
});

it("does not retry a quiet failed read without another change or explicit recovery", async () => {
  const query = observe(["github-coverage", "alpha"]);
  coordinator.enqueue(["sources"]);
  await settle();
  query.failures[0]!();
  await vi.advanceTimersByTimeAsync(
    QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 3,
  );
  expect(query.queryFn).toHaveBeenCalledTimes(1);
  expect(cache.getQueryState(["github-coverage", "alpha"])?.status).toBe(
    "error",
  );
});

it("does not run a trailing read after its observer unmounts", async () => {
  const query = observe(["github-coverage", "alpha"]);
  coordinator.enqueue(["sources"]);
  await settle();
  coordinator.enqueue(["sources"]);
  query.ends[0]!();
  await settle();
  query.unsubscribe();
  await vi.advanceTimersByTimeAsync(
    QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 3,
  );
  expect(query.queryFn).toHaveBeenCalledTimes(1);
});

it("coalesces source bursts, preserves in-flight reads and follows with the latest state", async () => {
  const query = observe(["github-coverage", "alpha", {}]);
  coordinator.enqueue(["sources"]);
  await settle();
  expect(query.queryFn).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 8; i++) {
    coordinator.enqueue(["sources"]);
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(query.queryFn).toHaveBeenCalledTimes(1);
  expect(query.aborts).not.toHaveBeenCalled();
  query.ends[0]!();
  await settle();
  await vi.advanceTimersByTimeAsync(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS);
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  query.ends[1]!();
  await vi.advanceTimersByTimeAsync(
    QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS * 3,
  );
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  expect(cache.getQueryData(["github-coverage", "alpha", {}])).toBe(2);
});

it("does not lose changes received while an independently started read is pending", async () => {
  const key = ["github-coverage", "alpha", {}];
  const query = observe(key);
  void query.observer.refetch();
  coordinator.enqueue(["sources"]);
  await settle();
  expect(query.queryFn).toHaveBeenCalledTimes(1);
  query.ends[0]!();
  await vi.advanceTimersByTimeAsync(QUERY_REFRESH_LIMITS.SOURCE_INTERVAL_MS);
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  query.ends[1]!();
  await settle();
  expect(cache.getQueryData(key)).toBe(2);
  expect(query.aborts).not.toHaveBeenCalled();
});

it("keeps Activity prompt without making a slow source query delay other topics", async () => {
  const slow = observe(["github-coverage", "alpha"]);
  const activity = observe(["workspace", "alpha", "activity-feed", {}, null]);
  coordinator.enqueue(["sources"]);
  await settle();
  coordinator.enqueue(["activity"]);
  await settle();
  expect(slow.queryFn).toHaveBeenCalledTimes(1);
  expect(activity.queryFn).toHaveBeenCalledTimes(1);
  activity.ends[0]!();
  slow.ends[0]!();
  await settle();
});

it("marks inactive queries stale without fetching and never crosses workspace or view boundaries", async () => {
  const hidden = observe(["github-coverage", "alpha"]);
  hidden.unsubscribe();
  const other = observe(["github-coverage", "beta"]);
  const view = observe(["workspace", "alpha", "view", "settings-sources"]);
  const hooks = observe(["hooks", "alpha", "snapshot"]);
  coordinator.enqueue(["sources"]);
  await vi.advanceTimersByTimeAsync(10000);
  for (const query of [hidden, other, view, hooks])
    expect(query.queryFn).not.toHaveBeenCalled();
  expect(cache.getQueryState(["github-coverage", "alpha"])?.isInvalidated).toBe(
    true,
  );
});

it("keeps fixed history and completed receipts idle on recovery or source progress, but rechecks changed access", async () => {
  const history = observe([
    "workspace",
    "alpha",
    "activity-feed",
    {},
    "watermark",
  ]);
  const receipt = observe(["github-refresh", "alpha", "source", "receipt"], {
    status: "succeeded",
  });
  coordinator.enqueue(PUSH_TOPICS, true);
  coordinator.enqueue(["sources", "activity"]);
  await settle();
  expect(history.queryFn).not.toHaveBeenCalled();
  expect(receipt.queryFn).not.toHaveBeenCalled();
  coordinator.enqueue(["access"]);
  await settle();
  expect(history.queryFn).toHaveBeenCalledTimes(1);
  expect(receipt.queryFn).toHaveBeenCalledTimes(1);
  history.ends[0]!();
  receipt.ends[0]!();
  await settle();
});

it("drops queued work while hidden or stopped and does not restart it after a late response", async () => {
  const query = observe(["github-coverage", "alpha"]);
  coordinator.enqueue(["sources"]);
  await settle();
  coordinator.enqueue(["sources"]);
  active = false;
  coordinator.pause();
  query.ends[0]!();
  await vi.advanceTimersByTimeAsync(10000);
  expect(query.queryFn).toHaveBeenCalledTimes(1);
  active = true;
  coordinator.enqueue(["sources"], true);
  await settle();
  expect(query.queryFn).toHaveBeenCalledTimes(2);
  coordinator.enqueue(["sources"]);
  coordinator.stop();
  query.ends[1]!();
  await vi.advanceTimersByTimeAsync(10000);
  expect(query.queryFn).toHaveBeenCalledTimes(2);
});
