import { SECRET_PROVIDER_KIND } from "../shared/secrets";
import {
  describeProviderCredential,
  managedCredentialReference,
  managedProviderCredential,
  managedProviderCredentialRows,
  providerCredentialUnavailable,
} from "./provider-credential-store";
import {
  SecretGitHubClient,
  secretProvider,
  secretProviderReferences,
} from "./secret-github-client";
import type { WorkspaceService } from "./service";

export async function githubCredentialReferences(
  context: WorkspaceService,
  workspaceId: string,
) {
  const managed = await managedProviderCredentialRows(
    context,
    workspaceId,
    SECRET_PROVIDER_KIND.GITHUB,
  );
  const references = managed.map((row) => {
    const credential = describeProviderCredential(context, row);
    if (credential.settings.providerKind !== SECRET_PROVIDER_KIND.GITHUB)
      providerCredentialUnavailable();
    return {
      id: credential.id,
      name: credential.settings.name,
      revision: credential.revision,
      expiresAt: credential.settings.expiresAt,
      repositoryNames: credential.settings.scope.repositoryNames,
      writable: credential.settings.writable,
      available: credential.status === "available",
    };
  });
  return [
    ...references,
    ...secretProviderReferences(context.env, workspaceId, context.now()),
  ];
}

export async function githubCredential(
  context: WorkspaceService,
  workspaceId: string,
  reference: string,
) {
  if (!managedCredentialReference(reference))
    return secretProvider(context.env, workspaceId, reference, context.now());
  const credential = await managedProviderCredential(
    context,
    workspaceId,
    reference,
    SECRET_PROVIDER_KIND.GITHUB,
  );
  if (credential.settings.providerKind !== SECRET_PROVIDER_KIND.GITHUB)
    providerCredentialUnavailable();
  const descriptor = {
    workspaceId,
    name: credential.settings.name,
    revision: credential.revision,
    token: credential.token,
    expiresAt: credential.settings.expiresAt,
    repositoryNames: credential.settings.scope.repositoryNames,
    writable: credential.settings.writable,
  };
  return {
    descriptor,
    identity: credential.identity,
    client: new SecretGitHubClient(descriptor),
  };
}
