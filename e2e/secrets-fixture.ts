import type { Page } from "@playwright/test";
import sodium from "libsodium-wrappers";
import { CAPABILITY, DEFAULT_EXPECTATIONS } from "../shared/domain";
import { mockWorkspaceView } from "./workspace-fixture";
import type {
  SecretConnection,
  SecretDestination,
  SecretReview,
  SecretReviewedDestination,
} from "../shared/secrets";
import type { SecretCleanupReview } from "../shared/secret-cleanup";
import {
  MANAGED_CONFIGURATION_STATUS,
  managedConfigurationAction,
  managedConfigurationStatus,
  type ManagedConfiguration,
  type ManagedConfigurationReview,
} from "../shared/managed-configurations";

export const SECRET_TIME = "2026-09-06T12:30:00.000Z";
export const SECRET_RESOURCE = {
  id: "secret-repo",
  label: "example/maintainer-hq",
  repositoryIds: ["secret-repo"],
};
export const SECRET_CONNECTION: SecretConnection = {
  id: "secret-test",
  name: "Synthetic GitHub Secrets",
  providerKind: "github-actions",
  providerRef: "selected",
  providerName: "Synthetic provider",
  revision: 1,
  resourceIds: [SECRET_RESOURCE.id],
  resources: [SECRET_RESOURCE],
  enabled: true,
  available: true,
  writable: true,
  capabilities: {
    entryKinds: ["secret", "variable"],
    input: "provider-sealed",
    maxValueBytes: 49152,
    nameRule: "github-actions",
    scopeKinds: ["organization", "repository", "environment"],
    secretMutationScopeKinds: ["repository", "environment"],
    variableMutationScopeKinds: ["repository", "environment"],
    valueReadableKinds: ["variable"],
    activation: "secret-update",
    metadataVersion: "timestamps",
    storedValueReadable: false,
  },
};
const METADATA = {
  name: "DEPLOY_TOKEN",
  createdAt: SECRET_TIME,
  updatedAt: SECRET_TIME,
  version: "synthetic-v1",
};
export async function mockSecrets(
  page: Page,
  options: { empty?: boolean; viewer?: boolean; owner?: boolean } = {},
) {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  const timestamp = () => new Date().toISOString();
  const state = {
    connections: options.empty
      ? ([] as SecretConnection[])
      : [structuredClone(SECRET_CONNECTION)],
    reviews: new Map<string, SecretReview>(),
    cleanups: new Map<string, SecretCleanupReview>(),
    configurations: [] as ManagedConfiguration[],
    managedReviews: new Map<string, ManagedConfigurationReview>(),
    providerVariables: new Map([["DEPLOY_REGION", "us-central1"]]),
    calls: [] as { name: string; input: Record<string, unknown> }[],
    values: [] as string[],
    writes: 0,
    deletions: 0,
    rejectReads: false,
    conflict: false,
    loseInputResponse: false,
    loseRunResponse: false,
    uncertainWrite: false,
    uncertainDeletion: false,
    managedWrites: 0,
    uncertainManagedWrite: false,
    beforeCleanupWrite: null as (() => Promise<void>) | null,
  };
  const target = (
    destination: SecretDestination,
  ): SecretReviewedDestination => ({
    destination: structuredClone(destination),
    providerKind: "github-actions",
    connectionName: SECRET_CONNECTION.name,
    resource: SECRET_RESOURCE,
    snapshot: {
      name: destination.name.toUpperCase(),
      scope: destination.target.scope,
      resourceIdentity: "42",
      scopeIdentity:
        destination.target.scope.kind === "environment" ? "8" : null,
      resourceRevision: "1",
      before: { ...METADATA, name: destination.name.toUpperCase() },
      input: {
        kind: "provider-sealed",
        algorithm: "libsodium-sealed-box",
        keyId: "test-public-key",
        publicKey: sodium.to_base64(
          key.publicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        maxValueBytes: 49152,
      },
      activation: "secret-update",
    },
  });
  const managedItem = (
    configuration: ManagedConfiguration,
    destinationIndex: number,
  ) => {
    const desired = configuration.destinations[destinationIndex]!;
    if (configuration.entryKind === "secret")
      return desired.destination.name === "DEPLOY_TOKEN"
        ? {
            ...METADATA,
            name: desired.destination.name,
            kind: "secret" as const,
            management: "hq" as const,
            managedConfigurationId: configuration.id,
            value: null,
            valueFormat: null,
          }
        : null;
    const value = state.providerVariables.get(desired.destination.name);
    return value === undefined
      ? null
      : {
          ...METADATA,
          name: desired.destination.name,
          kind: "variable" as const,
          management: "hq" as const,
          managedConfigurationId: configuration.id,
          value,
          valueFormat: "text" as const,
        };
  };
  const managedSnapshot = (
    configuration: ManagedConfiguration,
    destinationIndex: number,
  ) => {
    const desired = configuration.destinations[destinationIndex]!;
    const item = managedItem(configuration, destinationIndex);
    return {
      name: desired.destination.name,
      entryKind: configuration.entryKind,
      scope: desired.destination.target.scope,
      resourceIdentity: "42",
      scopeIdentity:
        desired.destination.target.scope.kind === "environment" ? "8" : null,
      resourceRevision: "1",
      item: item
        ? {
            name: item.name,
            kind: item.kind,
            value: item.value,
            valueFormat: item.valueFormat,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            version: item.version,
          }
        : null,
      observedAt: timestamp(),
    };
  };
  const ownerOf = (
    entryKind: "secret" | "variable",
    name: string,
    inventoryTarget: unknown,
  ) =>
    state.configurations.find(
      (configuration) =>
        configuration.entryKind === entryKind &&
        configuration.destinations.some(
          (item) =>
            item.destination.name === name &&
            JSON.stringify(item.destination.target) ===
              JSON.stringify(inventoryTarget),
        ),
    );
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    repositories: [
      {
        id: SECRET_RESOURCE.id,
        workspaceId: "development",
        fullName: SECRET_RESOURCE.label,
        description: "Synthetic Secrets browser fixture",
        projectId: snapshot.projects[0]!.id,
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
        revision: 1,
        updatedAt: SECRET_TIME,
      },
    ],
    ...(options.viewer
      ? {
          capabilities: [CAPABILITY.READ],
          workspace: { ...snapshot.workspace, role: "viewer" },
        }
      : options.owner
        ? {
            capabilities: [
              ...snapshot.capabilities,
              CAPABILITY.ADMIN,
              CAPABILITY.SECRETS,
            ],
            workspace: { ...snapshot.workspace, role: "owner" },
          }
        : {}),
  }));
  await page.route("**/api/commands/secrets_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.calls.push({ name, input });
    const reply = (json: unknown) => route.fulfill({ json });
    const fail = (message: string, status = 409) =>
      route.fulfill({
        status,
        json: { error: { code: "synthetic_conflict", message } },
      });
    if (
      state.rejectReads &&
      ["secrets_inventory", "secrets_scopes"].includes(name)
    )
      return fail("Synthetic provider read unavailable", 503);
    if (name === "secrets_connections") return reply(state.connections);
    if (name === "secrets_providers")
      return reply([
        {
          id: "selected",
          kind: "github-actions",
          name: "Synthetic provider",
          revision: 1,
          resources: [SECRET_RESOURCE],
          available: true,
          writable: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilities: SECRET_CONNECTION.capabilities,
        },
      ]);
    if (name === "secrets_connection_save") {
      if (state.conflict)
        return fail(
          "Connection changed. Keep your draft and reload saved settings.",
        );
      const fields = input.connection as Omit<
        SecretConnection,
        "id" | "revision"
      >;
      const result = {
        ...SECRET_CONNECTION,
        ...fields,
        id: String(input.connectionId),
        revision: Number(input.revision) + 1,
      };
      state.connections = [result];
      return reply(result);
    }
    const pageNumber = Number(input.page ?? 1);
    if (name === "secrets_scopes")
      return reply({
        providerKind: "github-actions",
        resource: SECRET_RESOURCE,
        defaultScope: { kind: "repository" },
        fixedScopes: [
          {
            label: "Organization: example",
            scope: { kind: "organization", name: "example" },
            identity: "7",
          },
        ],
        items: [
          {
            label: pageNumber === 1 ? "Production / Blue" : "Staging",
            scope: {
              kind: "environment",
              name: pageNumber === 1 ? "Production / Blue" : "Staging",
            },
            identity: "8",
          },
        ],
        page: pageNumber,
        nextPage: pageNumber === 1 ? 2 : null,
        total: 2,
        truncated: false,
        observedAt: SECRET_TIME,
      });
    if (name === "secrets_inventory") {
      const entryKind =
        input.entryKind === "variable" ? "variable" : "secret";
      const itemName =
        entryKind === "variable"
          ? pageNumber === 1
            ? "DEPLOY_REGION"
            : "SECOND_REGION"
          : pageNumber === 1
            ? "DEPLOY_TOKEN"
            : "SECOND_TOKEN";
      const managed = ownerOf(entryKind, itemName, input.target);
      return reply({
        providerKind: "github-actions",
        entryKind,
        resource: SECRET_RESOURCE,
        target: input.target,
        resourceIdentity: "42",
        scopeIdentity:
          (input.target as { scope: { kind: string } }).scope.kind ===
          "organization"
            ? "7"
            : null,
        observedAt: SECRET_TIME,
        items: [
          entryKind === "variable"
            ? {
                ...METADATA,
                name: itemName,
                kind: "variable",
                management: managed ? "hq" : "unmanaged",
                managedConfigurationId: managed?.id ?? null,
                value:
                  state.providerVariables.get(itemName) ??
                  (pageNumber === 1 ? "us-central1" : "eu-west1"),
                valueFormat: "text",
              }
            : {
                ...METADATA,
                name: itemName,
                kind: "secret",
                management: managed ? "hq" : "unmanaged",
                managedConfigurationId: managed?.id ?? null,
                value: null,
                valueFormat: null,
              },
        ],
        page: pageNumber,
        nextPage: pageNumber === 1 ? 2 : null,
        total: 2,
        truncated: false,
      });
    }
    if (name === "secrets_configurations")
      return reply(state.configurations);
    if (name === "secrets_configuration_save") {
      if (state.conflict)
        return fail(
          "Managed configuration changed. Keep your draft and reload saved state.",
        );
      const revision = Number(input.revision);
      const existing = state.configurations.find(
        (item) => item.id === input.configurationId,
      );
      if ((existing?.revision ?? 0) !== revision)
        return fail("Managed configuration changed. Keep your draft.");
      const saved = {
        ...(input.configuration as Omit<
          ManagedConfiguration,
          "id" | "revision" | "createdAt" | "updatedAt"
        >),
        id: String(input.configurationId),
        revision: revision + 1,
        createdAt: existing?.createdAt ?? timestamp(),
        updatedAt: timestamp(),
      } as ManagedConfiguration;
      state.configurations = [
        ...state.configurations.filter((item) => item.id !== saved.id),
        saved,
      ];
      return reply(saved);
    }
    if (name === "secrets_configuration_stop") {
      const current = state.configurations.find(
        (item) => item.id === input.configurationId,
      );
      if (!current || current.revision !== input.revision)
        return fail("Managed configuration changed. Keep the saved state.");
      state.configurations = state.configurations.filter(
        (item) => item.id !== current.id,
      );
      return reply({ configurationId: current.id, stopped: true });
    }
    if (name === "secrets_configuration_status") {
      if (state.rejectReads)
        return fail("Synthetic provider read unavailable", 503);
      const configuration = state.configurations.find(
        (item) => item.id === input.configurationId,
      );
      if (!configuration) return fail("Managed configuration not found", 404);
      return reply({
        configuration,
        observations: configuration.destinations.map((desired, index) => {
          const item = managedItem(configuration, index);
          return {
            destinationIndex: index,
            status: managedConfigurationStatus(
              configuration.entryKind,
              desired.desiredState,
              configuration.desiredValue,
              item,
            ),
            item,
            observedAt: timestamp(),
            error: null,
          };
        }),
      });
    }
    if (name === "secrets_configuration_plan") {
      if (state.rejectReads)
        return fail("Synthetic provider read unavailable", 503);
      const configuration = state.configurations.find(
        (item) => item.id === input.configurationId,
      );
      const destinationIndex = Number(input.destinationIndex);
      const desired = configuration?.destinations[destinationIndex];
      if (!configuration || !desired)
        return fail("Managed configuration changed. Refresh live state.");
      if (configuration.entryKind === "secret")
        return fail(
          "Secret values need a custody boundary before HQ can apply them.",
        );
      const id = String(input.planId);
      if (!state.managedReviews.has(id)) {
        const before = managedSnapshot(configuration, destinationIndex);
        state.managedReviews.set(id, {
          id,
          fingerprint: "sha256:" + "d".repeat(64),
          actorMatches: !options.viewer,
          createdAt: timestamp(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          configurationId: configuration.id,
          configurationLabel: configuration.label,
          configurationRevision: configuration.revision,
          entryKind: configuration.entryKind,
          custody: configuration.custody,
          desiredValue: configuration.desiredValue,
          desired,
          providerKind: "github-actions",
          connectionName: SECRET_CONNECTION.name,
          resource: SECRET_RESOURCE,
          before,
          action: managedConfigurationAction(
            desired.desiredState,
            configuration.desiredValue,
            before.item,
          ),
          writable: true,
          operation: null,
        });
      }
      return reply(state.managedReviews.get(id));
    }
    const managedReview = state.managedReviews.get(String(input.planId));
    if (name === "secrets_configuration_review")
      return managedReview
        ? reply(managedReview)
        : fail("Managed configuration review not found", 404);
    if (name === "secrets_configuration_apply" && managedReview) {
      if (!managedReview.operation) {
        const submittedAt = timestamp();
        if (managedReview.action !== "none") {
          state.managedWrites++;
          if (!state.uncertainManagedWrite) {
            if (managedReview.action === "delete")
              state.providerVariables.delete(managedReview.desired.destination.name);
            else
              state.providerVariables.set(
                managedReview.desired.destination.name,
                managedReview.desiredValue!,
              );
          }
        }
        const configuration = state.configurations.find(
          (item) => item.id === managedReview.configurationId,
        )!;
        const destinationIndex = configuration.destinations.findIndex(
          (item) => JSON.stringify(item) === JSON.stringify(managedReview.desired),
        );
        const item = managedItem(configuration, destinationIndex);
        const observationStatus = managedConfigurationStatus(
          configuration.entryKind,
          managedReview.desired.desiredState,
          managedReview.desiredValue,
          item,
        );
        const operationStatus = state.uncertainManagedWrite
          ? "partial"
          : observationStatus === MANAGED_CONFIGURATION_STATUS.IN_SYNC
            ? "succeeded"
            : "partial";
        managedReview.operation = {
          id: crypto.randomUUID(),
          status: operationStatus,
          summary:
            operationStatus === "succeeded"
              ? "The reviewed provider change was accepted and live state matches."
              : "Provider acceptance is uncertain; reconcile from live state.",
          createdAt: submittedAt,
          updatedAt: timestamp(),
          receipt: {
            writeStatus: state.uncertainManagedWrite
              ? "indeterminate"
              : managedReview.action === "none"
                ? "not-sent"
                : "accepted",
            reason: state.uncertainManagedWrite
              ? "provider_result_uncertain"
              : null,
            observationStatus,
            item,
            observedAt: timestamp(),
            submittedAt:
              managedReview.action === "none" ? null : submittedAt,
          },
        };
      }
      return reply(managedReview);
    }
    if (name === "secrets_configuration_reconcile" && managedReview?.operation) {
      const configuration = state.configurations.find(
        (item) => item.id === managedReview.configurationId,
      )!;
      const destinationIndex = configuration.destinations.findIndex(
        (item) => JSON.stringify(item) === JSON.stringify(managedReview.desired),
      );
      const item = managedItem(configuration, destinationIndex);
      const observationStatus = managedConfigurationStatus(
        configuration.entryKind,
        managedReview.desired.desiredState,
        managedReview.desiredValue,
        item,
      );
      managedReview.operation.receipt.item = item;
      managedReview.operation.receipt.observationStatus = observationStatus;
      managedReview.operation.receipt.observedAt = timestamp();
      managedReview.operation.updatedAt = timestamp();
      managedReview.operation.status =
        observationStatus === MANAGED_CONFIGURATION_STATUS.IN_SYNC
          ? "succeeded"
          : "partial";
      managedReview.operation.summary =
        managedReview.operation.status === "succeeded"
          ? "A live provider read confirms the desired state."
          : "Live state does not yet confirm the desired outcome.";
      return reply(managedReview);
    }
    if (name === "secrets_configuration_history")
      return reply(
        [...state.managedReviews.values()].flatMap((item) =>
          item.operation
            ? [
                {
                  id: item.operation.id,
                  planId: item.id,
                  configurationId: item.configurationId,
                  status: item.operation.status,
                  summary: item.operation.summary,
                  createdAt: item.operation.createdAt,
                  updatedAt: item.operation.updatedAt,
                },
              ]
            : [],
        ),
      );
    if (name === "secrets_history")
      return reply({
        items: [...state.reviews.values()].map((review) => ({
          id: review.id,
          stage: review.stage,
          createdAt: review.createdAt,
          destinations: review.destinations.map((item) => ({
            name: item.destination.name,
            resource: item.resource,
            scope: item.snapshot.scope,
          })),
        })),
        nextCursor: null,
      });
    if (name === "secrets_draft") {
      if (state.conflict)
        return fail(
          "The provider changed during preparation. Your draft is still here.",
        );
      const id = String(input.reviewId);
      if (!state.reviews.has(id))
        state.reviews.set(id, {
          id,
          stage: "awaiting-input",
          draftFingerprint: "sha256:" + "a".repeat(64),
          fingerprint: null,
          actorMatches: !options.viewer,
          createdAt: timestamp(),
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          inputExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          inputPresent: false,
          destinations: (input.destinations as SecretDestination[]).map(target),
          source: input.source
            ? target(input.source as SecretDestination)
            : null,
          operation: null,
          recovery: null,
        });
      return reply(state.reviews.get(id));
    }
    const review = state.reviews.get(String(input.reviewId));
    if (name === "secrets_review")
      return review ? reply(review) : fail("Review not found", 404);
    if (name === "secrets_cancel" && review) {
      review.stage = "cancelled";
      review.inputPresent = false;
      return reply(review);
    }
    if (name === "secrets_apply" && review) {
      review.stage = "accepted";
      review.operation ??= {
        acceptedAt: timestamp(),
        leaseExpiresAt: null,
        leaseExpired: false,
        receipts: review.destinations.map((_item, destinationIndex) => ({
          destinationIndex,
          phase: "pending",
          writeStatus: "not-sent",
          reason: null,
          observationStatus: "unknown",
          metadata: null,
          observedAt: null,
          submittedAt: null,
          updatedAt: timestamp(),
          revision: 1,
          recoveryReviewId: null,
        })),
      };
      return reply(review);
    }
    if (name === "secrets_run" && review?.operation) {
      const receipt =
        review.operation.receipts[Number(input.destinationIndex)]!;
      if (receipt.phase === "pending") {
        state.writes++;
        Object.assign(receipt, {
          phase: "finished",
          writeStatus: state.uncertainWrite ? "indeterminate" : "accepted",
          observationStatus: state.uncertainWrite ? "unknown" : "present",
          metadata: METADATA,
          observedAt: timestamp(),
          revision: receipt.revision + 1,
        });
      }
      if (state.loseRunResponse) {
        state.loseRunResponse = false;
        return route.abort();
      }
      return reply(review);
    }
    if (name === "secrets_reconcile" && review?.operation) {
      Object.assign(
        review.operation.receipts[Number(input.destinationIndex)]!,
        {
          observationStatus: "present",
          metadata: METADATA,
          observedAt: timestamp(),
        },
      );
      return reply(review);
    }
    if (name === "secrets_recovery_plan" && review?.operation) {
      const index = Number(input.destinationIndex);
      const receipt = review.operation.receipts[index]!;
      const child = structuredClone(review);
      child.id = String(input.newReviewId);
      child.destinations = [review.destinations[index]!];
      child.source = null;
      child.operation = null;
      child.stage = "reviewed";
      child.inputPresent = true;
      child.recovery = {
        reviewId: review.id,
        destinationIndex: index,
        fingerprint: review.fingerprint!,
        receiptRevision: receipt.revision,
        depth: 1,
      };
      receipt.recoveryReviewId = child.id;
      state.reviews.set(child.id, child);
      return reply(child);
    }
    if (name === "secrets_cleanup_plan" && review?.source) {
      if (
        review.operation?.receipts.some(
          (receipt) =>
            receipt.writeStatus !== "accepted" ||
            receipt.observationStatus !== "present",
        )
      )
        return fail(
          "Every destination needs an accepted write before removal review.",
        );
      const id = String(input.cleanupId);
      const cleanup: SecretCleanupReview = {
        id,
        reviewId: review.id,
        fingerprint: "sha256:" + "c".repeat(64),
        actorMatches: true,
        createdAt: timestamp(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        source: review.source,
        destinations: review.destinations.map(
          (destination, originalDestinationIndex) => ({
            originalDestinationIndex,
            reviewId: review.id,
            destination,
            metadata: METADATA,
          }),
        ),
        receipt: {
          phase: "reviewed",
          writeStatus: "not-sent",
          reason: null,
          observationStatus: "unknown",
          metadata: null,
          observedAt: null,
          submittedAt: null,
          updatedAt: timestamp(),
          revision: 1,
          leaseExpiresAt: null,
          leaseExpired: false,
        },
      };
      state.cleanups.set(id, cleanup);
      return reply(cleanup);
    }
    if (name === "secrets_cleanup_history")
      return reply({
        items: [...state.cleanups.values()].map((item) => ({
          id: item.id,
          ...item.receipt,
          createdAt: item.createdAt,
        })),
        nextCursor: null,
      });
    const cleanup = state.cleanups.get(String(input.cleanupId));
    if (name === "secrets_cleanup_review" && cleanup) return reply(cleanup);
    if (name === "secrets_cleanup_apply" && cleanup) {
      await state.beforeCleanupWrite?.();
      if (cleanup.receipt.phase === "reviewed") {
        state.deletions++;
        Object.assign(cleanup.receipt, {
          phase: "finished",
          writeStatus: state.uncertainDeletion ? "indeterminate" : "accepted",
          observationStatus: "absent",
          observedAt: timestamp(),
          revision: 2,
        });
      }
      return reply(cleanup);
    }
    if (name === "secrets_cleanup_reconcile" && cleanup) {
      cleanup.receipt.observationStatus = "absent";
      return reply(cleanup);
    }
    return fail("Unsupported synthetic Secrets command", 400);
  });
  await page.route("**/api/secrets/input?*", async (route) => {
    const review = state.reviews.get(
      new URL(route.request().url()).searchParams.get("reviewId")!,
    )!;
    const body = route.request().postDataJSON() as {
      items: { ciphertext: string }[];
    };
    for (const item of body.items)
      state.values.push(
        sodium.to_string(
          sodium.crypto_box_seal_open(
            sodium.from_base64(
              item.ciphertext,
              sodium.base64_variants.ORIGINAL,
            ),
            key.publicKey,
            key.privateKey,
          ),
        ),
      );
    review.stage = "reviewed";
    review.fingerprint = "sha256:" + "b".repeat(64);
    review.inputPresent = true;
    if (state.loseInputResponse) {
      state.loseInputResponse = false;
      return route.abort();
    }
    await route.fulfill({ json: review });
  });
  return Object.assign(state, { target });
}
