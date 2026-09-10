import { describe, expect, it } from "vitest";
import {
  FLEET_DISCOVERY_LIMITS,
  fleetDiscoveryInput,
  fleetReconciliationPlanInput,
  type FleetDiscoveryScope,
  type FleetLookup,
} from "../shared/fleet-discovery";
import { collectFleetDiscovery } from "../worker/fleet-discovery-client";

const OWNER: FleetDiscoveryScope = {
  kind: "owner",
  owner: "example",
  cursor: null,
};
const ENROLLED: FleetDiscoveryScope = { kind: "enrolled", cursor: null };
const TOKEN = "synthetic-fleet-credential";
const node = (fields = {}) => ({
  id: "R_Example",
  nameWithOwner: "example/one",
  description: "A repository",
  isArchived: false,
  isPrivate: false,
  ...fields,
});
const catalog = (fields = {}) => ({
  data: {
    catalog: {
      login: "example",
      repositories: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: "cursor" },
        nodes: [node()],
        ...fields,
      },
    },
  },
});
const lookup = (fields = {}): FleetLookup => ({
  repositoryId: "one",
  fullName: "example/one",
  githubId: null,
  ...fields,
});
const response = (body: unknown) => Response.json(body);
const fetcher = (body: unknown) => (async () => response(body)) as typeof fetch;

describe("Fleet discovery contract", () => {
  it("binds provider cursors to the explicit source, revision and owner", () => {
    const input = {
      workspaceId: "alpha",
      sourceId: "github",
      sourceRevision: 1,
      scope: OWNER,
    };
    expect(fleetDiscoveryInput.parse(input).scope).toEqual(OWNER);
    const cursor = {
      sourceId: "github",
      sourceRevision: 1,
      owner: "example",
      after: "opaque",
    };
    expect(
      fleetDiscoveryInput.safeParse({ ...input, scope: { ...OWNER, cursor } })
        .success,
    ).toBe(true);
    for (const patch of [
      { sourceId: "other" },
      { sourceRevision: 2 },
      { owner: "another" },
    ]) {
      expect(
        fleetDiscoveryInput.safeParse({
          ...input,
          scope: { ...OWNER, cursor: { ...cursor, ...patch } },
        }).success,
      ).toBe(false);
    }
    expect(
      fleetDiscoveryInput.safeParse({ ...input, url: "https://example.com" })
        .success,
    ).toBe(false);
    expect(
      fleetDiscoveryInput.safeParse({
        ...input,
        scope: { kind: "owner", owner: "example/path" },
      }).success,
    ).toBe(false);
  });
  it("requires explicit new tracking and collection choices without accepting duplicate identities", () => {
    const selection = {
      githubId: "R_Example",
      fullName: "example/one",
      lifecycle: "active",
      repositoryId: null,
      revision: null,
      classification: "watchlist",
      projectId: "project",
      projectRevision: 1,
      collect: false,
    };
    const input = {
      workspaceId: "alpha",
      sourceId: "github",
      sourceRevision: 1,
      reviewId: "c7d25d9d-9362-4ed0-a7fc-fb49bc2ff87f",
      selections: [selection],
    };
    expect(fleetReconciliationPlanInput.safeParse(input).success).toBe(true);
    expect(
      fleetReconciliationPlanInput.safeParse({
        ...input,
        selections: [{ ...selection, classification: null }],
      }).success,
    ).toBe(false);
    expect(
      fleetReconciliationPlanInput.safeParse({
        ...input,
        selections: [{ ...selection, collect: undefined }],
      }).success,
    ).toBe(false);
    expect(
      fleetReconciliationPlanInput.safeParse({
        ...input,
        selections: [selection, selection],
      }).success,
    ).toBe(false);
    expect(
      fleetReconciliationPlanInput.safeParse({
        ...input,
        selections: [
          {
            ...selection,
            repositoryId: "one",
            revision: 1,
            classification: null,
            projectId: null,
            projectRevision: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      fleetReconciliationPlanInput.safeParse({
        ...input,
        selections: [{ ...selection, repositoryId: "one", revision: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("Bounded read-only GitHub fleet discovery", () => {
  it("uses one fixed-origin query with explicit owner, bounded fields and provider pagination", async () => {
    const fetch: typeof globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://api.github.com/graphql");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer " + TOKEN,
      );
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({ owner: "example" });
      expect(body.query).toContain(
        "first: " + FLEET_DISCOVERY_LIMITS.PAGE_SIZE,
      );
      expect(body.query).toContain("ownerAffiliations: [OWNER]");
      expect(body.query).toMatch(/^query /);
      return response(
        catalog({
          totalCount: 70,
          pageInfo: { hasNextPage: true, endCursor: "next-page" },
        }),
      );
    };
    const result = await collectFleetDiscovery(OWNER, [], TOKEN, { fetch });
    expect(result.read.state).toBe("observed");
    expect(result.requests).toBe(1);
    expect(result.total).toBe(70);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("next-page");
    expect(result.records[0].repository).toEqual({
      githubId: "R_Example",
      fullName: "example/one",
      description: "A repository",
      archived: false,
      private: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("keeps cursors in variables and preserves private/archive facts without inferring authority", async () => {
    const scope: FleetDiscoveryScope = {
      kind: "owner",
      owner: "example",
      cursor: {
        sourceId: "source",
        sourceRevision: 1,
        owner: "example",
        after: "opaque-cursor",
      },
    };
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body)).variables).toEqual({
        owner: "example",
        after: "opaque-cursor",
      });
      return response(
        catalog({
          nodes: [
            node({
              isArchived: true,
              isPrivate: true,
              description: null,
              permissions: { admin: true },
            }),
          ],
        }),
      );
    };
    const result = await collectFleetDiscovery(scope, [], TOKEN, { fetch });
    expect(result.records[0].repository).toMatchObject({
      archived: true,
      private: true,
      description: "",
    });
    expect(JSON.stringify(result)).not.toContain("admin");
  });
  it("performs rename-aware name lookups and pinned node lookups without HTTP redirects", async () => {
    const selected = [
      lookup(),
      lookup({
        repositoryId: "two",
        fullName: "example/old",
        githubId: "R_Stable",
      }),
    ];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      expect(variables).toEqual({
        owner0: "example",
        name0: "one",
        id1: "R_Stable",
      });
      expect(query).toContain("followRenames: true");
      expect(query).toContain("node(id: $id1)");
      expect(query).not.toContain("R_Stable");
      return response({
        data: {
          repository0: node({ nameWithOwner: "new-owner/renamed" }),
          repository1: node({
            id: "R_Stable",
            nameWithOwner: "another/transferred",
          }),
        },
      });
    };
    const result = await collectFleetDiscovery(ENROLLED, selected, TOKEN, {
      fetch,
    });
    expect(result.read.state).toBe("observed");
    expect(result.records.map((record) => record.repository?.fullName)).toEqual(
      ["new-owner/renamed", "another/transferred"],
    );
    expect(result.records[1].lookupGithubId).toBe("R_Stable");
  });
  it("keeps failed aliases separate from accepted repository identities and never reports removal", async () => {
    const result = await collectFleetDiscovery(
      ENROLLED,
      [lookup(), lookup({ repositoryId: "two", fullName: "example/two" })],
      TOKEN,
      {
        fetch: fetcher({
          data: { repository0: node(), repository1: null },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository1"],
              message: "private error text",
            },
          ],
        }),
      },
    );
    expect(result.read.state).toBe("error");
    expect(result.records[0].read.state).toBe("observed");
    expect(result.records[1]).toMatchObject({
      repository: null,
      read: { state: "unavailable", reason: "permission" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private error text|deleted|removed/,
    );
  });
  it("rejects a mismatched pinned identity", async () => {
    const result = await collectFleetDiscovery(
      ENROLLED,
      [lookup({ githubId: "R_Expected" })],
      TOKEN,
      { fetch: fetcher({ data: { repository0: node({ id: "R_Wrong" }) } }) },
    );
    expect(result.records[0]).toMatchObject({
      repository: null,
      read: { state: "error", reason: "response_invalid" },
    });
  });
  it.each([
    { data: { catalog: null } },
    {
      data: { catalog: null },
      errors: [{ type: "FORBIDDEN", path: ["catalog"] }],
    },
  ])(
    "does not turn an unavailable owner into an empty successful catalog",
    async (body) => {
      const result = await collectFleetDiscovery(OWNER, [], TOKEN, {
        fetch: fetcher(body),
      });
      expect(result.read).toEqual({
        state: "unavailable",
        reason: "permission",
      });
      expect(result.total).toBeNull();
      expect(result.records).toEqual([]);
    },
  );
  it.each([
    catalog({ nodes: [node(), node()] }),
    catalog({ nodes: [node({ nameWithOwner: "another/one" })] }),
    catalog({ totalCount: 0 }),
    catalog({ nodes: [node({ description: "x".repeat(501) })] }),
    catalog({ pageInfo: { hasNextPage: true, endCursor: null } }),
    { ...catalog(), errors: [{ type: "FORBIDDEN", path: ["unexpected"] }] },
    { data: { catalog: null, unexpected: node() } },
  ])("fails closed on malformed or out-of-scope catalogs", async (body) => {
    const result = await collectFleetDiscovery(OWNER, [], TOKEN, {
      fetch: fetcher(body),
    });
    expect(result.read).toEqual({ state: "error", reason: "response_invalid" });
    expect(result.records).toEqual([]);
    expect(result.total).toBeNull();
  });
  it("retains a bounded cooldown for GraphQL rate limits without accepting apparent data", async () => {
    const now = Date.now();
    const result = await collectFleetDiscovery(OWNER, [], TOKEN, {
      now: () => now,
      fetch: fetcher({
        ...catalog(),
        errors: [{ type: "RATE_LIMITED", path: ["catalog"] }],
      }),
    });
    expect(result.read).toEqual({
      state: "rate_limited",
      reason: "rate_limit",
    });
    expect(Date.parse(result.retryAt!)).toBeGreaterThan(now);
    expect(result.records).toEqual([]);
  });
  it("rejects non-advancing or empty continuation pages", async () => {
    const scope: FleetDiscoveryScope = {
      kind: "owner",
      owner: "example",
      cursor: {
        sourceId: "source",
        sourceRevision: 1,
        owner: "example",
        after: "repeated",
      },
    };
    for (const body of [
      catalog({
        totalCount: 2,
        pageInfo: { hasNextPage: true, endCursor: "repeated" },
      }),
      catalog({
        totalCount: 2,
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      }),
    ]) {
      const result = await collectFleetDiscovery(scope, [], TOKEN, {
        fetch: fetcher(body),
      });
      expect(result.read).toEqual({
        state: "limited",
        reason: "pagination_invalid",
      });
      expect(result.hasMore).toBe(false);
    }
  });
  it("does not follow credential-bearing redirects or expose provider errors", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      return new Response("private upstream body", {
        status: 301,
        headers: { location: "https://example.com/credential-capture" },
      });
    };
    const result = await collectFleetDiscovery(OWNER, [], TOKEN, { fetch });
    expect(result.read.reason).toBe("redirect");
    expect(requests).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(
      /credential-capture|private upstream body/,
    );
  });
  it("rejects invalid credentials, oversized lookup sets and duplicate HQ identities before provider I/O", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw Error("Provider must not be contacted");
    };
    for (const [selected, token] of [
      [[lookup()], "unsafe\ncredential"],
      [[lookup(), lookup()], TOKEN],
      [
        Array.from(
          { length: FLEET_DISCOVERY_LIMITS.PAGE_SIZE + 1 },
          (_, index) => lookup({ repositoryId: "repo" + index }),
        ),
        TOKEN,
      ],
    ] as [FleetLookup[], string][]) {
      const result = await collectFleetDiscovery(ENROLLED, selected, token, {
        fetch,
      });
      expect(result.requests).toBe(0);
      expect(result.read.state).not.toBe("observed");
    }
  });
  it("handles an empty enrolled page without a provider request", async () => {
    const result = await collectFleetDiscovery(ENROLLED, [], TOKEN, {
      fetch: fetcher({}),
    });
    expect(result).toMatchObject({
      requests: 0,
      total: 0,
      records: [],
      read: { state: "observed" },
    });
  });
});
