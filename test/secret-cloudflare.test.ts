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
import type { Env } from "../worker/types";
import { secretAdapter } from "../worker/secret-adapter-registry";
import { SecretsService } from "../worker/secrets";
import { CAPABILITY } from "../shared/domain";
import { CLOUDFLARE_SECRET_LIMITS } from "../shared/cloudflare-secrets";
import {
  CF_ACCOUNT,
  CF_CREDENTIAL,
  CF_DEPLOYMENT,
  CF_ID,
  CF_TOKEN,
  CF_VALUE,
  CF_VARIABLE_VALUE,
  CF_VERSION,
  CF_WORKER,
  cfSettings,
  cloudflareSecretsFixture,
} from "./fixtures/cloudflare-secrets";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let fixture: Awaited<ReturnType<typeof cloudflareSecretsFixture>>;
const workspace = { workspaceId: "alpha" };
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  fixture = await cloudflareSecretsFixture(bindings);
  await fixture.install();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function selected() {
  await fixture.saved();
  return new SecretsService(fixture.as()).resource(
    "alpha",
    "workers",
    fixture.target.resourceId,
  );
}
const inventory = () =>
  fixture.as().secretsInventory({
    ...workspace,
    connectionId: "workers",
    target: fixture.target,
    page: 1,
  });
describe("Cloudflare native Secrets adapter", () => {
  it("enrolls native Workers without fabricating repository membership or reading provider data", async () => {
    const providers = await fixture.as().secretsProviders(workspace);
    expect(providers).toEqual([
      expect.objectContaining({
        id: CF_CREDENTIAL,
        kind: "cloudflare-workers",
        available: true,
        writable: true,
        capabilities: expect.objectContaining({
          input: "private-transient",
          activation: "worker-deployment",
          metadataVersion: "opaque",
        }),
        resources: [
          { id: "worker-" + CF_WORKER, label: CF_WORKER, repositoryIds: [] },
          {
            id: "worker-second-worker",
            label: "second-worker",
            repositoryIds: [],
          },
        ],
      }),
    ]);
    const connection = await fixture.saved();
    expect(
      connection.resources.every(
        (resource) => resource.repositoryIds.length === 0,
      ),
    ).toBe(true);
    expect(await fixture.as().repositories(workspace)).toEqual([]);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(JSON.stringify({ providers, connection })).not.toContain(CF_TOKEN);
    const provider = await secretAdapter("cloudflare-workers").connect(
      fixture.as(),
      "alpha",
      CF_CREDENTIAL,
    );
    await expect(
      provider.selectResources(["worker-unselected"]),
    ).rejects.toMatchObject({ code: "secret_worker_denied" });
    const resources = await provider.selectResources([
      fixture.target.resourceId,
    ]);
    await expect(
      provider.checkResources([
        {
          ...resources[0]!,
          identity: JSON.stringify(["d".repeat(32), CF_WORKER]),
        },
      ]),
    ).rejects.toMatchObject({ code: "secret_identity_changed" });
    await expect(
      provider.checkResources([
        {
          ...resources[0]!,
          repositories: [{ id: "fake", fullName: "fake/repo" }],
        },
      ]),
    ).rejects.toMatchObject({ code: "secret_identity_changed" });
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("returns bounded case-sensitive text-secret inventory with honest deployment-only metadata", async () => {
    await fixture.saved();
    fixture.state.secrets = [
      { name: "Token", type: "secret_text" },
      { name: "token", type: "secret_text" },
      { name: "KEY", type: "secret_key" },
    ];
    const result = await inventory();
    expect(result.items).toEqual(
      ["Token", "token"].map((name) => ({
        name,
        kind: "secret",
        management: "unmanaged",
        managedConfigurationId: null,
        value: null,
        valueFormat: null,
        createdAt: null,
        updatedAt: null,
        version: JSON.stringify([CF_DEPLOYMENT, CF_VERSION]),
      })),
    );
    expect(result).toMatchObject({
      resourceIdentity: CF_ACCOUNT + "/" + CF_ID,
      total: 2,
      nextPage: null,
      truncated: false,
      excludedBindings: 1,
      unsupportedBindings: 1,
      scopeIdentity: null,
    });
    expect(result.workerDeployment).toEqual({
      accountId: CF_ACCOUNT,
      workerName: CF_WORKER,
      deploymentId: CF_DEPLOYMENT,
      versionId: CF_VERSION,
    });
    expect(fixture.request).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toContain(CF_VALUE);
    expect(JSON.stringify(result)).not.toContain(CF_TOKEN);
    fixture.state.secrets = Array.from({ length: 35 }, (_, index) => ({
      name: "NAME_" + String(index).padStart(2, "0"),
      type: "secret_text",
    }));
    expect(await inventory()).toMatchObject({ total: 35, nextPage: 2 });
    const page = await fixture
      .as()
      .secretsInventory({
        ...workspace,
        connectionId: "workers",
        target: fixture.target,
        page: 2,
      });
    expect(page.items).toHaveLength(5);
    expect(page.nextPage).toBeNull();
    fixture.state.split = true;
    expect(await inventory()).toMatchObject({
      workerDeployment: null,
      items: expect.arrayContaining([
        expect.objectContaining({ version: null }),
      ]),
    });
  });
  it("returns readable plaintext and JSON variables without exposing secret values", async () => {
    await fixture.saved();
    const result = await fixture.as().secretsInventory({
      ...workspace,
      connectionId: "workers",
      target: fixture.target,
      entryKind: "variable",
      page: 1,
    });
    expect(result).toMatchObject({
      entryKind: "variable",
      total: 2,
      excludedBindings: 2,
      items: [
        {
          name: "JSON_CONFIG",
          kind: "variable",
          management: "unmanaged",
          value: '{"region":"test","retries":2}',
          valueFormat: "json",
        },
        {
          name: "VARIABLE",
          kind: "variable",
          management: "unmanaged",
          value: CF_VARIABLE_VALUE,
          valueFormat: "text",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(CF_VALUE);
    expect(JSON.stringify(result)).not.toContain(CF_TOKEN);
    expect(fixture.request).toHaveBeenCalledTimes(5);
  });
  it("offers only Worker scope and rejects GitHub scopes before provider reads", async () => {
    await fixture.saved();
    expect(
      await fixture
        .as()
        .secretsScopes({
          ...workspace,
          connectionId: "workers",
          resourceId: fixture.target.resourceId,
          page: 1,
        }),
    ).toMatchObject({
      defaultScope: { kind: "worker" },
      items: [],
      nextPage: null,
    });
    fixture.request.mockClear();
    await expect(
      fixture
        .as()
        .secretsInventory({
          ...workspace,
          connectionId: "workers",
          target: { ...fixture.target, scope: { kind: "repository" } },
          page: 1,
        }),
    ).rejects.toMatchObject({ code: "secret_scope_invalid" });
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("captures immutable Worker identity, exact case and serving version for activation review", async () => {
    const { provider, resource } = await selected();
    const snapshot = await provider.prepare(
      resource,
      { kind: "worker" },
      "Token",
    );
    expect(snapshot).toMatchObject({
      name: "Token",
      scope: { kind: "worker" },
      resourceIdentity: CF_ACCOUNT + "/" + CF_ID,
      resourceRevision: JSON.stringify([CF_DEPLOYMENT, CF_VERSION]),
      input: { kind: "private-transient", maxValueBytes: 5120 },
      activation: "worker-deployment",
      workerDeployment: {
        accountId: CF_ACCOUNT,
        workerName: CF_WORKER,
        deploymentId: CF_DEPLOYMENT,
        versionId: CF_VERSION,
      },
    });
    expect(fixture.request).toHaveBeenCalledTimes(6);
    expect(
      (await provider.prepare(resource, { kind: "worker" }, "token")).before,
    ).toBeNull();
    expect(provider.validateSealedInput(snapshot, "synthetic-ciphertext")).toBe(
      false,
    );
    await expect(
      provider.writeSealed(resource, snapshot, "synthetic-ciphertext"),
    ).rejects.toMatchObject({ code: "secret_input_unsupported" });
    expect(JSON.stringify(snapshot)).not.toContain(CF_VALUE);
  });
  it("blocks non-secret collisions, capacity, gradual deployments and invalid binding names", async () => {
    const { provider, resource } = await selected();
    await expect(
      provider.prepare(resource, { kind: "worker" }, "VARIABLE"),
    ).rejects.toMatchObject({ code: "secret_binding_conflict" });
    fixture.state.otherBindings = Array.from(
      { length: CLOUDFLARE_SECRET_LIMITS.BINDINGS - 1 },
      (_, index) => ({ name: "VAR_" + index, type: "plain_text" }),
    );
    await expect(
      provider.prepare(resource, { kind: "worker" }, "NEW"),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(
      (await provider.prepare(resource, { kind: "worker" }, "Token")).before
        ?.name,
    ).toBe("Token");
    fixture.state.split = true;
    await expect(
      provider.prepare(resource, { kind: "worker" }, "Token"),
    ).rejects.toMatchObject({ code: "secret_worker_deployment_unsupported" });
    fixture.request.mockClear();
    for (const name of [".", "..", "bad\nname", ""])
      await expect(
        provider.prepare(resource, { kind: "worker" }, name),
      ).rejects.toMatchObject({ code: "secret_name_invalid" });
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("separates live authority checks from destination deployment preflight and rejects forged snapshots", async () => {
    const { provider, resource } = await selected();
    const snapshot = await provider.prepare(
      resource,
      { kind: "worker" },
      "Token",
    );
    fixture.state.deploymentId = crypto.randomUUID();
    fixture.state.versionId = crypto.randomUUID();
    fixture.request.mockClear();
    await provider.checkPrepared(resource, snapshot);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(
      await provider.prepare(resource, { kind: "worker" }, "Token"),
    ).not.toEqual(snapshot);
    for (const altered of [
      { ...snapshot, workerDeployment: undefined },
      { ...snapshot, resourceIdentity: "d".repeat(32) + "/" + CF_ID },
      { ...snapshot, resourceRevision: CF_VERSION },
      {
        ...snapshot,
        workerDeployment: {
          ...snapshot.workerDeployment!,
          workerName: "second-worker",
        },
      },
      { ...snapshot, activation: "secret-update" as const },
    ])
      await expect(
        provider.checkPrepared(resource, altered),
      ).rejects.toMatchObject({ code: "secret_review_conflict" });
  });
  it("preserves exact transient bytes, validates limits and separates observation from acceptance", async () => {
    const { provider, resource } = await selected();
    const snapshot = await provider.prepare(
      resource,
      { kind: "worker" },
      "token",
    );
    const valid = provider.validateTransientInput!;
    expect(valid(snapshot, "\u03bb".repeat(2560))).toBe(true);
    for (const value of ["", "\u03bb".repeat(2561), "\ud800"])
      expect(valid(snapshot, value)).toBe(false);
    const value = CF_VALUE + "\n\u03bb\u0000";
    expect(await provider.writeTransient!(resource, snapshot, value)).toEqual({
      status: "accepted",
      reason: null,
    });
    const write = fixture.request.mock.calls.find(
      (call) => call[1]?.method === "PUT",
    )!;
    expect(JSON.parse(String(write[1]!.body))).toEqual({
      name: "token",
      text: value,
      type: "secret_text",
    });
    const observed = await provider.observe(resource, snapshot);
    expect(observed).toMatchObject({
      name: "token",
      createdAt: null,
      updatedAt: null,
    });
    expect(observed?.version).not.toBe(snapshot.resourceRevision);
    expect(JSON.stringify(observed)).not.toContain(CF_VALUE);
    fixture.state.workerId = "d".repeat(32);
    await expect(provider.observe(resource, snapshot)).rejects.toMatchObject({
      code: "secret_identity_changed",
    });
  });
  it("requires fresh workspace authority and prevents account or credential fallback", async () => {
    await fixture.saved();
    for (const service of [
      fixture.as("outside"),
      fixture.as("owner", { sourceId: "publisher" }),
      fixture.as("owner", { scopes: [CAPABILITY.ACTIVITY] }),
    ])
      await expect(
        service.secretsInventory({
          ...workspace,
          connectionId: "workers",
          target: fixture.target,
        }),
      ).rejects.toThrow();
    expect(fixture.request).not.toHaveBeenCalled();
    await expect(
      secretAdapter("cloudflare-workers").connect(
        fixture.as(),
        "beta",
        CF_CREDENTIAL,
      ),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await expect(
      secretAdapter("cloudflare-workers").connect(
        fixture.as(),
        "alpha",
        "legacy-account-token",
      ),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    expect(
      await fixture
        .as("viewer")
        .secretsInventory({
          ...workspace,
          connectionId: "workers",
          target: fixture.target,
        }),
    ).toMatchObject({ providerKind: "cloudflare-workers" });
    fixture.runtime.PROVIDER_CREDENTIAL_KEYS = "";
    expect(await fixture.as().secretsConnections(workspace)).toEqual([
      expect.objectContaining({ available: false }),
    ]);
    await expect(inventory()).rejects.toMatchObject({
      code: "provider_credential_unavailable",
    });
  });
  it("verifies exact Worker metadata without claiming write permission and rechecks rotation during reads", async () => {
    const input = {
      ...workspace,
      credentialId: CF_CREDENTIAL,
      revision: 1,
      resourceName: CF_WORKER,
    };
    expect(await fixture.as().providerCredentialVerify(input)).toMatchObject({
      scope: { kind: "worker" },
      entryKind: "secret",
      evidence: "secret-metadata-readable",
      writePermissionVerified: false,
    });
    expect(fixture.request).toHaveBeenCalledTimes(5);
    fixture.request.mockClear();
    expect(
      await fixture.as().providerCredentialVerify({
        ...input,
        entryKind: "variable",
      }),
    ).toMatchObject({
      scope: { kind: "worker" },
      entryKind: "variable",
      evidence: "variable-values-readable",
      writePermissionVerified: false,
    });
    expect(fixture.request).toHaveBeenCalledTimes(5);
    expect(
      fixture.request.mock.calls.map(([request]) => String(request)).join("\n"),
    ).toContain("/settings");
    expect(
      fixture.request.mock.calls.map(([request]) => String(request)).join("\n"),
    ).not.toContain("/secrets");
    fixture.request.mockClear();
    await expect(
      fixture
        .as()
        .providerCredentialVerify({ ...input, resourceName: "unselected" }),
    ).rejects.toMatchObject({ code: "secret_worker_denied" });
    await expect(
      fixture
        .as()
        .providerCredentialVerify({ ...input, scope: { kind: "repository" } }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      fixture.as("operator").providerCredentialVerify(input),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fixture.request).not.toHaveBeenCalled();
    const original = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementationOnce(async (url, init) => {
      const response = await original(url, init);
      await fixture.install(cfSettings, 1);
      return response;
    });
    await expect(
      fixture.as().providerCredentialVerify(input),
    ).rejects.toMatchObject({ code: "provider_credential_conflict" });
  });
  it("never converts denied inventory into empty evidence and honors read-only credentials", async () => {
    await fixture.install({ ...cfSettings, writable: false }, 1);
    const { provider, resource } = await selected();
    const snapshot = await provider.prepare(
      resource,
      { kind: "worker" },
      "Token",
    );
    fixture.request.mockClear();
    expect(
      await provider.writeTransient!(resource, snapshot, CF_VALUE),
    ).toEqual({ status: "rejected", reason: "credential_read_only" });
    expect(await provider.remove(resource, snapshot)).toEqual({
      status: "rejected",
      reason: "credential_read_only",
    });
    expect(fixture.request).not.toHaveBeenCalled();
    fixture.state.status = 403;
    await expect(inventory()).rejects.toMatchObject({
      code: "secret_permission_denied",
    });
  });
});
