import { describe, expect, it } from "vitest";
import type { GitHubRefreshItem } from "../shared/github";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import {
  GITHUB_CHANGE_LABELS,
  githubCollectionOutcome,
  githubReceiptHref,
  githubRefreshSummary,
} from "../shared/github-refresh-summary";
import type { GitHubStopReason } from "../shared/github-diagnostics";

function item(reason: GitHubStopReason = "complete"): GitHubRefreshItem {
  return {
    repositoryId: "repo",
    fullName: "example/repository",
    status: reason === "complete" ? "succeeded" : "partial",
    attempts: 1,
    summary: "Synthetic evidence",
    updatedAt: "2026-01-01T00:00:00Z",
    observedAt: "2026-01-01T00:00:00Z",
    changes: [],
    evidence: {
      checks: GITHUB_CHECK_KEYS.map((key) => ({
        key,
        state:
          key !== "secretScanning" || reason === "complete"
            ? "observed"
            : reason === "permission" || reason === "credential"
              ? "unavailable"
              : "error",
        summary: "Synthetic category",
      })),
    },
    diagnostics: {
      elapsedMs: 10,
      requests: 7,
      pages: 5,
      endpoints: GITHUB_CHECK_KEYS.map((key) => ({
        key,
        requests: 1,
        pages: 0,
        reason: key === "secretScanning" ? reason : "complete",
      })),
    },
  };
}

describe("Refresh summary distinctions", () => {
  it("separates fully collected, coverage-limited, and actionable failures in one run", () => {
    const summary = githubRefreshSummary([
      item(),
      item("permission"),
      item("timeout"),
      item("credential"),
    ]);
    expect(summary.outcome).toContain(
      "1 fully collected, 1 with access or feature gaps, 2 needing collection attention",
    );
    expect(summary.outcome).toContain("Timed out, Credential rejected");
    expect(summary.changes).toBe(
      "No evidence changes since the previous observations.",
    );
  });

  it("does not invent expected gaps from unverified legacy diagnostics or mixed failures", () => {
    const legacy = { ...item("permission"), diagnostics: null, changes: null };
    expect(githubCollectionOutcome(legacy)).toBe("failure");
    expect(githubRefreshSummary([legacy]).changes).toContain("not recorded");
    const mixed = item("permission");
    mixed.evidence!.checks.find((check) => check.key === "checks")!.state =
      "rate_limited";
    mixed.diagnostics!.endpoints.find(
      (endpoint) => endpoint.key === "checks",
    )!.reason = "rate_limit";
    expect(githubCollectionOutcome(mixed)).toBe("failure");
    expect(githubRefreshSummary([mixed]).outcome).toContain(
      "Provider cooldown",
    );
    expect(githubCollectionOutcome({ ...item(), status: "failed" })).toBe(
      "failure",
    );
  });

  it("does not call failed CI or an unknown assessment a collection failure", () => {
    const collected = {
      ...item(),
      summary: "CI is failing. At least 3 open security findings.",
    };
    expect(githubCollectionOutcome(collected)).toBe("collected");
    expect(githubRefreshSummary([collected]).summary).not.toMatch(
      /healthy|clean bill|CI passed/i,
    );
  });

  it("bounds names and reasons while keeping the full changed count", () => {
    const changes = Object.keys(GITHUB_CHANGE_LABELS).filter(
      (key) => key !== "first",
    ) as NonNullable<GitHubRefreshItem["changes"]>;
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...item("provider_error"),
      fullName: "x".repeat(39) + "/" + "r".repeat(95) + index,
      changes,
    }));
    const summary = githubRefreshSummary(items);
    expect(summary.summary).toContain("Evidence changed for 100 repositories");
    expect(summary.summary).toContain("plus 97 repositories");
    expect(summary.summary).not.toContain(items[3].fullName);
    expect(summary.summary.length).toBeLessThanOrEqual(2000);
  });

  it("builds local receipt links from encoded identifiers, not provider URLs", () => {
    const href = githubReceiptHref("alpha", "source", "receipt");
    expect(href).toBe(
      "/settings/github?workspace=alpha&source=source&refresh=receipt",
    );
    const suspicious = githubReceiptHref(
      "alpha&workspace=beta",
      "https://other.invalid/",
      "<img>",
    );
    const url = new URL(suspicious, "https://hq.example");
    expect(url.origin).toBe("https://hq.example");
    expect(url.searchParams.getAll("workspace")).toEqual([
      "alpha&workspace=beta",
    ]);
    expect(url.searchParams.get("refresh")).toBe("<img>");
  });
});
