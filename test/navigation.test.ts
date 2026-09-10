import { expect, it } from "vitest";
import { navigationContext, workspaceDestination } from "../src/lib/navigation";
import { viewSnapshot, type WorkspaceView } from "../shared/workspace-sync";
import { projectSchema } from "../shared/domain";
import {
  normalizeAppPathname,
  resourceIdFromPath,
} from "../shared/app-pathname";
import { routeScope } from "../src/lib/workspace-sync";

const snapshot = viewSnapshot({
  workspace: { id: "alpha", name: "Alpha", role: "owner" },
  principal: { subject: "owner", displayName: "Owner" },
  scope: { view: "projects" },
  cursor: 1,
  memberRevision: 1,
  generatedAt: "2026-01-01",
  development: true,
  capabilities: ["read"],
  records: {
    projects: [
      projectSchema.parse({
        id: "project-one",
        workspaceId: "alpha",
        name: "Delivery",
        description: "",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  },
} satisfies WorkspaceView);

it("labels app tabs, resource sections, and missing routes without fetching another view", () => {
  expect(navigationContext("/", "", snapshot).label).toBe("Overview");
  expect(
    navigationContext("/repositories/repo-one", "?section=work", snapshot)
      .label,
  ).toBe("Work");
  expect(
    navigationContext("/projects/project-one", "?section=releases", snapshot)
      .label,
  ).toBe("Releases");
  expect(navigationContext("/work", "", snapshot).label).toBe("Page not found");
  expect(workspaceDestination("/work", "beta")).toBe(
    "/overview?workspace=beta",
  );
  expect(
    navigationContext("/projects/project-one", "?section=monitoring", snapshot)
      .title,
  ).toBe("Delivery | Monitoring | Alpha | Maintainer HQ");
  expect(navigationContext("/secrets", "?view=providers", snapshot).label).toBe(
    "Provider access",
  );
  expect(
    navigationContext("/secrets", "?view=operations", snapshot).label,
  ).toBe("Secret operations");
  expect(
    navigationContext("/secrets", "?view=managed", snapshot).label,
  ).toBe("Managed configuration");
  expect(navigationContext("/settings/preferences", "", snapshot).label).toBe(
    "Date and time",
  );
  for (const path of [
    "/unknown",
    "/settings/unknown",
    "/projects/id/unknown",
    "/constructor",
    "/__proto__",
  ])
    expect(navigationContext(path, "", snapshot).label).toBe("Page not found");
});

it("switches resource details to the destination inventory without carrying foreign resource IDs", () => {
  expect(workspaceDestination("/", "beta")).toBe("/overview?workspace=beta");
  expect(workspaceDestination("/projects/project-one", "beta")).toBe(
    "/projects?workspace=beta",
  );
  expect(workspaceDestination("/repositories/repo-one", "beta")).toBe(
    "/repositories?workspace=beta",
  );
  expect(workspaceDestination("/settings/preferences", "a b")).toBe(
    "/settings/preferences?workspace=a%20b",
  );
  expect(workspaceDestination("/unknown", "beta")).toBe(
    "/overview?workspace=beta",
  );
  expect(workspaceDestination("/constructor", "beta")).toBe(
    "/overview?workspace=beta",
  );
  expect(workspaceDestination("/settings/unknown", "beta")).toBe(
    "/settings?workspace=beta",
  );
  expect(workspaceDestination("/settings/github", "beta")).toBe(
    "/settings/github?workspace=beta",
  );
});

it("aligns route aliases without changing resource identity or query context", () => {
  expect(normalizeAppPathname("/")).toBe("/");
  expect(normalizeAppPathname("/Repositories/CaseSensitive-ID///")).toBe(
    "/repositories/CaseSensitive-ID",
  );
  expect(normalizeAppPathname("/Settings/GitHub/")).toBe("/settings/github");
  expect(normalizeAppPathname("/projects//CaseSensitive-ID")).toBe(
    "/projects//CaseSensitive-ID",
  );
  expect(navigationContext("/Repositories/", "", snapshot).title).toBe(
    "Repositories | Alpha | Maintainer HQ",
  );
  expect(
    navigationContext("/Secrets/", "?view=providers", snapshot).label,
  ).toBe("Provider access");
  expect(navigationContext("/Settings/GitHub/", "", snapshot).label).toBe(
    "GitHub evidence",
  );
  expect(workspaceDestination("/Settings/GitHub/", "CaseSensitive-ID")).toBe(
    "/settings/github?workspace=CaseSensitive-ID",
  );
});

it("rejects malformed resource IDs before requesting a resource view", () => {
  for (const id of ["%", "%25", "%2F", "%E0%A4%A", "a".repeat(101)]) {
    expect(resourceIdFromPath(id)).toBeUndefined();
    for (const collection of ["projects", "repositories"]) {
      const path = "/" + collection + "/" + id;
      expect(routeScope(path, "activity")).toEqual({ view: "workspace" });
      expect(navigationContext(path, "", snapshot).label).toBe("Invalid link");
    }
  }
  expect(resourceIdFromPath("CaseSensitive%2DID")).toBe("CaseSensitive-ID");
  expect(routeScope("/repositories/CaseSensitive%2DID", null)).toEqual({
    view: "repository",
    repositoryId: "CaseSensitive-ID",
  });
  expect(navigationContext("/projects/project%2Done", "", snapshot).title).toBe(
    "Delivery | Overview | Alpha | Maintainer HQ",
  );
});
