import type {
  GitHubAuthReference,
  GitHubCapability,
} from "../shared/github-apps";
import type { Env } from "./types";

export type GitHubCredentialContext = {
  env: Env;
  db: D1Database;
  now: () => number;
};
export type GitHubAuthorityFence = {
  workspaceId: string;
  connectionId: string;
  connectionRevision: number;
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
  repositoryId: string;
  repositoryFullName: string;
  capability: GitHubCapability;
  connectionId: string;
  connectionRevision: number;
  binding:
    | {
        kind: "actor";
        subject: string;
        tokenId: string | null;
        membershipRevision: number;
      }
    | {
        kind: "source";
        sourceId: string;
        sourceRevision: number;
        jobId: string;
      };
  phase: "read" | "effect";
};
