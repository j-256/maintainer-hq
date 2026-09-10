import { describe, expect, it } from "vitest";
import {
  hookAttention,
  monitorAttention,
} from "../shared/attention-operations";
import type { HookResult } from "../shared/hooks";
import type { MonitorResult } from "../shared/monitoring";

const READ = "2026-09-07T12:00:00.000Z";
const NOW = Date.parse(READ);
const DEADLINE = "2026-09-07T12:03:00.000Z";
const source = { id: "connection", name: "Example provider" };
function hookFixture() {
  const snapshot: HookResult<"snapshot"> = {
    observedAt: READ,
    deliveries: {
      totals: {
        pending: 0,
        queued: 0,
        processing: 0,
        retrying: 0,
        delivered: 0,
        filtered: 0,
        exhausted: 0,
      },
      sampled: 0,
      limit: 1000,
      truncated: false,
    },
    signals: { items: [], truncated: false },
    lastRetentionAt: null,
  };
  const deliveries: HookResult<"deliveries"> = {
    items: [],
    nextCursor: null,
    scanned: 0,
    observedAt: READ,
    pagination: "live-updated-desc",
  };
  return { snapshot, deliveries };
}
function monitorFixture() {
  const configuration = {
    configFingerprint: "sha256:" + "a".repeat(64),
    revision: 1,
    targetCount: 1,
    updatedAt: READ,
    updatedBy: "operator",
    updatedWorkspace: "alpha",
  };
  const snapshot: MonitorResult<"snapshot"> = {
    readAt: READ,
    configuration,
    runtimeConfigured: true,
    enabled: true,
    deliveryEnabled: true,
    analyticsEnabled: false,
    openIncidents: { count: 0, truncated: false },
    pendingDeliveries: { count: 0, truncated: false },
    execution: {
      state: "fresh",
      freshUntil: DEADLINE,
      expectedIntervalSeconds: 60,
      retainedRunLimit: 120,
      lastRun: {
        scheduledAt: READ,
        startedAt: READ,
        completedAt: READ,
        enabled: true,
        configurationRevision: 1,
        configFingerprint: configuration.configFingerprint,
        probeIntervalMinutes: 1,
        targetCount: 1,
        dueTargets: 1,
        succeededProbes: 1,
        failedProbes: 0,
        phaseErrors: 0,
        deliveriesFailed: 0,
        subrequests: 1,
      },
    },
  };
  const targets: MonitorResult<"targets"> = {
    readAt: READ,
    configuration,
    items: [
      {
        id: "health",
        url: "https://private.example/sensitive-endpoint",
        method: "GET",
        failureThreshold: 2,
        recoveryThreshold: 2,
        timeoutMilliseconds: 10000,
        evidence: {
          state: "unobserved",
          observedAt: null,
          incidentId: null,
          configurationMatches: null,
          status: null,
          errorCode: null,
          check: {
            state: "passed",
            observedAt: READ,
            lastSuccessAt: READ,
            freshUntil: DEADLINE,
            scheduledAt: READ,
            configurationRevision: 1,
            configurationMatches: true,
            status: 200,
            errorCode: null,
          },
        },
      },
    ],
    nextCursor: null,
  };
  const incidents: MonitorResult<"incidents"> = {
    readAt: READ,
    items: [],
    nextCursor: null,
  };
  return { snapshot, targets, incidents };
}
describe("Operational attention evidence", () => {
  it("keeps delivery identities distinct when event and sink names contain separators", () => {
    const fixture = hookFixture();
    fixture.deliveries.items = [
      { eventId: "event:a", sinkName: "b" },
      { eventId: "event", sinkName: "a:b" },
    ].map((identity) => ({
      ...identity,
      generation: 1,
      status: "exhausted",
      attempts: 3,
      decisionReason: null,
      updatedAt: READ,
      deliveredAt: null,
      receivedAt: READ,
      subscription: "example",
      source: "example",
    }));
    const { items } = hookAttention(
      "alpha",
      source,
      fixture.snapshot,
      fixture.deliveries,
      NOW,
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    for (const [index, item] of items.entries()) {
      const params = new URL(item.href, "https://hq.example").searchParams;
      expect(params.get("event")).toBe(fixture.deliveries.items[index].eventId);
      expect(params.get("sink")).toBe(fixture.deliveries.items[index].sinkName);
    }
  });
  it("groups repeated retained signals without inventing event or resource identity", () => {
    const fixture = hookFixture();
    fixture.snapshot.signals.items = ["warning", "critical"].map(
      (severity) => ({
        code: "ingress-persistence-rejected",
        severity: severity as "warning" | "critical",
        occurrences: 3,
        firstSeenAt: READ,
        lastSeenAt: READ,
        resolvedAt: null,
      }),
    );
    fixture.snapshot.signals.items.push({
      ...fixture.snapshot.signals.items[0],
      resolvedAt: READ,
    });
    const result = hookAttention(
      "alpha",
      source,
      fixture.snapshot,
      fixture.deliveries,
      NOW,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      severity: "critical",
      resourceKey: null,
      repositoryIds: [],
      projectIds: [],
    });
    expect(result.items[0].reason).toContain(
      "2 unresolved retained signal records",
    );
  });
  it("exposes sample limits even when no failures occur in the visible sample", () => {
    const fixture = hookFixture();
    fixture.snapshot.deliveries.truncated = true;
    expect(
      hookAttention("alpha", source, fixture.snapshot, fixture.deliveries, NOW),
    ).toMatchObject({
      limited: true,
      items: [expect.objectContaining({ category: "coverage" })],
    });
  });
  it("distinguishes matching failed checks, stale evidence and configuration changes without endpoint URLs", () => {
    const fixture = monitorFixture();
    expect(
      monitorAttention(
        "alpha",
        source,
        fixture.snapshot,
        fixture.targets,
        fixture.incidents,
        NOW,
      ).items,
    ).toEqual([]);
    fixture.targets.items[0].evidence.check.state = "failed";
    fixture.targets.items[0].evidence.check.status = 503;
    expect(
      monitorAttention(
        "alpha",
        source,
        fixture.snapshot,
        fixture.targets,
        fixture.incidents,
        NOW,
      ).items,
    ).toEqual([
      expect.objectContaining({
        category: "problem",
        title: "Monitoring check failed",
        resourceKey: "health",
      }),
    ]);
    fixture.targets.items[0].evidence.check.configurationMatches = false;
    expect(
      monitorAttention(
        "alpha",
        source,
        fixture.snapshot,
        fixture.targets,
        fixture.incidents,
        NOW,
      ).items,
    ).toEqual([
      expect.objectContaining({
        category: "coverage",
        title: "Monitoring check configuration changed",
      }),
    ]);
    fixture.targets.items[0].evidence.check.configurationMatches = true;
    const stale = monitorAttention(
      "alpha",
      source,
      fixture.snapshot,
      fixture.targets,
      fixture.incidents,
      Date.parse(DEADLINE),
    );
    expect(stale.items.map((item) => item.category)).toEqual([
      "coverage",
      "coverage",
    ]);
    expect(JSON.stringify(stale)).not.toContain("private.example");
  });
  it("surfaces scheduler errors and explicitly missing or bounded monitoring evidence", () => {
    const fixture = monitorFixture();
    fixture.snapshot.execution.lastRun!.phaseErrors = 1;
    expect(
      monitorAttention(
        "alpha",
        source,
        fixture.snapshot,
        fixture.targets,
        fixture.incidents,
        NOW,
      ).items[0],
    ).toMatchObject({
      category: "problem",
      title: "Monitoring run reported errors",
    });
    fixture.snapshot.execution.lastRun = null;
    fixture.snapshot.enabled = false;
    fixture.snapshot.openIncidents.truncated = true;
    const result = monitorAttention(
      "alpha",
      source,
      fixture.snapshot,
      fixture.targets,
      fixture.incidents,
      NOW,
    );
    expect(result.limited).toBe(true);
    expect(result.items.every((item) => item.category === "coverage")).toBe(
      true,
    );
    expect(
      result.items.some(
        (item) => item.title === "Monitoring scheduler has not been observed",
      ),
    ).toBe(true);
  });
});
