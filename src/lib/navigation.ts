import type { Snapshot } from "../../shared/domain";
import { settingsSection } from "../../shared/settings-navigation";
import {
  normalizeAppPathname,
  resourceIdFromPath,
} from "../../shared/app-pathname";

const PAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  overview: "Overview",
  activity: "Activity",
  projects: "Projects",
  repositories: "Repositories",
  dependencies: "Dependencies",
  hooks: "Hooks",
  monitoring: "Monitoring",
  secrets: "Secrets",
  settings: "Settings",
});
const RESOURCE_SECTION_LABELS: Readonly<Record<string, string>> = Object.freeze(
  {
    ...PAGE_LABELS,
    work: "Work",
    releases: "Releases",
  },
);

function pageLabel(page: string) {
  return Object.hasOwn(PAGE_LABELS, page) ? PAGE_LABELS[page] : undefined;
}

export function navigationContext(
  pathname: string,
  search: string,
  snapshot?: Snapshot,
) {
  const [page, id, extra] = normalizeAppPathname(pathname)
    .split("/")
    .filter(Boolean);
  const params = new URLSearchParams(search);
  const settings = settingsSection(pathname);
  let label =
    pageLabel(page) ?? (page ? "Page not found" : PAGE_LABELS.overview);
  let resource: string | undefined;
  if (
    extra ||
    (id && !["projects", "repositories"].includes(page) && !settings)
  )
    label = "Page not found";
  else if (settings) label = settings.title;
  else if (id && (page === "projects" || page === "repositories")) {
    const resourceId = resourceIdFromPath(id);
    resource =
      page === "projects"
        ? (snapshot?.projects.find((project) => project.id === resourceId)
            ?.name ?? "Project")
        : (snapshot?.repositories.find(
            (repository) => repository.id === resourceId,
          )?.fullName ?? "Repository");
    const section = params.get("section") ?? "overview";
    label = resourceId
      ? Object.hasOwn(RESOURCE_SECTION_LABELS, section)
        ? RESOURCE_SECTION_LABELS[section]
        : "Overview"
      : "Invalid link";
  } else if (page === "secrets") {
    if (params.get("view") === "providers") label = "Provider access";
    if (params.get("view") === "operations") label = "Secret operations";
    if (params.get("view") === "managed") label = "Managed configuration";
  }
  return {
    label,
    title: [resource, label, snapshot?.workspace.name, "Maintainer HQ"]
      .filter(Boolean)
      .join(" | "),
  };
}

export function workspaceDestination(pathname: string, workspaceId: string) {
  pathname = normalizeAppPathname(pathname);
  const [page] = pathname.split("/").filter(Boolean);
  const path = settingsSection(pathname)
    ? pathname
    : pageLabel(page)
      ? "/" + page
      : "/overview";
  return path + "?workspace=" + encodeURIComponent(workspaceId);
}
