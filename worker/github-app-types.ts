import type {
  GitHubAuthReference,
  GitHubCapability,
  GitHubAppPermissions,
} from "../shared/github-apps";
import type { Capability, Principal } from "../shared/domain";
import type { Env } from "./types";

export type GitHubCredentialContext = {
  env: Env;
  db: D1Database;
  now: () => number;
  principal?: Principal;
  fetch?: typeof fetch;
  remainingBudgetMs?: () => number;
};
export type GitHubRequestBinding =
  | {
      kind: "actor";
      subject: string;
      tokenId: string | null;
      membershipRevision: number;
    }
  | { kind: "source"; sourceId: string; sourceRevision: number; jobId: string };
export type GitHubAuthorityFence = {
  workspaceId: string;
  connectionId: string;
  connectionRevision: number;
  connectionKind: "source" | "configuration" | "configuration-admission";
  repositoryId: string | null;
  repositoryFullName: string;
  capability: GitHubCapability;
  binding: GitHubRequestBinding;
  actorCapability: Capability;
  actorExpiresAt: number | null;
} & (
  | {
      kind: "token";
      reference: string;
      credentialIdentity: string;
    }
  | {
      kind: "app";
      registrationId: string;
      registrationRevision: number;
      keyRevision: number;
      installationId: number;
      grantId: string;
      grantRevision: number;
      observedAuthorityGeneration: number;
      providerRepositoryId: number;
    }
);
export type GitHubCredentialLease = {
  token: string;
  authorityIdentity: string;
  quotaKey: string;
  observedAuthorityGeneration: number | null;
  validUntil: number;
  fence: GitHubAuthorityFence;
};
export type GitHubCredentialRequest = {
  workspaceId: string;
  reference: GitHubAuthReference;
  repositoryId: string | null;
  repositoryFullName: string;
  capability: GitHubCapability;
  connectionId: string;
  connectionRevision: number;
  binding: GitHubRequestBinding;
  connectionKind?: "source" | "configuration" | "configuration-admission";
  actorCapability?: Capability;
  permissions?: GitHubAppPermissions;
  optionalPermissions?: GitHubAppPermissions;
  phase: "read" | "effect";
};
