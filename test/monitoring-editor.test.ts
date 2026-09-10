import { describe, expect, it } from "vitest";
import { jsonFields, jsonFieldsValue } from "../shared/monitoring-editor";
import {
  MONITOR_DEFAULTS,
  monitorConfigurationPlanInput,
  monitorTargetSchema,
  monitorTriagePlanInput,
} from "../shared/monitoring";
import { canonicalMonitorConfiguration } from "../worker/monitoring-operations";

describe("structured monitoring expectations", () => {
  it("normalizes triage notes and rejects blank, oversized, or control-bearing values", () => {
    const input = {
      workspaceId: "test",
      connectionId: "test",
      connectionRevision: 1,
      reviewId: crypto.randomUUID(),
      incidentId: "test-incident",
      incidentRevision: 1,
      action: "acknowledged",
    };
    expect(monitorTriagePlanInput.parse(input).note).toBeNull();
    expect(monitorTriagePlanInput.parse({ ...input, note: "  Checking origin  " }).note).toBe("Checking origin");
    for (const note of ["", "  ", "line\nbreak", "tab\tvalue", "control\u0085value", "a".repeat(1025)]) {
      expect(monitorTriagePlanInput.safeParse({ ...input, note }).success).toBe(false);
    }
  });
  it("round-trips nested values without raw JSON editing or prototype mutation", () => {
    const value = JSON.parse(
      '{"ready":true,"count":2,"nullable":null,"label":"ready","nested":{"items":["a",2,false,null,{"state":"ok"}]},"__proto__":{"safe":true}}',
    );
    expect(jsonFieldsValue(jsonFields(value))).toEqual(value);
    expect(Object.hasOwn(jsonFieldsValue(jsonFields(value)), "__proto__")).toBe(
      true,
    );
    expect(Object.getPrototypeOf(jsonFieldsValue(jsonFields(value)))).toBe(
      Object.prototype,
    );
  });
  it("requires unique sibling properties and finite nonempty numbers", () => {
    const field = jsonFields({ value: 1 })[0]!;
    expect(() => jsonFieldsValue([field, { ...field, id: "other" }])).toThrow(
      /unique/,
    );
    expect(jsonFieldsValue([field, { ...field, id: "other" }], true)).toEqual([
      1, 1,
    ]);
    for (const value of ["", " ", "Infinity", "NaN", "1e999"])
      expect(() => jsonFieldsValue([{ ...field, value }])).toThrow(/finite/);
    expect(jsonFieldsValue([{ ...field, value: "-1.25" }])).toEqual({
      value: -1.25,
    });
  });
  it("validates head, redirect, nested JSON, and public endpoint combinations", () => {
    const target = {
      id: "example-health",
      url: "https://example.com",
      method: "GET",
      failureThreshold: 2,
      recoveryThreshold: 2,
      timeoutMilliseconds: 10000,
    };
    for (const fields of [
      { method: "HEAD", expect: { jsonSubset: { ready: true } } },
      {
        expect: {
          location: { url: "https://example.com/next", ignoreQuery: false },
        },
      },
      { expect: { jsonSubset: {} } },
      { expect: { jsonSubset: { oversized: "a".repeat(4096) } } },
      { url: "http://127.0.0.1/health" },
      { url: "https://token@example.com" },
    ])
      expect(
        monitorTargetSchema.safeParse({ ...target, ...fields }).success,
      ).toBe(false);
    expect(
      monitorTargetSchema.safeParse({
        ...target,
        expectedStatuses: [301, 308],
        expect: {
          location: { url: "https://example.com/next", ignoreQuery: true },
        },
      }).success,
    ).toBe(true);
    expect(
      monitorConfigurationPlanInput.safeParse({
        workspaceId: "test",
        connectionId: "test",
        connectionRevision: 1,
        configurationRevision: 1,
        reviewId: crypto.randomUUID(),
        change: {
          kind: "target",
          action: "update",
          targetId: "different",
          target,
        },
      }).success,
    ).toBe(false);
  });
  it("canonicalizes URL, statuses and nested properties for provider review fingerprints", () => {
    const result = canonicalMonitorConfiguration({
      schemaVersion: 2,
      defaults: { ...MONITOR_DEFAULTS },
      targets: [
        {
          id: "synthetic-health",
          url: "HTTPS://EXAMPLE.COM:443/health",
          method: "GET",
          failureThreshold: 2,
          recoveryThreshold: 2,
          timeoutMilliseconds: 10000,
          expectedStatuses: [204, 200],
          expect: {
            jsonSubset: { z: [{ two: 2, one: 1 }, null, true], a: "ready" },
            bodyIncludes: "ready",
            contentType: "application/json",
          },
        },
      ],
    });
    expect(JSON.stringify(result)).toBe(
      '{"defaults":{"failureThreshold":2,"method":"GET","probeIntervalMinutes":5,"recoveryThreshold":2,"timeoutMilliseconds":10000},"schemaVersion":2,"targets":[{"expect":{"bodyIncludes":"ready","contentType":"application/json","jsonSubset":{"a":"ready","z":[{"one":1,"two":2},null,true]}},"expectedStatuses":[200,204],"failureThreshold":2,"id":"synthetic-health","method":"GET","recoveryThreshold":2,"timeoutMilliseconds":10000,"url":"https://example.com/health"}]}',
    );
  });
});
