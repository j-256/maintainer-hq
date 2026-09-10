import { applyD1Migrations, env } from "cloudflare:test";
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
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
} from "../shared/domain";
import { commandAnnotations, commands } from "../shared/commands";
import {
  PROVIDER_CREDENTIAL_LIMITS,
  type ProviderCredentialFields,
  type ProviderCredentialReview,
} from "../shared/provider-credentials";
import { createApplication } from "../worker/app";
import { ProviderCredentials } from "../worker/provider-credentials";
import { managedProviderCredential } from "../worker/provider-credential-store";
import {
  githubCredential,
  githubCredentialReferences,
} from "../worker/provider-github-credential";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const PRIVATE = "synthetic-private-credential-canary";
const OTHER_PRIVATE = "synthetic-replacement-credential-canary";
const KEY = btoa("a".repeat(32));
const workspace = { workspaceId: "alpha" };
const credentialId = "managed-actions";
const settings: ProviderCredentialFields = {
  providerKind: "github-actions",
  name: "Selected repository credentials",
  expiresAt: "2099-01-01T00:00:00.000Z",
  writable: true,
  scope: { repositoryNames: ["example/repo-a"] },
};
let runtime: Env;
let now: number;
function as(subject = "owner", extra: Partial<Principal> = {}) {
  return new WorkspaceService(
    runtime,
    { subject, displayName: subject, ...extra },
    false,
    () => now,
  );
}
function plan(
  revision = 0,
  replaceToken = true,
  service = as(),
  selectedSettings = settings,
) {
  return service.providerCredentialPlan({
    ...workspace,
    credentialId,
    revision,
    change: { kind: "save", settings: selectedSettings, replaceToken },
  });
}
function selection(review: ProviderCredentialReview) {
  return { ...workspace, planId: review.id, fingerprint: review.fingerprint };
}
function privateRequest(review: ProviderCredentialReview, token = PRIVATE) {
  return new Request(
    "https://hq.example/api/provider-credentials/input?" +
      new URLSearchParams({ ...workspace, planId: review.id }),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": review.fingerprint,
        Origin: "https://hq.example",
      },
      body: JSON.stringify({ version: 1, token }),
    },
  );
}
function upload(
  review: ProviderCredentialReview,
  token = PRIVATE,
  service = as(),
) {
  return new ProviderCredentials(service).upload(
    privateRequest(review, token),
    { ...workspace, planId: review.id },
  );
}
function connectionSave(service = as()) {
  return service.secretsConnectionSave({
    ...workspace,
    connectionId: "actions",
    revision: 0,
    connection: {
      name: "Actions secrets",
      providerKind: "github-actions",
      providerRef: credentialId,
      resourceIds: ["repo-a"],
      enabled: true,
    },
  });
}
async function stored() {
  return bindings.HQ_DB.prepare(
    "SELECT * FROM provider_credentials WHERE workspace_id=? AND id=?",
  )
    .bind("alpha", credentialId)
    .first<Record<string, unknown>>();
}
async function privateArtifacts() {
  const tables = [
    "provider_credentials",
    "action_plans",
    "activity",
    "secret_connections",
    "secret_payloads",
    "secret_receipts",
  ];
  return JSON.stringify(
    await Promise.all(
      tables.map((table) =>
        bindings.HQ_DB.prepare("SELECT * FROM " + table).all(),
      ),
    ),
  );
}
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "first",
      keys: [{ id: "first", key: KEY }],
    }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','second','Second owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO repositories (id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('repo-a','alpha','example/repo-a','','project','maintained','active',?,?,'initial')",
    ).bind(JSON.stringify(DEFAULT_EXPECTATIONS), new Date(now).toISOString()),
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error(
        "No provider effects permitted in credential storage tests",
      );
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reviewed provider credential lifecycle", () => {
  it("persists only bound ciphertext and exposes metadata without keys, tokens or ciphertext", async () => {
    const review = await plan();
    expect(review).toMatchObject({
      revision: 0,
      actorMatches: true,
      appliedAt: null,
      connections: [],
    });
    expect((await as().providerCredentialsList(workspace)).items).toEqual([]);
    await expect(
      as().providerCredentialApply(selection(review)),
    ).rejects.toMatchObject({
      code: "provider_credential_private_input_required",
    });
    expect(await upload(review)).toMatchObject({
      submitted: true,
      review: { appliedAt: new Date(now).toISOString() },
    });
    const row = (await stored())!;
    expect(row).toMatchObject({
      revision: 1,
      key_id: "first",
      retired_at: null,
    });
    expect(typeof row.ciphertext).toBe("string");
    expect(
      (
        await managedProviderCredential(
          as(),
          "alpha",
          credentialId,
          "github-actions",
        )
      ).token,
    ).toBe(PRIVATE);
    const metadata = JSON.stringify(
      await as().providerCredentialsList(workspace),
    );
    for (const secret of [
      PRIVATE,
      KEY,
      row.ciphertext,
      row.nonce,
      row.identity,
    ])
      expect(metadata).not.toContain(String(secret));
    expect(await privateArtifacts()).not.toContain(PRIVATE);
    expect(await privateArtifacts()).not.toContain(KEY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not consume replacement input when the same review already has a receipt", async () => {
    const review = await plan();
    await upload(review);
    const request = privateRequest(review, OTHER_PRIVATE);
    const read = vi.spyOn(request.body!, "getReader");
    expect(
      await new ProviderCredentials(as()).upload(request, {
        ...workspace,
        planId: review.id,
      }),
    ).toMatchObject({ submitted: false });
    expect(read).not.toHaveBeenCalled();
    expect(
      (
        await managedProviderCredential(
          as(),
          "alpha",
          credentialId,
          "github-actions",
        )
      ).token,
    ).toBe(PRIVATE);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT COUNT(*) FROM activity WHERE type='provider.credential.saved'",
      ).first<number>("COUNT(*)"),
    ).toBe(1);
  });

  it("permits only one competing private upload to claim that its token was stored", async () => {
    const review = await plan();
    const results = await Promise.all([
      upload(review, PRIVATE),
      upload(review, OTHER_PRIVATE),
    ]);
    expect(results.filter((item) => item.submitted)).toHaveLength(1);
    const expected = results[0]!.submitted ? PRIVATE : OTHER_PRIVATE;
    expect(
      (
        await managedProviderCredential(
          as(),
          "alpha",
          credentialId,
          "github-actions",
        )
      ).token,
    ).toBe(expected);
    expect((await stored())!.revision).toBe(1);
  });

  it("re-encrypts retained-token settings and advances the exact linked connection revision", async () => {
    await upload(await plan());
    await connectionSave();
    const before = (await stored())!;
    const review = await plan(1, false, as(), {
      ...settings,
      name: "Read-only credentials",
      writable: false,
    });
    expect(review.connections).toEqual([
      { id: "actions", name: "Actions secrets", revision: 1, enabled: true },
    ]);
    await as().providerCredentialApply(selection(review));
    const after = (await stored())!;
    expect(after.identity).not.toBe(before.identity);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(after.revision).toBe(2);
    expect(
      (
        await managedProviderCredential(
          as(),
          "alpha",
          credentialId,
          "github-actions",
        )
      ).token,
    ).toBe(PRIVATE);
    expect((await as().secretsConnections(workspace))[0]).toMatchObject({
      revision: 2,
      enabled: true,
      writable: false,
    });
  });

  it("purges retired ciphertext, disables connections, preserves history and never revokes upstream", async () => {
    await upload(await plan());
    await connectionSave();
    const review = await as().providerCredentialPlan({
      ...workspace,
      credentialId,
      revision: 1,
      change: { kind: "retire" },
    });
    await as().providerCredentialApply(selection(review));
    expect(await stored()).toMatchObject({
      revision: 2,
      key_id: null,
      nonce: null,
      ciphertext: null,
      retired_at: new Date(now).toISOString(),
    });
    expect((await as().secretsConnections(workspace))[0]).toMatchObject({
      revision: 2,
      enabled: false,
      available: false,
    });
    expect((await as().providerCredentialsList(workspace)).items).toEqual([]);
    expect(
      (await as().providerCredentialsList({ ...workspace, retired: true }))
        .items[0],
    ).toMatchObject({ status: "retired" });
    await expect(
      managedProviderCredential(as(), "alpha", credentialId, "github-actions"),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await expect(plan(2, false)).rejects.toMatchObject({ code: "validation" });
    await upload(await plan(2), OTHER_PRIVATE);
    expect((await as().secretsConnections(workspace))[0]).toMatchObject({
      revision: 3,
      enabled: false,
      available: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates a credential review if linked enrollment changes or appears after review", async () => {
    await upload(await plan());
    const review = await plan(1, false);
    await connectionSave();
    await expect(
      as().providerCredentialApply(selection(review)),
    ).rejects.toMatchObject({ code: "provider_credential_conflict" });
    const next = await plan(1, false);
    await bindings.HQ_DB.prepare(
      "UPDATE secret_connections SET revision=revision+1 WHERE workspace_id='alpha'",
    ).run();
    await expect(
      as().providerCredentialApply(selection(next)),
    ).rejects.toMatchObject({ code: "provider_credential_conflict" });
    expect((await stored())!.revision).toBe(1);
  });

  it("does not enroll a connection with credentials retired during resource selection", async () => {
    await upload(await plan());
    const retirement = await as().providerCredentialPlan({
      ...workspace,
      credentialId,
      revision: 1,
      change: { kind: "retire" },
    });
    const service = as();
    const repositories = service.repositories.bind(service);
    vi.spyOn(service, "repositories").mockImplementationOnce(async (input) => {
      const result = await repositories(input);
      await as().providerCredentialApply(selection(retirement));
      return result;
    });
    await expect(connectionSave(service)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await as().secretsConnections(workspace)).toEqual([]);
  });

  it("rejects stale revisions, changed membership, mismatched fingerprints and different owners before reading input", async () => {
    const review = await plan();
    expect(
      (
        await as("second").providerCredentialReview({
          ...workspace,
          planId: review.id,
        })
      ).actorMatches,
    ).toBe(false);
    for (const service of [
      as("second"),
      as("outside"),
      as("operator"),
      as("viewer"),
      as("owner", { reporterId: "reporter" }),
      as("owner", { sourceId: "source" }),
    ]) {
      const request = privateRequest(review);
      const read = vi.spyOn(request.body!, "getReader");
      await expect(
        new ProviderCredentials(service).upload(request, {
          ...workspace,
          planId: review.id,
        }),
      ).rejects.toBeDefined();
      expect(read).not.toHaveBeenCalled();
    }
    const wrong = privateRequest(review);
    wrong.headers.set("If-Match", "sha256:" + "a".repeat(64));
    await expect(
      new ProviderCredentials(as()).upload(wrong, {
        ...workspace,
        planId: review.id,
      }),
    ).rejects.toMatchObject({ code: "provider_credential_conflict" });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET revision=revision+1 WHERE workspace_id='alpha' AND subject='owner'",
    ).run();
    await expect(upload(review)).rejects.toMatchObject({
      code: "provider_credential_conflict",
    });
    expect(await stored()).toBeNull();
  });

  it("requires both live administrator and read scopes, and binds a review to its original token identity", async () => {
    const scoped = {
      tokenId: "cli",
      scopes: [CAPABILITY.READ, CAPABILITY.ADMIN],
      workspaceId: "alpha",
    };
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('cli','alpha','owner','Owner CLI','synthetic-hash',?,?,?)",
    )
      .bind(
        JSON.stringify(scoped.scopes),
        new Date(now).toISOString(),
        settings.expiresAt,
      )
      .run();
    const service = as("owner", scoped);
    const review = await plan(0, true, service);
    await expect(upload(review, PRIVATE, as())).rejects.toMatchObject({
      code: "provider_credential_conflict",
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json=? WHERE id='cli'",
    )
      .bind(JSON.stringify([CAPABILITY.ADMIN]))
      .run();
    await expect(upload(review, PRIVATE, service)).rejects.toMatchObject({
      code: "forbidden",
    });
    await bindings.HQ_DB.prepare(
      "UPDATE credentials SET scopes_json=?,revoked_at=? WHERE id='cli'",
    )
      .bind(JSON.stringify(scoped.scopes), new Date(now).toISOString())
      .run();
    await expect(upload(review, PRIVATE, service)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("expires reviews and credentials, and permits local retirement even without a decryption key", async () => {
    const expired = await plan();
    now += PROVIDER_CREDENTIAL_LIMITS.REVIEW_MS + 1;
    await expect(upload(expired)).rejects.toMatchObject({
      code: "provider_credential_conflict",
    });
    await upload(await plan());
    runtime.PROVIDER_CREDENTIAL_KEYS = undefined;
    expect(
      (await as().providerCredentialsList(workspace)).items[0],
    ).toMatchObject({ status: "key-unavailable" });
    await expect(plan(1)).rejects.toMatchObject({
      code: "provider_credential_storage_missing",
    });
    const retirement = await as().providerCredentialPlan({
      ...workspace,
      credentialId,
      revision: 1,
      change: { kind: "retire" },
    });
    await as().providerCredentialApply(selection(retirement));
    expect((await stored())!.ciphertext).toBeNull();
  });

  it("rejects unsafe or oversized private bodies without logging their contents", async () => {
    const review = await plan();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    for (const token of [
      "",
      "has whitespace",
      "newline\ncanary",
      "x".repeat(PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES + 1),
    ]) {
      const result = await app.fetch(privateRequest(review, token), runtime);
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain(token || PRIVATE);
    }
    const request = privateRequest(review);
    request.headers.set(
      "Content-Length",
      String(PROVIDER_CREDENTIAL_LIMITS.INPUT_BYTES + 1),
    );
    expect((await app.fetch(request, runtime)).status).toBe(400);
    expect(await stored()).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
    expect(await privateArtifacts()).not.toContain(PRIVATE);
  });

  it("never falls back to a deployment credential under the managed namespace", async () => {
    runtime.GITHUB_SECRET_CREDENTIALS = JSON.stringify({
      [credentialId]: {
        workspaceId: "alpha",
        name: "Legacy shadow",
        revision: 1,
        token: OTHER_PRIVATE,
        expiresAt: settings.expiresAt,
        repositoryNames: ["example/repo-a"],
        writable: true,
      },
    });
    expect(await githubCredentialReferences(as(), "alpha")).toEqual([]);
    await expect(
      githubCredential(as(), "alpha", credentialId),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await upload(await plan());
    expect(
      (await githubCredential(as(), "alpha", credentialId)).descriptor.token,
    ).toBe(PRIVATE);
    await expect(
      githubCredential(as("outside"), "beta", credentialId),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await expect(
      managedProviderCredential(
        as(),
        "alpha",
        credentialId,
        "cloudflare-workers",
      ),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    runtime.PROVIDER_CREDENTIAL_KEYS = undefined;
    await expect(
      githubCredential(as(), "alpha", credentialId),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
  });

  it("verifies exact scoped metadata reads without claiming write permission or returning provider payloads", async () => {
    await upload(await plan());
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = new URL(String(input));
        fetched.push(url.pathname);
        expect(url.origin).toBe("https://api.github.com");
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer " + PRIVATE,
        );
        if (url.pathname.endsWith("/secrets"))
          return Response.json({
            total_count: 0,
            secrets: [],
            private: PRIVATE,
          });
        return Response.json({
          id: 42,
          full_name: "example/repo-a",
          archived: false,
          disabled: false,
          owner: { id: 7, login: "example", type: "Organization" },
          private: true,
        });
      }),
    );
    const evidence = await as().providerCredentialVerify({
      ...workspace,
      credentialId,
      revision: 1,
      resourceName: "example/repo-a",
    });
    expect(evidence).toMatchObject({
      evidence: "secret-metadata-readable",
      writePermissionVerified: false,
      revision: 1,
    });
    expect(fetched).toEqual([
      "/repos/example/repo-a",
      "/repos/example/repo-a/actions/secrets",
    ]);
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE);
    await expect(
      as().providerCredentialVerify({
        ...workspace,
        credentialId,
        revision: 1,
        resourceName: "example/outside",
      }),
    ).rejects.toMatchObject({ code: "secret_repository_denied" });
    expect(fetched).toHaveLength(2);
  });

  it("verifies an explicitly selected environment without requiring repository secret access", async () => {
    await upload(await plan());
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const path = new URL(String(input)).pathname;
        fetched.push(path);
        if (path === "/repos/example/repo-a")
          return Response.json({
            id: 42,
            full_name: "example/repo-a",
            archived: false,
            disabled: false,
            owner: { id: 7, login: "example", type: "Organization" },
            private: true,
          });
        if (
          path === "/repos/example/repo-a/environments/Production%20%2F%20Blue"
        )
          return Response.json({ id: 8, name: "Production / Blue" });
        if (
          path ===
          "/repos/example/repo-a/environments/Production%20%2F%20Blue/secrets"
        )
          return Response.json({ total_count: 0, secrets: [] });
        return new Response(null, { status: 403 });
      }),
    );
    const evidence = await as().providerCredentialVerify({
      ...workspace,
      credentialId,
      revision: 1,
      resourceName: "example/repo-a",
      scope: { kind: "environment", name: "Production / Blue" },
    });
    expect(evidence).toMatchObject({
      scope: { kind: "environment", name: "Production / Blue" },
      writePermissionVerified: false,
    });
    expect(fetched).toEqual([
      "/repos/example/repo-a",
      "/repos/example/repo-a/environments/Production%20%2F%20Blue",
      "/repos/example/repo-a/environments/Production%20%2F%20Blue/secrets",
    ]);
    await expect(
      as().providerCredentialVerify({
        ...workspace,
        credentialId,
        revision: 1,
        resourceName: "example/repo-a",
        scope: { kind: "worker" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(fetched).toHaveLength(3);
  });

  it("verifies repository-effective organization variable values without claiming organization-wide access", async () => {
    await upload(await plan());
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const path = new URL(String(input)).pathname;
        fetched.push(path);
        if (path === "/repos/example/repo-a")
          return Response.json({
            id: 42,
            full_name: "example/repo-a",
            archived: false,
            disabled: false,
            owner: { id: 7, login: "example", type: "Organization" },
          });
        if (
          path ===
          "/repos/example/repo-a/actions/organization-variables"
        )
          return Response.json({
            total_count: 1,
            variables: [
              {
                name: "DEPLOY_REGION",
                value: "us-central1",
                created_at: "2026-09-01T00:00:00Z",
                updated_at: "2026-09-02T00:00:00Z",
              },
            ],
          });
        return new Response(null, { status: 403 });
      }),
    );
    const evidence = await as().providerCredentialVerify({
      ...workspace,
      credentialId,
      revision: 1,
      resourceName: "example/repo-a",
      entryKind: "variable",
      scope: { kind: "organization", name: "example" },
    });
    expect(evidence).toMatchObject({
      entryKind: "variable",
      scope: { kind: "organization", name: "example" },
      evidence: "variable-values-readable",
      writePermissionVerified: false,
    });
    expect(fetched).toEqual([
      "/repos/example/repo-a",
      "/repos/example/repo-a/actions/organization-variables",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("us-central1");
  });

  it("accepts the maximum printable token when JSON escaping doubles its envelope size", async () => {
    const token = '\\"'.repeat(PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES / 2);
    expect(new TextEncoder().encode(token).length).toBe(
      PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES,
    );
    const receipt = await upload(await plan(), token);
    expect(receipt.submitted).toBe(true);
    expect(
      (
        await managedProviderCredential(
          as(),
          "alpha",
          credentialId,
          "github-actions",
        )
      ).token,
    ).toBe(token);
  });

  it("does not report verification as fresh after credential revision or access changes during a provider read", async () => {
    await upload(await plan());
    const replacement = await plan(1, false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        if (new URL(String(input)).pathname.endsWith("/secrets")) {
          await as().providerCredentialApply(selection(replacement));
          return Response.json({ total_count: 0, secrets: [] });
        }
        return Response.json({
          id: 42,
          full_name: "example/repo-a",
          archived: false,
          disabled: false,
          owner: { id: 7, login: "example", type: "Organization" },
          private: true,
        });
      }),
    );
    await expect(
      as().providerCredentialVerify({
        ...workspace,
        credentialId,
        revision: 1,
        resourceName: "example/repo-a",
      }),
    ).rejects.toMatchObject({ code: "provider_credential_conflict" });
  });

  it("marks expired credentials unavailable and cannot extend them without replacement input", async () => {
    await upload(
      await plan(0, true, as(), {
        ...settings,
        expiresAt: new Date(now + 10000).toISOString(),
      }),
    );
    now += 10001;
    expect(
      (await as().providerCredentialsList(workspace)).items[0],
    ).toMatchObject({ status: "expired" });
    await expect(
      managedProviderCredential(as(), "alpha", credentialId, "github-actions"),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    const extension = await plan(1, false);
    await expect(
      as().providerCredentialApply(selection(extension)),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
  });

  it("bounds active credentials, pending reviews and history pagination", async () => {
    for (let index = 0; index < PROVIDER_CREDENTIAL_LIMITS.WORKSPACE; index++) {
      const review = await as().providerCredentialPlan({
        ...workspace,
        credentialId: "managed-" + index,
        revision: 0,
        change: { kind: "save", settings, replaceToken: true },
      });
      await upload(review);
    }
    const excess = await plan();
    await expect(upload(excess)).rejects.toMatchObject({
      code: "provider_credential_conflict",
    });
    expect((await as().providerCredentialsList(workspace)).items).toHaveLength(
      PROVIDER_CREDENTIAL_LIMITS.WORKSPACE,
    );
    for (
      let index = 1;
      index < PROVIDER_CREDENTIAL_LIMITS.PENDING_REVIEWS;
      index++
    )
      await plan();
    await expect(plan()).rejects.toMatchObject({
      code: "provider_credential_conflict",
    });
    await expect(
      as().providerCredentialsList({ ...workspace, before: "invalid" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("has bounded strict HTTP and MCP parity without private-value command fields", async () => {
    await upload(await plan());
    const app = createApplication(async () => ({
      subject: "owner",
      displayName: "Owner",
    }));
    const request = (path: string, body: object) =>
      new Request("https://hq.example" + path, {
        method: "POST",
        headers: {
          Origin: "https://hq.example",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const list = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      runtime,
    );
    const discovery = (await list.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(discovery.result.tools.map((tool) => tool.name)).toContain(
      "provider_credential_plan",
    );
    const result = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "provider_credentials_list", arguments: workspace },
      }),
      runtime,
    );
    const envelope = (await result.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(envelope.result.isError).not.toBe(true);
    expect(JSON.parse(envelope.result.content[0]!.text)).toEqual(
      await as().providerCredentialsList(workspace),
    );
    expect(JSON.stringify(envelope)).not.toContain(PRIVATE);
    expect(
      commands.provider_credential_plan.schema.safeParse({
        ...workspace,
        token: PRIVATE,
      }).success,
    ).toBe(false);
    expect(
      commandAnnotations("provider_credential_apply", false),
    ).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
    const viewer = createApplication(async () => ({
      subject: "viewer",
      displayName: "Viewer",
    }));
    expect(
      (
        await viewer.fetch(
          request("/api/commands/provider_credentials_list", workspace),
          runtime,
        )
      ).status,
    ).toBe(403);
    const crossOrigin = privateRequest(await plan(1));
    crossOrigin.headers.set("Origin", "https://untrusted.example");
    expect((await app.fetch(crossOrigin, runtime)).status).toBe(403);
  });
});
