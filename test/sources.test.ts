import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "../worker/service";
import { resolveProductionPrincipal } from "../worker/auth";
import production from "../worker/index";
import development from "../worker/development";
import { createApplication } from "../worker/app";
import { callCommand, clientConfiguration } from "../cli/client";
import type { IssuedPublisherCredential } from "../shared/sources";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Principal,
  type Connection,
} from "../shared/domain";
import { SOURCE_LIMITS, sourceFreshness } from "../shared/sources";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const owner: Principal = { subject: "owner", displayName: "Owner" };
const workspaceId = "alpha";
let now = Date.now();
let service: WorkspaceService;
let repositoryId: string;
let secondId: string;
let source: Connection;
const fields = () => ({
  name: "Test laptop",
  enabled: true,
  freshnessMinutes: 15,
  repositoryIds: [repositoryId, secondId],
});
const issueInput = () => ({
  workspaceId,
  sourceId: source.id,
  revision: source.revision,
  credentialId: "credential",
  name: "Local publisher",
  expiresInDays: 30,
});
const report = (reportId = "report", timestamp = now) => ({
  workspaceId,
  sourceId: source.id,
  reportId,
  observations: [
    {
      repositoryId,
      observedAt: new Date(timestamp).toISOString(),
      branch: "main",
      dirty: false,
      ahead: 0,
    },
  ],
});

beforeAll(async () => {
  await applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS);
});
beforeEach(async () => {
  now = Date.now();
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('alpha', 'Alpha', '2026-01-01'), ('beta', 'Beta', '2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members (workspace_id, subject, display_name, role) VALUES ('alpha', 'owner', 'Owner', 'owner'), ('alpha', 'operator', 'Operator', 'operator'), ('alpha', 'viewer', 'Viewer', 'viewer'), ('beta', 'other', 'Other', 'owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects (id,workspace_id,name,description) VALUES ('project','alpha','Project','')",
    ),
  ]);
  service = new WorkspaceService(bindings, owner, false, () => now);
  const repository = {
    fullName: "example/first",
    description: "Synthetic",
    projectId: "project",
    classification: "maintained",
    lifecycle: "active",
    expectations: DEFAULT_EXPECTATIONS,
  };
  repositoryId = (await service.createRepository({ workspaceId, repository }))
    .id;
  secondId = (
    await service.createRepository({
      workspaceId,
      repository: { ...repository, fullName: "example/second" },
    })
  ).id;
  source = await service.sourceEnroll({
    workspaceId,
    sourceId: "laptop",
    source: fields(),
  });
});

async function publisher() {
  const issued = await service.publisherCredentialIssue(issueInput());
  const principal = await resolveProductionPrincipal(
    new Request("https://hq.example/api/session", {
      headers: { Authorization: "Bearer " + issued.token },
    }),
    bindings,
  );
  return {
    ...issued,
    principal,
    publisher: new WorkspaceService(bindings, principal, false, () => now),
  };
}

describe("Publisher ownership and credential custody", () => {
  it("enrolls idempotently and restricts administration to owners", async () => {
    expect(
      await service.sourceEnroll({
        workspaceId,
        sourceId: source.id,
        source: fields(),
      }),
    ).toEqual(source);
    await expect(
      service.sourceEnroll({
        workspaceId,
        sourceId: source.id,
        source: { ...fields(), name: "Changed" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await service.activity({ workspaceId })).filter(
        (event) => event.type === "source.enrolled",
      ),
    ).toHaveLength(1);
    for (const subject of ["operator", "viewer"]) {
      const actor = new WorkspaceService(bindings, {
        subject,
        displayName: subject,
      });
      await expect(
        actor.sourceEnroll({
          workspaceId,
          sourceId: "another",
          source: fields(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        actor.publisherCredentialIssue(issueInput()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        actor.publisherCredentials({ workspaceId, sourceId: source.id }),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      service.sourceGet({ workspaceId: "beta", sourceId: source.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.sourceEnroll({
        workspaceId,
        sourceId: "unknown",
        source: { ...fields(), repositoryIds: ["not-enrolled"] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reveals a credential once and keeps the value and digest out of metadata and audit", async () => {
    const { token, principal } = await publisher();
    expect(token).toMatch(/^hqp_[a-f0-9]{64}$/);
    expect(principal.scopes).toEqual([CAPABILITY.PUBLISH]);
    expect(principal.sourceId).toBe(source.id);
    await expect(
      service.publisherCredentialIssue(issueInput()),
    ).rejects.toMatchObject({ status: 409 });
    const metadata = JSON.stringify([
      await service.snapshot({ workspaceId }),
      await service.publisherCredentials({ workspaceId, sourceId: source.id }),
    ]);
    const row = await bindings.HQ_DB.prepare(
      "SELECT token_hash FROM credentials WHERE id = 'credential'",
    ).first<{ token_hash: string }>();
    expect(metadata).not.toContain(token);
    expect(metadata).not.toContain(row!.token_hash);
    expect(metadata).not.toContain("token_hash");
    expect(row!.token_hash).not.toContain(token);
  });

  it("requires the reviewed source revision and enabled state before granting credentials", async () => {
    await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: source.revision,
      source: { ...fields(), enabled: false },
    });
    await expect(
      service.publisherCredentialIssue(issueInput()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await service.publisherCredentials({ workspaceId, sourceId: source.id }),
    ).toHaveLength(0);
  });

  it("denies publisher reads, metadata changes, cross-source and cross-workspace reports", async () => {
    const { publisher: agent, token } = await publisher();
    await expect(agent.session()).rejects.toMatchObject({ status: 403 });
    await expect(agent.snapshot({ workspaceId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      agent.sourceUpdate({
        workspaceId,
        sourceId: source.id,
        revision: 1,
        source: fields(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      agent.observationsPublish({ ...report(), sourceId: "another" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      agent.observationsPublish({ ...report(), workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.observationsPublish(report())).rejects.toMatchObject({
      status: 403,
    });
    const response = await production.fetch(
      new Request("https://hq.example/api/session", {
        headers: { Authorization: "Bearer " + token },
      }),
      bindings,
    );
    expect(response.status).toBe(403);
    const devResponse = await development.fetch(
      new Request("http://127.0.0.1:5178/api/session", {
        headers: { Authorization: "Bearer invalid" },
      }),
      bindings,
    );
    expect(devResponse.status).toBe(401);
  });

  it("revokes idempotently and invalidates already-resolved principals", async () => {
    const { publisher: agent, token } = await publisher();
    const input = {
      workspaceId,
      sourceId: source.id,
      credentialId: "credential",
    };
    const [a, b] = await Promise.all([
      service.publisherCredentialRevoke(input),
      service.publisherCredentialRevoke(input),
    ]);
    expect(a).toEqual(b);
    expect(
      (await service.activity({ workspaceId })).filter(
        (event) => event.type === "publisher.credential.revoked",
      ),
    ).toHaveLength(1);
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    await expect(
      resolveProductionPrincipal(
        new Request("https://hq.example", {
          headers: { Authorization: "Bearer " + token },
        }),
        bindings,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("Bounded, ordered observation ingestion", () => {
  it("checks expiry at the database write time, not only at request authentication", async () => {
    now = Date.now() - 10000;
    const { principal } = await publisher();
    const db = bindings.HQ_DB;
    const guarded = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await db
          .prepare(
            "UPDATE credentials SET expires_at = ? WHERE id = 'credential'",
          )
          .bind(new Date(Date.now() - 1).toISOString())
          .run();
        return db.batch(statements);
      },
    } as D1Database;
    const agent = new WorkspaceService(
      { ...bindings, HQ_DB: guarded },
      principal,
      false,
      () => now,
    );
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 409,
    });
    expect(await service.observations({ workspaceId })).toHaveLength(0);
  });

  it("rejects a mixed-order batch without updating either repository or its receipt", async () => {
    const { publisher: agent } = await publisher();
    const first = report();
    first.observations.push({
      ...first.observations[0],
      repositoryId: secondId,
    });
    await agent.observationsPublish(first);
    const before = await service.observations({ workspaceId });
    const sourceBefore = await service.sourceGet({
      workspaceId,
      sourceId: source.id,
    });
    now += SOURCE_LIMITS.REPORT_INTERVAL_MS;
    await expect(
      agent.observationsPublish({
        ...report("mixed"),
        observations: [
          report().observations[0],
          { ...first.observations[1], dirty: true },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.observations({ workspaceId })).toEqual(before);
    expect(
      (await service.sourceGet({ workspaceId, sourceId: source.id }))
        .lastSuccessAt,
    ).toBe(sourceBefore.lastSuccessAt);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS total FROM publisher_reports",
      ).first("total"),
    ).toBe(1);
  });

  it("retains duplicate receipts, ignores no timestamps, and does not freshen retries", async () => {
    const { publisher: agent } = await publisher();
    const input = report();
    const [a, b] = await Promise.all([
      agent.observationsPublish(input),
      agent.observationsPublish(input),
    ]);
    expect(a).toEqual(b);
    const before = await service.observations({ workspaceId });
    now += SOURCE_LIMITS.MINUTE_MS;
    expect(await agent.observationsPublish(input)).toEqual(a);
    expect(await service.observations({ workspaceId })).toEqual(before);
    await expect(
      agent.observationsPublish({
        ...input,
        observations: [{ ...input.observations[0], dirty: true }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      agent.observationsPublish(report("older", now - 120000)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await service.activity({ workspaceId })).filter(
        (event) => event.type === "source.reported",
      ),
    ).toHaveLength(1);
    await agent.observationsPublish(report("newer"));
    expect(
      (await service.activity({ workspaceId })).filter(
        (event) => event.type === "source.reported",
      ),
    ).toHaveLength(1);
  });

  it("validates the entire batch and never accepts provider or freshness claims from a publisher", async () => {
    const { publisher: agent } = await publisher();
    const input = report();
    for (const invalid of [
      { ...input, provider: "github" },
      { ...input, observations: [{ ...input.observations[0], ci: "passing" }] },
      {
        ...input,
        observations: [
          { ...input.observations[0], expiresAt: "2099-01-01T00:00:00Z" },
        ],
      },
      {
        ...input,
        observations: [input.observations[0], input.observations[0]],
      },
    ])
      await expect(agent.observationsPublish(invalid)).rejects.toThrow();
    await expect(
      agent.observationsPublish({
        ...input,
        observations: [
          ...input.observations,
          { ...input.observations[0], repositoryId: "unowned" },
        ],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await service.observations({ workspaceId })).toHaveLength(0);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS total FROM publisher_reports",
      ).first("total"),
    ).toBe(0);
  });

  it("enforces source-wide rate limits and observation ordering across credentials", async () => {
    const { publisher: agent } = await publisher();
    await agent.observationsPublish(report());
    now += 1000;
    await expect(
      agent.observationsPublish(report("too-fast")),
    ).rejects.toMatchObject({ status: 429 });
    now += SOURCE_LIMITS.REPORT_INTERVAL_MS;
    const outcomes = await Promise.allSettled([
      agent.observationsPublish(report("a")),
      agent.observationsPublish(report("b", now - 1)),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const saved = (await service.observations({ workspaceId }))[0];
    now += SOURCE_LIMITS.REPORT_INTERVAL_MS;
    await expect(
      agent.observationsPublish(
        report("stale", Date.parse(saved.observedAt) - 1),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.observations({ workspaceId }))[0]).toEqual(saved);
  });

  it("checks revocation atomically even when it occurs after request authentication", async () => {
    const { principal } = await publisher();
    const db = bindings.HQ_DB;
    const guarded = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await service.publisherCredentialRevoke({
          workspaceId,
          sourceId: source.id,
          credentialId: "credential",
        });
        return db.batch(statements);
      },
    } as D1Database;
    const agent = new WorkspaceService(
      { ...bindings, HQ_DB: guarded },
      principal,
      false,
      () => now,
    );
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 409,
    });
    expect(await service.observations({ workspaceId })).toHaveLength(0);
    expect(
      await db
        .prepare("SELECT count(*) AS total FROM publisher_reports")
        .first("total"),
    ).toBe(0);
  });

  it("checks membership loss, expiry, disabled sources, and narrowed repository scope", async () => {
    const { publisher: agent } = await publisher();
    source = await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: 1,
      source: { ...fields(), repositoryIds: [secondId] },
    });
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 403,
    });
    source = await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: source.revision,
      source: { ...fields(), enabled: false },
    });
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 403,
    });
    source = await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: source.revision,
      source: fields(),
    });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role = 'viewer' WHERE workspace_id = 'alpha' AND subject = 'owner'",
    ).run();
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 403,
    });
    await bindings.HQ_DB.prepare(
      "UPDATE members SET role = 'owner' WHERE workspace_id = 'alpha' AND subject = 'owner'",
    ).run();
    now += 31 * SOURCE_LIMITS.DAY_MS;
    await expect(agent.observationsPublish(report())).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("Shared CLI and MCP contract", () => {
  it("uses real bearer authorization for the same publishing and revocation operations", async () => {
    const ownerApp = createApplication(async () => owner);
    async function rpc(name: string, input: unknown, token?: string) {
      const response = await (token ? production : ownerApp).fetch(
        new Request("https://hq.example/mcp", {
          method: "POST",
          headers: {
            Origin: "https://hq.example",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: input },
          }),
        }),
        bindings,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
    }
    const issuedResult = await rpc("publisher_credential_issue", issueInput());
    expect(issuedResult.result.isError).not.toBe(true);
    const issued = JSON.parse(
      issuedResult.result.content[0].text,
    ) as IssuedPublisherCredential;
    const payload = report();
    const published = await rpc("observations_publish", payload, issued.token);
    expect(published.result.isError).not.toBe(true);
    const denied = await rpc(
      "source_get",
      { workspaceId, sourceId: source.id },
      issued.token,
    );
    expect(denied.result.isError).toBe(true);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(init?.redirect).toBe("error");
        // The edge Request constructor accepts only follow or manual
        return production.fetch(
          new Request(input, { ...init, redirect: "manual" }),
          bindings,
        );
      });
    try {
      const configuration = clientConfiguration(
        "https://hq.example",
        false,
        issued.token,
      );
      const result = await callCommand(
        configuration,
        "observations_publish",
        payload,
      );
      expect(result).toEqual(JSON.parse(published.result.content[0].text));
      const revoked = await rpc("publisher_credential_revoke", {
        workspaceId,
        sourceId: source.id,
        credentialId: issued.credential.id,
      });
      expect(revoked.result.isError).not.toBe(true);
      await expect(
        callCommand(configuration, "observations_publish", payload),
      ).rejects.toMatchObject({ exitCode: 1 });
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("Connection freshness and optimistic settings", () => {
  it("shows missing, partial, fresh, stale, disabled, and expired-credential states honestly", async () => {
    expect(sourceFreshness(source, [], now).label).toBe("No active credential");
    const { publisher: agent } = await publisher();
    source = await service.sourceGet({ workspaceId, sourceId: source.id });
    expect(sourceFreshness(source, [], now).label).toBe(
      "Awaiting first report",
    );
    await agent.observationsPublish(report());
    expect(
      sourceFreshness(source, await service.observations({ workspaceId }), now)
        .label,
    ).toBe("Partially observed");
    now += SOURCE_LIMITS.REPORT_INTERVAL_MS;
    await agent.observationsPublish({
      ...report("second"),
      observations: [{ ...report().observations[0], repositoryId: secondId }],
    });
    expect(
      sourceFreshness(source, await service.observations({ workspaceId }), now)
        .label,
    ).toBe("Reports current");
    now += 16 * SOURCE_LIMITS.MINUTE_MS;
    expect(
      sourceFreshness(source, await service.observations({ workspaceId }), now)
        .label,
    ).toBe("Reports stale");
    source = await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: source.revision,
      source: { ...fields(), freshnessMinutes: 60 },
    });
    expect(
      sourceFreshness(source, await service.observations({ workspaceId }), now)
        .label,
    ).toBe("Reports stale");
    source = await service.sourceUpdate({
      workspaceId,
      sourceId: source.id,
      revision: source.revision,
      source: { ...fields(), enabled: false },
    });
    expect(
      sourceFreshness(source, await service.observations({ workspaceId }), now)
        .label,
    ).toBe("Disabled");
  });

  it("does not turn a delayed report into fresh evidence", async () => {
    const { publisher: agent } = await publisher();
    await agent.observationsPublish(
      report("delayed", now - 60 * SOURCE_LIMITS.MINUTE_MS),
    );
    const evidence = await service.observations({ workspaceId });
    expect(Date.parse(evidence[0].expiresAt)).toBeLessThan(now);
    expect(evidence[0].provider).toBe("local");
    expect(evidence[0].details).not.toHaveProperty("ci");
  });

  it("accepts one concurrent settings save without mixed scopes or extra audit", async () => {
    const outcomes = await Promise.allSettled([
      service.sourceUpdate({
        workspaceId,
        sourceId: source.id,
        revision: 1,
        source: { ...fields(), repositoryIds: [repositoryId] },
      }),
      service.sourceUpdate({
        workspaceId,
        sourceId: source.id,
        revision: 1,
        source: { ...fields(), repositoryIds: [secondId] },
      }),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await service.sourceGet({ workspaceId, sourceId: source.id }))
        .repositoryIds,
    ).toHaveLength(1);
    expect(
      (await service.activity({ workspaceId })).filter(
        (event) => event.type === "source.updated",
      ),
    ).toHaveLength(1);
  });
});
