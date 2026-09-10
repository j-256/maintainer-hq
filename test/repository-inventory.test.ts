import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  type Observation,
  type Project,
  type Repository,
} from "../shared/domain";
import {
  inventoryQuery,
  repositoryInventory,
  withInventoryContext,
} from "../src/repository-inventory";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const project = (id = "project", name = "Project"): Project => ({
  id,
  workspaceId: "workspace",
  name,
  description: "",
  lifecycle: "active",
  importance: "standard",
  importanceNote: "",
  portfolio: DEFAULT_PORTFOLIO,
  revision: 1,
  updatedAt: new Date(NOW).toISOString(),
});
function repository(id: string, fields: Partial<Repository> = {}): Repository {
  return {
    id,
    workspaceId: "workspace",
    fullName: "example/" + id,
    description: "",
    projectId: "project",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
    revision: 1,
    updatedAt: new Date(NOW).toISOString(),
    ...fields,
  };
}
function observation(
  resourceId: string,
  fields: Partial<Observation> = {},
): Observation {
  return {
    resourceId,
    resourceType: "repository",
    sourceId: "github",
    provider: "github",
    name: resourceId,
    health: "healthy",
    summary: "Observed passing checks",
    details: { ci: "passing", openFindings: 0 },
    observedAt: new Date(NOW - 1000).toISOString(),
    receivedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 1000).toISOString(),
    ...fields,
  };
}
const query = (input = "") => inventoryQuery(new URLSearchParams(input));

describe("Repository inventory presentation", () => {
  it("normalizes untrusted URL input and bounds page size without changing authority context", () => {
    expect(
      query(
        "filter=invalid&classification=owner&sort=raw&page=-10&pageSize=100000",
      ),
    ).toEqual(query());
    for (const page of ["NaN", "Infinity", "2.5", "9007199254740992"])
      expect(query("page=" + page).page).toBe(1);
    expect(
      query(
        "filter=archived&q=hello&classification=watchlist&sort=project&page=3&pageSize=50",
      ),
    ).toMatchObject({
      filter: "archived",
      search: "hello",
      classification: "watchlist",
      sort: "project",
      page: 3,
      pageSize: 50,
    });
    expect(
      withInventoryContext(
        "/repositories/repo?workspace=correct&section=hooks",
        new URLSearchParams(
          "workspace=wrong&section=secrets&q=a%26b&page=2&redirect=https://example.invalid",
        ),
      ),
    ).toBe("/repositories/repo?workspace=correct&section=hooks&q=a%26b&page=2");
  });

  it("keeps workspace counts independent of search, tracking, and pagination, without calling missing evidence healthy", () => {
    const snapshot = {
      projects: [project()],
      repositories: [
        repository("healthy"),
        repository("unverified", { classification: "watchlist" }),
        repository("due", {
          expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2020-01-01" },
        }),
        repository("warning"),
        repository("stale"),
        repository("archived", { lifecycle: "archived" }),
      ],
      observations: [
        observation("healthy"),
        observation("warning", { health: "warning" }),
        observation("stale", { expiresAt: new Date(NOW).toISOString() }),
        observation("archived"),
      ],
    };
    const result = repositoryInventory(
      snapshot,
      query("classification=watchlist&q=unverified"),
      NOW,
    );
    expect(result.counts).toEqual({
      all: 5,
      attention: 2,
      unknown: 3,
      archived: 1,
    });
    expect(result.rows.map((row) => row.repository.id)).toEqual(["unverified"]);
    expect(result.rows[0].assessment).toMatchObject({
      health: "unknown",
      freshness: "unknown",
    });
    expect(
      repositoryInventory(snapshot, query("filter=attention"), NOW).rows.map(
        (row) => row.repository.id,
      ),
    ).toEqual(["due", "warning"]);
    expect(
      repositoryInventory(snapshot, query("filter=archived"), NOW).rows[0]
        .assessment.health,
    ).toBe("unknown");
  });

  it("searches full names, descriptions, and explicit projects and sorts by project", () => {
    const snapshot = {
      projects: [
        project("project", "A project"),
        project("secondary", "Z project"),
      ],
      repositories: [
        repository("z", { projectId: "project" }),
        repository("a", {
          description: "Hidden description needle",
          projectId: "secondary",
        }),
      ],
      observations: [],
    };
    expect(
      repositoryInventory(snapshot, query("q=%20NEEDLE%20"), NOW).rows[0]
        .repository.id,
    ).toBe("a");
    expect(
      repositoryInventory(snapshot, query("q=A+project"), NOW).rows[0]
        .repository.id,
    ).toBe("z");
    expect(
      repositoryInventory(snapshot, query("sort=project"), NOW).rows.map(
        (row) => row.repository.id,
      ),
    ).toEqual(["z", "a"]);
    expect(
      repositoryInventory(snapshot, query("q=no-match"), NOW),
    ).toMatchObject({
      total: 0,
      first: 0,
      last: 0,
      page: 1,
      pageCount: 1,
      rows: [],
    });
  });

  it("uses deterministic natural-name, attention, and recent metadata order without mutating records", () => {
    const snapshot = {
      projects: [project()],
      repositories: [
        repository("repo10"),
        repository("repo2"),
        repository("repo1", { updatedAt: new Date(NOW + 1000).toISOString() }),
      ],
      observations: [
        observation("repo10", { health: "critical" }),
        observation("repo2"),
      ],
    };
    const ids = (sort: string) =>
      repositoryInventory(snapshot, query("sort=" + sort), NOW).rows.map(
        (row) => row.repository.id,
      );
    expect(ids("name")).toEqual(["repo1", "repo2", "repo10"]);
    expect(ids("name-desc")).toEqual(["repo10", "repo2", "repo1"]);
    expect(ids("attention")).toEqual(["repo10", "repo1", "repo2"]);
    expect(ids("updated")).toEqual(["repo1", "repo2", "repo10"]);
    expect(snapshot.repositories.map((row) => row.id)).toEqual([
      "repo10",
      "repo2",
      "repo1",
    ]);
    const ties = {
      ...snapshot,
      repositories: [
        repository("z", { fullName: "example/Same" }),
        repository("a", { fullName: "example/same" }),
      ],
    };
    expect(
      repositoryInventory(ties, query(), NOW).rows.map(
        (row) => row.repository.id,
      ),
    ).toEqual(["a", "z"]);
  });

  it("pages a bounded large fleet and clamps a vanished final page after a live record change", () => {
    const snapshot = {
      projects: [project()],
      repositories: Array.from({ length: 1000 }, (_, index) =>
        repository("repo" + index),
      ),
      observations: [],
    };
    expect(repositoryInventory(snapshot, query(), NOW)).toMatchObject({
      total: 1000,
      first: 1,
      last: 25,
      page: 1,
      pageCount: 40,
    });
    expect(
      repositoryInventory(snapshot, query("pageSize=100&page=999"), NOW),
    ).toMatchObject({ first: 901, last: 1000, page: 10, pageCount: 10 });
    const selected = query("page=2");
    snapshot.repositories = snapshot.repositories.slice(0, 26);
    expect(repositoryInventory(snapshot, selected, NOW)).toMatchObject({
      page: 2,
      first: 26,
      last: 26,
    });
    snapshot.repositories.pop();
    expect(repositoryInventory(snapshot, selected, NOW)).toMatchObject({
      page: 1,
      first: 1,
      last: 25,
    });
    expect(selected.page).toBe(2);
  });

  it("ages evidence and reviews using one assessment clock, never reviving an older superseded report", () => {
    const snapshot = {
      projects: [project()],
      repositories: [repository("repo")],
      observations: [observation("repo")],
    };
    expect(
      repositoryInventory(snapshot, query(), NOW).rows[0].assessment.health,
    ).toBe("healthy");
    expect(
      repositoryInventory(snapshot, query(), NOW + 1000).rows[0].assessment,
    ).toMatchObject({ health: "unknown", freshness: "stale" });
    snapshot.observations.push(
      observation("repo", {
        observedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW).toISOString(),
      }),
    );
    expect(
      repositoryInventory(snapshot, query(), NOW).rows[0].assessment.freshness,
    ).toBe("stale");
    snapshot.observations = [observation("repo", { resourceType: "hook" })];
    expect(
      repositoryInventory(snapshot, query(), NOW).rows[0].assessment.freshness,
    ).toBe("unknown");
  });
});
