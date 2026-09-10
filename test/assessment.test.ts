import { describe, expect, it } from "vitest";
import {
  assessRepository,
  DEFAULT_EXPECTATIONS,
  reviewIsDue,
  type Observation,
  type Repository,
} from "../shared/domain";

const NOW = Date.parse("2026-01-02T12:00:00Z");
const repository: Repository = {
  id: "repository",
  workspaceId: "workspace",
  fullName: "example/project",
  description: "",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  expectations: DEFAULT_EXPECTATIONS,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00Z",
};
const healthy: Observation = {
  sourceId: "github",
  resourceId: repository.id,
  resourceType: "repository",
  name: repository.fullName,
  provider: "github",
  health: "healthy",
  summary: "Checks passing",
  details: { ci: "passing", openFindings: 0, visibility: "private" },
  observedAt: "2026-01-02T11:00:00Z",
  receivedAt: "2026-01-02T11:00:01Z",
  expiresAt: "2026-01-02T13:00:00Z",
};

describe("Evidence-aware repository assessment", () => {
  it("never treats missing, unrelated, expired, or archived evidence as healthy", () => {
    expect(assessRepository(repository, [], NOW)).toMatchObject({
      health: "unknown",
      freshness: "unknown",
    });
    expect(
      assessRepository(
        repository,
        [{ ...healthy, resourceId: "elsewhere" }],
        NOW,
      ).health,
    ).toBe("unknown");
    expect(
      assessRepository(
        repository,
        [{ ...healthy, expiresAt: "2026-01-02T12:00:00Z" }],
        NOW,
      ),
    ).toMatchObject({ health: "unknown", freshness: "stale" });
    expect(
      assessRepository({ ...repository, lifecycle: "archived" }, [healthy], NOW)
        .health,
    ).toBe("unknown");
  });
  it("uses the newest source evidence without mutating input order or reviving superseded evidence", () => {
    const newer = {
      ...healthy,
      observedAt: "2026-01-02T11:00:00.500Z",
      details: { ...healthy.details, ci: "failing" as const },
    };
    const observations = [healthy, newer];
    expect(assessRepository(repository, observations, NOW)).toMatchObject({
      health: "warning",
      reasons: ["CI is failing"],
    });
    expect(observations[0]).toBe(healthy);
    expect(
      assessRepository(
        repository,
        [healthy, { ...newer, expiresAt: "2026-01-02T12:00:00Z" }],
        NOW,
      ).health,
    ).toBe("unknown");
  });
  it("distinguishes unverified requirements from known problems", () => {
    expect(assessRepository(repository, [healthy], NOW).health).toBe("healthy");
    expect(
      assessRepository(
        repository,
        [{ ...healthy, details: { ci: "passing" } }],
        NOW,
      ),
    ).toMatchObject({
      health: "unknown",
      reasons: ["Security has not been verified"],
    });
    expect(
      assessRepository(
        repository,
        [{ ...healthy, details: { ci: "passing", openFindings: 2 } }],
        NOW,
      ),
    ).toMatchObject({ health: "warning", reasons: ["Open security findings"] });
    expect(
      assessRepository(
        repository,
        [
          {
            ...healthy,
            health: "critical",
            summary: "Critical source finding",
          },
        ],
        NOW,
      ),
    ).toMatchObject({
      health: "critical",
      reasons: ["Critical source finding"],
    });
  });
  it("requires known coverage, honors disabled sources, and never substitutes unrelated passing checks", () => {
    const tracked = {
      ...repository,
      expectations: { ...DEFAULT_EXPECTATIONS, hooks: "required" as const },
    };
    const hook: Observation = {
      ...healthy,
      sourceId: "hooks",
      provider: "hookrelay",
      health: "unknown",
      details: {},
    };
    expect(assessRepository(tracked, [healthy], NOW).health).toBe("unknown");
    expect(assessRepository(tracked, [healthy, hook], NOW)).toMatchObject({
      health: "unknown",
      reasons: ["Hook coverage is unverified"],
    });
    expect(
      assessRepository(
        tracked,
        [healthy, { ...hook, health: "healthy", details: { enabled: false } }],
        NOW,
      ).health,
    ).toBe("warning");
    expect(
      assessRepository(
        tracked,
        [healthy, { ...hook, health: "healthy", details: { enabled: true } }],
        NOW,
      ).health,
    ).toBe("healthy");
  });
  it("distinguishes absent visibility from a mismatch and explains unknown-only observations", () => {
    const privateRepository = {
      ...repository,
      expectations: { ...DEFAULT_EXPECTATIONS, visibility: "private" as const },
    };
    expect(
      assessRepository(
        privateRepository,
        [{ ...healthy, details: { ci: "passing", openFindings: 0 } }],
        NOW,
      ),
    ).toMatchObject({
      health: "unknown",
      reasons: ["Visibility has not been verified"],
    });
    expect(
      assessRepository(
        privateRepository,
        [{ ...healthy, details: { ...healthy.details, visibility: "public" } }],
        NOW,
      ).health,
    ).toBe("warning");
    expect(
      assessRepository(repository, [{ ...healthy, health: "unknown" }], NOW),
    ).toMatchObject({
      health: "unknown",
      reasons: ["Fresh observations do not establish health"],
    });
  });
  it("makes review reminders due only after the entire UTC date has passed", () => {
    const review = {
      ...repository,
      expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2026-01-02" },
    };
    expect(reviewIsDue(review, Date.parse("2026-01-02T23:59:59.999Z"))).toBe(
      false,
    );
    expect(reviewIsDue(review, Date.parse("2026-01-03T00:00:00Z"))).toBe(true);
    expect(
      reviewIsDue(
        { ...review, lifecycle: "archived" },
        Date.parse("2026-01-03T00:00:00Z"),
      ),
    ).toBe(false);
  });
});
