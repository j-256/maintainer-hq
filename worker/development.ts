import { createApplication } from "./app";
import { resolveProductionPrincipal } from "./auth";
export { WorkspaceEvents } from "./workspace-events";

export default createApplication(
  async (request, env) =>
    request.headers.has("Authorization")
      ? resolveProductionPrincipal(request, env)
      : { subject: "development-owner", displayName: "Local maintainer" },
  true,
);
