import { expect, it } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  projectSchema,
  type Goal,
} from "../shared/domain";
import {
  applyViewUpdate,
  routeScope,
  sortView,
} from "../src/lib/workspace-sync";
import {
  VIEW_COLLECTIONS,
  VIEW_TOPICS,
  type WorkspaceView,
  type SyncDelta,
} from "../shared/workspace-sync";
import { workspaceQueryMatches } from "../src/lib/workspace-push";
import { SETTINGS_SECTIONS } from "../shared/settings-navigation";

const repo = {
  id: "repo",
  workspaceId: "alpha",
  fullName: "example/repo",
  description: "Original",
  projectId: "project",
  classification: "maintained" as const,
  lifecycle: "active" as const,
  expectations: DEFAULT_EXPECTATIONS,
  revision: 1,
  updatedAt: "2026-01-01",
};
const view: WorkspaceView = {
  workspace: { id: "alpha", name: "Alpha", role: "owner" },
  principal: { subject: "owner", displayName: "Owner" },
  capabilities: ["read"],
  scope: { view: "repositories" },
  cursor: 10,
  memberRevision: 1,
  generatedAt: "2026-01-01",
  development: true,
  records: {
    repositories: [repo],
    observations: [],
    projects: [
      projectSchema.parse({
        id: "project",
        workspaceId: "alpha",
        name: "Project",
        description: "",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  },
};
const delta: SyncDelta = {
  type: "delta",
  from: 10,
  cursor: 12,
  generatedAt: "2026-01-02",
  upserts: { repositories: [{ ...repo, description: "Updated", revision: 2 }] },
  removals: [],
};
it("loads only the membership envelope for an unknown app route", () => {
  expect(routeScope("/unknown", null)).toEqual({ view: "workspace" });
  expect(VIEW_COLLECTIONS.workspace).toEqual([]);
  expect(routeScope("/", null)).toEqual({ view: "overview" });
});
it("keeps Releases separate from Activity, health observations and unrelated provider topics", () => {
  expect(routeScope("/repositories/repo", "work")).toEqual({
    view: "repository-work",
    repositoryId: "repo",
  });
  expect(routeScope("/repositories/repo", "releases")).toEqual({
    view: "repository-releases",
    repositoryId: "repo",
  });
  expect(routeScope("/projects/project", "releases")).toEqual({
    view: "projects-releases",
  });
  for (const view of [
    "repository-releases",
    "projects-releases",
    "repository-work",
  ] as const) {
    expect(VIEW_COLLECTIONS[view]).toEqual([
      "projects",
      "repositories",
      "connections",
    ]);
    expect(VIEW_TOPICS[view]).toEqual([
      "workspace",
      "sources",
      "associations",
      "access",
    ]);
  }
  const key = ["repository-releases", "alpha", "repo", 1, "github", 1];
  const workKey = ["repository-work", "alpha", "repo", 1, "github", 1];
  expect(workspaceQueryMatches(workKey, "alpha", ["sources"])).toBe(true);
  expect(workspaceQueryMatches(workKey, "beta", ["sources"])).toBe(false);
  expect(workspaceQueryMatches(key, "alpha", ["sources"])).toBe(true);
  expect(workspaceQueryMatches(key, "beta", ["sources"])).toBe(false);
  for (const topic of [
    "activity",
    "hooks",
    "monitoring",
    "operations",
  ] as const) {
    expect(workspaceQueryMatches(key, "alpha", [topic])).toBe(false);
    expect(workspaceQueryMatches(workKey, "alpha", [topic])).toBe(false);
  }
});
it("keeps subscriptions consistent with case-insensitive routes and trailing slashes", () => {
  for (const route of [
    "overview",
    "activity",
    "projects",
    "repositories",
    "hooks",
    "monitoring",
    "secrets",
    "settings",
  ])
    for (const path of ["/" + route + "/", "/" + route.toUpperCase()])
      expect(routeScope(path, null)).toEqual(routeScope("/" + route, null));
  expect(routeScope("/Settings/GitHub/", null)).toEqual({
    view: "settings-sources",
  });
  expect(routeScope("/Repositories/CaseSensitive-ID/", "hooks")).toEqual({
    view: "repository-hooks",
    repositoryId: "CaseSensitive-ID",
  });
});
it("scopes each Settings task independently and retains import eligibility updates", () => {
  expect(routeScope("/settings", null)).toEqual({ view: "workspace" });
  for (const section of SETTINGS_SECTIONS)
    expect(routeScope("/settings/" + section.id, null)).toEqual({
      view: section.view,
    });
  expect(VIEW_COLLECTIONS["settings-sources"]).toEqual([
    "repositories",
    "observations",
    "connections",
  ]);
  expect(VIEW_COLLECTIONS["settings-import"]).toEqual([]);
  expect(VIEW_TOPICS["settings-import"]).toContain("workspace");
  expect(VIEW_TOPICS.workspace).toEqual(["access"]);
});
it("keeps project subscriptions section-specific while retaining repository regrouping deltas", () => {
  expect(routeScope("/projects", null)).toEqual({ view: "projects" });
  expect(routeScope("/projects/project", "repositories")).toEqual({
    view: "projects",
  });
  for (const section of ["activity", "hooks", "monitoring", "secrets"] as const)
    expect(routeScope("/projects/project", section)).toEqual({
      view: "projects-" + section,
    });
  expect(VIEW_COLLECTIONS.projects).not.toContain("goals");
  expect(VIEW_TOPICS.projects).not.toContain("activity");
  expect(VIEW_COLLECTIONS["projects-secrets"]).not.toContain("observations");
  expect(VIEW_TOPICS["projects-secrets"]).not.toContain("hooks");
  const original: WorkspaceView = {
    ...view,
    scope: { view: "projects" },
    records: {
      ...view.records,
      repositories: [{ ...repo, projectId: "original" }],
    },
  };
  const updated = applyViewUpdate(original, original.scope, {
    ...delta,
    upserts: {
      repositories: [{ ...repo, projectId: "destination", revision: 2 }],
    },
  });
  expect(
    updated.records.repositories?.filter(
      (repository) => repository.projectId === "original",
    ),
  ).toEqual([]);
  expect(updated.records.repositories?.[0].projectId).toBe("destination");
  expect(
    workspaceQueryMatches(
      ["project-resources", "alpha", "project", "hook", null],
      "alpha",
      ["associations"],
    ),
  ).toBe(true);
  expect(
    workspaceQueryMatches(
      ["project-resources", "alpha", "project", "hook", null],
      "alpha",
      ["activity"],
    ),
  ).toBe(false);
});

it("applies changes atomically without replacing unrelated collections and ignores duplicate or older delivery", () => {
  const updated = applyViewUpdate(view, view.scope, delta);
  expect(updated.records.repositories?.[0].description).toBe("Updated");
  expect(updated.records.observations).toBe(view.records.observations);
  expect(updated.records.projects).toBe(view.records.projects);
  expect(view.records.repositories?.[0].description).toBe("Original");
  expect(applyViewUpdate(updated, view.scope, delta)).toBe(updated);
  expect(applyViewUpdate(updated, view.scope, { ...delta, cursor: 11 })).toBe(
    updated,
  );
  expect(
    applyViewUpdate(updated, view.scope, { ...delta, cursor: 13, from: 10 })
      .cursor,
  ).toBe(13);
});
it("recovers gaps, rejects other scopes and prevents cross-workspace or off-view cache pollution", () => {
  expect(applyViewUpdate(view, view.scope, { ...delta, from: 11 }).resync).toBe(
    true,
  );
  expect(applyViewUpdate(view, { view: "activity" }, delta)).toBe(view);
  expect(
    applyViewUpdate(view, view.scope, { ...delta, upserts: { goals: [] } })
      .resync,
  ).toBe(true);
  expect(
    applyViewUpdate(view, view.scope, {
      ...delta,
      upserts: { repositories: [{ ...repo, workspaceId: "beta" }] },
    }).resync,
  ).toBe(true);
  expect(
    applyViewUpdate(view, view.scope, {
      ...delta,
      upserts: {
        projects: [
          projectSchema.parse({
            id: "foreign-project",
            workspaceId: "beta",
            name: "Foreign",
            description: "",
            revision: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      },
    }).resync,
  ).toBe(true);
  expect(
    applyViewUpdate(view, view.scope, {
      type: "reset",
      cursor: 20,
      reason: "history_expired",
    }).resync,
  ).toBe(true);
});
it("applies tombstones and preserves deterministic display order", () => {
  const inserted = applyViewUpdate(view, view.scope, {
    ...delta,
    upserts: {
      repositories: [{ ...repo, id: "another", fullName: "a/first" }],
    },
  });
  expect(
    sortView(inserted).records.repositories?.map((record) => record.id),
  ).toEqual(["another", "repo"]);
  expect(
    applyViewUpdate(view, view.scope, {
      ...delta,
      upserts: {},
      removals: [{ collection: "repositories", key: repo.id }],
    }).records.repositories,
  ).toEqual([]);
});
it("sorts paused open goals ahead of cleared history after incremental delivery", () => {
  const goal = (
    id: string,
    status: Goal["status"],
    startedAt: string,
  ): Goal => ({
    id,
    status,
    startedAt,
    sourceId: "agent",
    actor: "Agent",
    objective: id,
    reportedAt: startedAt,
    receivedAt: startedAt,
  });
  const original: WorkspaceView = {
    ...view,
    scope: { view: "activity" },
    records: {
      goals: [
        goal("older-open", "active", "2026-01-01"),
        goal("newer-paused", "paused", "2026-01-02"),
        goal("history", "complete", "2026-02-01"),
      ],
    },
  };
  const updated = applyViewUpdate(original, original.scope, {
    ...delta,
    upserts: { goals: [goal("cleared", "cleared", "2026-03-01")] },
  });
  expect(sortView(updated).records.goals?.map(({ id }) => id)).toEqual([
    "newer-paused",
    "older-open",
    "cleared",
    "history",
  ]);
  expect(original.records.goals).toHaveLength(3);
});
it("derives app and repository section scopes and never broadly invalidates view records for Activity", () => {
  expect(routeScope("/repositories", null)).toEqual({ view: "repositories" });
  expect(routeScope("/repositories/repo", "activity")).toEqual({
    view: "repository-activity",
    repositoryId: "repo",
  });
  expect(routeScope("/settings/preferences", null)).toEqual({
    view: "preferences",
  });
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "view", "repositories", null],
      "alpha",
      ["activity"],
    ),
  ).toBe(false);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "view", "repositories", null],
      "alpha",
      ["workspace"],
    ),
  ).toBe(false);
  expect(
    workspaceQueryMatches(
      ["workspace", "alpha", "view", "repositories", null],
      "alpha",
      ["access"],
    ),
  ).toBe(true);
});
