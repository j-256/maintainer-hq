import { settingsSection } from "./settings-navigation";
import { normalizeAppPathname } from "./app-pathname";

export const DOCUMENTATION_ORIGIN = "https://docs.hq.lasers.app";

const GUIDES: Record<string, { page: string; label: string }> = {
  overview: { page: "overview", label: "Overview" },
  activity: { page: "activity", label: "Activity" },
  projects: { page: "projects", label: "Projects" },
  repositories: { page: "repositories", label: "Repositories" },
  dependencies: { page: "dependencies", label: "Dependency maintenance" },
  releases: { page: "releases", label: "Releases and deployments" },
  work: { page: "repository-work", label: "Pull requests and issues" },
  hooks: { page: "hooks", label: "Hooks" },
  monitoring: { page: "monitoring", label: "Monitoring" },
  secrets: { page: "secrets", label: "Secrets" },
  settings: { page: "access", label: "Settings and access" },
};
const RESOURCE_SECTIONS = new Set([
  "repositories",
  "dependencies",
  "releases",
  "work",
  "hooks",
  "monitoring",
  "secrets",
  "activity",
]);

export function documentationForRoute(pathname: string, search: string) {
  const segments = normalizeAppPathname(pathname).split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  const section = params.get("section") ?? "";
  const settings = settingsSection(pathname);
  let guide = Object.hasOwn(GUIDES, segments[0])
    ? GUIDES[segments[0]]
    : { page: "getting-started", label: "Getting started" };
  if (settings) guide = { page: settings.guide, label: settings.label };
  else if (segments[0] === "projects" && segments[1] && params.has("transfer"))
    guide = { page: "project-transfers", label: "Workspace transfers" };
  else if (
    ["projects", "repositories"].includes(segments[0]) &&
    segments[1] &&
    RESOURCE_SECTIONS.has(section)
  )
    guide = GUIDES[section];
  return {
    href: DOCUMENTATION_ORIGIN + "/" + guide.page + "/",
    label: guide.label,
  };
}
