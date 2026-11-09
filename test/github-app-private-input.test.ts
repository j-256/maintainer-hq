import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApplication } from "../worker/app";
import { GitHubApps } from "../worker/github-app-registrations";
import { uploadGitHubAppMaterial } from "../worker/github-app-private-input";
import { githubAppTestKey } from "./helpers/github-app-keys";
import {
  createGitHubAppFixture,
  migrateGitHubAppFixture,
  githubAppTestPrincipal,
  type GitHubAppFixture,
} from "./helpers/github-app-fixture";

let fixture: GitHubAppFixture;
let key: Awaited<ReturnType<typeof githubAppTestKey>>;
beforeAll(async () => {
  await migrateGitHubAppFixture();
  key = await githubAppTestKey();
});
beforeEach(async () => {
  fixture = await createGitHubAppFixture();
  fixture.runtime.GITHUB_APP_ORIGIN = "https://hq.example";
});
afterEach(() => vi.restoreAllMocks());
const upstream = {
  id: 42,
  slug: "repository-operator",
  name: "Repository operator",
  owner: { id: 50, login: "example", type: "Organization" },
  permissions: { metadata: "read", contents: "read" },
};

describe("protected GitHub App import", () => {
  it("verifies the exact App, encrypts both materials and returns safe HTTP receipt headers", async () => {
    const review = await fixture.plan();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe("https://api.github.com/app");
        return Response.json(upstream);
      });
    const request = new Request(
      "https://hq.example/api/github-apps/input?workspaceId=administration&planId=" +
        review.id,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          "If-Match": review.fingerprint,
        },
        body: JSON.stringify({
          version: 1,
          privateKey: key.pkcs1,
          webhookSecret: "synthetic-lifecycle-secret",
        }),
      },
    );
    const response = await createApplication(async () =>
      githubAppTestPrincipal(),
    ).fetch(request, fixture.runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toContain("synthetic-lifecycle-secret");
    expect(JSON.parse(body)).toMatchObject({
      submitted: true,
      review: {
        applied: true,
        registration: {
          keyFingerprint: key.fingerprint,
          lifecycleIngress: "ready",
        },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const repeated = await fixture.operator.githubAppRegistrationApply({
      workspaceId: "administration",
      planId: review.id,
      fingerprint: review.fingerprint,
    });
    expect(repeated.applied).toBe(true);
  });

  it("checks review and origin before reading private material or contacting GitHub", async () => {
    const review = await fixture.plan();
    const provider = vi.spyOn(globalThis, "fetch");
    const invalid = new Request("https://hq.example/api/github-apps/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://other.example",
        "If-Match": review.fingerprint,
      },
      body: "private-canary",
    });
    await expect(
      uploadGitHubAppMaterial(invalid, fixture.operator, {
        workspaceId: "administration",
        planId: review.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(invalid.bodyUsed).toBe(false);
    const expired = new Request("https://hq.example/api/github-apps/input", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://hq.example",
        "If-Match": review.fingerprint,
      },
      body: "private-canary",
    });
    fixture.clock.now += 10 * 60 * 1000 + 1;
    await expect(
      uploadGitHubAppMaterial(expired, fixture.operator, {
        workspaceId: "administration",
        planId: review.id,
      }),
    ).rejects.toMatchObject({ code: "github_app_conflict" });
    expect(expired.bodyUsed).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects oversized input, substituted App identity and ordinary private command arguments", async () => {
    const review = await fixture.plan();
    const input = { workspaceId: "administration", planId: review.id };
    const request = (body: unknown) =>
      new Request("https://hq.example/api/github-apps/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          "If-Match": review.fingerprint,
        },
        body: JSON.stringify(body),
      });
    await expect(
      uploadGitHubAppMaterial(
        request({ version: 1, privateKey: "x".repeat(65537) }),
        fixture.operator,
        input,
      ),
    ).rejects.toThrow();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...upstream, id: 43 }),
    );
    await expect(
      uploadGitHubAppMaterial(
        request({ version: 1, privateKey: key.pkcs8 }),
        fixture.operator,
        input,
      ),
    ).rejects.toMatchObject({ code: "github_app_response_invalid" });
    expect(
      (
        await fixture.operator.githubAppList({
          workspaceId: "administration",
          scope: "administration",
        })
      ).registrations,
    ).toHaveLength(0);
    await expect(
      fixture.operator.githubAppRegistrationApply({
        ...input,
        fingerprint: review.fingerprint,
        privateKey: "private-canary",
      }),
    ).rejects.toThrow();
  });

  it("does not enable lifecycle ingress from a replacement key alone", async () => {
    const review = await fixture.plan();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(upstream));
    const result = await uploadGitHubAppMaterial(
      new Request("https://hq.example/api/github-apps/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://hq.example",
          "If-Match": review.fingerprint,
        },
        body: JSON.stringify({ version: 1, privateKey: key.pkcs8 }),
      }),
      fixture.operator,
      { workspaceId: "administration", planId: review.id },
    );
    expect(result.review.registration?.lifecycleIngress).toBe(
      "requires_webhook_secret",
    );
    expect(
      (await new GitHubApps(fixture.operator).registration("app-a"))
        ?.webhook_revision,
    ).toBeNull();
  });
});
