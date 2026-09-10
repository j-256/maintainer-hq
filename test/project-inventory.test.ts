import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPECTATIONS,
  projectSchema,
  type Project,
  type Repository,
} from "../shared/domain";
import {
  projectHref,
  projectInventory,
  projectListContext,
  projectQuery,
  projectsHref,
} from "../src/project-inventory";
import {
  inventoryQuery,
  repositoryInventory,
  withInventoryContext,
} from "../src/repository-inventory";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
function project(id: string, fields: Partial<Project> = {}) {
  return projectSchema.parse({
    id: id.replaceAll(" ", "-"),
    workspaceId: "workspace",
    name: id,
    description: "",
    revision: 1,
    updatedAt: new Date(NOW).toISOString(),
    ...fields,
  });
}
function repository(id: string, projectId: string): Repository {
  return {
    id,
    workspaceId: "workspace",
    projectId,
    fullName: "example/" + id,
    description: "",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
    revision: 1,
    updatedAt: new Date(NOW).toISOString(),
  };
}
const query = (input = "") => projectQuery(new URLSearchParams(input));
describe("Project inventory", () => {
  it("normalizes untrusted filters and bounds pagination", () => {
    expect(
      query(
        "filter=bad&importance=constructor&portfolio=toString&sort=raw&page=-1&pageSize=100000",
      ),
    ).toEqual(query());
    for (const page of ["NaN", "Infinity", "2.5", "9007199254740992"])
      expect(query("page=" + page).page).toBe(1);
    const snapshot = {
      projects: Array.from({ length: 28 }, (_, index) =>
        project("Project " + (index + 1)),
      ),
      repositories: [],
      observations: [],
    };
    const result = projectInventory(snapshot, query("page=100&sort=name"), NOW);
    expect(result).toMatchObject({
      total: 28,
      page: 2,
      pageCount: 2,
      first: 26,
      last: 28,
    });
    expect(result.rows.map((row) => row.project.name)).toEqual([
      "Project 26",
      "Project 27",
      "Project 28",
    ]);
  });
  it("orders by Importance without converting missing repository evidence into health", () => {
    const snapshot = {
      projects: [
        project("A standard"),
        project("B critical", { importance: "critical" }),
        project("Archived", { lifecycle: "archived" }),
      ],
      repositories: [
        repository("critical", "B-critical"),
        repository("standard", "A-standard"),
      ],
      observations: [],
    };
    const result = projectInventory(snapshot, query(), NOW);
    expect(result.rows.map((row) => row.project.name)).toEqual([
      "B critical",
      "A standard",
    ]);
    expect(result.rows[0]).toMatchObject({
      repositoryCount: 1,
      unknownCount: 1,
      warningCount: 0,
    });
    expect(result.rows[1]).toMatchObject({
      repositoryCount: 1,
      activeRepositoryCount: 1,
    });
    expect(result.counts).toEqual({ active: 2, archived: 1, attention: 0 });
    expect(
      projectInventory(snapshot, query("q=critical&importance=critical"), NOW)
        .total,
    ).toBe(1);
    expect(
      projectInventory(snapshot, query("portfolio=listed"), NOW).total,
    ).toBe(0);
  });
  it("shows a Portfolio review due after the chosen UTC date without changing repository evidence", () => {
    const snapshot = {
      projects: [
        project("Due", {
          portfolio: {
            status: "listed",
            url: null,
            reason: "",
            reviewDate: "2026-09-06",
          },
        }),
        project("Today", {
          portfolio: {
            status: "planned",
            url: null,
            reason: "",
            reviewDate: "2026-09-07",
          },
        }),
      ],
      repositories: [],
      observations: [],
    };
    const result = projectInventory(snapshot, query("filter=attention"), NOW);
    expect(result.rows.map((row) => row.project.name)).toEqual(["Due"]);
    expect(result.rows[0]).toMatchObject({
      reviewDue: true,
      warningCount: 0,
      unknownCount: 0,
    });
  });
  it("keeps project-list filters separate from nested repository controls and rejects authority-shaped return context", () => {
    const list = new URLSearchParams(
      "q=search&filter=archived&importance=high&page=2&workspace=wrong&redirect=https://example.invalid",
    );
    const href = projectHref("workspace", "project", "repositories", list);
    const detail = new URL(href, "https://hq.invalid");
    expect(detail.searchParams.get("q")).toBeNull();
    expect(detail.searchParams.get("workspace")).toBe("workspace");
    detail.searchParams.set("q", "example/repo");
    detail.searchParams.set("filter", "unknown");
    detail.searchParams.set("fromProject", "project");
    const repositoryPage = new URL(
      withInventoryContext(
        "/repositories/repo?workspace=workspace",
        detail.searchParams,
      ),
      "https://hq.invalid",
    );
    const returned = new URL(
      projectHref(
        "workspace",
        "project",
        "repositories",
        repositoryPage.searchParams,
      ),
      "https://hq.invalid",
    );
    expect(returned.searchParams.get("q")).toBe("example/repo");
    expect(returned.searchParams.get("filter")).toBe("unknown");
    expect(projectsHref("workspace", returned.searchParams)).toBe(
      "/projects?workspace=workspace&q=search&filter=archived&importance=high&page=2",
    );
    const untrusted = new URLSearchParams(
      "projectList=" +
        encodeURIComponent(
          "workspace=wrong&section=hooks&q=allowed&redirect=evil",
        ),
    );
    expect(projectsHref("workspace", untrusted)).toBe(
      "/projects?workspace=workspace&q=allowed",
    );
    expect(projectListContext(untrusted)).toBe("q=allowed");
    expect(
      projectListContext(
        new URLSearchParams("project=project&q=provider-search"),
      ),
    ).toBe("");
  });
  it("filters repositories by project and prioritizes project importance without changing health", () => {
    const snapshot = {
      projects: [
        project("important", { importance: "high" }),
        project("standard"),
      ],
      repositories: [
        repository("a-standard", "standard"),
        repository("b-important", "important"),
      ],
      observations: [],
    };
    expect(
      repositoryInventory(
        snapshot,
        inventoryQuery(new URLSearchParams("project=standard")),
        NOW,
      ).rows.map((row) => row.repository.id),
    ).toEqual(["a-standard"]);
    const result = repositoryInventory(
      snapshot,
      inventoryQuery(new URLSearchParams("sort=importance")),
      NOW,
    );
    expect(result.rows.map((row) => row.repository.id)).toEqual([
      "b-important",
      "a-standard",
    ]);
    expect(result.rows.map((row) => row.assessment.health)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(
      repositoryInventory(
        snapshot,
        inventoryQuery(new URLSearchParams("project=missing")),
        NOW,
      ).total,
    ).toBe(0);
  });
});
