import { createApplication } from "./app";
import { handoffDemoEnvironment } from "./hook-handoff-demo";
import { resolveProductionPrincipal } from "./auth";
export { WorkspaceEvents } from "./workspace-events";

const application = createApplication(
  async (request, env) =>
    request.headers.has("Authorization")
      ? resolveProductionPrincipal(request, env)
      : { subject: "development-owner", displayName: "Local maintainer" },
  true,
);
export default { ...application, async fetch(request: Request, env: Parameters<typeof application.fetch>[1], context?: ExecutionContext) {
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname);
  return application.fetch(request, loopback && !request.headers.has("Authorization") ? await handoffDemoEnvironment(env) : env, context);
} };
