import { CAPABILITY } from "../shared/domain";
import {
  GITHUB_CAPABILITY,
  type GitHubAppPermissions,
} from "../shared/github-apps";
import { authorizeHooks } from "./hook-authority";
import {
  githubAppCredentialReferences,
  githubCredentialDescriptor,
  githubCredentialDescriptorGuard,
  type GitHubCredentialDescriptor,
} from "./github-credential-descriptors";
import {
  assertGitHubAuthorityFence,
  resolveGitHubCredential,
  readGitHubAuthReference,
} from "./github-credential-resolver";
import type { GitHubAuthorityFence } from "./github-app-types";
import { DomainError } from "./errors";
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
  const apps = await githubAppCredentialReferences(context, workspaceId);
  return [
    ...apps
      .filter((app) =>
        app.capabilities.some(
          (capability) =>
            capability === GITHUB_CAPABILITY.CONFIGURATION_READ ||
            capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE,
        ),
      )
      .map((app) => ({
        id: app.id,
        name: app.name,
        revision: app.revision,
        expiresAt: app.expiresAt,
        repositoryNames: app.repositoryNames!,
        writable: app.capabilities.includes(
          GITHUB_CAPABILITY.CONFIGURATION_WRITE,
        ),
        available: app.available,
      })),
    ...references,
    ...secretProviderReferences(context.env, workspaceId, context.now()),
  ];
}

export async function githubCredential(
  context: WorkspaceService,
  workspaceId: string,
  reference: string,
  connection?: { id: string; revision: number },
) {
  const resolved = await readGitHubAuthReference(
    context,
    workspaceId,
    reference,
  );
  if (resolved.kind === "app") {
    const app = await githubCredentialDescriptor(
      context,
      workspaceId,
      reference,
    );
    if (
      !app?.available ||
      !app.capabilities.some(
        (capability) =>
          capability === GITHUB_CAPABILITY.CONFIGURATION_READ ||
          capability === GITHUB_CAPABILITY.CONFIGURATION_WRITE,
      )
    )
      providerCredentialUnavailable();
    return appConfigurationCredential(context, workspaceId, app, connection);
  }
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

function configurationPermission(
  path: string,
  method: string,
): GitHubAppPermissions {
  const effect = method !== "GET";
  const level = effect ? "write" : "read";
  if (/^\/environments\/[^/]+\/(secrets|variables)(\/|$)/.test(path))
    return { metadata: "read", environments: level };
  if (path === "/environments" || /^\/environments\/[^/]+$/.test(path)) {
    if (effect)
      throw new DomainError(
        "github_app_permission_missing",
        "This configuration operation is not supported.",
        403,
      );
    return { metadata: "read", actions: "read" };
  }
  if (/^\/actions\/(organization-)?secrets(\/|$)/.test(path))
    return { metadata: "read", secrets: level };
  if (/^\/actions\/(organization-)?variables(\/|$)/.test(path))
    return { metadata: "read", variables: level };
  if (!path && !effect) return { metadata: "read" };
  throw new DomainError(
    "github_app_permission_missing",
    "This configuration operation is outside the supported App permission profile.",
    403,
  );
}
async function appConfigurationCredential(
  context: WorkspaceService,
  workspaceId: string,
  app: GitHubCredentialDescriptor,
  connection?: { id: string; revision: number },
) {
  const memberRevision = await authorizeHooks(
    context,
    workspaceId,
    CAPABILITY.SECRETS,
  );
  const fences: GitHubAuthorityFence[] = [];
  const descriptor: {
    workspaceId: string;
    name: string;
    revision: number;
    expiresAt: string | null;
    repositoryNames: string[];
    writable: boolean;
    token?: never;
  } = {
    workspaceId,
    name: app.name,
    revision: app.revision,
    expiresAt: app.expiresAt,
    repositoryNames: app.repositoryNames!,
    writable: app.capabilities.includes(GITHUB_CAPABILITY.CONFIGURATION_WRITE),
  };
  const authorityGuard = () =>
    githubCredentialDescriptorGuard(workspaceId, app);
  const client = new SecretGitHubClient(
    descriptor,
    fetch,
    async (path, method) => {
      const url = new URL(path, "https://api.github.com");
      const match = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(url.pathname);
      if (!match) providerCredentialUnavailable();
      const fullName =
        decodeURIComponent(match[1]) + "/" + decodeURIComponent(match[2]);
      const repository = await context.db
        .prepare(
          "SELECT id,full_name FROM repositories WHERE workspace_id=? AND lower(full_name)=lower(?)",
        )
        .bind(workspaceId, fullName)
        .first<{ id: string; full_name: string }>();
      if (!repository) providerCredentialUnavailable();
      const effect = method !== "GET";
      if (effect && (!connection || !descriptor.writable))
        providerCredentialUnavailable();
      const capability =
        effect ||
        !app.capabilities.includes(GITHUB_CAPABILITY.CONFIGURATION_READ)
          ? GITHUB_CAPABILITY.CONFIGURATION_WRITE
          : GITHUB_CAPABILITY.CONFIGURATION_READ;
      const lease = await resolveGitHubCredential(context, {
        workspaceId,
        reference: app.reference,
        repositoryId: repository.id,
        repositoryFullName: repository.full_name,
        connectionId: connection?.id ?? app.id,
        connectionRevision: connection?.revision ?? app.revision,
        connectionKind: connection
          ? "configuration"
          : "configuration-admission",
        capability,
        actorCapability: CAPABILITY.SECRETS,
        binding: {
          kind: "actor",
          subject: context.principal.subject,
          tokenId: context.principal.tokenId ?? null,
          membershipRevision: memberRevision,
        },
        permissions: configurationPermission(match[3], method),
        phase: effect ? "effect" : "read",
      });
      fences.push(lease.fence);
      await assertGitHubAuthorityFence(context, lease.fence);
      return {
        token: lease.token,
        assertLive: async () => {
          for (const fence of fences)
            await assertGitHubAuthorityFence(context, fence);
        },
      };
    },
  );
  return { descriptor, identity: app.hash, client, authorityGuard };
}
