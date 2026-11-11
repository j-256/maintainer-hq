import { githubAppPermissions } from "../shared/github-apps";
import { CAPABILITY } from "../shared/domain";
import { resolveGitHubCredential } from "../worker/github-credential-resolver";
import { invalidateGitHubAppAuthority } from "../worker/github-app-authority";
import { FleetDiscoveryService } from "../worker/fleet-discovery";
import { runGitHubJobs, runGitHubScheduled } from "../worker/github-runner";
import { githubCredentialDescriptor } from "../worker/github-credential-descriptors";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
  appInstallationFixture,
} from "./helpers/github-app-active-fixture";
import { releaseFixture, comparisonFixture } from "./fixtures/releases";
import { workFixture, workSignalsFixture } from "./fixtures/repository-work";
import { WORK_QUERY, WORK_SIGNALS_QUERY } from "../worker/work-client";
import {
  dependencyProviderFixture,
  DEPENDENCY_PROVIDER,
} from "./fixtures/dependency-provider";
import {
  dependabotProviderFixture,
  DEPENDABOT_PROVIDER,
} from "./fixtures/dependabot-provider";
let fixture: GitHubAppFixture;
let repositoryId: string;
let evidenceMode:
  "work" | "releases" | "dependencies" | "dependabot" | "collector" | "fleet";
let requests: string[];
let allRequests: string[];
let outsideCatalog = false;
let invalidateAfterRead = false;
let denyAppTokens = false;
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  requests = [];
  allRequests = [];
  outsideCatalog = false;
  invalidateAfterRead = false;
  denyAppTokens = false;
  const app = appProviderFixture(fixture);
  const dependencies = await dependencyProviderFixture();
  const dependabot = await dependabotProviderFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    allRequests.push(url.pathname);
    if (url.pathname === "/app/installations/91")
      return Response.json({
        ...appInstallationFixture,
        permissions: githubAppPermissions(["collection"]),
      });
    if (url.pathname.startsWith("/app/")) {
      if (denyAppTokens && url.pathname.endsWith("/access_tokens"))
        return Response.json({}, { status: 403 });
      return app(input, init);
    }
    requests.push(new Headers(init?.headers).get("Authorization") ?? "");
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (invalidateAfterRead)
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
      if (evidenceMode === "fleet") {
        const repository = {
          id: "node-project",
          nameWithOwner: "example/project",
          description: "Project",
          isArchived: false,
          isPrivate: true,
        };
        return Response.json({
          data: body.query.includes("FleetCatalog")
            ? {
                catalog: {
                  login: "example",
                  repositories: {
                    totalCount: outsideCatalog ? 2 : 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: outsideCatalog
                      ? [
                          repository,
                          {
                            ...repository,
                            id: "node-outside",
                            nameWithOwner: "example/outside",
                          },
                        ]
                      : [repository],
                  },
                },
              }
            : { repository0: repository },
        });
      }
      if (evidenceMode === "collector")
        return Response.json({
          data: {
            repository: {
              nameWithOwner: "example/project",
              object: {
                oid: body.variables.expression,
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: {
                    totalCount: outsideCatalog ? 2 : 1,
                    checkRunCount: 1,
                    checkRunCountsByState: [{ state: "SUCCESS", count: 1 }],
                    statusContextCount: 0,
                    statusContextCountsByState: [],
                  },
                },
              },
            },
          },
        });
      if (body.query === WORK_SIGNALS_QUERY)
        return Response.json(
          workSignalsFixture("example/project", body.variables.ids),
        );
      return Response.json(
        body.query === WORK_QUERY
          ? workFixture("example/project")
          : releaseFixture("example/project"),
      );
    }
    if (evidenceMode === "collector") {
      if (url.pathname === "/repos/example/project")
        return Response.json({
          id: 101,
          full_name: "example/project",
          private: true,
          default_branch: "main",
        });
      if (url.pathname === "/repos/example/project/branches/main")
        return Response.json({ name: "main", commit: { sha: "a".repeat(40) } });
      if (url.pathname.endsWith("/alerts")) return Response.json([]);
      return Response.json({}, { status: 404 });
    }
    if (evidenceMode === "dependencies" || evidenceMode === "dependabot") {
      const name =
        evidenceMode === "dependencies"
          ? DEPENDENCY_PROVIDER.repository
          : DEPENDABOT_PROVIDER.repository;
      const adapter =
        evidenceMode === "dependencies" ? dependencies : dependabot;
      const reply = adapter.response(
        new URL(String(url).replace("example/project", name)),
      );
      return new Response(
        (await reply.text()).replaceAll(name, "example/project"),
        { status: reply.status, headers: reply.headers },
      );
    }
    return Response.json(comparisonFixture());
  });
  const scope = await activateGitHubAppFixture(fixture, "alpha", "grant-a", {
    permissions: githubAppPermissions(["collection"]),
  });
  repositoryId = scope.repositoryId;
  allRequests = [];
  await fixture.runtime.HQ_DB.prepare(
    "DELETE FROM github_context_budgets",
  ).run();
});
afterEach(() => vi.restoreAllMocks());
const scope = () => ({
  workspaceId: "alpha",
  sourceId: "github",
  repositoryId,
});
describe.each(["token", "app"] as const)(
  "GitHub read paths with %s credentials",
  (mode) => {
    beforeEach(async () => {
      if (mode === "token")
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE connections SET credential_ref='legacy',revision=2 WHERE workspace_id='alpha' AND id='github'",
        ).run();
    });
    it.each(["manual", "scheduled"] as const)(
      "collects CI and scanner evidence through the %s path",
      async (trigger) => {
        evidenceMode = "collector";
        if (trigger === "manual")
          await fixture.operator.githubRefresh({
            workspaceId: "alpha",
            sourceId: "github",
            revision: mode === "app" ? 1 : 2,
            refreshId: "manual-refresh",
          });
        const run = trigger === "manual" ? runGitHubJobs : runGitHubScheduled;
        await run(fixture.runtime, {
          now: () => fixture.clock.now,
          fetch: globalThis.fetch,
          maxItems: 1,
        });
        const jobs = await fixture.operator.githubRefreshes({
          workspaceId: "alpha",
          sourceId: "github",
        });
        expect(jobs).toHaveLength(1);
        const result = await fixture.operator.githubRefreshGet({
          workspaceId: "alpha",
          sourceId: "github",
          refreshId: jobs[0].id,
        });
        expect(["succeeded", "partial"]).toContain(result.status);
        expect(result.items?.[0].evidence).not.toBeNull();
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((header) =>
            mode === "app"
              ? header.startsWith("Bearer synthetic-installation-token-")
              : header === "Bearer synthetic-legacy-token",
          ),
        ).toBe(true);
      },
    );
    it("lists authorized App and manual references as metadata without provider discovery", async () => {
      const references = await fixture.operator.githubCredentials({
        workspaceId: "alpha",
      });
      expect(
        references.find((reference) => reference.id === "grant-a"),
      ).toMatchObject({
        kind: "app",
        capabilities: ["collection"],
        available: true,
      });
      expect(
        references.find((reference) => reference.id === "legacy"),
      ).toMatchObject({ kind: "token", available: true });
      expect(
        (
          await fixture.operator.githubSourceGet({
            workspaceId: "alpha",
            sourceId: "github",
          })
        ).credentialConfigured,
      ).toBe(true);
      expect(allRequests).toEqual([]);
    });
    it.each(["owner", "enrolled"] as const)(
      "discovers the %s catalog using explicit authority",
      async (kind) => {
        evidenceMode = "fleet";
        const result = await new FleetDiscoveryService(
          fixture.operator,
        ).discover({
          workspaceId: "alpha",
          sourceId: "github",
          sourceRevision: mode === "app" ? 1 : 2,
          scope:
            kind === "owner"
              ? { kind: "owner", owner: "example" }
              : { kind: "enrolled" },
        });
        expect(result.state).toBe("ready");
        expect(result.candidates[0].provider?.fullName).toBe("example/project");
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((header) =>
            mode === "app"
              ? header.startsWith("Bearer synthetic-installation-token-")
              : header === "Bearer synthetic-legacy-token",
          ),
        ).toBe(true);
      },
    );
    it("captures per-target authority in a fleet identity review", async () => {
      evidenceMode = "fleet";
      const review = await fixture.operator.fleetReconciliationPlan({
        workspaceId: "alpha",
        sourceId: "github",
        sourceRevision: mode === "app" ? 1 : 2,
        reviewId: crypto.randomUUID(),
        selections: [
          {
            githubId: "node-project",
            fullName: "example/project",
            lifecycle: "active",
            repositoryId,
            revision: 1,
            classification: null,
            projectId: null,
            projectRevision: null,
            collect: true,
          },
        ],
      });
      expect(review.state).toBe("ready");
      if (mode === "app") {
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        const changed = await fixture.operator.fleetReconciliationReview({
          workspaceId: "alpha",
          planId: review.planId,
        });
        expect(changed.state).toBe("stale");
      }
    });
    if (mode === "app") {
      it("marks a repository outside a narrowed grant unavailable in access metadata", async () => {
        const row = await fixture.runtime.HQ_DB.prepare(
          "SELECT metadata_json FROM github_app_grants WHERE id='grant-a'",
        ).first<{ metadata_json: string }>();
        const grant = JSON.parse(row!.metadata_json);
        grant.repositories = [
          { ...grant.repositories[0], id: 102, fullName: "example/another" },
        ];
        grant.revision++;
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE github_app_grants SET revision=?,metadata_json=? WHERE id='grant-a'",
        )
          .bind(grant.revision, JSON.stringify(grant))
          .run();
        const access = await fixture.operator.repositoryAccess({
          workspaceId: "alpha",
          repositoryId,
        });
        expect(access.github.sources[0].credential).toBe("unavailable");
        const coverage = await fixture.operator.repositoryCredentialCoverage({
          workspaceId: "alpha",
          repositoryIds: [repositoryId],
        });
        expect(coverage.rows[0].collection).toMatchObject({
          configured: 0,
          credentialUnavailable: 1,
        });
        expect(allRequests).toEqual([]);
      });
      it("shares a collector cooldown across workspace grants for the same installation", async () => {
        evidenceMode = "collector";
        await activateGitHubAppFixture(fixture, "beta", "grant-b");
        const beta = fixture.as({ subject: "other", displayName: "Other" });
        await fixture.operator.githubRefresh({
          workspaceId: "alpha",
          sourceId: "github",
          revision: 1,
          refreshId: "alpha-queued",
        });
        await beta.githubRefresh({
          workspaceId: "beta",
          sourceId: "github",
          revision: 1,
          refreshId: "beta-queued",
        });
        const descriptor = await githubCredentialDescriptor(
          fixture.operator,
          "alpha",
          "grant-a",
        );
        await fixture.runtime.HQ_DB.prepare(
          "INSERT INTO github_cooldowns(credential_hash,retry_at) VALUES (?,?)",
        )
          .bind(
            descriptor!.quotaKey,
            new Date(fixture.clock.now + 60000).toISOString(),
          )
          .run();
        allRequests = [];
        await runGitHubJobs(fixture.runtime, {
          now: () => fixture.clock.now,
          fetch: globalThis.fetch,
          maxItems: 2,
        });
        expect(
          (
            await fixture.operator.githubRefreshGet({
              workspaceId: "alpha",
              sourceId: "github",
              refreshId: "alpha-queued",
            })
          ).status,
        ).toBe("queued");
        expect(
          (
            await beta.githubRefreshGet({
              workspaceId: "beta",
              sourceId: "github",
              refreshId: "beta-queued",
            })
          ).status,
        ).toBe("queued");
        expect(allRequests).toEqual([]);
      });
      it("cancels collection when authority changes after claim and before provider I/O", async () => {
        evidenceMode = "collector";
        let invalidated = false;
        fixture.runtime.WORKSPACE_EVENTS = {
          getByName: () => ({
            publish: async () => {
              const running = await fixture.runtime.HQ_DB.prepare(
                "SELECT 1 FROM github_refresh_items WHERE status='running'",
              ).first();
              if (running && !invalidated) {
                invalidated = true;
                await invalidateGitHubAppAuthority(fixture.operator, "app-a");
              }
            },
          }),
        } as unknown as NonNullable<typeof fixture.runtime.WORKSPACE_EVENTS>;
        await fixture.operator.githubRefresh({
          workspaceId: "alpha",
          sourceId: "github",
          revision: 1,
          refreshId: "claim-race",
        });
        await expect(
          runGitHubJobs(fixture.runtime, {
            now: () => fixture.clock.now,
            fetch: globalThis.fetch,
            maxItems: 1,
          }),
        ).resolves.toBeDefined();
        const result = await fixture.operator.githubRefreshGet({
          workspaceId: "alpha",
          sourceId: "github",
          refreshId: "claim-race",
        });
        expect(result.status).toBe("cancelled");
        expect(requests).toEqual([]);
      });
      it("preserves a denied collector target without accepting healthy evidence or a token fallback", async () => {
        evidenceMode = "collector";
        denyAppTokens = true;
        await fixture.operator.githubRefresh({
          workspaceId: "alpha",
          sourceId: "github",
          revision: 1,
          refreshId: "denied-refresh",
        });
        await runGitHubJobs(fixture.runtime, {
          now: () => fixture.clock.now,
          fetch: globalThis.fetch,
          maxItems: 1,
        });
        const result = await fixture.operator.githubRefreshGet({
          workspaceId: "alpha",
          sourceId: "github",
          refreshId: "denied-refresh",
        });
        expect(result.status).not.toBe("succeeded");
        expect(result.items?.[0].evidence).toBeNull();
        expect(requests).toEqual([]);
      });
      it("does not expose catalog metadata outside the accepted grant", async () => {
        evidenceMode = "fleet";
        outsideCatalog = true;
        const result = await new FleetDiscoveryService(
          fixture.operator,
        ).discover({
          workspaceId: "alpha",
          sourceId: "github",
          sourceRevision: 1,
          scope: { kind: "owner", owner: "example" },
        });
        expect(JSON.stringify(result)).not.toContain("example/outside");
        expect(result.evidence?.total).toBeNull();
        expect(result.evidence?.read.reason).toBe("permission");
      });
      it.each(["fleet", "work"] as const)(
        "rejects %s evidence invalidated during provider I/O",
        async (kind) => {
          evidenceMode = kind;
          invalidateAfterRead = true;
          const read =
            kind === "fleet"
              ? new FleetDiscoveryService(fixture.operator).discover({
                  workspaceId: "alpha",
                  sourceId: "github",
                  sourceRevision: 1,
                  scope: { kind: "enrolled" },
                })
              : fixture.operator.repositoryWork(scope());
          await expect(read).rejects.toMatchObject({
            code: "github_app_conflict",
          });
          const stored = await fixture.runtime.HQ_DB.prepare(
            "SELECT result_json FROM " +
              (kind === "fleet"
                ? "github_discovery_cache"
                : "github_work_cache") +
              " WHERE workspace_id='alpha'",
          ).first<{ result_json: string | null }>();
          expect(stored?.result_json).toBeNull();
        },
      );
    }
    it.each(["dependencies", "dependabot"] as const)(
      "prepares an authority-pinned %s review",
      async (kind) => {
        evidenceMode = kind;
        const result =
          kind === "dependencies"
            ? await fixture.operator.repositoryDependencies({
                ...scope(),
                refresh: true,
              })
            : await fixture.operator.repositoryDependabot({
                ...scope(),
                refresh: true,
              });
        let planId: string;
        if (kind === "dependencies") {
          const evidence = (
            result as Awaited<
              ReturnType<typeof fixture.operator.repositoryDependencies>
            >
          ).evidence!;
          const review = await fixture.operator.dependencyChangePlan({
            ...scope(),
            headSha: evidence.headSha,
            policyDigest: evidence.report!.policyDigest,
            overrideId: "decoder-advisory",
            change: {
              kind: "renew",
              owner: "Project maintainers",
              reason: "The repository still requires the older runner release",
              reviewDays: 14,
            },
          });
          expect(review.state).toBe("ready");
          planId = review.planId;
        } else {
          const evidence = (
            result as Awaited<
              ReturnType<typeof fixture.operator.repositoryDependabot>
            >
          ).evidence!;
          const review = await fixture.operator.dependabotChangePlan({
            ...scope(),
            headSha: evidence.headSha,
            fileDigest: evidence.file!.digest,
            edits: [
              {
                entryId: evidence.entries[0].id,
                schedule: {
                  interval: "weekly",
                  day: "monday",
                  time: "04:00",
                  timezone: "Etc/UTC",
                },
              },
            ],
          });
          expect(review.state).toBe("ready");
          planId = review.planId;
        }
        if (mode === "app") {
          await invalidateGitHubAppAuthority(fixture.operator, "app-a");
          const review =
            kind === "dependencies"
              ? await fixture.operator.dependencyChangeReview({
                  workspaceId: "alpha",
                  planId,
                })
              : await fixture.operator.dependabotChangeReview({
                  workspaceId: "alpha",
                  planId,
                });
          expect(review.state).toBe("stale");
        }
      },
    );
    it("reports configured collection authority in access and coverage metadata", async () => {
      const access = await fixture.operator.repositoryAccess({
        workspaceId: "alpha",
        repositoryId,
      });
      expect(access.github.sources[0].credential).toBe("configured");
      const coverage = await fixture.operator.repositoryCredentialCoverage({
        workspaceId: "alpha",
        repositoryIds: [repositoryId],
      });
      expect(coverage.rows[0].collection).toMatchObject({
        configured: 1,
        credentialUnavailable: 0,
        grant: "not_verified",
      });
      expect(allRequests).toEqual([]);
    });
    it.each(["dependencies", "dependabot"] as const)(
      "uses verified App authority for cached %s inventory pages",
      async (kind) => {
        evidenceMode = kind;
        if (kind === "dependencies")
          await fixture.operator.repositoryDependencies({
            ...scope(),
            refresh: true,
          });
        else
          await fixture.operator.repositoryDependabot({
            ...scope(),
            refresh: true,
          });
        allRequests = [];
        if (kind === "dependencies") {
          const page = await fixture.operator.dependenciesList({
            workspaceId: "alpha",
          });
          expect(page.rows[0].summary.observedAt).not.toBeNull();
        } else {
          const page = await fixture.operator.dependabotSchedules({
            workspaceId: "alpha",
          });
          expect(page.rows[0].result?.state).toBe("ready");
        }
        expect(allRequests).toEqual([]);
        if (mode === "app") {
          fixture.clock.now += 61000;
          const page = await fixture.operator.dependabotSchedules({
            workspaceId: "alpha",
          });
          expect(page.rows[0].result?.state).toBe("waiting");
          expect(allRequests).toEqual([]);
        }
      },
    );
    it("saves an explicit source reference without changing provider grants", async () => {
      const source = await fixture.operator.githubSourceEnroll({
        workspaceId: "alpha",
        sourceId: "additional-source",
        source: {
          name: "Additional source",
          enabled: true,
          freshnessMinutes: 30,
          repositoryIds: [repositoryId],
          credentialRef: mode === "app" ? "grant-a" : "legacy",
          refreshIntervalMinutes: 15,
        },
      });
      expect(source.credentialConfigured).toBe(true);
      expect(allRequests).toEqual([]);
    });
    it("keeps a cached-only inspection local while authority is unverified", async () => {
      const result = await fixture.operator.repositoryDependencies({
        ...scope(),
        refresh: false,
      });
      expect(result.state).toBe("waiting");
      expect(result.evidence).toBeNull();
      expect(allRequests).toEqual([]);
    });
    it("keeps verified cached evidence readable during a shared provider cooldown", async () => {
      evidenceMode = "work";
      const first = await fixture.operator.repositoryWork(scope());
      expect(first.state).toBe("ready");
      const descriptor = await githubCredentialDescriptor(
        fixture.operator,
        "alpha",
        mode === "app" ? "grant-a" : "legacy",
      );
      await fixture.runtime.HQ_DB.prepare(
        "INSERT INTO github_cooldowns(credential_hash,retry_at) VALUES (?,?)",
      )
        .bind(
          descriptor!.quotaKey,
          new Date(fixture.clock.now + 120000).toISOString(),
        )
        .run();
      allRequests = [];
      expect((await fixture.operator.repositoryWork(scope())).state).toBe(
        "ready",
      );
      expect(allRequests).toEqual([]);
    });
    it.each(["work", "releases", "dependencies", "dependabot"] as const)(
      "preserves observed %s evidence and keeps material private",
      async (kind) => {
        evidenceMode = kind;
        const result =
          kind === "work"
            ? await fixture.operator.repositoryWork(scope())
            : kind === "releases"
              ? await fixture.operator.repositoryReleases(scope())
              : kind === "dependencies"
                ? await fixture.operator.repositoryDependencies({
                    ...scope(),
                    refresh: true,
                    checkUpstream: false,
                  })
                : await fixture.operator.repositoryDependabot({
                    ...scope(),
                    refresh: true,
                  });
        expect(result.state).toBe("ready");
        expect(result.evidence).not.toBeNull();
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((header) =>
            mode === "app"
              ? header.startsWith("Bearer synthetic-installation-token-")
              : header === "Bearer synthetic-legacy-token",
          ),
        ).toBe(true);
        expect(JSON.stringify(result)).not.toContain(
          "synthetic-installation-token",
        );
        expect(JSON.stringify(result)).not.toContain("synthetic-legacy-token");
        if (kind === "dependabot" || kind === "dependencies")
          expect(result.evidence).toMatchObject({
            read: { state: "observed" },
          });
      },
    );
  },
);

describe.each(["token", "app"] as const)(
  "GitHub configuration reads with %s credentials",
  (mode) => {
    it("offers authorized App references and reads repository, environment and repository-effective organization inventory", async () => {
      fixture = await createGitHubAppFixture();
      const app = appProviderFixture(fixture);
      const permissions = {
        metadata: "read" as const,
        contents: "read" as const,
        actions: "read" as const,
        environments: "read" as const,
        secrets: "read" as const,
        actions_variables: "read" as const,
      };
      fixture.runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
        "manual-actions": {
          workspaceId: "alpha",
          name: "Manual Actions",
          revision: 1,
          token: "synthetic-manual-actions",
          expiresAt: new Date(fixture.clock.now + 3600000).toISOString(),
          repositoryNames: ["example/project"],
          writable: false,
        },
      });
      const auth: string[] = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/app/installations/91")
          return Response.json({
            id: 91,
            app_id: 42,
            account: { id: 50, login: "example", type: "Organization" },
            permissions,
            repository_selection: "selected",
            suspended_at: null,
          });
        if (url.pathname.startsWith("/app/")) return app(input, init);
        auth.push(new Headers(init?.headers).get("Authorization") ?? "");
        if (url.pathname === "/repos/example/project")
          return Response.json({
            id: 101,
            full_name: "example/project",
            private: true,
            archived: false,
            disabled: false,
            owner: { id: 50, login: "example", type: "Organization" },
          });
        if (url.pathname.endsWith("/environments/production"))
          return Response.json({ id: 8, name: "production" });
        if (url.pathname.endsWith("/environments"))
          return Response.json({
            total_count: 1,
            environments: [{ id: 8, name: "production" }],
          });
        if (url.pathname.endsWith("secrets"))
          return Response.json({
            total_count: 1,
            secrets: [
              {
                name: "EXAMPLE",
                created_at: new Date(fixture.clock.now).toISOString(),
                updated_at: new Date(fixture.clock.now).toISOString(),
              },
            ],
          });
        if (url.pathname.endsWith("variables"))
          return Response.json({
            total_count: 1,
            variables: [
              {
                name: "EXAMPLE",
                value: "visible value",
                created_at: new Date(fixture.clock.now).toISOString(),
                updated_at: new Date(fixture.clock.now).toISOString(),
              },
            ],
          });
        return Response.json({}, { status: 404 });
      });
      const scope = await activateGitHubAppFixture(
        fixture,
        "alpha",
        "grant-a",
        {
          capabilities: ["collection", "configuration-read"],
          permissions,
        },
      );
      const admission = {
        ...scope,
        reference: { kind: "app" as const, grantId: "grant-a" },
        capability: "configuration-read" as const,
        actorCapability: CAPABILITY.SECRETS,
        connectionKind: "configuration-admission" as const,
        permissions: { metadata: "read" as const },
      };
      await expect(
        resolveGitHubCredential(fixture.operator, {
          ...admission,
          phase: "effect",
        }),
      ).rejects.toMatchObject({ code: "github_app_conflict" });
      await expect(
        resolveGitHubCredential(fixture.operator, {
          ...admission,
          repositoryId: "unenrolled",
          phase: "read",
        }),
      ).rejects.toMatchObject({ code: "github_app_conflict" });
      expect(auth).toEqual([]);
      const references = await fixture.operator.secretsProviders({
        workspaceId: "alpha",
      });
      expect(
        references.find((reference) => reference.id === "grant-a"),
      ).toMatchObject({ available: true, writable: false });
      const saved = await fixture.operator.secretsConnectionSave({
        workspaceId: "alpha",
        connectionId: "actions",
        revision: 0,
        connection: {
          name: "Actions",
          providerKind: "github-actions",
          providerRef: mode === "app" ? "grant-a" : "manual-actions",
          resourceIds: [scope.repositoryId],
          enabled: true,
        },
      });
      expect(saved.available).toBe(true);
      const scopes = await fixture.operator.secretsScopes({
        workspaceId: "alpha",
        connectionId: "actions",
        resourceId: scope.repositoryId,
        page: 1,
      });
      expect(scopes.items[0].label).toBe("production");
      for (const scopeKind of [
        "repository",
        "environment",
        "organization",
      ] as const) {
        for (const entryKind of ["secret", "variable"] as const) {
          const inventory = await fixture.operator.secretsInventory({
            workspaceId: "alpha",
            connectionId: "actions",
            target: {
              resourceId: scope.repositoryId,
              scope:
                scopeKind === "repository"
                  ? { kind: scopeKind }
                  : {
                      kind: scopeKind,
                      name:
                        scopeKind === "environment" ? "production" : "example",
                    },
            },
            entryKind,
            page: 1,
          });
          expect(inventory.items[0].name).toBe("EXAMPLE");
        }
      }
      expect(auth.length).toBeGreaterThan(0);
      expect(
        auth.every((value) =>
          mode === "app"
            ? value.startsWith("Bearer synthetic-installation-token-")
            : value === "Bearer synthetic-manual-actions",
        ),
      ).toBe(true);
    });
  },
);

it("lists an authorized maintenance App in the existing writer selector and coverage view", async () => {
  fixture = await createGitHubAppFixture();
  const app = appProviderFixture(fixture);
  vi.mocked(fetch).mockImplementation(app);
  const scope = await activateGitHubAppFixture(fixture, "alpha", "grant-a", {
    capabilities: ["collection", "repository-maintenance"],
  });
  const access = await fixture.operator.dependencyWriteAccess({
    workspaceId: "alpha",
    repositoryId: scope.repositoryId,
  });
  expect(
    access.credentials.find((credential) => credential.id === "grant-a"),
  ).toMatchObject({
    kind: "app",
    status: "available",
    writable: true,
    expiresAt: null,
  });
  const coverage = await fixture.operator.repositoryCredentialCoverage({
    workspaceId: "alpha",
    repositoryIds: [scope.repositoryId],
  });
  expect(coverage.rows[0].maintenance.configuredForWrites).toBe(1);
});
