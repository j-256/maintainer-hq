import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  type Observation,
  type Project,
  type Repository,
} from "../shared/domain";
import {
  ATTENTION_LIMITS,
  ageAttention,
  attentionPage,
  workspaceAttention,
  type AttentionContext,
} from "../shared/attention";
import { GITHUB_CHECK_KEYS } from "../shared/github-evidence";
import type { GitHubSource } from "../shared/github";
import { commands, commandAnnotations } from "../shared/commands";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const PRIVATE = "private-provider-summary";
const repository: Repository = {
  id: "repo",
  workspaceId: "alpha",
  fullName: "example/repo",
  description: "",
  projectId: "project",
  classification: "maintained",
  lifecycle: "active",
  expectations: { ...DEFAULT_EXPECTATIONS },
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
};
const project: Project = {
  id: "project",
  workspaceId: "alpha",
  name: "Project",
  description: "",
  lifecycle: "active",
  importance: "high",
  importanceNote: "",
  portfolio: { ...DEFAULT_PORTFOLIO },
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
};
const source: GitHubSource = {
  id: "github",
  name: "GitHub selected",
  provider: "github",
  repositoryIds: [repository.id],
  revision: 1,
  enabled: true,
  freshnessMinutes: 30,
  credentialConfigured: true,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: PRIVATE,
  github: {
    credentialRef: PRIVATE,
    configurationValid: true,
    refreshIntervalMinutes: 5,
    nextRefreshAt: null,
    retryAt: null,
    activeRefreshId: null,
    lastRefreshId: null,
    lastRefreshStatus: null,
  },
};
const observation: Observation = {
  sourceId: source.id,
  resourceType: "repository",
  resourceId: repository.id,
  name: repository.fullName,
  provider: "github",
  health: "warning",
  summary: PRIVATE,
  observedAt: new Date(NOW - 1000).toISOString(),
  receivedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  details: {
    ci: "failing",
    openFindings: 2,
    visibility: "public",
    github: {
      headSha: "a".repeat(40),
      checks: GITHUB_CHECK_KEYS.map((key) => ({
        key,
        state: key === "codeScanning" ? "unavailable" : "observed",
        summary: PRIVATE,
      })),
    },
  },
};
function fixture(): AttentionContext {
  return structuredClone({
    workspace: { id: "alpha", name: "Alpha", role: "owner" },
    repositories: [repository],
    projects: [project],
    connections: [source],
    observations: [observation],
  });
}
const build = (context = fixture()) => workspaceAttention(context, NOW);

describe("Actionable workspace attention", () => {
  it("keeps positively observed failures alongside unread coverage and strips raw private summaries", () => {
    const items = build();
    expect(items.map((item) => item.category)).toEqual([
      "coverage",
      "problem",
      "problem",
    ]);
    expect(
      items.find((item) => item.title.includes("security"))?.reason,
    ).toContain("additional findings");
    expect(items.find((item) => item.title.includes("CI"))).toMatchObject({
      repositoryIds: ["repo"],
      projectIds: ["project"],
      source: source.name,
      observedAt: observation.observedAt,
    });
    expect(JSON.stringify(items)).not.toContain(PRIVATE);
    expect(items.find((item) => item.title.includes("CI"))?.href).toBe(
      "https://github.com/example/repo/commit/" + "a".repeat(40) + "/checks",
    );
    const href = items.find((item) => item.category === "coverage")!.href;
    expect(href).toContain("repository=repo");
    expect(href).toContain("workspace=alpha");
  });
  it.each([
    "stale",
    "renamed",
    "disabled",
    "missing-grant",
    "foreign-source",
    "archived",
    "future",
  ])("does not call %s evidence a fresh incident", (mode) => {
    const context = fixture();
    if (mode === "stale")
      context.observations[0].expiresAt = new Date(NOW).toISOString();
    if (mode === "renamed") context.observations[0].name = "example/previous";
    if (mode === "disabled") context.connections[0].enabled = false;
    if (mode === "missing-grant")
      context.connections[0].credentialConfigured = false;
    if (mode === "foreign-source") context.connections[0].repositoryIds = [];
    if (mode === "archived") context.repositories[0].lifecycle = "archived";
    if (mode === "future")
      context.observations[0].observedAt = new Date(NOW + 30_000).toISOString();
    expect(
      build(context).filter((item) => item.category === "problem"),
    ).toEqual([]);
  });
  it("does not turn optional checks into healthy evidence or hide observed problems", () => {
    const context = fixture();
    context.repositories[0].expectations = {
      ...DEFAULT_EXPECTATIONS,
      ci: "unmanaged",
      security: "optional",
    };
    expect(
      build(context).filter((item) => item.category === "problem"),
    ).toHaveLength(2);
    context.connections = [];
    context.observations = [];
    expect(build(context)).toEqual([]);
  });
  it("does not equate readable endpoints with passing required CI", () => {
    const context = fixture();
    context.observations[0].details.ci = "unknown";
    context.observations[0].details.openFindings = 0;
    context.observations[0].details.github!.checks.forEach((check) => {
      check.state = "observed";
    });
    expect(build(context)).toEqual([
      expect.objectContaining({
        category: "coverage",
        title: "Required CI is not verified",
      }),
    ]);
  });
  it("keeps reviews independent of missing evidence and lists project-only Portfolio reviews once", () => {
    const context = fixture();
    context.observations = [];
    context.repositories[0].expectations.reviewDate = "2026-09-06";
    context.projects.push({
      ...project,
      id: "standalone",
      portfolio: { ...DEFAULT_PORTFOLIO, reviewDate: "2026-09-06" },
    });
    expect(build(context).filter((item) => item.category === "review")).toEqual(
      [
        expect.objectContaining({
          title: "Expectation review overdue",
          repositoryIds: ["repo"],
        }),
        expect.objectContaining({
          title: "Portfolio review overdue",
          repositoryIds: [],
          projectIds: ["standalone"],
        }),
      ],
    );
    context.projects[1].lifecycle = "archived";
    expect(
      build(context).filter((item) => item.category === "review"),
    ).toHaveLength(1);
    context.repositories[0].expectations.reviewDate = "2026-09-07";
    expect(
      build(context).filter((item) => item.category === "review"),
    ).toHaveLength(0);
  });
  it("makes future evidence and missing required results explicit even when endpoints were readable", () => {
    const context = fixture();
    context.observations[0].details.github!.checks.forEach((check) => {
      check.state = "observed";
    });
    context.observations[0].observedAt = new Date(NOW + 1).toISOString();
    expect(build(context)).toEqual([
      expect.objectContaining({
        category: "coverage",
        title: "Evidence timestamp is ahead of this clock",
      }),
    ]);
    context.observations[0].observedAt = observation.observedAt;
    context.observations[0].details.ci = "passing";
    delete context.observations[0].details.openFindings;
    delete context.observations[0].details.visibility;
    context.repositories[0].expectations.security = "required";
    context.repositories[0].expectations.visibility = "private";
    expect(build(context).map((item) => item.title)).toEqual([
      "Required security result is not verified",
      "Required visibility is not verified",
    ]);
  });
  it("prioritizes category then severity then project Importance, with bounded stable pages and context search", () => {
    const context = fixture();
    const sample = build().find((item) => item.category === "problem")!;
    const rows = Array.from({ length: 31 }, (_, index) => ({
      ...sample,
      id: String(index).padStart(2, "0"),
    }));
    rows.push({
      ...sample,
      id: "critical",
      severity: "critical",
      projectIds: [],
    });
    rows.push({
      ...sample,
      id: "gap",
      severity: "critical",
      category: "coverage",
    });
    const first = attentionPage(rows, context, {}, NOW);
    expect(first.items[0].id).toBe("critical");
    expect(first.items).toHaveLength(ATTENTION_LIMITS.PAGE_SIZE);
    expect(first.counts).toEqual({ problem: 32, review: 0, coverage: 1 });
    expect(attentionPage(rows, context, { page: 999 }, NOW).page).toBe(2);
    expect(
      attentionPage(
        rows,
        context,
        { category: "coverage", search: "project" },
        NOW,
      ).items.map((item) => item.id),
    ).toEqual(["gap"]);
    const copy = [...rows];
    attentionPage(rows, context, {}, NOW);
    expect(rows).toEqual(copy);
  });
  it("moves expired operational problems into historical coverage without discarding the reason", () => {
    const item = build().find((item) => item.category === "problem")!;
    const aged = ageAttention(item, NOW + 60_000);
    expect(aged).toMatchObject({
      category: "coverage",
      title: "Last known: " + item.title,
    });
    expect(aged.reason).toContain(item.reason);
  });
  it("provides strict bounded shared-command parity without write or arbitrary provider input", () => {
    expect(
      commands.workspace_attention.schema.safeParse({
        workspaceId: "alpha",
        page: 1001,
      }).success,
    ).toBe(false);
    expect(
      commands.attention_connection.schema.safeParse({
        workspaceId: "alpha",
        connectionId: "hooks",
        revision: 1,
        url: "https://example.com",
      }).success,
    ).toBe(false);
    expect(
      commandAnnotations(
        "workspace_attention",
        commands.workspace_attention.readOnly,
      ).readOnlyHint,
    ).toBe(true);
    expect(
      commandAnnotations(
        "attention_connection",
        commands.attention_connection.readOnly,
      ).readOnlyHint,
    ).toBe(true);
  });
});
