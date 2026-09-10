import type { RepositoryResource } from "./resource-links";
import type { SecretProviderKind } from "./secrets";

export const REPOSITORY_CONTEXT_LIMITS = Object.freeze({
  RESOURCE_PREVIEW: 3,
  ACTIVITY_PREVIEW: 3,
});

export type RepositorySecretResource = {
  connectionId: string;
  connectionName: string;
  connectionEnabled: boolean;
  providerKind: SecretProviderKind;
  resourceId: string;
  label: string;
  repositoryCount: number;
  identityMatches: boolean;
};

export type RepositoryContext = {
  repositoryId: string;
  generatedAt: string;
  hooks: { total: number; items: RepositoryResource[] };
  monitoring: { total: number; items: RepositoryResource[] };
  secrets: { total: number; items: RepositorySecretResource[] };
};
