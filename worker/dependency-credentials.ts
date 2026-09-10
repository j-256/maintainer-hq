import { CAPABILITY } from "../shared/domain";
import { PROVIDER_CREDENTIAL_KIND } from "../shared/provider-credentials";
import { dependencyWriteAccessInput } from "../shared/dependency-changes";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  describeProviderCredential,
  managedProviderCredential,
  managedProviderCredentialRows,
  providerCredentialUnavailable,
} from "./provider-credential-store";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export async function dependencyCredential(
  context: WorkspaceService,
  workspaceId: string,
  credentialId: string,
  repository: string,
  writable = true,
) {
  const credential = await managedProviderCredential(
    context,
    workspaceId,
    credentialId,
    PROVIDER_CREDENTIAL_KIND.REPOSITORY,
  );
  if (
    credential.settings.providerKind !== PROVIDER_CREDENTIAL_KIND.REPOSITORY ||
    (writable && !credential.settings.writable) ||
    !credential.settings.scope.repositoryNames.some(
      (name) => name.toLowerCase() === repository.toLowerCase(),
    )
  )
    providerCredentialUnavailable();
  return credential;
}

export async function dependencyWriteAccess(
  context: WorkspaceService,
  input: unknown,
) {
  const { workspaceId, repositoryId } = dependencyWriteAccessInput.parse(input);
  await authorizeHooks(context, workspaceId, CAPABILITY.OPERATE);
  const guard = hookActorGuard(context, workspaceId, CAPABILITY.OPERATE);
  const repository = await context.db
    .prepare(
      `SELECT full_name FROM repositories WHERE workspace_id=? AND id=? AND ${guard.sql}`,
    )
    .bind(workspaceId, repositoryId, ...guard.values)
    .first<string>("full_name");
  if (!repository)
    throw new DomainError(
      "not_found",
      "Repository not found or access changed.",
      404,
    );
  const rows = await managedProviderCredentialRows(
    context,
    workspaceId,
    PROVIDER_CREDENTIAL_KIND.REPOSITORY,
  );
  const result = rows
    .map((row) => describeProviderCredential(context, row))
    .filter(
      (item) =>
        item.settings.providerKind === PROVIDER_CREDENTIAL_KIND.REPOSITORY &&
        item.settings.scope.repositoryNames.some(
          (name) => name.toLowerCase() === repository.toLowerCase(),
        ),
    )
    .map((item) => ({
      id: item.id,
      revision: item.revision,
      name: item.settings.name,
      expiresAt: item.settings.expiresAt,
      writable: item.settings.writable,
      status: item.status,
    }));
  await authorizeHooks(context, workspaceId, CAPABILITY.OPERATE);
  return { credentials: result };
}
