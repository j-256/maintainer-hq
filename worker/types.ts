import type { Principal } from "../shared/domain";
import type { WorkspaceEvents } from "./workspace-events";

export interface Env {
  HQ_DB: D1Database;
  WORKSPACE_EVENTS?: DurableObjectNamespace<WorkspaceEvents>;
  ASSETS: Fetcher;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  INITIAL_OWNER_SETUP?: string;
  CREDENTIALS?: string;
  GITHUB_CREDENTIALS?: string;
  GITHUB_SECRET_CREDENTIALS?: string;
  PROVIDER_CREDENTIAL_KEYS?: string;
  HOOKRELAY_CREDENTIALS?: string;
  MONITORING_CREDENTIALS?: string;
}
export type PrincipalResolver = (
  request: Request,
  env: Env,
) => Promise<Principal>;
