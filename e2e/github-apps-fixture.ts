import type { Page } from "@playwright/test";
import type {
  GitHubAppGrant,
  GitHubAppGrantReview,
  GitHubAppMetadata,
  GitHubAppRegistrationReview,
} from "../shared/github-apps";
import { mockWorkspaceView } from "./workspace-fixture";
export function appMetadata(): GitHubAppMetadata {
  return {
    id: "synthetic-app",
    name: "Repository operator",
    appId: 42,
    slug: "repository-operator",
    visibility: "public",
    capabilities: [
      "collection",
      "repository-maintenance",
      "configuration-read",
      "configuration-write",
    ],
    revision: 1,
    state: "active",
    keyFingerprint: "a".repeat(64),
    lifecycleIngress: "ready",
  };
}
export async function mockGitHubApps(
  page: Page,
  options: { empty?: boolean; offer?: boolean; viewer?: boolean } = {},
) {
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    ...(options.viewer
      ? {
          capabilities: ["read"],
          workspace: { ...snapshot.workspace, role: "viewer" },
        }
      : {}),
  }));
  const state = {
    registrations: options.empty
      ? ([] as GitHubAppMetadata[])
      : [appMetadata()],
    grants: [] as GitHubAppGrant[],
    offers: [] as GitHubAppGrantReview[],
    conflict: false,
    missingPermission: false,
    calls: [] as { name: string; input: Record<string, unknown> }[],
    reviews: new Map<string, GitHubAppRegistrationReview>(),
  };
  const offer: GitHubAppGrantReview = {
    id: "offer",
    fingerprint: "sha256:" + "a".repeat(64),
    targetWorkspaceId: "development",
    registrationId: "synthetic-app",
    installationId: 91,
    grantId: "grant-development",
    revision: 0,
    kind: "offer",
    repositories: [
      { id: 101, fullName: "example/project", ownerId: 50, private: true },
    ],
    capabilities: ["collection"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    grantExpiresAt: null,
    state: "offered",
    grant: null,
  };
  const grantReviews = new Map<string, GitHubAppGrantReview>();
  if (options.offer) {
    state.offers.push(offer);
    grantReviews.set(offer.id, offer);
  }
  await page.route("**/api/commands/github_app*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON();
    state.calls.push({ name, input });
    let result: unknown;
    if (
      state.conflict &&
      [
        "github_app_registration_plan",
        "github_app_grant_plan",
        "github_app_grant_accept",
      ].includes(name)
    )
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "github_app_conflict",
            message: "This review changed. Your draft is preserved.",
          },
        },
      });
    switch (name) {
      case "github_apps_list":
        result = { registrations: state.registrations, limited: false };
        break;
      case "github_app_grant_list":
        result = { grants: state.grants, offers: state.offers, limited: false };
        break;
      case "github_app_connection_requests_list":
        result = { requests: [], limited: false };
        break;
      case "github_app_connection_request":
        result = { id: input.requestId, state: "requested" };
        break;
      case "github_app_grant_plan":
        result = {
          ...offer,
          id: "new-offer",
          grantId: input.grantId,
          targetWorkspaceId: input.targetWorkspaceId,
          capabilities: input.capabilities,
        };
        state.offers.push(result as GitHubAppGrantReview);
        grantReviews.set(
          (result as GitHubAppGrantReview).id,
          result as GitHubAppGrantReview,
        );
        break;
      case "github_app_grant_get":
        result = grantReviews.get(input.planId);
        break;
      case "github_app_grant_accept": {
        const selected = state.offers.find((item) => item.id === input.planId)!;
        const grant: GitHubAppGrant = {
          id: selected.grantId,
          workspaceId: selected.targetWorkspaceId,
          credentialRef: selected.grantId,
          registrationId: selected.registrationId,
          appId: 42,
          appName: "Repository operator",
          installationId: 91,
          account: { id: 50, login: "example", type: "Organization" },
          repositories: selected.repositories,
          capabilities: selected.capabilities,
          revision: 1,
          state: "active",
          expiresAt: null,
          issuerSubject: "operator",
          acceptedBy: "owner",
          acceptedAt: new Date().toISOString(),
        };
        state.grants.push(grant);
        state.offers = state.offers.filter((item) => item.id !== input.planId);
        result = { ...selected, grant, state: "active" };
        grantReviews.set(input.planId, result as GitHubAppGrantReview);
        break;
      }
      case "github_app_installations_list":
        result = {
          items: [
            {
              id: 91,
              appId: 42,
              account: { id: 50, login: "example", type: "Organization" },
              permissions: state.missingPermission
                ? { metadata: "read" }
                : {
                    metadata: "read",
                    contents: "write",
                    pull_requests: "write",
                    checks: "read",
                    statuses: "read",
                    issues: "read",
                    deployments: "read",
                    vulnerability_alerts: "read",
                    security_events: "read",
                    secret_scanning_alerts: "read",
                    actions: "read",
                    secrets: "write",
                    variables: "write",
                    environments: "write",
                  },
              repositorySelection: "selected",
              suspendedAt: null,
            },
          ],
          nextCursor: null,
          limited: false,
        };
        break;
      case "github_app_repositories_list":
        result = {
          items: [
            {
              id: 101,
              fullName: "example/project",
              ownerId: 50,
              private: true,
            },
          ],
          nextCursor: null,
          limited: false,
        };
        break;
      case "github_app_manifest_start":
        result = {
          id: "attempt",
          registrationId: input.registrationId,
          state: "pending",
          expiresAt: "2099-01-01T00:00:00.000Z",
          browserUrl:
            "/api/github-apps/manifest/start?workspaceId=development&attemptId=attempt",
          registration: null,
          recovery: "none",
        };
        break;
      case "github_app_manifest_get":
        result = {
          id: input.attemptId,
          registrationId: "synthetic-app",
          state: "indeterminate",
          expiresAt: "2099-01-01T00:00:00.000Z",
          browserUrl:
            "/api/github-apps/manifest/start?workspaceId=development&attemptId=attempt",
          registration: null,
          recovery: "protected_import_required",
        };
        break;
      case "github_app_registration_plan": {
        const review: GitHubAppRegistrationReview = {
          id: "registration-review",
          registrationId: input.registrationId,
          revision: input.revision,
          change: input.change,
          fingerprint: "sha256:" + "a".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z",
          privateInputRequired: input.change.kind !== "disconnect",
          applied: false,
          expired: false,
          impact: { affectedWorkspaceIds: ["development", "other-workspace"] },
          registration: null,
        };
        state.reviews.set(review.id, review);
        result = review;
        break;
      }
      case "github_app_registration_get":
        result = state.reviews.get(input.planId);
        break;
      case "github_app_registration_apply":
        result = state.reviews.get(input.planId);
        break;
      default:
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: "unsupported_fixture",
              message: "Unsupported synthetic command",
            },
          },
        });
    }
    return route.fulfill({ json: result });
  });
  await page.route("**/api/commands/github_credentials_list", (route) =>
    route.fulfill({
      json: [
        {
          id: "legacy",
          name: "Advanced token",
          kind: "token",
          configured: true,
        },
      ],
    }),
  );
  return state;
}
