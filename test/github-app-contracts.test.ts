import { describe, expect, it } from "vitest";
import {
  githubAuthReferenceSchema,
  githubAppMetadataSchema,
  githubAppPermissions,
} from "../shared/github-apps";
import { githubAppPrivateInputSchema } from "../shared/github-app-input";

const metadata = {
  id: "app-a",
  name: "Repository operator",
  appId: 42,
  slug: "repository-operator",
  visibility: "public",
  capabilities: ["collection"],
  revision: 1,
  state: "active",
  keyFingerprint: "a".repeat(64),
  lifecycleIngress: "ready",
};

describe("GitHub App public contracts", () => {
  it("uses GitHub's accepted Actions Variables permission name for configuration profiles", () => {
    for (const capability of [
      "configuration-read",
      "configuration-write",
    ] as const) {
      const permissions = githubAppPermissions([capability]);
      expect(permissions).toHaveProperty(
        "actions_variables",
        capability === "configuration-read" ? "read" : "write",
      );
      expect(permissions).not.toHaveProperty("variables");
    }
  });

  it("keeps token and App authority explicit without changing token reference spelling", () => {
    expect(
      githubAuthReferenceSchema.parse({
        kind: "token",
        reference: "app-grant-existing",
      }),
    ).toEqual({ kind: "token", reference: "app-grant-existing" });
    expect(
      githubAuthReferenceSchema.parse({ kind: "app", grantId: "grant-a" }),
    ).toEqual({ kind: "app", grantId: "grant-a" });
    for (const extra of ["token", "privateKey", "webhookSecret"]) {
      expect(
        githubAuthReferenceSchema.safeParse({
          kind: "app",
          grantId: "grant-a",
          [extra]: "private-canary",
        }).success,
      ).toBe(false);
      expect(
        githubAppMetadataSchema.safeParse({
          ...metadata,
          [extra]: "private-canary",
        }).success,
      ).toBe(false);
    }
    expect(githubAppMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it("derives selected permission unions without granting unrelated powers", () => {
    expect(
      githubAppPermissions(["repository-maintenance", "configuration-read"]),
    ).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      actions: "read",
      secrets: "read",
      actions_variables: "read",
      environments: "read",
    });
    const collection = githubAppPermissions(["collection"]);
    expect(collection).toEqual({
      metadata: "read",
      contents: "read",
      checks: "read",
      statuses: "read",
      pull_requests: "read",
      issues: "read",
      deployments: "read",
      vulnerability_alerts: "read",
      security_events: "read",
      secret_scanning_alerts: "read",
    });
    expect(
      githubAppPermissions(["configuration-write", "configuration-read"]),
    ).toEqual({
      metadata: "read",
      actions: "read",
      secrets: "write",
      actions_variables: "write",
      environments: "write",
    });
  });

  it("rejects ambiguous modes, unsafe identities and unsupported profiles", () => {
    for (const value of [
      { kind: "app", grantId: "grant-a", reference: "token-a" },
      { kind: "token", reference: "../credential" },
      { kind: "gh", reference: "ambient" },
    ])
      expect(githubAuthReferenceSchema.safeParse(value).success).toBe(false);
    expect(
      githubAppMetadataSchema.safeParse({
        ...metadata,
        capabilities: ["workflows"],
      }).success,
    ).toBe(false);
    expect(
      githubAppMetadataSchema.safeParse({ ...metadata, appId: 0 }).success,
    ).toBe(false);
    expect(
      githubAppMetadataSchema.safeParse({
        ...metadata,
        capabilities: ["collection", "collection"],
      }).success,
    ).toBe(false);
  });

  it("accepts material only in a bounded dedicated input envelope", () => {
    const input = {
      version: 1,
      privateKey: "synthetic-private-pem",
      webhookSecret: "synthetic-webhook-secret",
    };
    expect(githubAppPrivateInputSchema.parse(input)).toEqual(input);
    expect(
      githubAppPrivateInputSchema.safeParse({
        ...input,
        privateKey: "x".repeat(65537),
      }).success,
    ).toBe(false);
    expect(
      githubAppPrivateInputSchema.safeParse({
        ...input,
        token: "private-canary",
      }).success,
    ).toBe(false);
  });
});
