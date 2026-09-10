import { SECRET_PROVIDER_KIND } from "../shared/secrets";
import {
  describeProviderCredential,
  managedProviderCredential,
  managedProviderCredentialRows,
  providerCredentialUnavailable,
} from "./provider-credential-store";
import { SecretCloudflareClient } from "./secret-cloudflare-client";
import type { WorkspaceService } from "./service";

export async function cloudflareCredentialReferences(
  context: WorkspaceService,
  workspaceId: string,
) {
  const rows = await managedProviderCredentialRows(
    context,
    workspaceId,
    SECRET_PROVIDER_KIND.CLOUDFLARE,
  );
  return rows.map((row) => {
    const credential = describeProviderCredential(context, row);
    if (credential.settings.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE)
      providerCredentialUnavailable();
    return {
      id: credential.id,
      name: credential.settings.name,
      revision: credential.revision,
      expiresAt: credential.settings.expiresAt,
      accountId: credential.settings.scope.accountId,
      workerNames: credential.settings.scope.workerNames,
      writable: credential.settings.writable,
      available: credential.status === "available",
    };
  });
}

export async function cloudflareCredential(
  context: WorkspaceService,
  workspaceId: string,
  reference: string,
) {
  const credential = await managedProviderCredential(
    context,
    workspaceId,
    reference,
    SECRET_PROVIDER_KIND.CLOUDFLARE,
  );
  if (credential.settings.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE)
    providerCredentialUnavailable();
  const descriptor = {
    ...credential.settings.scope,
    expiresAt: credential.settings.expiresAt,
    writable: credential.settings.writable,
  };
  return {
    descriptor,
    identity: credential.identity,
    client: new SecretCloudflareClient({
      ...descriptor,
      token: credential.token,
    }),
  };
}
