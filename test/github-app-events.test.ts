import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApplication } from "../worker/app";
import {
  handleGitHubAppLifecycle,
  reconcileGitHubAppAuthority,
  GITHUB_APP_EVENT_LIMITS,
} from "../worker/github-app-events";
import { sealGitHubAppMaterial } from "../worker/github-app-crypto";
import {
  resolveGitHubCredential,
  assertGitHubAuthorityFence,
} from "../worker/github-credential-resolver";
import { invalidateGitHubAppAuthority } from "../worker/github-app-authority";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";
import {
  activateGitHubAppFixture,
  appProviderFixture,
} from "./helpers/github-app-active-fixture";
const SECRET = "synthetic-lifecycle-signing-secret";
let fixture: GitHubAppFixture;
let target: Awaited<ReturnType<typeof activateGitHubAppFixture>>;
beforeAll(migrateGitHubAppFixture);
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(appProviderFixture(fixture));
  target = await activateGitHubAppFixture(fixture);
  const encrypted = await sealGitHubAppMaterial(
    {
      env: fixture.runtime,
      deploymentId: fixture.runtime.GITHUB_APP_DEPLOYMENT_ID!,
      administrativeWorkspaceId: "administration",
      registrationId: "app-a",
      kind: "webhook-secret",
      materialId: "lifecycle-secret",
      revision: 1,
    },
    new TextEncoder().encode(SECRET),
  );
  await fixture.runtime.HQ_DB.batch([
    fixture.runtime.HQ_DB.prepare(
      "UPDATE github_app_registrations SET webhook_revision=1,metadata_json=json_set(metadata_json,'$.lifecycleIngress','ready') WHERE id='app-a'",
    ),
    fixture.runtime.HQ_DB.prepare(
      "INSERT INTO github_app_material(registration_id,kind,material_id,revision,key_id,nonce,ciphertext,created_at) VALUES ('app-a','webhook-secret','lifecycle-secret',1,?,?,?,?)",
    ).bind(
      encrypted.keyId,
      encrypted.nonce,
      encrypted.ciphertext,
      new Date(fixture.clock.now).toISOString(),
    ),
  ]);
});
afterEach(() => vi.restoreAllMocks());
async function delivery(
  action = "deleted",
  options: {
    event?: string;
    id?: string;
    secret?: string;
    body?: string;
    registration?: string;
  } = {},
) {
  const body =
    options.body ??
    JSON.stringify({
      action,
      installation: { id: 91, app_id: 42 },
      repositories_removed: [{ id: 101 }],
      private_payload: "must-not-persist",
    });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return new Request(
    "https://hq.example/api/github-apps/events/" +
      (options.registration ?? "app-a"),
    {
      method: "POST",
      headers: {
        "X-Hub-Signature-256": "sha256=" + signature,
        "X-GitHub-Event": options.event ?? "installation",
        "X-GitHub-Delivery": options.id ?? crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body,
    },
  );
}
const handle = async (request: Request) =>
  handleGitHubAppLifecycle(request, fixture.runtime, () => fixture.clock.now);
const generation = () =>
  fixture.runtime.HQ_DB.prepare(
    "SELECT generation FROM github_app_authority WHERE registration_id='app-a'",
  ).first<number>("generation");
async function seedEvidence(workspaceId = "alpha") {
  const now = new Date(fixture.clock.now).toISOString();
  await fixture.runtime.HQ_DB.prepare(
    "INSERT INTO observations(workspace_id,source_id,resource_type,resource_id,name,health,summary,details_json,observed_at,received_at,expires_at) VALUES (?,'github','repository',?,'CI','healthy','Observed','{}',?,?,?)",
  )
    .bind(
      workspaceId,
      "repository-" + workspaceId,
      now,
      now,
      new Date(fixture.clock.now + 3600000).toISOString(),
    )
    .run();
}
it("authenticates raw bytes before parsing and refuses unknown, disabled and oversized ingress", async () => {
  await resolveGitHubCredential(fixture.operator, target);
  const before = await generation();
  expect(
    (
      await handle(
        await delivery("deleted", { secret: "wrong", body: "not-json" }),
      )
    ).status,
  ).toBe(401);
  expect(
    (await handle(await delivery("deleted", { registration: "unknown" })))
      .status,
  ).toBe(404);
  expect(
    (
      await handle(
        await delivery("deleted", {
          body: "x".repeat(GITHUB_APP_EVENT_LIMITS.BODY_BYTES + 1),
        }),
      )
    ).status,
  ).toBe(413);
  expect(await generation()).toBe(before);
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_registrations SET webhook_revision=NULL WHERE id='app-a'",
  ).run();
  expect((await handle(await delivery())).status).toBe(404);
});
it("deduplicates an authenticated delivery atomically before invalidating shared installation authority", async () => {
  await activateGitHubAppFixture(fixture, "beta", "grant-b");
  const old = await resolveGitHubCredential(fixture.operator, target);
  await seedEvidence();
  await seedEvidence("beta");
  const body = await delivery("suspend", { id: "same-delivery" });
  const responses = await Promise.all([
    handle(body.clone() as Request),
    handle(body.clone() as Request),
  ]);
  expect(responses.every((response) => response.status === 202)).toBe(true);
  const after = await generation();
  expect(after).toBe(old.observedAuthorityGeneration! + 1);
  await handle(body.clone() as Request);
  expect(await generation()).toBe(after);
  await expect(
    assertGitHubAuthorityFence(fixture.operator, old.fence),
  ).rejects.toThrow();
  const rows = (
    await fixture.runtime.HQ_DB.prepare(
      "SELECT expires_at FROM observations",
    ).all<{ expires_at: string }>()
  ).results;
  expect(
    rows.every((row) => Date.parse(row.expires_at) <= fixture.clock.now),
  ).toBe(true);
  expect(
    JSON.stringify(
      (
        await fixture.runtime.HQ_DB.prepare(
          "SELECT * FROM github_app_deliveries",
        ).all()
      ).results,
    ),
  ).not.toContain("must-not-persist");
});
it("does not revive a deleted installation from a delayed addition or enroll repositories", async () => {
  const old = await resolveGitHubCredential(fixture.operator, target);
  const before = await fixture.runtime.HQ_DB.prepare(
    "SELECT count(*) AS total FROM source_repositories",
  ).first("total");
  expect((await handle(await delivery())).status).toBe(202);
  expect((await handle(await delivery("created"))).status).toBe(202);
  expect(
    (
      await handle(
        await delivery("added", { event: "installation_repositories" }),
      )
    ).status,
  ).toBe(202);
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT state FROM github_app_grants WHERE id='grant-a'",
    ).first("state"),
  ).toBe("revoked");
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT count(*) AS total FROM source_repositories",
    ).first("total"),
  ).toBe(before);
  await expect(
    assertGitHubAuthorityFence(fixture.operator, old.fence),
  ).rejects.toThrow();
});
it.each([
  ["push", "created"],
  ["installation", "unexpected"],
  ["installation_repositories", "unexpected"],
])("rejects unsupported event/action %s %s", async (event, action) => {
  expect((await handle(await delivery(action, { event }))).status).toBe(400);
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT count(*) FROM github_app_deliveries",
    ).first("count(*)"),
  ).toBe(0);
});
it("rejects signed App identity substitution", async () => {
  expect(
    (
      await handle(
        await delivery("deleted", {
          body: JSON.stringify({
            action: "deleted",
            installation: { id: 91, app_id: 43 },
          }),
        }),
      )
    ).status,
  ).toBe(400);
});
it("routes lifecycle HMAC authentication without requiring a user session or browser origin", async () => {
  const principal = vi.fn(async () => {
    throw new Error("Must not use user authentication");
  });
  const app = createApplication(principal);
  expect((await app.fetch(await delivery(), fixture.runtime)).status).toBe(202);
  expect(principal).not.toHaveBeenCalled();
});
it("expires evidence with the injected clock even when an invalidated authority has no observation time", async () => {
  await resolveGitHubCredential(fixture.operator, target);
  await invalidateGitHubAppAuthority(fixture.operator, "app-a", 91);
  await seedEvidence();
  fixture.clock.now += 1000;
  await invalidateGitHubAppAuthority(fixture.operator, "app-a", 91);
  expect(
    Date.parse(
      (await fixture.runtime.HQ_DB.prepare(
        "SELECT expires_at FROM observations",
      ).first<string>("expires_at")) ?? "",
    ),
  ).toBe(fixture.clock.now);
});
it("expires only the changed local grant's evidence", async () => {
  await activateGitHubAppFixture(fixture, "beta", "grant-b");
  await seedEvidence();
  await seedEvidence("beta");
  const review = await fixture.operator.githubAppGrantRevokePlan({
    workspaceId: "alpha",
    grantId: "grant-a",
    revision: 1,
  });
  await fixture.operator.githubAppGrantAccept({
    workspaceId: "alpha",
    planId: review.id,
    fingerprint: review.fingerprint,
  });
  const rows = (
    await fixture.runtime.HQ_DB.prepare(
      "SELECT workspace_id,expires_at FROM observations ORDER BY workspace_id",
    ).all<{ workspace_id: string; expires_at: string }>()
  ).results;
  expect(Date.parse(rows[0].expires_at)).toBeLessThanOrEqual(fixture.clock.now);
  expect(Date.parse(rows[1].expires_at)).toBeGreaterThan(fixture.clock.now);
});
it("detects a missed installation deletion on the next due provider verification", async () => {
  const old = await resolveGitHubCredential(fixture.operator, target);
  await seedEvidence();
  fixture.clock.now += 60001;
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 404 }));
  const result = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  expect(result).toMatchObject({
    checked: 1,
    denied: 1,
    failed: 0,
    incomplete: false,
  });
  await expect(
    assertGitHubAuthorityFence(fixture.operator, old.fence),
  ).rejects.toThrow();
  expect(
    Date.parse(
      (await fixture.runtime.HQ_DB.prepare(
        "SELECT expires_at FROM observations",
      ).first<string>("expires_at")) ?? "",
    ),
  ).toBeLessThanOrEqual(fixture.clock.now);
});
it("does not use a bad signature to change grants or persist raw payloads", async () => {
  const response = await handle(await delivery("deleted", { secret: "wrong" }));
  expect(response.status).toBe(401);
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT state FROM github_app_grants",
    ).first("state"),
  ).toBe("active");
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT count(*) AS total FROM github_app_deliveries",
    ).first("total"),
  ).toBe(0);
});
it("acknowledges signed ping without changing authority", async () => {
  const old = await resolveGitHubCredential(fixture.operator, target);
  expect(
    (
      await handle(
        await delivery("ignored", {
          event: "ping",
          body: JSON.stringify({ zen: "synthetic" }),
        }),
      )
    ).status,
  ).toBe(202);
  expect(await generation()).toBe(old.observedAuthorityGeneration);
});
it("rejects reuse of a delivery ID with different authenticated metadata", async () => {
  await handle(await delivery("suspend", { id: "collision" }));
  expect(
    (await handle(await delivery("unsuspend", { id: "collision" }))).status,
  ).toBe(409);
});
it("bounds reconciliation provider work and reports remaining scopes", async () => {
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
  const base = appProviderFixture(fixture);
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("/access_tokens")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        token: "synthetic-bounded-token",
        expires_at: new Date(fixture.clock.now + 3600000).toISOString(),
        permissions: body.permissions,
        repositories: body.repository_ids.map((id: number) => ({
          id,
          full_name: repositories.find((repo) => repo.id === id)!.fullName,
          owner: { id: 50 },
          private: true,
        })),
      });
    }
    return base(input, init);
  });
  const result = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  expect(result).toMatchObject({
    checked: 20,
    requests: 40,
    denied: 0,
    failed: 0,
    remaining: 80,
    incomplete: true,
  });
});
it("advances past failed scopes on a later reconciliation batch", async () => {
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
    if (String(input).includes("/access_tokens"))
      visited.push(JSON.parse(String(init?.body)).repository_ids[0]);
    const response = await appProviderFixture(fixture)(input, init);
    if (String(input).includes("/access_tokens"))
      return Response.json({}, { status: 500 });
    return response;
  });
  await reconcileGitHubAppAuthority(fixture.runtime, fixture.clock.now);
  const first = [...visited];
  visited.length = 0;
  await reconcileGitHubAppAuthority(fixture.runtime, fixture.clock.now);
  expect(first).toHaveLength(20);
  expect(visited).toHaveLength(20);
  expect(visited.some((id) => first.includes(id))).toBe(false);
});
it("retires expired setup attempts and old delivery metadata in bounded batches", async () => {
  await handle(await delivery("suspend"));
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_deliveries SET received_at=?",
  )
    .bind(
      new Date(
        fixture.clock.now - GITHUB_APP_EVENT_LIMITS.RETENTION_MS - 1,
      ).toISOString(),
    )
    .run();
  await fixture.runtime.HQ_DB.prepare(
    "INSERT INTO github_app_manifest_attempts(id,workspace_id,actor_subject,input_json,state_hash,state,created_at,expires_at) VALUES ('abandoned','administration','owner','{}','hash','conversion_claimed',?,?)",
  )
    .bind(
      new Date(fixture.clock.now - 10000).toISOString(),
      new Date(fixture.clock.now - 1).toISOString(),
    )
    .run();
  const result = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  expect(result).toMatchObject({ retiredAttempts: 1, retiredDeliveries: 1 });
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT state FROM github_app_manifest_attempts WHERE id='abandoned'",
    ).first("state"),
  ).toBe("indeterminate");
});
it("expires observations and cached contexts on registration disconnect", async () => {
  await seedEvidence();
  await fixture.runtime.HQ_DB.prepare(
    "INSERT INTO github_work_cache(workspace_id,source_id,repository_id,identity,next_read_at,result_json) VALUES ('alpha','github','repository-alpha','synthetic',?,'{}')",
  )
    .bind(new Date(fixture.clock.now).toISOString())
    .run();
  const review = await fixture.operator.githubAppRegistrationPlan({
    workspaceId: "administration",
    registrationId: "app-a",
    revision: 1,
    change: { kind: "disconnect" },
  });
  expect(review.impact.affectedWorkspaceIds).toContain("alpha");
  await fixture.operator.githubAppRegistrationApply({
    workspaceId: "administration",
    planId: review.id,
    fingerprint: review.fingerprint,
  });
  expect(
    Date.parse(
      (await fixture.runtime.HQ_DB.prepare(
        "SELECT expires_at FROM observations",
      ).first<string>("expires_at")) ?? "",
    ),
  ).toBeLessThanOrEqual(fixture.clock.now);
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT result_json FROM github_work_cache",
    ).first("result_json"),
  ).toBeNull();
});
it("invalidates all local registrations for the same provider App and installation", async () => {
  await resolveGitHubCredential(fixture.operator, target);
  await fixture.runtime.HQ_DB.prepare(
    "INSERT INTO github_app_registrations(id,administrative_workspace_id,metadata_json,identity_json,revision,key_revision,created_at,updated_at,write_id) SELECT 'app-copy',administrative_workspace_id,json_set(metadata_json,'$.id','app-copy'),identity_json,revision,key_revision,created_at,updated_at,'synthetic-copy' FROM github_app_registrations WHERE id='app-a'",
  ).run();
  await fixture.runtime.HQ_DB.prepare(
    "INSERT INTO github_app_authority(registration_id,installation_id,repository_id,generation,state,write_id) VALUES ('app-copy',91,101,7,'unknown','synthetic-copy')",
  ).run();
  await handle(await delivery("suspend"));
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT generation FROM github_app_authority WHERE registration_id='app-copy'",
    ).first("generation"),
  ).toBe(8);
});
it("invalidates repository removal without accepting a delayed addition as provider verification", async () => {
  const old = await resolveGitHubCredential(fixture.operator, target);
  await handle(
    await delivery("removed", { event: "installation_repositories" }),
  );
  await handle(await delivery("added", { event: "installation_repositories" }));
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT state FROM github_app_authority",
    ).first("state"),
  ).toBe("unknown");
  await expect(
    assertGitHubAuthorityFence(fixture.operator, old.fence),
  ).rejects.toThrow();
});
it("logs bounded reconciliation failures without provider payloads or credentials", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await resolveGitHubCredential(fixture.operator, target);
  fixture.clock.now += 60001;
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ private_error: "must-not-log" }, { status: 500 }),
  );
  const result = await reconcileGitHubAppAuthority(
    fixture.runtime,
    fixture.clock.now,
  );
  expect(result).toMatchObject({ failed: 1, incomplete: true });
  expect(
    warn.mock.calls.some(
      ([value]) =>
        value.event === "hq.github.app.reconciliation" && value.failed === 1,
    ),
  ).toBe(true);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(
    /must-not-log|synthetic-installation-token|signing-secret/,
  );
});
it("caps new observations at an explicit workspace grant expiry", async () => {
  const expiry = new Date(fixture.clock.now + 1000).toISOString();
  await fixture.runtime.HQ_DB.prepare(
    "UPDATE github_app_grants SET expires_at=?,metadata_json=json_set(metadata_json,'$.expiresAt',?) WHERE id='grant-a'",
  )
    .bind(expiry, expiry)
    .run();
  await seedEvidence();
  expect(
    await fixture.runtime.HQ_DB.prepare(
      "SELECT expires_at FROM observations",
    ).first("expires_at"),
  ).toBe(expiry);
});
