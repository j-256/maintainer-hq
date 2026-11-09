import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export function githubAppOrigin(context: WorkspaceService): string {
  try {
    const raw = context.env.GITHUB_APP_ORIGIN;
    if (!raw || raw.length > 2048) throw new Error();
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(context.development && loopback && url.protocol === "http:"))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new DomainError(
      "github_app_setup_unavailable",
      "App setup requires the deployment's exact application origin. Check its protected setup configuration.",
      503,
    );
  }
}
export function assertGitHubAppInputOrigin(
  request: Request,
  context: WorkspaceService,
) {
  const origin = githubAppOrigin(context);
  const supplied = request.headers.get("Origin");
  if (
    new URL(request.url).origin !== origin ||
    (supplied !== null && supplied !== origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new DomainError(
      "forbidden",
      "Use the configured application origin for protected App input.",
      403,
    );
}
