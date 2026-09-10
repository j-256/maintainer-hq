import { expect, type Page } from "@playwright/test";
import type {
  SecretConnection,
  SecretDestination,
  SecretReview,
  SecretReviewedDestination,
} from "../shared/secrets";
import { mockSecrets } from "./secrets-fixture";

export const CLOUDFLARE_RESOURCE = {
  id: "worker-synthetic",
  label: "synthetic-worker",
  repositoryIds: [],
};
export const CLOUDFLARE_CONNECTION: SecretConnection = {
  id: "cf-secrets",
  name: "Synthetic Cloudflare Secrets",
  providerKind: "cloudflare-workers",
  providerRef: "managed-cloudflare",
  providerName: "Synthetic Cloudflare",
  revision: 1,
  resourceIds: [CLOUDFLARE_RESOURCE.id],
  resources: [CLOUDFLARE_RESOURCE],
  enabled: true,
  available: true,
  writable: true,
  capabilities: {
    entryKinds: ["secret", "variable"],
    input: "private-transient",
    maxValueBytes: 5120,
    nameRule: "provider-defined",
    scopeKinds: ["worker"],
    secretMutationScopeKinds: ["worker"],
    variableMutationScopeKinds: [],
    valueReadableKinds: ["variable"],
    activation: "worker-deployment",
    metadataVersion: "opaque",
    storedValueReadable: false,
  },
};
export async function mockCloudflareSecrets(page: Page, mixed = false) {
  const base = await mockSecrets(page, { owner: true });
  const state = base;
  state.connections = [
    ...(mixed ? state.connections : []),
    structuredClone(CLOUDFLARE_CONNECTION),
  ];
  const extra = { privateRequests: 0, loseTransientResponse: false };
  const target = (destination: SecretDestination): SecretReviewedDestination =>
    destination.connectionId !== CLOUDFLARE_CONNECTION.id
      ? base.target(destination)
      : {
          destination: structuredClone(destination),
          providerKind: "cloudflare-workers",
          connectionName: CLOUDFLARE_CONNECTION.name,
          resource: CLOUDFLARE_RESOURCE,
          snapshot: {
            name: destination.name,
            scope: { kind: "worker" },
            resourceIdentity: "a".repeat(32) + "/" + "b".repeat(32),
            scopeIdentity: null,
            resourceRevision: "synthetic-deployment",
            before:
              destination.name === "MixedCaseToken"
                ? {
                    name: destination.name,
                    createdAt: null,
                    updatedAt: null,
                    version: "synthetic-deployment",
                  }
                : null,
            input: { kind: "private-transient", maxValueBytes: 5120 },
            activation: "worker-deployment",
            workerDeployment: {
              accountId: "a".repeat(32),
              workerName: CLOUDFLARE_RESOURCE.label,
              deploymentId: "11111111-1111-4111-8111-111111111111",
              versionId: "22222222-2222-4222-8222-222222222222",
            },
          },
        };
  await page.route("**/api/commands/secrets_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    const reply = (json: unknown) => route.fulfill({ json });
    if (name === "secrets_draft") {
      state.calls.push({ name, input });
      const destinations = (input.destinations as SecretDestination[]).map(
        target,
      );
      const sealed = destinations.some(
        (item) => item.snapshot.input.kind === "provider-sealed",
      );
      const id = String(input.reviewId);
      const review: SecretReview = {
        id,
        stage: sealed ? "awaiting-input" : "reviewed",
        draftFingerprint: "sha256:" + "a".repeat(64),
        fingerprint: sealed ? null : "sha256:" + "a".repeat(64),
        actorMatches: true,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        inputExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        inputPresent: false,
        destinations,
        source: input.source ? target(input.source as SecretDestination) : null,
        operation: null,
        recovery: null,
      };
      state.reviews.set(id, review);
      return reply(review);
    }
    if (name === "secrets_providers")
      return reply(
        state.connections.map((item) => ({
          id: item.providerRef,
          kind: item.providerKind,
          name: item.providerName,
          revision: 1,
          resources: item.resources,
          available: true,
          writable: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
          capabilities: item.capabilities,
        })),
      );
    if (
      input.connectionId === CLOUDFLARE_CONNECTION.id &&
      ["secrets_inventory", "secrets_scopes"].includes(name)
    ) {
      state.calls.push({ name, input });
      if (name === "secrets_scopes")
        return reply({
          providerKind: "cloudflare-workers",
          resource: CLOUDFLARE_RESOURCE,
          defaultScope: { kind: "worker" },
          fixedScopes: [],
          observedAt: new Date().toISOString(),
          items: [],
          page: 1,
          total: 0,
          nextPage: null,
          truncated: false,
        });
      const entryKind =
        input.entryKind === "variable" ? "variable" : "secret";
      return reply({
        providerKind: "cloudflare-workers",
        entryKind,
        resource: CLOUDFLARE_RESOURCE,
        target: input.target,
        resourceIdentity: "a".repeat(32) + "/" + "b".repeat(32),
        scopeIdentity: null,
        observedAt: new Date().toISOString(),
        items: [
          entryKind === "variable"
            ? {
                name: "ApiOrigin",
                kind: "variable",
                management: "unmanaged",
                managedConfigurationId: null,
                value: "https://api.example.test",
                valueFormat: "text",
                createdAt: null,
                updatedAt: null,
                version: "synthetic-deployment",
              }
            : {
                name: "MixedCaseToken",
                kind: "secret",
                management: "unmanaged",
                managedConfigurationId: null,
                value: null,
                valueFormat: null,
                createdAt: null,
                updatedAt: null,
                version: "synthetic-deployment",
              },
        ],
        page: 1,
        total: 1,
        nextPage: null,
        truncated: false,
        excludedBindings: 1,
      });
    }
    if (
      name === "secrets_run" &&
      state.reviews.get(String(input.reviewId))?.destinations[
        Number(input.destinationIndex)
      ]?.providerKind === "cloudflare-workers"
    )
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "secret_transient_input_required",
            message: "Use private transient input",
          },
        },
      });
    return route.fallback();
  });
  await page.route("**/api/secrets/transient-input?*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const review = state.reviews.get(url.searchParams.get("reviewId")!)!;
    expect(request.headers()["if-match"]).toBe(review.fingerprint);
    expect(review.stage).toBe("accepted");
    const index = Number(url.searchParams.get("destinationIndex"));
    const receipt = review.operation!.receipts[index]!;
    if (receipt.phase !== "pending")
      return route.fulfill({ json: { inputConsumed: false, review } });
    extra.privateRequests++;
    const body = request.postDataJSON() as { version: number; value: string };
    expect(Object.keys(body).sort()).toEqual(["value", "version"]);
    expect(body.version).toBe(1);
    state.values.push(body.value);
    state.writes++;
    Object.assign(receipt, {
      phase: "finished",
      writeStatus: state.uncertainWrite ? "indeterminate" : "accepted",
      observationStatus: state.uncertainWrite ? "unknown" : "present",
      metadata: state.uncertainWrite
        ? null
        : {
            name: review.destinations[index]!.destination.name,
            createdAt: null,
            updatedAt: null,
            version: "next-synthetic-deployment",
          },
      submittedAt: new Date().toISOString(),
      observedAt: state.uncertainWrite ? null : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 4,
    });
    if (extra.loseTransientResponse) {
      extra.loseTransientResponse = false;
      return route.abort();
    }
    return route.fulfill({ json: { inputConsumed: true, review } });
  });
  return { state, extra };
}
