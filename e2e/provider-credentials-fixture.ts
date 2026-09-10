import type { Page } from "@playwright/test";
import {
  providerCredentialPlanInput,
  type ProviderCredential,
  type ProviderCredentialReview,
} from "../shared/provider-credentials";
import {
  mockSecrets,
  SECRET_CONNECTION,
  SECRET_RESOURCE,
} from "./secrets-fixture";

export function credentialFixture(): ProviderCredential {
  return {
    id: "managed-synthetic",
    revision: 1,
    settings: {
      providerKind: "github-actions",
      name: "Product repository access",
      expiresAt: "2099-01-01T00:00:00.000Z",
      writable: true,
      scope: { repositoryNames: [SECRET_RESOURCE.label] },
    },
    status: "available",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retiredAt: null,
  };
}

export async function mockProviderCredentials(
  page: Page,
  options: { viewer?: boolean; empty?: boolean; storageReady?: boolean } = {},
) {
  const secrets = await mockSecrets(page, {
    empty: true,
    viewer: options.viewer,
    owner: !options.viewer,
  });
  const state = {
    calls: [] as { name: string; input: Record<string, unknown> }[],
    credentials: options.empty
      ? ([] as ProviderCredential[])
      : [credentialFixture()],
    reviews: new Map<string, ProviderCredentialReview>(),
    privateInputs: [] as string[],
    loseInputResponse: false,
    conflict: false,
    verifyFailure: false,
    extraPage: false,
  };
  const apply = (review: ProviderCredentialReview) => {
    if (review.appliedAt) return;
    review.appliedAt = new Date().toISOString();
    const old = state.credentials.find(
      (item) => item.id === review.credentialId,
    );
    const settings =
      review.change.kind === "save" ? review.change.settings : old!.settings;
    const credential: ProviderCredential = {
      id: review.credentialId,
      revision: review.revision + 1,
      settings,
      status: review.change.kind === "retire" ? "retired" : "available",
      createdAt: old?.createdAt ?? review.appliedAt,
      updatedAt: review.appliedAt,
      retiredAt: review.change.kind === "retire" ? review.appliedAt : null,
    };
    state.credentials = [
      ...state.credentials.filter((item) => item.id !== credential.id),
      credential,
    ];
  };
  await page.route("**/api/commands/secrets_providers", async (route) => {
    await route.fulfill({
      json: state.credentials
        .filter((item) => item.status === "available")
        .map((item) => ({
          id: item.id,
          kind: item.settings.providerKind,
          name: item.settings.name,
          revision: item.revision,
          resources: [SECRET_RESOURCE],
          available: true,
          writable: item.settings.writable,
          expiresAt: item.settings.expiresAt,
          capabilities: SECRET_CONNECTION.capabilities,
        })),
    });
  });
  await page.route("**/api/commands/provider_*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.calls.push({ name, input });
    const reply = (json: unknown) => route.fulfill({ json });
    const fail = (message: string) =>
      route.fulfill({
        status: 409,
        json: { error: { code: "synthetic_conflict", message } },
      });
    if (name === "provider_credentials_list")
      return reply({
        items: state.credentials
          .filter((item) => Boolean(item.retiredAt) === Boolean(input.retired))
          .map((item) =>
            input.before
              ? {
                  ...item,
                  id: item.id + "-second",
                  settings: { ...item.settings, name: "Second access page" },
                }
              : item,
          ),
        nextCursor: state.extraPage && !input.before ? "second" : null,
        storageReady: options.storageReady !== false,
      });
    if (name === "provider_credential_plan") {
      if (state.conflict)
        return fail(
          "Credential changed. Keep your draft and review saved access.",
        );
      const parsed = providerCredentialPlanInput.parse(input);
      const id = "credential-review-" + (state.reviews.size + 1);
      const previous = state.credentials.find(
        (item) => item.id === parsed.credentialId,
      );
      const review: ProviderCredentialReview = {
        id,
        credentialId: parsed.credentialId,
        revision: parsed.revision,
        change: parsed.change,
        previousSettings: previous?.settings ?? null,
        fingerprint:
          "sha256:" + String(state.reviews.size + 1).padStart(64, "0"),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        appliedAt: null,
        actorMatches: true,
        connections: [],
        pendingReviews: 0,
        unsettledDestinations: 0,
      };
      state.reviews.set(id, review);
      return reply(review);
    }
    if (name === "provider_credential_review")
      return reply(state.reviews.get(String(input.planId)));
    if (name === "provider_credential_apply") {
      const review = state.reviews.get(String(input.planId))!;
      if (review.fingerprint !== input.fingerprint)
        return fail("Exact reviewed fingerprint required.");
      apply(review);
      return reply(review);
    }
    if (name === "provider_credential_verify") {
      if (state.verifyFailure)
        return fail("Synthetic provider read unavailable.");
      return reply({
        ...input,
        providerKind: "github-actions",
        verifiedAt: new Date().toISOString(),
        evidence:
          input.entryKind === "variable"
            ? "variable-values-readable"
            : "secret-metadata-readable",
        writePermissionVerified: false,
      });
    }
    return fail("Unexpected credential command: " + name);
  });
  await page.route("**/api/provider-credentials/input?**", async (route) => {
    const review = state.reviews.get(
      new URL(route.request().url()).searchParams.get("planId")!,
    )!;
    if (route.request().headers()["if-match"] !== review.fingerprint)
      throw new Error("Missing exact fingerprint");
    if (review.appliedAt)
      return route.fulfill({ json: { submitted: false, review } });
    state.privateInputs.push(route.request().postDataJSON().token);
    apply(review);
    if (state.loseInputResponse) {
      state.loseInputResponse = false;
      return route.abort("failed");
    }
    return route.fulfill({ json: { submitted: true, review } });
  });
  return Object.assign(state, { secrets });
}
