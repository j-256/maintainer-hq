import { githubRepositoryUrl } from "./github-context";
import { repositoryFields } from "./domain";
import {
  GITHUB_LIMITS,
  GITHUB_SECURITY_KEYS,
  type GitHubCheck,
} from "./github-evidence";

export const GITHUB_SETTINGS_PATHS = Object.freeze({
  ACCESS: "/settings/access",
  SECURITY: "/settings/security_analysis",
  FINE_GRAINED_TOKENS: "/settings/personal-access-tokens",
  CLASSIC_TOKENS: "/settings/tokens",
  APP_INSTALLATIONS: "/settings/installations",
});

export type GitHubManagementLink = {
  id:
    | "repository-access"
    | "security"
    | "fine-grained-tokens"
    | "classic-tokens"
    | "app-installations";
  label: string;
  href: string;
  scope: "repository" | "credential";
};

export function githubManagementLinks(
  fullName: string,
  checks: readonly Pick<GitHubCheck, "key" | "state">[],
): GitHubManagementLink[] {
  const unavailable = new Set(
    checks
      .filter((check) => check.state === "unavailable")
      .map((check) => check.key),
  );
  if (!unavailable.size) return [];
  if (!repositoryFields.shape.fullName.safeParse(fullName).success) return [];
  const repository = githubRepositoryUrl(fullName);
  if (repository.endsWith("/.") || repository.endsWith("/..")) return [];
  const links: GitHubManagementLink[] = [];
  if (unavailable.has("repository"))
    links.push({
      id: "repository-access",
      label: "Repository access on GitHub",
      href: repository + GITHUB_SETTINGS_PATHS.ACCESS,
      scope: "repository",
    });
  if (GITHUB_SECURITY_KEYS.some((key) => unavailable.has(key)))
    links.push({
      id: "security",
      label: "Security settings on GitHub",
      href: repository + GITHUB_SETTINGS_PATHS.SECURITY,
      scope: "repository",
    });
  links.push(
    {
      id: "fine-grained-tokens",
      label: "Fine-grained tokens",
      href:
        GITHUB_LIMITS.WEB_ORIGIN + GITHUB_SETTINGS_PATHS.FINE_GRAINED_TOKENS,
      scope: "credential",
    },
    {
      id: "classic-tokens",
      label: "Classic tokens",
      href: GITHUB_LIMITS.WEB_ORIGIN + GITHUB_SETTINGS_PATHS.CLASSIC_TOKENS,
      scope: "credential",
    },
    {
      id: "app-installations",
      label: "GitHub App installations",
      href: GITHUB_LIMITS.WEB_ORIGIN + GITHUB_SETTINGS_PATHS.APP_INSTALLATIONS,
      scope: "credential",
    },
  );
  return links;
}
