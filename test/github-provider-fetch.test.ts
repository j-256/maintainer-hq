import { describe, expect, it, vi } from "vitest";
import { DependencyGitHub } from "../worker/dependency-github";
import { SecretGitHubClient } from "../worker/secret-github-client";

describe("native GitHub provider transports", () => {
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
