import { describe, expect, it } from "vitest";
import type {
  MonitorObservedTarget,
  MonitorResult,
} from "../shared/monitoring";
import {
  monitorCheckState,
  monitorExecutionState,
} from "../shared/monitoring-freshness";

const CHECKED = "2026-09-06T10:00:00.000Z";
const DEADLINE = "2026-09-06T10:03:00.000Z";
const evidence: MonitorObservedTarget["evidence"] = {
  state: "unobserved",
  observedAt: null,
  incidentId: null,
  configurationMatches: null,
  status: null,
  errorCode: null,
  check: {
    state: "passed",
    observedAt: CHECKED,
    lastSuccessAt: CHECKED,
    freshUntil: DEADLINE,
    scheduledAt: CHECKED,
    configurationRevision: 1,
    configurationMatches: true,
    status: 200,
    errorCode: null,
  },
};
const execution: MonitorResult<"snapshot">["execution"] = {
  state: "fresh",
  freshUntil: DEADLINE,
  expectedIntervalSeconds: 60,
  retainedRunLimit: 120,
  lastRun: {
    scheduledAt: CHECKED,
    startedAt: CHECKED,
    completedAt: CHECKED,
    enabled: true,
    configurationRevision: 1,
    configFingerprint: "sha256:" + "a".repeat(64),
    probeIntervalMinutes: 1,
    targetCount: 1,
    dueTargets: 1,
    succeededProbes: 1,
    failedProbes: 0,
    phaseErrors: 0,
    deliveriesFailed: 0,
    subrequests: 1,
  },
};
describe("monitor evidence clocks", () => {
  it("ages cached evidence at its deadline without another provider response", () => {
    expect(monitorExecutionState(execution, Date.parse(CHECKED))).toBe("fresh");
    expect(monitorCheckState(evidence, Date.parse(CHECKED))).toBe("passed");
    for (const now of [Date.parse(DEADLINE), Date.parse(CHECKED) - 1, NaN]) {
      expect(monitorExecutionState(execution, now)).toBe("stale");
      expect(monitorCheckState(evidence, now)).toBe("stale");
    }
    expect(
      monitorExecutionState(
        { ...execution, lastRun: null },
        Date.parse(CHECKED),
      ),
    ).toBe("unobserved");
    expect(
      monitorExecutionState(
        { ...execution, state: "stale" },
        Date.parse(CHECKED),
      ),
    ).toBe("stale");
  });
  it("does not revive mismatched, stale, missing, or superseded probe evidence", () => {
    const now = Date.parse(CHECKED) + 2000;
    expect(
      monitorCheckState(
        {
          ...evidence,
          check: { ...evidence.check, configurationMatches: false },
        },
        now,
      ),
    ).toBe("configuration_changed");
    expect(
      monitorCheckState(
        { ...evidence, check: { ...evidence.check, state: "stale" } },
        now,
      ),
    ).toBe("stale");
    expect(
      monitorCheckState(
        { ...evidence, check: { ...evidence.check, observedAt: null } },
        now,
      ),
    ).toBe("unobserved");
    expect(
      monitorCheckState(
        {
          ...evidence,
          check: { ...evidence.check, configurationMatches: null },
        },
        now,
      ),
    ).toBe("unobserved");
    expect(
      monitorCheckState(
        {
          ...evidence,
          state: "exceptional",
          configurationMatches: true,
          observedAt: "2026-09-06T10:00:01.000Z",
        },
        now,
      ),
    ).toBe("exceptional");
    expect(
      monitorCheckState(
        {
          ...evidence,
          check: { ...evidence.check, state: "failed", status: 503 },
        },
        now,
      ),
    ).toBe("failed");
  });
});
