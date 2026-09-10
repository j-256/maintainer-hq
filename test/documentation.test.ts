import { describe, expect, it } from "vitest";
import {
  DOCUMENTATION_ORIGIN,
  documentationForRoute,
} from "../shared/documentation";

describe("contextual documentation", () => {
  it.each([
    ["/overview", "", "overview"],
    ["/activity", "?workspace=private", "activity"],
    ["/projects/project-id", "?section=hooks", "hooks"],
    ["/repositories/repository-id", "?section=monitoring", "monitoring"],
    ["/projects/project-id", "?section=secrets", "secrets"],
    ["/projects/project-id", "?section=activity", "activity"],
    ["/projects/project-id", "?section=releases", "releases"],
    ["/repositories/repository-id", "?section=releases", "releases"],
    ["/repositories/repository-id", "?section=work", "repository-work"],
    ["/projects/project-id", "?transfer=review-id", "project-transfers"],
    ["/projects/project-id", "?section=overview", "projects"],
    ["/settings/preferences", "", "preferences"],
    ["/settings/github", "", "github"],
    ["/settings/publishers", "", "publishing"],
    ["/settings/automation", "", "automation"],
    ["/settings/members", "", "access"],
    ["/settings/import", "", "import"],
    ["/settings", "", "access"],
    ["/Repositories/", "", "repositories"],
    ["/Settings/GitHub/", "", "github"],
    ["/unknown", "?section=https://untrusted.example", "getting-started"],
    ["/constructor", "", "getting-started"],
    ["/__proto__", "", "getting-started"],
  ])("links %s to its published guide", (pathname, search, page) => {
    expect(documentationForRoute(pathname, search).href).toBe(
      DOCUMENTATION_ORIGIN + "/" + page + "/",
    );
  });

  it("never includes workspace, resource, review, or free-form query values", () => {
    const result = documentationForRoute(
      "/repositories/private-id",
      "?workspace=private-workspace&q=private-note&section=../../untrusted",
    );
    const url = new URL(result.href);
    expect(url.origin).toBe(DOCUMENTATION_ORIGIN);
    expect(url.pathname).toBe("/repositories/");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(result.label).toBe("Repositories");
  });
});
