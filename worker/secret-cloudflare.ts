import {
  SECRET_ENTRY_KIND,
  SECRET_MANAGEMENT,
  SECRET_LIMITS,
  SECRET_PROVIDER_KIND,
  type SecretScope,
  type SecretTargetSnapshot,
} from "../shared/secrets";
import {
  CLOUDFLARE_SECRET_LIMITS,
  CLOUDFLARE_SECRET_TYPE,
  cloudflareSecretNameSchema,
} from "../shared/cloudflare-secrets";
import {
  cloudflareCredential,
  cloudflareCredentialReferences,
} from "./provider-cloudflare-credential";
import {
  describeSecretResource,
  type SecretAdapter,
  type SecretResourceBinding,
} from "./secret-adapters";
import { DomainError } from "./errors";

function bindWorker(accountId: string, name: string): SecretResourceBinding {
  return {
    id: "worker-" + name,
    label: name,
    identity: JSON.stringify([accountId, name]),
    repositories: [],
  };
}
function workerScope(scope: SecretScope) {
  if (scope.kind !== "worker")
    throw new DomainError(
      "secret_scope_invalid",
      "Cloudflare text secrets belong to a Worker, not a repository or GitHub environment.",
      400,
    );
}
function inputUnsupported(): never {
  throw new DomainError(
    "secret_input_unsupported",
    "Cloudflare requires dedicated private input at execution. No supplied value can be staged or recovered from this review.",
    409,
  );
}
export const cloudflareSecretAdapter: SecretAdapter = {
  kind: SECRET_PROVIDER_KIND.CLOUDFLARE,
  capabilities: {
    entryKinds: [SECRET_ENTRY_KIND.SECRET, SECRET_ENTRY_KIND.VARIABLE],
    input: "private-transient",
    maxValueBytes: CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES,
    nameRule: "provider-defined",
    scopeKinds: ["worker"],
    secretMutationScopeKinds: ["worker"],
    variableMutationScopeKinds: [],
    valueReadableKinds: [SECRET_ENTRY_KIND.VARIABLE],
    activation: "worker-deployment",
    metadataVersion: "opaque",
    storedValueReadable: false,
  },
  async references(context, workspaceId) {
    return (await cloudflareCredentialReferences(context, workspaceId)).map(
      (reference) => ({
        id: reference.id,
        kind: SECRET_PROVIDER_KIND.CLOUDFLARE,
        name: reference.name,
        revision: reference.revision,
        expiresAt: reference.expiresAt,
        writable: reference.writable,
        available: reference.available,
        capabilities: cloudflareSecretAdapter.capabilities,
        resources: reference.workerNames.map((name) =>
          describeSecretResource(bindWorker(reference.accountId, name)),
        ),
      }),
    );
  },
  async connect(context, workspaceId, reference) {
    const provider = await cloudflareCredential(
      context,
      workspaceId,
      reference,
    );
    const resources = provider.descriptor.workerNames.map((name) =>
      bindWorker(provider.descriptor.accountId, name),
    );
    function local(resource: SecretResourceBinding) {
      const expected = resources.find((item) => item.id === resource.id);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(resource))
        throw new DomainError(
          "secret_identity_changed",
          "This Worker is no longer inside the connection's exact account and Worker scope. Review the connection before continuing.",
          409,
        );
      return expected.label;
    }
    function checkPrepared(
      resource: SecretResourceBinding,
      snapshot: SecretTargetSnapshot,
    ) {
      const name = local(resource);
      workerScope(snapshot.scope);
      const deployment = snapshot.workerDeployment;
      if (
        !deployment ||
        deployment.accountId !== provider.descriptor.accountId ||
        deployment.workerName !== name ||
        snapshot.activation !== "worker-deployment" ||
        snapshot.scopeIdentity !== null ||
        snapshot.input.kind !== "private-transient" ||
        snapshot.input.maxValueBytes !== CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES ||
        !cloudflareSecretNameSchema.safeParse(snapshot.name).success ||
        !new RegExp(
          "^" + provider.descriptor.accountId + "/[a-f0-9]{32}$",
        ).test(snapshot.resourceIdentity) ||
        snapshot.resourceRevision !==
          JSON.stringify([deployment.deploymentId, deployment.versionId])
      )
        throw new DomainError(
          "secret_review_conflict",
          "The reviewed Worker identity or activation evidence is invalid. Prepare a fresh review.",
          409,
        );
    }
    function validInput(snapshot: SecretTargetSnapshot, value: string) {
      return (
        snapshot.input.kind === "private-transient" &&
        snapshot.input.maxValueBytes === CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES &&
        value.length > 0 &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        new TextEncoder().encode(value).byteLength <=
          CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES
      );
    }
    return {
      identity: provider.identity,
      writable: provider.descriptor.writable,
      async selectResources(ids) {
        const selected = resources.filter((item) => ids.includes(item.id));
        if (selected.length !== ids.length)
          throw new DomainError(
            "secret_worker_denied",
            "Select Workers inside this credential's approved account and Worker scope.",
            403,
          );
        return selected.sort((a, b) => a.id.localeCompare(b.id));
      },
      async checkResources(selected) {
        for (const resource of selected) local(resource);
      },
      async scopes(resource, page) {
        const name = local(resource);
        await provider.client.worker(name);
        return {
          providerKind: SECRET_PROVIDER_KIND.CLOUDFLARE,
          resource: describeSecretResource(resource),
          defaultScope: { kind: "worker" },
          fixedScopes: [],
          observedAt: new Date(context.now()).toISOString(),
          items: [],
          page,
          total: 0,
          nextPage: null,
          truncated: false,
        };
      },
      async inventory(resource, scope, entryKind, page) {
        workerScope(scope);
        const name = local(resource);
        const state =
          entryKind === SECRET_ENTRY_KIND.VARIABLE
            ? await provider.client.variables(name)
            : await provider.client.state(name);
        const offset = (page - 1) * SECRET_LIMITS.PAGE_SIZE;
        return {
          providerKind: SECRET_PROVIDER_KIND.CLOUDFLARE,
          entryKind,
          resource: describeSecretResource(resource),
          target: { resourceId: resource.id, scope },
          resourceIdentity: state.resourceIdentity,
          scopeIdentity: null,
          observedAt: new Date(context.now()).toISOString(),
          items: state.items
            .slice(offset, offset + SECRET_LIMITS.PAGE_SIZE)
            .map((item) => ({
              name: item.name,
              kind: entryKind,
              management: SECRET_MANAGEMENT.UNMANAGED,
              managedConfigurationId: null,
              value: "value" in item ? item.value : null,
              valueFormat: "valueFormat" in item ? item.valueFormat : null,
              createdAt: null,
              updatedAt: null,
              version: state.revision,
            })),
          page,
          total: state.items.length,
          nextPage:
            offset + SECRET_LIMITS.PAGE_SIZE < state.items.length
              ? page + 1
              : null,
          truncated: false,
          excludedBindings: state.excludedBindings,
          unsupportedBindings: state.excludedBindings,
          workerDeployment: state.activation,
        };
      },
      async prepare(resource, scope, name) {
        workerScope(scope);
        if (!cloudflareSecretNameSchema.safeParse(name).success)
          throw new DomainError(
            "secret_name_invalid",
            "Use the exact case-sensitive Cloudflare binding name without control characters or dot segments.",
            400,
          );
        const state = await provider.client.state(local(resource), true);
        const collision = state.bindings.find((item) => item.name === name);
        if (collision && collision.type !== CLOUDFLARE_SECRET_TYPE)
          throw new DomainError(
            "secret_binding_conflict",
            "This name belongs to a non-text-secret binding. HQ will not replace it with a secret.",
            409,
          );
        if (
          !collision &&
          state.bindings.length >= CLOUDFLARE_SECRET_LIMITS.BINDINGS
        )
          throw new DomainError(
            "capacity",
            "This Worker has reached HQ's binding preflight limit. Remove unused bindings through their owning configuration before adding one.",
            409,
          );
        if (!state.activation || !state.revision)
          throw new DomainError(
            "secret_worker_deployment_unsupported",
            "A single fully serving Worker version is required.",
            409,
          );
        return {
          name,
          scope,
          resourceIdentity: state.resourceIdentity,
          scopeIdentity: null,
          resourceRevision: state.revision,
          before: state.items.find((item) => item.name === name) ?? null,
          input: {
            kind: "private-transient",
            maxValueBytes: CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES,
          },
          activation: "worker-deployment",
          workerDeployment: state.activation,
        };
      },
      async checkPrepared(resource, snapshot) {
        checkPrepared(resource, snapshot);
      },
      validateSealedInput() {
        return false;
      },
      async writeSealed() {
        return inputUnsupported();
      },
      validateTransientInput: validInput,
      async writeTransient(resource, snapshot, value) {
        checkPrepared(resource, snapshot);
        if (!validInput(snapshot, value))
          throw new DomainError(
            "secret_input_invalid",
            "Supply nonempty UTF-8 text within the reviewed Cloudflare value limit through private input.",
            400,
          );
        return provider.client.put(local(resource), snapshot.name, value);
      },
      async observe(resource, snapshot) {
        checkPrepared(resource, snapshot);
        const state = await provider.client.state(local(resource));
        if (state.resourceIdentity !== snapshot.resourceIdentity)
          throw new DomainError(
            "secret_identity_changed",
            "The original Worker was replaced. This read cannot reconcile its earlier operation.",
            409,
          );
        return state.items.find((item) => item.name === snapshot.name) ?? null;
      },
      async remove(resource, snapshot) {
        checkPrepared(resource, snapshot);
        return provider.client.remove(local(resource), snapshot.name);
      },
    };
  },
};
