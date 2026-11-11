import { describe, expect, it, vi } from "vitest";
import { DependencyGitHub } from "../worker/dependency-github";
import { SecretGitHubClient } from "../worker/secret-github-client";

describe("native GitHub provider transports", () => {
  it("creates maintenance requests accepted by the native Worker runtime", async () => {
    const sha = "a".repeat(40);
    const client = new DependencyGitHub("example/repository", "synthetic-token", async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      return Response.json({ sha }, { status: 201 });
    });
    expect(await client.tree(sha, [])).toBe(sha);
  });

  it("rejects redirect responses without following them or retaining their destination", async () => {
    const privateLocation = "https://private.invalid/private-bearer";
    const client = new DependencyGitHub("example/repository", "synthetic-token", async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: privateLocation } });
    });
    const error = await client.readBranch("main").catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: "provider_unavailable", diagnostic: { stage: "response", errorType: "HttpStatus", status: 302 } });
    expect(client.requests).toBe(1);
    expect(JSON.stringify(error)).not.toContain(privateLocation);
  });

  it.each([false, true])("preserves native fetch for configuration reads with explicit transport %s", async (explicit) => {
    const repository = {
      id: 101,
      full_name: "example/repository",
      archived: false,
      disabled: false,
      owner: { id: 50, login: "example", type: "Organization" },
    };
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json(repository));
    });
    try {
      const client = new SecretGitHubClient({
        workspaceId: "fixture", name: "Fixture", revision: 1,
        token: "synthetic-token", expiresAt: null,
        repositoryNames: [repository.full_name], writable: false,
      }, explicit ? globalThis.fetch : undefined);
      expect(await client.repository(repository.full_name)).toMatchObject({ id: repository.id });
    } finally { request.mockRestore(); }
  });

  it.each([false, true])("preserves native fetch for maintenance with explicit transport %s", async (explicit) => {
    const sha = "a".repeat(40);
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ ref: "refs/heads/main", object: { type: "commit", sha } }));
    });
    try {
      const client = new DependencyGitHub("example/repository", "synthetic-token", explicit ? globalThis.fetch : undefined);
      expect(await client.readBranch("main")).toBe(sha);
    } finally { request.mockRestore(); }
  });
});
