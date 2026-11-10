import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { reconcileGitHubAppAuthority } from "../worker/github-app-events";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
} from "./helpers/github-app-active-fixture";
beforeAll(migrateGitHubAppFixture);
afterEach(() => vi.restoreAllMocks());
it("advances failed reconciliation scopes at the actual cron cadence", async () => {
  const fixture = await createGitHubAppFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(appProviderFixture(fixture));
  await activateGitHubAppFixture(fixture);
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    id: 101 + index,
    fullName: "example/project" + (index || ""),
    ownerId: 50,
    private: true,
  }));
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_grants SET metadata_json=json_set(metadata_json,'$.repositories',json(?)) WHERE id='grant-a'",
  )
    .bind(JSON.stringify(repositories))
    .run();
  const visited: number[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("/access_tokens")) {
      visited.push(JSON.parse(String(init?.body)).repository_ids[0]);
      return Response.json({}, { status: 500 });
    }
    return appProviderFixture(fixture)(input, init);
  });
  const firstResult = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  const first = [...visited];
  visited.length = 0;
  fixture.clock.now += 61000;
  const secondResult = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  expect(firstResult.checked).toBeGreaterThan(0);
  expect(secondResult.checked).toBeGreaterThan(0);
  expect(visited.some((id) => first.includes(id))).toBe(false);
});
it("closes an explicitly fulfilled request and returns duplicate pending requests without exhausting capacity", async () => {
  const fixture = await createGitHubAppFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(appProviderFixture(fixture));
  const request = await fixture.operator.githubAppConnectionRequest({
    workspaceId: "alpha",
    requestId: "request-0",
    requestedCapabilities: ["collection"],
  });
  await activateGitHubAppFixture(fixture);
  const closed = await fixture.operator.githubAppConnectionRequestFinish({
    workspaceId: "alpha",
    requestId: request.id,
    revision: request.revision,
    action: "resolve",
    grantId: "grant-a",
  });
  expect(closed.state).toBe("resolved");
  expect(
    (
      await fixture.operator.githubAppConnectionRequestsList({
        workspaceId: "alpha",
        scope: "workspace",
      })
    ).requests,
  ).toEqual([]);
  const next = await fixture.operator.githubAppConnectionRequest({
    workspaceId: "alpha",
    requestId: "request-next",
    requestedCapabilities: ["collection", "repository-maintenance"],
  });
  for (let index = 0; index < 25; index++)
    expect(
      (
        await fixture.operator.githubAppConnectionRequest({
          workspaceId: "alpha",
          requestId: "duplicate-" + index,
          requestedCapabilities: ["repository-maintenance", "collection"],
        })
      ).id,
    ).toBe(next.id);
  const cancelled = await fixture.operator.githubAppConnectionRequestFinish({
    workspaceId: "alpha",
    requestId: next.id,
    revision: next.revision,
    action: "cancel",
  });
  expect(cancelled.state).toBe("cancelled");
  expect(
    (
      await fixture.operator.githubAppConnectionRequestsList({
        workspaceId: "alpha",
        scope: "workspace",
        status: "all",
      })
    ).requests.map((item) => item.state),
  ).toEqual(["resolved", "cancelled"]);
});
it("pages pending requests beyond the administrative first page and retires expired admission capacity", async () => {
  const fixture = await createGitHubAppFixture();
  const time = new Date(fixture.clock.now).toISOString();
  const expiry = new Date(fixture.clock.now + 60000).toISOString();
  const statements = Array.from({ length: 105 }, (_, index) =>
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO github_app_connection_requests(id,workspace_id,actor_subject,capabilities_json,created_at,expires_at) VALUES (?,'alpha','owner','[\"collection\"]',?,?)",
    ).bind("pending-" + String(index).padStart(3, "0"), time, expiry),
  );
  await fixture.runtime.HQ_DB.batch(statements);
  const first = await fixture.operator.githubAppConnectionRequestsList({
    workspaceId: "administration",
    scope: "administration",
  });
  expect(first.requests).toHaveLength(100);
  expect(first.nextCursor).not.toBeNull();
  const second = await fixture.operator.githubAppConnectionRequestsList({
    workspaceId: "administration",
    scope: "administration",
    cursor: first.nextCursor,
  });
  expect(second.requests).toHaveLength(5);
  expect(
    second.requests.some((item) =>
      first.requests.some((prior) => prior.id === item.id),
    ),
  ).toBe(false);
  await expect(
    fixture.operator.githubAppConnectionRequest({
      workspaceId: "alpha",
      requestId: "at-capacity",
      requestedCapabilities: ["configuration-read"],
    }),
  ).rejects.toMatchObject({ code: "github_app_request_capacity" });
  fixture.clock.now += 60001;
  expect(
    (
      await fixture.operator.githubAppConnectionRequest({
        workspaceId: "alpha",
        requestId: "after-expiry",
        requestedCapabilities: ["configuration-read"],
      })
    ).state,
  ).toBe("requested");
});

it("App configuration 429 must establish the shared installation cooldown", async () => {
  const { githubCredential } =
    await import("../worker/provider-github-credential");
  const { appRepositoryFixture } =
    await import("./helpers/github-app-active-fixture");
  const fixture = await createGitHubAppFixture();
  const base = appProviderFixture(fixture);
  let configurationCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("/repos/")) {
      configurationCalls++;
      if (configurationCalls === 1)
        return Response.json(
          {},
          { status: 429, headers: { "Retry-After": "3600" } },
        );
      return Response.json({
        ...appRepositoryFixture,
        owner: { id: 50, login: "example", type: "Organization" },
      });
    }
    return base(input, init);
  });
  await activateGitHubAppFixture(fixture, "alpha", "grant-a", {
    capabilities: ["configuration-read"],
  });
  await activateGitHubAppFixture(fixture, "beta", "grant-b", {
    capabilities: ["configuration-read"],
  });
  const first = await githubCredential(fixture.operator, "alpha", "grant-a");
  await expect(
    first.client.repository("example/project"),
  ).rejects.toMatchObject({ code: "secret_rate_limited" });
  const cooldowns = await fixture.runtime.HQ_DB.prepare(
    "SELECT count(*) AS count FROM github_cooldowns",
  ).first<number>("count");
  const second = await githubCredential(
    fixture.as({ subject: "other", displayName: "Other" }),
    "beta",
    "grant-b",
  );
  await expect(
    second.client.repository("example/project"),
  ).rejects.toMatchObject({ code: "github_app_rate_limited" });
  expect(cooldowns).toBe(1);
  expect(configurationCalls).toBe(1);
});
it("refuses local edits that imply changing GitHub installation visibility", async () => {
  const fixture = await createGitHubAppFixture();
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(appProviderFixture(fixture));
  await activateGitHubAppFixture(fixture);
  fetchSpy.mockClear();
  await expect(
    fixture.operator.githubAppRegistrationPlan({
      workspaceId: "administration",
      registrationId: "app-a",
      revision: 1,
      change: {
        kind: "save",
        replaceKey: false,
        fields: {
          name: "Repository operator",
          appId: 42,
          visibility: "private",
          capabilities: ["collection"],
        },
      },
    }),
  ).rejects.toMatchObject({ code: "github_app_visibility_immutable" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("preserves repository A evidence and another workspace cache while first verifying repository B", async () => {
  const { appInstallationFixture, appRepositoryFixture } =
    await import("./helpers/github-app-active-fixture");
  const { resolveGitHubCredential } =
    await import("../worker/github-credential-resolver");
  const fixture = await createGitHubAppFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(appProviderFixture(fixture));
  const first = await activateGitHubAppFixture(fixture);
  await activateGitHubAppFixture(fixture, "beta", "grant-b");
  await resolveGitHubCredential(fixture.operator, first);
  const now = new Date(fixture.clock.now).toISOString();
  const expiry = new Date(fixture.clock.now + 1800000).toISOString();
  for (const workspace of ["alpha", "beta"]) {
    await fixture.runtime.HQ_DB.prepare(
      "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES (?,'github','repository',?,'CI','healthy','Observed','{}',?,?,?)",
    )
      .bind(workspace, "repository-" + workspace, now, now, expiry)
      .run();
    await fixture.runtime.HQ_DB.prepare(
      "INSERT INTO github_work_cache(workspace_id,source_id,repository_id,identity,next_read_at,result_json) VALUES (?,'github',?,'synthetic',?,'{}')",
    )
      .bind(workspace, "repository-" + workspace, now)
      .run();
  }
  const secondRepo = {
    id: 102,
    fullName: "example/second",
    ownerId: 50,
    private: true,
  };
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_grants SET metadata_json=json_set(metadata_json,'$.repositories',json(?)) WHERE id='grant-a'",
  )
    .bind(
      JSON.stringify([
        { id: 101, fullName: "example/project", ownerId: 50, private: true },
        secondRepo,
      ]),
    )
    .run();
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/app/installations/91"))
      return Response.json(appInstallationFixture);
    const body = JSON.parse(String(init?.body));
    return Response.json({
      token: "synthetic-second-token",
      expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
      permissions: body.permissions,
      repositories: [
        { ...appRepositoryFixture, id: 102, full_name: secondRepo.fullName },
      ],
    });
  });
  await resolveGitHubCredential(fixture.operator, {
    ...first,
    actorCapability: "workspace:admin",
    repositoryId: null,
    repositoryFullName: secondRepo.fullName,
  });
  expect(
    (
      await fixture.runtime.HQ_DB.prepare(
        "SELECT expires_at FROM observations",
      ).all()
    ).results.map((row) => row.expires_at),
  ).toEqual([expiry, expiry]);
  expect(
    (
      await fixture.runtime.HQ_DB.prepare(
        "SELECT result_json FROM github_work_cache",
      ).all()
    ).results.map((row) => row.result_json),
  ).toEqual(["{}", "{}"]);
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_authority SET generation=generation+1,state='unknown',invalidated_at=? WHERE repository_id=102",
  )
    .bind(now)
    .run();
  expect(
    (
      await fixture.runtime.HQ_DB.prepare(
        "SELECT expires_at FROM observations",
      ).all()
    ).results.map((row) => row.expires_at),
  ).toEqual([expiry, expiry]);
});

it("requires a matching live grant and workspace ownership to close a request", async () => {
  const fixture = await createGitHubAppFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(appProviderFixture(fixture));
  await activateGitHubAppFixture(fixture);
  const request = await fixture.operator.githubAppConnectionRequest({
    workspaceId: "alpha",
    requestId: "unfulfilled",
    requestedCapabilities: ["repository-maintenance"],
  });
  await expect(
    fixture.operator.githubAppConnectionRequestFinish({
      workspaceId: "alpha",
      requestId: request.id,
      revision: request.revision,
      action: "resolve",
      grantId: "grant-a",
    }),
  ).rejects.toMatchObject({ code: "github_app_conflict" });
  await expect(
    fixture
      .as({ subject: "other", displayName: "Other" })
      .githubAppConnectionRequestFinish({
        workspaceId: "alpha",
        requestId: request.id,
        revision: request.revision,
        action: "cancel",
      }),
  ).rejects.toMatchObject({ status: 404 });
  const input = {
    workspaceId: "alpha",
    requestId: request.id,
    revision: request.revision,
    action: "cancel",
  };
  const cancelled =
    await fixture.operator.githubAppConnectionRequestFinish(input);
  expect(
    await fixture.operator.githubAppConnectionRequestFinish(input),
  ).toEqual(cancelled);
});
