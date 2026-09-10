import { vi, expect } from "vitest";
import type { Principal } from "../../shared/domain";
import type { ProviderCredentialFields } from "../../shared/provider-credentials";
import { ProviderCredentials } from "../../worker/provider-credentials";
import { WorkspaceService } from "../../worker/service";
import type { Env } from "../../worker/types";

export const CF_ACCOUNT = "a".repeat(32);
export const CF_ID = "b".repeat(32);
export const CF_DEPLOYMENT = "11111111-1111-4111-8111-111111111111";
export const CF_VERSION = "22222222-2222-4222-8222-222222222222";
export const CF_TOKEN = "synthetic-cf-credential-canary";
export const CF_VALUE = "synthetic-cf-value-canary";
export const CF_VARIABLE_VALUE = "https://api.example.test";
export const CF_CREDENTIAL = "managed-cloudflare";
export const CF_WORKER = "selected-worker";
export const cfSettings: ProviderCredentialFields = {
  name: "Selected Workers",
  providerKind: "cloudflare-workers",
  writable: true,
  expiresAt: "2099-01-01T00:00:00.000Z",
  scope: { accountId: CF_ACCOUNT, workerNames: [CF_WORKER, "second-worker"] },
};
export async function cloudflareSecretsFixture(bindings: Env) {
  const runtime = {
    ...bindings,
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "test-key",
      keys: [{ id: "test-key", key: btoa("a".repeat(32)) }],
    }),
  };
  const state = {
    now: Date.now(),
    workerId: CF_ID,
    deploymentId: CF_DEPLOYMENT,
    versionId: CF_VERSION,
    split: false,
    secrets: [{ name: "Token", type: "secret_text" }],
    otherBindings: [
      {
        name: "VARIABLE",
        type: "plain_text",
        text: CF_VARIABLE_VALUE,
      },
      {
        name: "JSON_CONFIG",
        type: "json",
        json: { region: "test", retries: 2 },
      },
      { name: "CACHE", type: "kv_namespace" },
    ] as {
      name: string;
      type: string;
      text?: string;
      json?: unknown;
    }[],
    status: 200,
  };
  const secondState = {
    ...structuredClone(state),
    workerId: "c".repeat(32),
    deploymentId: "33333333-3333-4333-8333-333333333333",
    versionId: "44444444-4444-4444-8444-444444444444",
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('alpha','Alpha',?),('beta','Beta',?)",
    ).bind(
      new Date(state.now).toISOString(),
      new Date(state.now).toISOString(),
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','second','Second owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','outside','Outside','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  function as(subject = "owner", extra: Partial<Principal> = {}) {
    return new WorkspaceService(
      runtime,
      { subject, displayName: subject, ...extra },
      false,
      () => state.now,
    );
  }
  async function install(
    settings = cfSettings,
    revision = 0,
    credentialId = CF_CREDENTIAL,
  ) {
    const review = await as().providerCredentialPlan({
      workspaceId: "alpha",
      credentialId,
      revision,
      change: { kind: "save", settings, replaceToken: true },
    });
    await new ProviderCredentials(as()).upload(
      new Request("https://hq.example/api/provider-credentials/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": review.fingerprint,
        },
        body: JSON.stringify({ version: 1, token: CF_TOKEN }),
      }),
      { workspaceId: "alpha", planId: review.id },
    );
    return review;
  }
  const json = (result: unknown, status = 200) =>
    Response.json({ success: true, result }, { status });
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer " + CF_TOKEN,
    );
    const prefix = "/client/v4/accounts/" + CF_ACCOUNT + "/workers/";
    expect(url.pathname.startsWith(prefix)).toBe(true);
    const suffix = url.pathname.slice(prefix.length);
    const name = suffix.split("/")[1]!;
    expect([CF_WORKER, "second-worker"]).toContain(name);
    const workerState = name === CF_WORKER ? state : secondState;
    if (workerState.status !== 200)
      return new Response(CF_VALUE, { status: workerState.status });
    if (init?.method === "GET") {
      if (suffix === "workers/" + name)
        return json({
          id: workerState.workerId,
          name,
        });
      if (suffix === "scripts/" + name + "/deployments")
        return json({
          deployments: [
            {
              id: workerState.deploymentId,
              strategy: "percentage",
              versions: [
                {
                  version_id: workerState.versionId,
                  percentage: workerState.split ? 50 : 100,
                },
                ...(workerState.split
                  ? [{ version_id: CF_DEPLOYMENT, percentage: 50 }]
                  : []),
              ],
            },
          ],
        });
      if (suffix === "scripts/" + name + "/secrets")
        return json(
          workerState.secrets.map((item) => ({ ...item, text: CF_VALUE })),
        );
      if (suffix === "scripts/" + name + "/settings")
        return json({
          bindings: [
            ...workerState.secrets.map((item) => ({
              ...item,
              text: CF_VALUE,
            })),
            ...workerState.otherBindings.map((item) =>
              item.type === "plain_text"
                ? { ...item, text: item.text ?? CF_VARIABLE_VALUE }
                : item,
            ),
          ],
        });
    }
    if (init?.method === "PUT" && suffix === "scripts/" + name + "/secrets") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        type: string;
        text: string;
      };
      expect(body.type).toBe("secret_text");
      const item = { name: body.name, type: body.type };
      workerState.secrets = [
        ...workerState.secrets.filter((value) => value.name !== body.name),
        item,
      ];
      workerState.deploymentId = crypto.randomUUID();
      workerState.versionId = crypto.randomUUID();
      return json(item, 201);
    }
    if (
      init?.method === "DELETE" &&
      suffix.startsWith("scripts/" + name + "/secrets/")
    ) {
      const selected = decodeURIComponent(
        suffix.slice(("scripts/" + name + "/secrets/").length),
      );
      workerState.secrets = workerState.secrets.filter(
        (item) => item.name !== selected,
      );
      workerState.deploymentId = crypto.randomUUID();
      workerState.versionId = crypto.randomUUID();
      return json(null);
    }
    throw new Error("Unexpected bounded Cloudflare route");
  });
  vi.stubGlobal("fetch", request);
  const saved = () =>
    as().secretsConnectionSave({
      workspaceId: "alpha",
      connectionId: "workers",
      revision: 0,
      connection: {
        name: "Worker secrets",
        providerKind: "cloudflare-workers",
        providerRef: CF_CREDENTIAL,
        resourceIds: ["worker-" + CF_WORKER, "worker-second-worker"],
        enabled: true,
      },
    });
  const target = {
    resourceId: "worker-" + CF_WORKER,
    scope: { kind: "worker" as const },
  };
  return {
    runtime,
    state,
    secondState,
    as,
    install,
    saved,
    target,
    request,
    json,
  };
}
