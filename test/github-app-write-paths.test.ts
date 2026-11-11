import { countD1Statements } from "./helpers/d1-count";
import { D1_VOLUME_TEST_TIMEOUT_MS } from "./helpers/timeouts";
import { DependencyGitHub } from "../worker/dependency-github";
import { SecretReviews } from "../worker/secret-reviews";
import { invalidateGitHubAppAuthority } from "../worker/github-app-authority";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { githubAppPermissions } from "../shared/github-apps";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appInstallationFixture,
  appRepositoryFixture,
} from "./helpers/github-app-active-fixture";
import {
  dependencyProviderFixture,
  DEPENDENCY_PROVIDER,
} from "./fixtures/dependency-provider";
import {
  dependabotProviderFixture,
  DEPENDABOT_PROVIDER,
} from "./fixtures/dependabot-provider";
import { ProviderCredentials } from "../worker/provider-credentials";
import type { DependencyChangeReview } from "../shared/dependency-changes";
import type { DependabotChangeReview } from "../shared/dependabot-changes";
const CAPABILITIES = [
  "collection",
  "repository-maintenance",
  "configuration-read",
  "configuration-write",
] as const;
const NEW_TREE = "c".repeat(40);
const NEW_COMMIT = "d".repeat(40);
let fixture: GitHubAppFixture;
let repositoryId: string;
let kind: "dependencies" | "dependabot";
let writes: { phase: string; token: string }[];
let events: string[];
let revokeAfter: string | null;
let interruptAfter: string | null;
let tokenLifetimeMs: number;
let minted: number;
let rejectedAuthentication: number;
let authenticationAttempts: string[];
let permissions: ReturnType<typeof githubAppPermissions>;
let provider: Awaited<ReturnType<typeof dependencyProviderFixture>>;
let scheduleProvider: Awaited<ReturnType<typeof dependabotProviderFixture>>;
function interceptFinalReceipt(
  database: D1Database,
  invalidate: () => Promise<void>,
  matches = (sql: string, values: unknown[]) =>
    sql.startsWith("UPDATE operations SET status=") &&
    values[0] === "succeeded",
) {
  const originals = new WeakMap<
    D1PreparedStatement,
    { original: D1PreparedStatement; final: boolean }
  >();
  let injected = false;
  const inject = async (final: boolean) => {
    if (final && !injected) {
      injected = true;
      await invalidate();
    }
  };
  function wrap(
    original: D1PreparedStatement,
    sql: string,
    final = false,
  ): D1PreparedStatement {
    const proxy = new Proxy(original, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) =>
            wrap(target.bind(...values), sql, matches(sql, values));
        const value = Reflect.get(target, key, target);
        if (key === "run")
          return async () => {
            await inject(final);
            return target.run();
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, { original, final });
    return proxy;
  }
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await inject(
            statements.some((statement) => originals.get(statement)?.final),
          );
          return target.batch(
            statements.map(
              (statement) => originals.get(statement)?.original ?? statement,
            ),
          );
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  writes = [];
  events = [];
  revokeAfter = null;
  interruptAfter = null;
  tokenLifetimeMs = 3600000;
  minted = 0;
  rejectedAuthentication = 0;
  authenticationAttempts = [];
  kind = "dependencies";
  permissions = githubAppPermissions([...CAPABILITIES]);
  provider = await dependencyProviderFixture();
  scheduleProvider = await dependabotProviderFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    events.push(url.pathname);
    if (url.pathname === "/app/installations/91")
      return Response.json({ ...appInstallationFixture, permissions });
    if (url.pathname.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        token: "synthetic-app-write-token-" + ++minted,
        expires_at: new Date(fixture.clock.now + tokenLifetimeMs).toISOString(),
        permissions: body.permissions,
        repositories: [appRepositoryFixture],
      });
    }
    const path = url.pathname.slice("/repos/example/project".length);
    if (init?.method === "POST") {
      authenticationAttempts.push(
        new Headers(init.headers).get("Authorization") ?? "",
      );
      if (rejectedAuthentication-- > 0)
        return Response.json(
          {},
          { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
        );
      const body = JSON.parse(String(init.body));
      const phase =
        path === "/git/trees"
          ? "tree"
          : path === "/git/commits"
            ? "commit"
            : path === "/git/refs"
              ? "branch"
              : "pull_request";
      const stored = await fixture.runtime.HQ_DB.prepare(
        "SELECT result_json FROM operations WHERE workspace_id='alpha' AND status='running'",
      ).first<{ result_json: string }>();
      expect(JSON.parse(stored!.result_json).phase).toBe(phase);
      writes.push({
        phase,
        token: new Headers(init.headers).get("Authorization") ?? "",
      });
      if (revokeAfter === phase)
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE github_app_grants SET state='revoked',revision=revision+1 WHERE id='grant-a'",
        ).run();
      if (interruptAfter === phase)
        throw new Error("Synthetic provider interruption after submission");
      if (phase === "tree")
        return Response.json({ sha: NEW_TREE }, { status: 201 });
      if (phase === "commit")
        return Response.json(
          {
            sha: NEW_COMMIT,
            tree: { sha: body.tree },
            parents: body.parents.map((sha: string) => ({ sha })),
          },
          { status: 201 },
        );
      if (phase === "branch")
        return Response.json(
          { ref: body.ref, object: { type: "commit", sha: body.sha } },
          { status: 201 },
        );
      return Response.json(
        {
          number: 17,
          state: "open",
          merged: false,
          body: body.body,
          head: {
            ref: body.head,
            sha: NEW_COMMIT,
            repo: { full_name: "example/project" },
          },
          base: { ref: body.base, repo: { full_name: "example/project" } },
        },
        { status: 201 },
      );
    }
    if (path === "/git/ref/heads/main")
      return Response.json({
        ref: "refs/heads/main",
        object: { type: "commit", sha: "a".repeat(40) },
      });
    const name =
      kind === "dependencies"
        ? DEPENDENCY_PROVIDER.repository
        : DEPENDABOT_PROVIDER.repository;
    const adapter = kind === "dependencies" ? provider : scheduleProvider;
    const response = adapter.response(
      new URL(String(url).replace("example/project", name)),
    );
    return new Response(
      (await response.text()).replaceAll(name, "example/project"),
      { status: response.status, headers: response.headers },
    );
  });
  const scope = await activateGitHubAppFixture(fixture, "alpha", "grant-a", {
    capabilities: [...CAPABILITIES],
    permissions,
  });
  repositoryId = scope.repositoryId;
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
  "reviewed repository writes with %s credentials",
  (mode) => {
    beforeEach(async () => {
      if (mode === "token")
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE connections SET credential_ref='legacy',revision=2 WHERE workspace_id='alpha' AND id='github'",
        ).run();
      const review = await fixture.operator.providerCredentialPlan({
        workspaceId: "alpha",
        credentialId: "managed-writer",
        revision: 0,
        change: {
          kind: "save",
          replaceToken: true,
          settings: {
            name: "Manual writer",
            providerKind: "github-repositories",
            writable: true,
            expiresAt: new Date(fixture.clock.now + 3600000).toISOString(),
            scope: { repositoryNames: ["example/project"] },
          },
        },
      });
      await new ProviderCredentials(fixture.operator).upload(
        new Request("https://hq.example/api/provider-credentials/input", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "If-Match": review.fingerprint,
          },
          body: JSON.stringify({
            version: 1,
            token: "synthetic-manual-writer",
          }),
        }),
        { workspaceId: "alpha", planId: review.id },
      );
    });
    const writer = () => (mode === "app" ? "grant-a" : "managed-writer");
    async function plan(selected: "dependencies" | "dependabot") {
      kind = selected;
      if (selected === "dependencies") {
        const result = await fixture.operator.repositoryDependencies({
          ...scope(),
          refresh: true,
        });
        const evidence = result.evidence!;
        return fixture.operator.dependencyChangePlan({
          ...scope(),
          credentialId: writer(),
          headSha: evidence.headSha,
          policyDigest: evidence.report!.policyDigest,
          overrideId: "decoder-advisory",
          change: {
            kind: "renew",
            owner: "Project maintainers",
            reason: "The older runner still requires the patched decoder",
            reviewDays: 14,
          },
        });
      }
      const result = await fixture.operator.repositoryDependabot({
        ...scope(),
        refresh: true,
      });
      const evidence = result.evidence!;
      return fixture.operator.dependabotChangePlan({
        ...scope(),
        credentialId: writer(),
        headSha: evidence.headSha,
        fileDigest: evidence.file!.digest,
        edits: [
          {
            entryId: evidence.entries[0].id,
            schedule: { interval: "weekly", day: "tuesday", time: "09:30" },
          },
        ],
      });
    }
    const apply = (review: DependencyChangeReview | DependabotChangeReview) => {
      const input = {
        workspaceId: "alpha",
        planId: review.planId,
        fingerprint: review.fingerprint,
      };
      return kind === "dependencies"
        ? fixture.operator.dependencyChangeApply(input)
        : fixture.operator.dependabotChangeApply(input);
    };
    it.each(["dependencies", "dependabot"] as const)(
      "submits the reviewed %s PR through the selected credential",
      async (selected) => {
        const measured = countD1Statements(fixture.runtime.HQ_DB);
        const originalOperator = fixture.operator;
        fixture.operator = new Proxy(originalOperator, {
          get(target, key) {
            return key === "db"
              ? measured.db
              : Reflect.get(target, key, target);
          },
        });
        events = [];
        const review = await plan(selected);
        if (mode === "app")
          console.info("APP_RESOURCE_PR_REVIEW", selected, {
            calls: measured.calls(),
            statements: measured.count(),
            provider: events.length,
          });
        measured.reset();
        events = [];
        const operation = await apply(review);
        if (mode === "app") {
          console.info("APP_RESOURCE_PR_EFFECT", selected, {
            calls: measured.calls(),
            statements: measured.count(),
            provider: events.length,
            mints: events.filter((path) => path.endsWith("/access_tokens"))
              .length,
          });
          expect(measured.calls()).toBeLessThan(1000);
          expect(events.length).toBeLessThanOrEqual(50);
        }
        expect(operation).toMatchObject({
          status: "succeeded",
          phase: "finished",
          pullRequest: { number: 17 },
        });
        expect(writes.map((write) => write.phase)).toEqual([
          "tree",
          "commit",
          "branch",
          "pull_request",
        ]);
        expect(
          writes.every((write) =>
            mode === "app"
              ? write.token.startsWith("Bearer synthetic-app-write-token-")
              : write.token === "Bearer synthetic-manual-writer",
          ),
        ).toBe(true);
        if (mode === "app")
          expect(
            events.filter((path) => path === "/app/installations/91").length,
          ).toBeGreaterThanOrEqual(writes.length);
        expect(await apply(review)).toMatchObject({ id: operation!.id });
        expect(writes).toHaveLength(4);
        expect(JSON.stringify(operation)).not.toContain(
          "synthetic-app-write-token",
        );
      },
    );
    if (mode === "app")
      it("records an operation rate limit for another workspace sharing the installation", async () => {
        const beta = await activateGitHubAppFixture(
          fixture,
          "beta",
          "grant-b",
          { capabilities: [...CAPABILITIES], permissions },
        );
        const review = await plan("dependencies");
        const original = vi.mocked(fetch).getMockImplementation()!;
        let rejected = 0;
        vi.mocked(fetch).mockImplementation(async (input, init) => {
          if (
            new URL(String(input)).pathname.endsWith("/git/trees") &&
            init?.method === "POST"
          ) {
            rejected++;
            return Response.json(
              {},
              { status: 429, headers: { "Retry-After": "3600" } },
            );
          }
          return original(input, init);
        });
        await apply(review);
        expect(rejected).toBe(1);
        expect(
          await fixture.runtime.HQ_DB.prepare(
            "SELECT count(*) AS total FROM github_cooldowns",
          ).first<number>("total"),
        ).toBe(1);
        const { dependencyCredential } =
          await import("../worker/dependency-credentials");
        const before = events.length;
        await expect(
          dependencyCredential(
            fixture.as({ subject: "other", displayName: "Other" }),
            "beta",
            "grant-b",
            beta.repositoryFullName,
            true,
            {
              repositoryId: beta.repositoryId,
              sourceId: beta.connectionId,
              sourceRevision: beta.connectionRevision,
              membershipRevision: 1,
              phase: "read",
            },
          ),
        ).rejects.toMatchObject({ code: "github_app_rate_limited" });
        expect(events.length).toBe(before);
      });
    it("preserves the review and operation identity across routine credential renewal", async () => {
      tokenLifetimeMs = 90000;
      const review = await plan("dependencies");
      const before = minted;
      fixture.clock.now += 91000;
      if (mode === "app")
        await fixture.runtime.HQ_DB.prepare(
          "UPDATE github_app_authority SET valid_until='2020-01-01T00:00:00.000Z'",
        ).run();
      const operation = await apply(review);
      expect(operation?.status).toBe("succeeded");
      if (mode === "app") expect(minted).toBeGreaterThan(before);
      expect(await apply(review)).toMatchObject({
        id: operation!.id,
        planId: review.planId,
      });
    });
    it("never replays an indeterminate effect after token renewal", async () => {
      const review = await plan("dependencies");
      interruptAfter = "tree";
      const first = await apply(review);
      expect(first?.status).toBe("indeterminate");
      fixture.clock.now += 91000;
      expect(await apply(review)).toMatchObject({
        id: first!.id,
        status: "indeterminate",
      });
      expect(writes).toHaveLength(1);
    }, D1_VOLUME_TEST_TIMEOUT_MS);
    if (mode === "app") {
      it("remints once after an explicit unapplied authentication rejection", async () => {
        const review = await plan("dependencies");
        rejectedAuthentication = 1;
        const result = await apply(review);
        expect(result?.status).toBe("succeeded");
        expect(authenticationAttempts).toHaveLength(5);
        expect(authenticationAttempts[0]).not.toBe(authenticationAttempts[1]);
        expect(writes).toHaveLength(4);
      });
      it("bounds repeated authentication rejection without creating Git objects", async () => {
        const review = await plan("dependencies");
        rejectedAuthentication = 3;
        const result = await apply(review);
        expect(result?.reason).toBe("provider_rejected");
        expect(authenticationAttempts).toHaveLength(2);
        expect(writes).toEqual([]);
      });
      it("rejects successful receipt acceptance when authority changes immediately before its D1 write", async () => {
        const review = await plan("dependencies");
        const database = fixture.runtime.HQ_DB;
        fixture.runtime.HQ_DB = interceptFinalReceipt(database, async () => {
          await database
            .prepare(
              "UPDATE github_app_grants SET state='revoked',revision=revision+1 WHERE id='grant-a'",
            )
            .run();
        });
        fixture.operator = fixture.as();
        const result = await apply(review);
        expect(result).toMatchObject({
          status: "partial",
          reason: "access_changed",
          pullRequest: { number: 17 },
        });
        expect(writes).toHaveLength(4);
        expect(await apply(review)).toMatchObject({
          id: result!.id,
          status: "partial",
        });
      });
      it.each(["tree", "commit", "branch"] as const)(
        "stops before the next effect after revocation during %s",
        async (phase) => {
          const review = await plan("dependencies");
          revokeAfter = phase;
          const operation = await apply(review);
          expect(operation?.status).toBe("partial");
          expect(operation?.reason).toBe("access_changed");
          expect(writes.map((write) => write.phase)).toEqual(
            ["tree", "commit", "branch"].slice(
              0,
              ["tree", "commit", "branch"].indexOf(phase) + 1,
            ),
          );
          expect(await apply(review)).toMatchObject({ id: operation!.id });
        },
      );
      it("refuses a missing PR permission without escalating the App profile", async () => {
        permissions = { ...permissions, pull_requests: "read" };
        await expect(plan("dependencies")).rejects.toMatchObject({
          code: "github_app_permission_missing",
        });
        expect(writes).toEqual([]);
      });
    }
  },
);

describe.each(["token", "app"] as const)(
  "reviewed configuration writes with %s credentials",
  (mode) => {
    let effects: { method: string; path: string; token: string }[];
    let variable: string | null;
    let secretNames: Set<string>;
    let invalidateDuringWrite: boolean;
    let writeStatus: number;
    let withdrawWritePermission: boolean;
    let configurationAttempts: string[];
    let configurationAuthRejections: number;
    const destination = (environment = false) => ({
      connectionId: "actions",
      connectionRevision: 1,
      target: {
        resourceId: repositoryId,
        scope: environment
          ? { kind: "environment" as const, name: "production" }
          : { kind: "repository" as const },
      },
      name: "DEPLOY_TOKEN",
    });
    beforeEach(async () => {
      effects = [];
      variable = "us-central1";
      secretNames = new Set([
        "/actions/secrets/DEPLOY_TOKEN",
        "/environments/production/secrets/DEPLOY_TOKEN",
      ]);
      invalidateDuringWrite = false;
      writeStatus = 204;
      withdrawWritePermission = false;
      configurationAttempts = [];
      configurationAuthRejections = 0;
      fixture.runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
        "manual-actions": {
          workspaceId: "alpha",
          name: "Manual Actions",
          revision: 1,
          token: "synthetic-manual-actions",
          expiresAt: new Date(fixture.clock.now + 3600000).toISOString(),
          repositoryNames: ["example/project"],
          writable: true,
        },
      });
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/app/installations/91")
          return Response.json({
            ...appInstallationFixture,
            permissions: withdrawWritePermission
              ? {
                  ...permissions,
                  secrets: "read",
                  variables: "read",
                  environments: "read",
                }
              : permissions,
          });
        if (url.pathname.endsWith("/access_tokens")) {
          const body = JSON.parse(String(init?.body));
          return Response.json({
            token: "synthetic-app-write-token-" + ++minted,
            expires_at: new Date(
              fixture.clock.now + tokenLifetimeMs,
            ).toISOString(),
            permissions: body.permissions,
            repositories: [appRepositoryFixture],
          });
        }
        const path = url.pathname.slice("/repos/example/project".length);
        const method = init?.method ?? "GET";
        const metadata = {
          created_at: new Date(fixture.clock.now - 10000).toISOString(),
          updated_at: new Date(fixture.clock.now).toISOString(),
        };
        if (method !== "GET") {
          configurationAttempts.push(
            new Headers(init?.headers).get("Authorization") ?? "",
          );
          if (configurationAuthRejections-- > 0)
            return Response.json(
              {},
              { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
            );
          effects.push({
            method,
            path,
            token: new Headers(init?.headers).get("Authorization") ?? "",
          });
          if (path.includes("/variables")) {
            if (method === "DELETE") variable = null;
            else variable = JSON.parse(String(init?.body)).value;
          }
          if (path.includes("/secrets")) {
            if (method === "DELETE") secretNames.delete(path);
            else secretNames.add(path);
          }
          if (invalidateDuringWrite)
            await invalidateGitHubAppAuthority(fixture.operator, "app-a");
          return new Response(null, {
            status:
              method === "POST" && writeStatus === 204 ? 201 : writeStatus,
          });
        }
        if (!path)
          return Response.json({
            ...appRepositoryFixture,
            archived: false,
            disabled: false,
            owner: { id: 50, login: "example", type: "Organization" },
          });
        if (path === "/environments/production")
          return Response.json({ id: 8, name: "production" });
        if (path.endsWith("/public-key"))
          return Response.json({ key_id: "key", key: "A".repeat(43) + "=" });
        if (path.endsWith("/secrets/DEPLOY_TOKEN"))
          return secretNames.has(path)
            ? Response.json({ name: "DEPLOY_TOKEN", ...metadata })
            : Response.json({}, { status: 404 });
        if (path.endsWith("/variables/DEPLOY_REGION"))
          return variable === null
            ? Response.json({}, { status: 404 })
            : Response.json({
                name: "DEPLOY_REGION",
                value: variable,
                ...metadata,
              });
        if (path.endsWith("/variables"))
          return Response.json({
            total_count: variable === null ? 0 : 1,
            variables:
              variable === null
                ? []
                : [{ name: "DEPLOY_REGION", value: variable, ...metadata }],
          });
        if (path.endsWith("/secrets"))
          return Response.json({
            total_count: secretNames.has(path + "/DEPLOY_TOKEN") ? 1 : 0,
            secrets: secretNames.has(path + "/DEPLOY_TOKEN")
              ? [{ name: "DEPLOY_TOKEN", ...metadata }]
              : [],
          });
        return Response.json({}, { status: 404 });
      });
      await fixture.operator.secretsConnectionSave({
        workspaceId: "alpha",
        connectionId: "actions",
        revision: 0,
        connection: {
          name: "Actions",
          providerKind: "github-actions",
          providerRef: mode === "app" ? "grant-a" : "manual-actions",
          resourceIds: [repositoryId],
          enabled: true,
        },
      });
    });
    async function prepare(environment = false, source = false) {
      const review = await fixture.operator.secretsDraft({
        workspaceId: "alpha",
        reviewId: "distribution",
        destinations: [destination(environment)],
        source: source ? destination() : null,
      });
      const finalized = await new SecretReviews(fixture.operator).upload(
        new Request("https://hq.example/api/secrets/input", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "If-Match": review.draftFingerprint,
          },
          body: JSON.stringify({
            version: 1,
            items: [{ destinationIndex: 0, ciphertext: btoa("u".repeat(80)) }],
          }),
        }),
        { workspaceId: "alpha", reviewId: review.id },
      );
      return {
        workspaceId: "alpha",
        reviewId: review.id,
        fingerprint: finalized.fingerprint!,
      };
    }
    async function managedPlan(environment = false) {
      await fixture.operator.secretsConfigurationSave({
        workspaceId: "alpha",
        configurationId: "region",
        revision: 0,
        requestId: "region-save",
        configuration: {
          label: "Region",
          entryKind: "variable",
          custody: "none",
          desiredValue: "eu-west-1",
          destinations: [
            {
              destination: {
                ...destination(environment),
                name: "DEPLOY_REGION",
              },
              desiredState: "present",
            },
          ],
        },
      });
      return fixture.operator.secretsConfigurationPlan({
        workspaceId: "alpha",
        configurationId: "region",
        configurationRevision: 1,
        destinationIndex: 0,
        planId: "variable-review",
      });
    }
    it.each([false, true])(
      "writes a supplied sealed secret in an environment=%s scope once",
      async (environment) => {
        const input = await prepare(environment);
        await fixture.operator.secretsApply(input);
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0].writeStatus).toBe("accepted");
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        expect(effects).toHaveLength(1);
        expect(effects[0].token).toMatch(
          mode === "app"
            ? /^Bearer synthetic-app-write-token-/
            : /^Bearer synthetic-manual-actions$/,
        );
      },
      D1_VOLUME_TEST_TIMEOUT_MS,
    );
    it.each([false, true])(
      "applies a reviewed managed variable in an environment=%s scope",
      async (environment) => {
        const review = await managedPlan(environment);
        const input = {
          workspaceId: "alpha",
          planId: review.id,
          fingerprint: review.fingerprint,
        };
        const result = await fixture.operator.secretsConfigurationApply(input);
        expect(result.operation).toMatchObject({
          status: "succeeded",
          receipt: { writeStatus: "accepted" },
        });
        expect(variable).toBe("eu-west-1");
        await fixture.operator.secretsConfigurationApply(input);
        expect(effects).toHaveLength(1);
      },
    );
    it("keeps separately reviewed cleanup idempotent after a confirmed distribution", async () => {
      const input = await prepare(true, true);
      await fixture.operator.secretsApply(input);
      await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
      const review = await fixture.operator.secretsCleanupPlan({
        ...input,
        cleanupId: "cleanup",
        acknowledgeNonAtomicMove: true,
      });
      const apply = {
        workspaceId: "alpha",
        cleanupId: review.id,
        fingerprint: review.fingerprint,
      };
      const result = await fixture.operator.secretsCleanupApply(apply);
      expect(result.receipt).toMatchObject({
        phase: "finished",
        writeStatus: "accepted",
        observationStatus: "absent",
      });
      await fixture.operator.secretsCleanupApply(apply);
      expect(effects.map((effect) => effect.method)).toEqual(["PUT", "DELETE"]);
    });
    it("requires an explicit recovery review after an indeterminate supplied-secret write", async () => {
      const input = await prepare();
      await fixture.operator.secretsApply(input);
      writeStatus = 500;
      const initial = await fixture.operator.secretsRun({
        ...input,
        destinationIndex: 0,
      });
      expect(initial.operation?.receipts[0].writeStatus).toBe("indeterminate");
      writeStatus = 204;
      const recovery = await fixture.operator.secretsRecoveryPlan({
        ...input,
        destinationIndex: 0,
        newReviewId: "recovery",
        acknowledgePossibleOverwrite: true,
      });
      const next = {
        workspaceId: "alpha",
        reviewId: recovery.id,
        fingerprint: recovery.fingerprint!,
      };
      await fixture.operator.secretsApply(next);
      const result = await fixture.operator.secretsRun({
        ...next,
        destinationIndex: 0,
      });
      expect(result.operation?.receipts[0].writeStatus).toBe("accepted");
      expect(
        (
          await fixture.operator.secretsReview({
            workspaceId: "alpha",
            reviewId: input.reviewId,
          })
        ).operation?.receipts[0].writeStatus,
      ).toBe("indeterminate");
      expect(effects).toHaveLength(2);
    });
    it("rejects a connection credential switch after review", async () => {
      const input = await prepare();
      await fixture.runtime.HQ_DB.prepare(
        "UPDATE secret_connections SET credential_ref=?,revision=revision+1 WHERE workspace_id='alpha' AND id='actions'",
      )
        .bind(mode === "app" ? "manual-actions" : "grant-a")
        .run();
      await expect(fixture.operator.secretsApply(input)).rejects.toMatchObject({
        code: "secret_review_conflict",
      });
      expect(effects).toEqual([]);
    });
    if (mode === "app") {
      it("renews a rejected configuration credential once without replaying an accepted write", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        configurationAuthRejections = 1;
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0].writeStatus).toBe("accepted");
        expect(configurationAttempts).toHaveLength(2);
        expect(configurationAttempts[0]).not.toBe(configurationAttempts[1]);
        expect(effects).toHaveLength(1);
      });
      it("bounds repeated configuration authentication rejection", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        configurationAuthRejections = 3;
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0].writeStatus).toBe("rejected");
        expect(configurationAttempts).toHaveLength(2);
        expect(effects).toEqual([]);
      });
      it("records a known unsent supplied-secret request when fresh write authority is refused", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        withdrawWritePermission = true;
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0]).toMatchObject({
          phase: "finished",
          writeStatus: "not-sent",
          reason: "authority_changed",
        });
        expect(effects).toEqual([]);
      });
      it("records a known unsent managed-variable request when fresh write authority is refused", async () => {
        const review = await managedPlan();
        withdrawWritePermission = true;
        const result = await fixture.operator.secretsConfigurationApply({
          workspaceId: "alpha",
          planId: review.id,
          fingerprint: review.fingerprint,
        });
        expect(result.operation).toMatchObject({
          status: "failed",
          receipt: { writeStatus: "not-sent", reason: "authority_changed" },
        });
        expect(effects).toEqual([]);
      });
      it("preserves provider acceptance and flags a supplied-secret authority change at receipt recording", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        const database = fixture.runtime.HQ_DB;
        fixture.runtime.HQ_DB = interceptFinalReceipt(
          database,
          async () => {
            await invalidateGitHubAppAuthority(
              {
                env: fixture.runtime,
                db: database,
                now: () => fixture.clock.now,
              },
              "app-a",
            );
          },
          (sql, values) =>
            sql.startsWith("UPDATE secret_receipts SET phase='finished'") &&
            values[0] === "accepted",
        );
        fixture.operator = fixture.as();
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0]).toMatchObject({
          writeStatus: "accepted",
          reason: "authority_changed",
          observationStatus: "unavailable",
        });
        expect(effects).toHaveLength(1);
      });
      it("preserves provider acceptance and flags a managed-variable authority change at receipt recording", async () => {
        const review = await managedPlan();
        const database = fixture.runtime.HQ_DB;
        fixture.runtime.HQ_DB = interceptFinalReceipt(database, async () => {
          await invalidateGitHubAppAuthority(
            {
              env: fixture.runtime,
              db: database,
              now: () => fixture.clock.now,
            },
            "app-a",
          );
        });
        fixture.operator = fixture.as();
        const result = await fixture.operator.secretsConfigurationApply({
          workspaceId: "alpha",
          planId: review.id,
          fingerprint: review.fingerprint,
        });
        expect(result.operation).toMatchObject({
          status: "partial",
          receipt: { writeStatus: "accepted", reason: "authority_changed" },
        });
        expect(effects).toHaveLength(1);
      });
      it("preserves a confirmed acknowledgement when App authority changes during the request", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        invalidateDuringWrite = true;
        const result = await fixture.operator.secretsRun({
          ...input,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0]).toMatchObject({
          writeStatus: "accepted",
          reason: "authority_changed",
          observationStatus: "unknown",
        });
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        expect(effects).toHaveLength(1);
      });
      it("reconciles an uncertain secret through current read authority without restoring the old write review", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        writeStatus = 500;
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        const result = await fixture.operator.secretsReconcile({
          workspaceId: "alpha",
          reviewId: input.reviewId,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0]).toMatchObject({
          writeStatus: "indeterminate",
          observationStatus: "present",
        });
        expect(effects).toHaveLength(1);
      });
      it("refuses fresh metadata acceptance if read authority changes at persistence", async () => {
        const input = await prepare();
        await fixture.operator.secretsApply(input);
        writeStatus = 500;
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        const database = fixture.runtime.HQ_DB;
        fixture.runtime.HQ_DB = interceptFinalReceipt(
          database,
          () =>
            invalidateGitHubAppAuthority(
              {
                env: fixture.runtime,
                db: database,
                now: () => fixture.clock.now,
              },
              "app-a",
            ),
          (sql, values) =>
            sql.startsWith("UPDATE secret_receipts SET observation_status") &&
            values[0] === "present",
        );
        fixture.operator = fixture.as();
        const result = await fixture.operator.secretsReconcile({
          workspaceId: "alpha",
          reviewId: input.reviewId,
          destinationIndex: 0,
        });
        expect(result.operation?.receipts[0]).toMatchObject({
          writeStatus: "indeterminate",
          observationStatus: "unavailable",
        });
        expect(effects).toHaveLength(1);
      });
      it("reconciles managed-variable state using new read authority while preserving uncertain write acceptance", async () => {
        const review = await managedPlan();
        writeStatus = 500;
        await fixture.operator.secretsConfigurationApply({
          workspaceId: "alpha",
          planId: review.id,
          fingerprint: review.fingerprint,
        });
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        const result = await fixture.operator.secretsConfigurationReconcile({
          workspaceId: "alpha",
          planId: review.id,
        });
        expect(result.operation).toMatchObject({
          status: "succeeded",
          receipt: {
            writeStatus: "indeterminate",
            observationStatus: "in-sync",
          },
        });
        expect(effects).toHaveLength(1);
      });
      it("preserves acknowledged cleanup after authority changes during deletion", async () => {
        const input = await prepare(true, true);
        await fixture.operator.secretsApply(input);
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        const review = await fixture.operator.secretsCleanupPlan({
          ...input,
          cleanupId: "cleanup",
          acknowledgeNonAtomicMove: true,
        });
        invalidateDuringWrite = true;
        const result = await fixture.operator.secretsCleanupApply({
          workspaceId: "alpha",
          cleanupId: review.id,
          fingerprint: review.fingerprint,
        });
        expect(result.receipt).toMatchObject({
          writeStatus: "accepted",
          reason: "authority_changed",
          observationStatus: "unknown",
        });
        expect(
          secretNames.has("/environments/production/secrets/DEPLOY_TOKEN"),
        ).toBe(true);
        expect(effects.map((effect) => effect.method)).toEqual([
          "PUT",
          "DELETE",
        ]);
      });
      it("reconciles uncertain cleanup using current read authority without replaying deletion", async () => {
        const input = await prepare(true, true);
        await fixture.operator.secretsApply(input);
        await fixture.operator.secretsRun({ ...input, destinationIndex: 0 });
        const review = await fixture.operator.secretsCleanupPlan({
          ...input,
          cleanupId: "cleanup",
          acknowledgeNonAtomicMove: true,
        });
        writeStatus = 500;
        await fixture.operator.secretsCleanupApply({
          workspaceId: "alpha",
          cleanupId: review.id,
          fingerprint: review.fingerprint,
        });
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        const result = await fixture.operator.secretsCleanupReconcile({
          workspaceId: "alpha",
          cleanupId: review.id,
        });
        expect(result.receipt).toMatchObject({
          writeStatus: "indeterminate",
          observationStatus: "absent",
        });
        expect(effects.map((effect) => effect.method)).toEqual([
          "PUT",
          "DELETE",
        ]);
      });
      it("requires a fresh supplied-secret review after authority generation invalidation", async () => {
        const input = await prepare();
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        await expect(
          fixture.operator.secretsApply(input),
        ).rejects.toMatchObject({ code: "secret_review_conflict" });
        expect(effects).toEqual([]);
      });
      it("requires a fresh managed-variable review after authority generation invalidation", async () => {
        const review = await managedPlan();
        await invalidateGitHubAppAuthority(fixture.operator, "app-a");
        await expect(
          fixture.operator.secretsConfigurationApply({
            workspaceId: "alpha",
            planId: review.id,
            fingerprint: review.fingerprint,
          }),
        ).rejects.toMatchObject({ code: "managed_configuration_conflict" });
        expect(effects).toEqual([]);
      });
    }
  },
);

it("does not dispatch a Git effect when authorization consumes its request deadline", async () => {
  let clock = fixture.clock.now;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ sha: NEW_TREE }, { status: 201 }),
  );
  const client = new DependencyGitHub(
    "example/project",
    "synthetic-initial-private",
    request,
    1000,
    Infinity,
    async () => {
      clock += 1001;
      return { token: "synthetic-current-private", assertLive: async () => {} };
    },
  );
  await expect(client.tree("a".repeat(40), [])).rejects.toMatchObject({
    reason: "provider_unavailable",
  });
  expect(request).not.toHaveBeenCalled();
});
it("does not serialize the Git client's private credential", () => {
  const client = new DependencyGitHub(
    "example/project",
    "synthetic-initial-private",
  );
  expect(JSON.stringify(client)).not.toContain("synthetic-initial-private");
});
