import {
  SECRET_ENTRY_KIND,
  SECRET_MANAGEMENT,
  SECRET_PROVIDER_KIND,
  type SecretScope,
} from "../shared/secrets";
import {
  GITHUB_SECRET_LIMITS,
  secretEnvironmentSchema,
  secretNameSchema,
} from "../shared/github-secrets";
import {
  githubCredential,
  githubCredentialReferences,
} from "./provider-github-credential";
import type { SecretGitHubClient } from "./secret-github-client";
import {
  describeSecretResource,
  type SecretAdapter,
  type SecretResourceBinding,
} from "./secret-adapters";
import { DomainError } from "./errors";
import type { Repository } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_ACTION,
  managedProviderSnapshotSchema,
} from "../shared/managed-configurations";

function bindRepository(repository: Repository): SecretResourceBinding {
  return {
    id: repository.id,
    label: repository.fullName,
    identity: repository.fullName,
    repositories: [{ id: repository.id, fullName: repository.fullName }],
  };
}

function environment(scope: SecretScope) {
  if (scope.kind === "repository") return null;
  if (
    scope.kind !== "environment" ||
    !secretEnvironmentSchema.safeParse(scope.name).success
  )
    throw new DomainError(
      "secret_scope_invalid",
      "GitHub secret changes require a repository or valid environment scope.",
      400,
    );
  return scope.name;
}
function organization(
  identity: Awaited<ReturnType<SecretGitHubClient["repository"]>>,
  scope: SecretScope,
) {
  if (
    scope.kind !== "organization" ||
    identity.owner.type !== "Organization" ||
    identity.owner.login.toLowerCase() !== scope.name.toLowerCase()
  )
    throw new DomainError(
      "secret_scope_invalid",
      "Select the GitHub organization that owns this repository.",
      400,
    );
  return identity.owner;
}
export const githubSecretAdapter: SecretAdapter = {
  kind: SECRET_PROVIDER_KIND.GITHUB,
  capabilities: {
    entryKinds: [SECRET_ENTRY_KIND.SECRET, SECRET_ENTRY_KIND.VARIABLE],
    input: "provider-sealed",
    maxValueBytes: GITHUB_SECRET_LIMITS.VALUE_BYTES,
    nameRule: "github-actions",
    scopeKinds: ["organization", "repository", "environment"],
    secretMutationScopeKinds: ["repository", "environment"],
    variableMutationScopeKinds: ["repository", "environment"],
    valueReadableKinds: [SECRET_ENTRY_KIND.VARIABLE],
    activation: "secret-update",
    metadataVersion: "timestamps",
    storedValueReadable: false,
  },
  async references(context, workspaceId) {
    const repositories = await context.repositories({ workspaceId });
    return (await githubCredentialReferences(context, workspaceId)).map(
      (reference) => ({
        id: reference.id,
        kind: SECRET_PROVIDER_KIND.GITHUB,
        name: reference.name,
        revision: reference.revision,
        expiresAt: reference.expiresAt,
        available: reference.available,
        writable: reference.writable,
        capabilities: githubSecretAdapter.capabilities,
        resources: repositories
          .filter((repository) =>
            reference.repositoryNames.some(
              (name) =>
                name.toLowerCase() === repository.fullName.toLowerCase(),
            ),
          )
          .map((repository) => ({
            id: repository.id,
            label: repository.fullName,
            repositoryIds: [repository.id],
          })),
      }),
    );
  },
  async connect(context, workspaceId, reference) {
    const provider = await githubCredential(context, workspaceId, reference);
    async function local(resource: SecretResourceBinding) {
      const repository = await context.repository({
        workspaceId,
        repositoryId: resource.id,
      });
      if (repository.fullName !== resource.identity)
        throw new DomainError(
          "secret_identity_changed",
          "The enrolled repository name changed. Review the Secrets connection before continuing.",
          409,
        );
      return repository;
    }
    async function resolve(resource: SecretResourceBinding) {
      const repository = await local(resource);
      const identity = await provider.client.repository(repository.fullName);
      return { repository, identity };
    }
    async function recheck(resource: SecretResourceBinding, revision: number) {
      if ((await local(resource)).revision !== revision)
        throw new DomainError(
          "revision_conflict",
          "Repository metadata changed during the provider read. Refresh before continuing.",
          409,
        );
    }
    async function selectResources(ids: string[]) {
      const repositories = (await context.repositories({ workspaceId })).filter(
        (item) => ids.includes(item.id),
      );
      if (
        repositories.length !== ids.length ||
        repositories.some(
          (repo) =>
            !provider.descriptor.repositoryNames.some(
              (name) => name.toLowerCase() === repo.fullName.toLowerCase(),
            ),
        )
      )
        throw new DomainError(
          "secret_repository_denied",
          "Select enrolled repositories inside the Secrets credential's approved scope.",
          403,
        );
      return repositories
        .map(bindRepository)
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    return {
      identity: provider.identity,
      writable: provider.descriptor.writable,
      selectResources,
      async checkResources(resources) {
        const repositories = await context.repositories({ workspaceId });
        if (
          resources.some(
            (resource) =>
              !repositories.some(
                (repository) =>
                  repository.id === resource.id &&
                  repository.fullName === resource.identity,
              ),
          )
        )
          throw new DomainError(
            "secret_identity_changed",
            "Enrolled resource identity changed. Review the Secrets connection before continuing.",
            409,
          );
        const selected = repositories
          .filter((repository) =>
            resources.some((resource) => resource.id === repository.id),
          )
          .map(bindRepository)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (
          selected.some(
            (resource) =>
              !provider.descriptor.repositoryNames.some(
                (name) =>
                  name.toLowerCase() === resource.identity.toLowerCase(),
              ),
          )
        )
          throw new DomainError(
            "secret_repository_denied",
            "The enrolled resource is outside the Secrets credential's approved scope.",
            403,
          );
        if (
          JSON.stringify(selected) !==
          JSON.stringify(
            [...resources].sort((a, b) => a.id.localeCompare(b.id)),
          )
        )
          throw new DomainError(
            "secret_identity_changed",
            "Enrolled resource identity changed. Review the Secrets connection before continuing.",
            409,
          );
      },
      async scopes(resource, page) {
        const { repository, identity } = await resolve(resource);
        const result = await provider.client.environments(
          repository.fullName,
          page,
        );
        await recheck(resource, repository.revision);
        return {
          ...result,
          providerKind: SECRET_PROVIDER_KIND.GITHUB,
          resource: describeSecretResource(resource),
          defaultScope: { kind: "repository" },
          fixedScopes:
            identity.owner.type === "Organization"
              ? [
                  {
                    label: "Organization: " + identity.owner.login,
                    scope: {
                      kind: "organization" as const,
                      name: identity.owner.login,
                    },
                    identity: String(identity.owner.id),
                  },
                ]
              : [],
          observedAt: new Date(context.now()).toISOString(),
          items: result.items.map((item) => ({
            label: item.name,
            scope: { kind: "environment" as const, name: item.name },
            identity: String(item.id),
          })),
        };
      },
      async prepare(resource, scope, name) {
        const canonical = secretNameSchema.safeParse(name);
        if (!canonical.success)
          throw new DomainError(
            "secret_name_invalid",
            "Choose a valid GitHub Actions secret name without the reserved GITHUB_ prefix.",
            400,
          );
        const selected = environment(scope);
        const { repository, identity } = await resolve(resource);
        if (identity.archived || identity.disabled)
          throw new DomainError(
            "secret_resource_read_only",
            "This GitHub repository is archived or disabled. No secret write was prepared.",
            409,
          );
        const environmentIdentity =
          selected === null
            ? null
            : await provider.client.environment(repository.fullName, selected);
        const key = await provider.client.publicKey(
          repository.fullName,
          selected,
        );
        const before = await provider.client.metadata(
          repository.fullName,
          selected,
          canonical.data,
        );
        await recheck(resource, repository.revision);
        return {
          name: canonical.data,
          scope,
          resourceIdentity: String(identity.id),
          scopeIdentity: environmentIdentity
            ? String(environmentIdentity.id)
            : null,
          resourceRevision: String(repository.revision),
          before: before
            ? {
                name: before.name,
                createdAt: before.created_at,
                updatedAt: before.updated_at,
                version: JSON.stringify([before.created_at, before.updated_at]),
              }
            : null,
          input: {
            kind: "provider-sealed",
            algorithm: "libsodium-sealed-box",
            keyId: key.key_id,
            publicKey: key.key,
            maxValueBytes: GITHUB_SECRET_LIMITS.VALUE_BYTES,
          },
          activation: "secret-update",
        };
      },
      validateSealedInput(snapshot, ciphertext) {
        if (
          snapshot.input.kind !== "provider-sealed" ||
          snapshot.input.algorithm !== "libsodium-sealed-box" ||
          snapshot.input.maxValueBytes !== GITHUB_SECRET_LIMITS.VALUE_BYTES
        )
          return false;
        try {
          const decoded = atob(ciphertext);
          return (
            decoded.length > GITHUB_SECRET_LIMITS.SEAL_BYTES &&
            decoded.length <=
              GITHUB_SECRET_LIMITS.VALUE_BYTES +
                GITHUB_SECRET_LIMITS.SEAL_BYTES &&
            btoa(decoded) === ciphertext
          );
        } catch {
          return false;
        }
      },
      async checkPrepared(resource, snapshot) {
        await recheck(resource, Number(snapshot.resourceRevision));
      },
      async writeSealed(resource, snapshot, ciphertext) {
        if (snapshot.input.kind !== "provider-sealed")
          throw new DomainError(
            "secret_input_unsupported",
            "This provider requires sealed input.",
            409,
          );
        return provider.client.put(
          resource.identity,
          environment(snapshot.scope),
          snapshot.name,
          snapshot.input.keyId,
          ciphertext,
        );
      },
      async remove(resource, snapshot) {
        return provider.client.remove(
          resource.identity,
          environment(snapshot.scope),
          snapshot.name,
        );
      },
      async observe(resource, snapshot) {
        const { repository, identity } = await resolve(resource);
        const selected = environment(snapshot.scope);
        const scopeIdentity =
          selected === null
            ? null
            : String(
                (
                  await provider.client.environment(
                    repository.fullName,
                    selected,
                  )
                ).id,
              );
        if (
          String(identity.id) !== snapshot.resourceIdentity ||
          scopeIdentity !== snapshot.scopeIdentity
        )
          throw new DomainError(
            "secret_identity_changed",
            "The original provider resource or scope identity changed. This read cannot reconcile the operation.",
            409,
          );
        const item = await provider.client.metadata(
          repository.fullName,
          selected,
          snapshot.name,
        );
        if (!item)
          await provider.client.publicKey(repository.fullName, selected);
        await recheck(resource, repository.revision);
        return item
          ? {
              name: item.name,
              createdAt: item.created_at,
              updatedAt: item.updated_at,
              version: JSON.stringify([item.created_at, item.updated_at]),
            }
          : null;
      },
      async inventory(resource, scope, entryKind, page) {
        const { repository, identity } = await resolve(resource);
        const environmentIdentity =
          scope.kind !== "environment"
            ? null
            : await provider.client.environment(repository.fullName, scope.name);
        const organizationIdentity =
          scope.kind === "organization" ? organization(identity, scope) : null;
        const result = await provider.client.configurationInventory(
          repository.fullName,
          scope,
          entryKind,
          page,
        );
        await recheck(resource, repository.revision);
        return {
          ...result,
          providerKind: SECRET_PROVIDER_KIND.GITHUB,
          entryKind,
          resource: describeSecretResource(resource),
          target: { resourceId: resource.id, scope },
          resourceIdentity: String(identity.id),
          scopeIdentity: environmentIdentity
            ? String(environmentIdentity.id)
            : organizationIdentity
              ? String(organizationIdentity.id)
              : null,
          observedAt: new Date(context.now()).toISOString(),
          items: result.items.map((item) => ({
            name: item.name,
            kind: entryKind,
            management: SECRET_MANAGEMENT.UNMANAGED,
            managedConfigurationId: null,
            value:
              entryKind === SECRET_ENTRY_KIND.VARIABLE &&
              "value" in item &&
              typeof item.value === "string"
                ? item.value
                : null,
            valueFormat:
              entryKind === SECRET_ENTRY_KIND.VARIABLE ? "text" : null,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            version: JSON.stringify([item.created_at, item.updated_at]),
          })),
        };
      },
      async inspectManaged(resource, scope, entryKind, name) {
        const canonical = secretNameSchema.safeParse(name);
        if (!canonical.success)
          throw new DomainError(
            "secret_name_invalid",
            "Choose a valid GitHub Actions configuration name without the reserved GITHUB_ prefix.",
            400,
          );
        const selected = environment(scope);
        const { repository, identity } = await resolve(resource);
        const environmentIdentity =
          selected === null
            ? null
            : await provider.client.environment(repository.fullName, selected);
        const item =
          entryKind === SECRET_ENTRY_KIND.SECRET
            ? await provider.client.metadata(
                repository.fullName,
                selected,
                canonical.data,
              )
            : await provider.client.variable(
                repository.fullName,
                selected,
                canonical.data,
              );
        if (!item && entryKind === SECRET_ENTRY_KIND.SECRET)
          await provider.client.publicKey(repository.fullName, selected);
        await recheck(resource, repository.revision);
        return managedProviderSnapshotSchema.parse({
          name: canonical.data,
          entryKind,
          scope,
          resourceIdentity: String(identity.id),
          scopeIdentity: environmentIdentity
            ? String(environmentIdentity.id)
            : null,
          resourceRevision: String(repository.revision),
          item: item
            ? {
                name: item.name,
                kind: entryKind,
                value:
                  entryKind === SECRET_ENTRY_KIND.VARIABLE && "value" in item
                    ? item.value
                    : null,
                valueFormat:
                  entryKind === SECRET_ENTRY_KIND.VARIABLE ? "text" : null,
                createdAt: item.created_at,
                updatedAt: item.updated_at,
                version: JSON.stringify([item.created_at, item.updated_at]),
              }
            : null,
          observedAt: new Date(context.now()).toISOString(),
        });
      },
      async writeManagedVariable(resource, snapshot, action, value) {
        if (
          snapshot.entryKind !== SECRET_ENTRY_KIND.VARIABLE ||
          !secretNameSchema.safeParse(snapshot.name).success
        )
          throw new DomainError(
            "secret_review_conflict",
            "The reviewed GitHub variable target is invalid. Prepare a fresh review.",
            409,
          );
        const selected = environment(snapshot.scope);
        if (action === MANAGED_CONFIGURATION_ACTION.DELETE)
          return provider.client.removeVariable(
            resource.identity,
            selected,
            snapshot.name,
          );
        if (value === null)
          throw new DomainError(
            "secret_review_conflict",
            "The reviewed GitHub variable value is unavailable. No provider write was attempted.",
            409,
          );
        return action === MANAGED_CONFIGURATION_ACTION.CREATE
          ? provider.client.createVariable(
              resource.identity,
              selected,
              snapshot.name,
              value,
            )
          : provider.client.updateVariable(
              resource.identity,
              selected,
              snapshot.name,
              value,
            );
      },
    };
  },
};
