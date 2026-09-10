import type { Page } from "./test-fixture";
import {
  DEFAULT_EXPECTATIONS,
  ROLE_CAPABILITIES,
  type Repository,
  type Role,
} from "../shared/domain";
import type { GitHubSource } from "../shared/github";
import {
  FLEET_DISCOVERY_LIMITS,
  type FleetCandidate,
  type FleetDiscoveryResult,
  type FleetReconciliationInput,
  type FleetReconciliationReview,
} from "../shared/fleet-discovery";
import { mockWorkspaceView } from "./workspace-fixture";

export const FLEET_WORKSPACE = "development";
export const FLEET_URL = "/repositories?workspace=" + FLEET_WORKSPACE;
export async function fleetFixture(page: Page, role: Role = "owner") {
  const observedAt = new Date().toISOString();
  const repository: Repository = {
    id: "fleet-existing",
    workspaceId: FLEET_WORKSPACE,
    fullName: "example/old-name",
    description: "Keep the HQ description",
    projectId: "development-default",
    classification: "watchlist",
    lifecycle: "active",
    revision: 1,
    updatedAt: observedAt,
    expectations: {
      ...DEFAULT_EXPECTATIONS,
      note: "Preserve the note",
      reviewDate: "2027-01-01",
    },
  };
  const source: GitHubSource = {
    id: "fleet-source",
    name: "Read-only fleet source",
    provider: "github",
    revision: 1,
    enabled: true,
    freshnessMinutes: 30,
    repositoryIds: [repository.id],
    credentialConfigured: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    github: {
      credentialRef: "synthetic",
      configurationValid: true,
      refreshIntervalMinutes: 15,
      nextRefreshAt: null,
      retryAt: null,
      activeRefreshId: null,
      lastRefreshId: null,
      lastRefreshStatus: null,
    },
  };
  const result: FleetDiscoveryResult = {
    workspaceId: FLEET_WORKSPACE,
    source: { id: source.id, name: source.name, revision: 1 },
    scope: { kind: "enrolled", cursor: null },
    state: "ready",
    nextReadAt: new Date(Date.now() + 300000).toISOString(),
    evidence: {
      observedAt,
      retryAt: null,
      requests: 1,
      read: { state: "observed", reason: "complete" },
      owner: null,
      total: 31,
      hasMore: true,
      nextCursor: null,
    },
    candidates: Array.from(
      { length: FLEET_DISCOVERY_LIMITS.PAGE_SIZE },
      (_, index): FleetCandidate => ({
        key: "node-" + index,
        provider:
          index === 3
            ? null
            : {
                githubId: "node-" + index,
                fullName:
                  index === 0
                    ? "example/renamed"
                    : "example/discovered-" + String(index).padStart(2, "0"),
                description: "A newly discovered repository",
                archived: index === 0,
                private: index === 1,
              },
        repository:
          index === 0
            ? {
                id: repository.id,
                fullName: repository.fullName,
                projectId: repository.projectId,
                revision: 1,
                classification: "watchlist",
                lifecycle: "active",
                collected: true,
              }
            : null,
        lookupFullName: index === 3 ? "example/unavailable" : null,
        state:
          index === 0
            ? "changed"
            : index === 2
              ? "conflict"
              : index === 3
                ? "unavailable"
                : "new",
        reason:
          index === 0
            ? "metadata_changed"
            : index === 2
              ? "name_conflict"
              : index === 3
                ? "provider_unavailable"
                : "new",
        identity: index === 0 ? "recorded" : "catalog",
        read:
          index === 3
            ? { state: "unavailable", reason: "permission" }
            : { state: "observed", reason: "complete" },
      }),
    ),
    nextScope: {
      kind: "enrolled",
      cursor: {
        sourceId: source.id,
        sourceRevision: 1,
        repositoryId: "page-one-end",
      },
    },
  };
  const state = {
    source,
    repository,
    result,
    calls: [] as { name: string; input: Record<string, unknown> }[],
    review: null as FleetReconciliationReview | null,
    planInputs: [] as FleetReconciliationInput[],
    applyInputs: [] as object[],
    losePreparation: false,
    loseApply: false,
    rejectApply: false,
    commitOnApply: true,
    missingReview: false,
    readStatus: 0,
  };
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role },
    capabilities: [...ROLE_CAPABILITIES[role]],
    repositories: [state.repository],
    connections: [state.source],
  }));
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      state.calls.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  await page.route("**/api/commands/fleet_sources", (route) =>
    route.fulfill({
      json: [
        {
          id: state.source.id,
          name: state.source.name,
          revision: state.source.revision,
          enabled: state.source.enabled,
          configured:
            state.source.credentialConfigured &&
            state.source.github.configurationValid,
        },
      ],
    }),
  );
  await page.route("**/api/commands/fleet_discover", async (route) => {
    if (state.readStatus)
      return route.fulfill({
        status: state.readStatus,
        json: {
          error: {
            code: "forbidden",
            message: "Read access changed. Your selection is unchanged.",
          },
        },
      });
    const input = route.request().postDataJSON();
    const nextPage = Boolean(input.scope.cursor);
    const response: FleetDiscoveryResult = {
      ...state.result,
      scope: input.scope,
      candidates: nextPage
        ? state.result.candidates.slice(4, 10).map((candidate, index) => ({
            ...candidate,
            key: "extra-" + index,
            provider: {
              ...candidate.provider!,
              githubId: "extra-" + index,
              fullName: "example/page-two-" + index,
            },
          }))
        : state.result.candidates,
      nextScope: nextPage
        ? null
        : input.scope.kind === "owner"
          ? {
              kind: "owner",
              owner: input.scope.owner,
              cursor: {
                sourceId: source.id,
                sourceRevision: 1,
                owner: input.scope.owner,
                after: "page-two",
              },
            }
          : state.result.nextScope,
    };
    await route.fulfill({ json: response });
  });
  await page.route(
    "**/api/commands/fleet_reconciliation_plan",
    async (route) => {
      const input: FleetReconciliationInput = route.request().postDataJSON();
      state.planInputs.push(input);
      if (!state.review)
        state.review = {
          workspaceId: FLEET_WORKSPACE,
          workspaceName: "Development",
          planId: input.reviewId,
          fingerprint: "b".repeat(64),
          actor: "Development owner",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          observedAt,
          source: {
            id: source.id,
            name: source.name,
            revision: source.revision,
            beforeCount: 1,
            afterCount: input.selections.filter((row) => row.collect).length,
          },
          fields: input,
          state: "ready",
          receipt: null,
          changes: input.selections.map((row) => ({
            repositoryId: row.repositoryId ?? "created-" + row.githubId,
            githubId: row.githubId,
            before: row.repositoryId ? { ...repository } : null,
            after: {
              fullName: row.fullName,
              lifecycle: row.lifecycle,
              classification: row.repositoryId
                ? repository.classification
                : row.classification!,
              description: row.repositoryId
                ? repository.description
                : "A newly discovered repository",
              projectId: row.repositoryId
                ? repository.projectId
                : row.projectId!,
              expectations: row.repositoryId
                ? repository.expectations
                : DEFAULT_EXPECTATIONS,
            },
            collectedBefore: Boolean(row.repositoryId),
            collectedAfter: row.collect,
          })),
        };
      if (state.losePreparation) {
        state.losePreparation = false;
        await route.abort("failed");
      } else await route.fulfill({ json: state.review });
    },
  );
  await page.route(
    "**/api/commands/fleet_reconciliation_review",
    async (route) => {
      if (state.missingReview || !state.review)
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: "not_found",
              message: "This saved review is not available.",
            },
          },
        });
      else await route.fulfill({ json: state.review });
    },
  );
  await page.route(
    "**/api/commands/fleet_reconciliation_apply",
    async (route) => {
      state.applyInputs.push(route.request().postDataJSON());
      if (state.rejectApply) {
        state.review!.state = "stale";
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "revision_conflict",
              message:
                "The selected repository changed. No new enrollment changes were applied.",
            },
          },
        });
      }
      const review = state.review!;
      if (state.commitOnApply) {
        review.receipt ??= {
          workspaceId: FLEET_WORKSPACE,
          planId: review.planId,
          fingerprint: review.fingerprint,
          appliedAt: new Date().toISOString(),
          sourceId: source.id,
          sourceRevision: source.revision + 1,
          createdRepositoryIds: review.changes
            .filter((row) => !row.before)
            .map((row) => row.repositoryId),
          updatedRepositoryIds: review.changes
            .filter((row) => row.before)
            .map((row) => row.repositoryId),
          addedToSource: review.changes
            .filter((row) => !row.collectedBefore && row.collectedAfter)
            .map((row) => row.repositoryId),
          removedFromSource: review.changes
            .filter((row) => row.collectedBefore && !row.collectedAfter)
            .map((row) => row.repositoryId),
        };
        review.state = "applied";
      }
      if (state.loseApply) {
        state.loseApply = false;
        await route.abort("failed");
      } else await route.fulfill({ json: review.receipt });
    },
  );
  return state;
}
