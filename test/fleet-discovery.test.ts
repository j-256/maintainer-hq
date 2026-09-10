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
import { GITHUB_CONTEXT_LIMITS } from "../shared/github-context";
import type {
  FleetDiscoveryInput,
  FleetProviderRecord,
} from "../shared/fleet-discovery";
import { credentialHash } from "../worker/credential-hash";
import { FleetDiscoveryService } from "../worker/fleet-discovery";
import {
  compareFleetRecords,
  type FleetInventoryRow,
} from "../worker/fleet-comparison";
import { WorkspaceService } from "../worker/service";
import type { Env } from "../worker/types";

const bindings = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const OWNER: Principal = { subject: "owner", displayName: "Owner" };
const TOKEN = "synthetic-fleet-read-only-credential";
let now: number;
let runtime: Env;
const as = (principal = OWNER) =>
  new WorkspaceService(runtime, principal, false, () => now);
const discovery = (principal = OWNER) =>
  new FleetDiscoveryService(as(principal));
const fields = (): FleetDiscoveryInput => ({
  workspaceId: "alpha",
  sourceId: "github",
  sourceRevision: 1,
  scope: { kind: "enrolled", cursor: null },
});
const api = (name = "example/first", id = "node-first", archived = false) => ({
  id,
  nameWithOwner: name,
  description: "Provider description",
  isArchived: archived,
  isPrivate: false,
});
const catalog = (nodes = [api()]) =>
  Response.json({
    data: {
      catalog: {
        login: "example",
        repositories: {
          totalCount: nodes.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    },
  });
function provider(
  intercept?: (body: {
    query: string;
    variables: Record<string, string>;
  }) => Promise<Response | void> | Response | void,
) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.github.com/graphql");
    const body = JSON.parse(String(init?.body));
    const override = await intercept?.(body);
    if (override) return override;
    return body.query.includes("FleetCatalog")
      ? catalog()
      : Response.json({ data: { repository0: api() } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
beforeAll(() => applyD1Migrations(bindings.HQ_DB, bindings.TEST_MIGRATIONS));
beforeEach(async () => {
  now = Date.now();
  runtime = {
    ...bindings,
    WORKSPACE_EVENTS: undefined,
    GITHUB_CREDENTIALS: JSON.stringify({
      personal: {
        workspaceId: "alpha",
        name: "Fleet read credential",
        token: TOKEN,
      },
    }),
  };
  await bindings.HQ_DB.batch([
    bindings.HQ_DB.prepare("DELETE FROM workspaces"),
    bindings.HQ_DB.prepare("DELETE FROM github_context_budgets"),
    bindings.HQ_DB.prepare("DELETE FROM github_cooldowns"),
    bindings.HQ_DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES ('alpha','Alpha','2026-01-01'),('beta','Beta','2026-01-01')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO members(workspace_id,subject,display_name,role) VALUES ('alpha','owner','Owner','owner'),('alpha','operator','Operator','operator'),('alpha','viewer','Viewer','viewer'),('beta','owner','Owner','owner')",
    ),
    bindings.HQ_DB.prepare(
      "INSERT INTO projects(workspace_id,id,name,description,updated_at) VALUES ('alpha','project','Project','',?),('beta','beta-project','Beta project','',?)",
    ).bind(new Date(now).toISOString(), new Date(now).toISOString()),
    bindings.HQ_DB.prepare(
      "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha','first','example/first','Keep HQ description','project','watchlist','active',?,?,'seed')",
    ).bind(JSON.stringify(DEFAULT_EXPECTATIONS), new Date(now).toISOString()),
  ]);
  await as().githubSourceEnroll({
    workspaceId: "alpha",
    sourceId: "github",
    source: {
      name: "Selected read authority",
      enabled: true,
      freshnessMinutes: 30,
      repositoryIds: ["first"],
      credentialRef: "personal",
      refreshIntervalMinutes: 15,
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Fleet identity comparisons", () => {
  const row = (patch: Partial<FleetInventoryRow> = {}): FleetInventoryRow => ({
    id: "first",
    fullName: "example/first",
    projectId: "project",
    revision: 1,
    classification: "watchlist",
    lifecycle: "active",
    collected: false,
    githubIds: [],
    ...patch,
  });
  const record = (
    patch: Partial<FleetProviderRecord> = {},
  ): FleetProviderRecord => ({
    repositoryId: null,
    lookupFullName: null,
    lookupGithubId: null,
    repository: {
      githubId: "node-first",
      fullName: "example/first",
      description: "",
      private: false,
      archived: false,
    },
    read: { state: "observed", reason: "complete" },
    ...patch,
  });
  it("distinguishes new records from unchanged and verified metadata differences", () => {
    expect(compareFleetRecords([record()], [])[0].state).toBe("new");
    expect(compareFleetRecords([record()], [row()])[0].state).toBe("unchanged");
    expect(
      compareFleetRecords([record()], [row({ lifecycle: "archived" })])[0]
        .state,
    ).toBe("changed");
    expect(
      compareFleetRecords(
        [record()],
        [row({ fullName: "old/name", githubIds: ["node-first"] })],
      )[0],
    ).toMatchObject({
      state: "changed",
      identity: "catalog",
      repository: { fullName: "old/name" },
    });
  });
  it("does not merge retained aliases, conflicting identities or reused names", () => {
    const renamed = record({
      repositoryId: "first",
      lookupFullName: "old/name",
    });
    expect(
      compareFleetRecords(
        [renamed],
        [row({ fullName: "old/name" }), row({ id: "canonical" })],
      )[0].reason,
    ).toBe("name_conflict");
    expect(
      compareFleetRecords(
        [record()],
        [row({ githubIds: ["different-node"] })],
      )[0].reason,
    ).toBe("identity_conflict");
    expect(
      compareFleetRecords(
        [record()],
        [row({ githubIds: ["node-first", "other"] })],
      )[0].reason,
    ).toBe("ambiguous_identity");
    expect(
      compareFleetRecords([record(), renamed], [row()]).every(
        (row) => row.state === "conflict",
      ),
    ).toBe(true);
  });
  it("does not turn unavailable evidence into an archive or deletion", () => {
    expect(
      compareFleetRecords(
        [
          record({
            repositoryId: "first",
            repository: null,
            read: { state: "unavailable", reason: "permission" },
          }),
        ],
        [row()],
      )[0],
    ).toMatchObject({
      state: "unavailable",
      provider: null,
      repository: { lifecycle: "active" },
    });
  });
});

describe("Owner-scoped fleet discovery", () => {
  it("lists only bounded source choices on demand without exposing credentials or contacting GitHub", async () => {
    const fetcher = provider();
    await bindings.HQ_DB.prepare(
      "INSERT INTO connections(workspace_id,id,name,provider,credential_ref) VALUES ('alpha','hooks','Hooks','hookrelay','private-hook-ref'),('beta','foreign','Foreign source','github','private-foreign-ref')",
    ).run();
    expect(await as().fleetSources({ workspaceId: "alpha" })).toEqual([
      {
        id: "github",
        name: "Selected read authority",
        revision: 1,
        enabled: true,
        configured: true,
      },
    ]);
    runtime.GITHUB_CREDENTIALS = "{}";
    expect(await as().fleetSources({ workspaceId: "alpha" })).toEqual([
      {
        id: "github",
        name: "Selected read authority",
        revision: 1,
        enabled: true,
        configured: false,
      },
    ]);
    for (const subject of ["viewer", "operator", "outsider"])
      await expect(
        as({ subject, displayName: subject }).fleetSources({
          workspaceId: "alpha",
        }),
      ).rejects.toBeDefined();
    await expect(
      as({ ...OWNER, reporterId: "reporter" }).fleetSources({
        workspaceId: "alpha",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as({ ...OWNER, expiresAt: now - 1 }).fleetSources({
        workspaceId: "alpha",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a browser session that expires during provider I/O without accepting its result", async () => {
    const expiresAt = now + 1000;
    provider(() => {
      now = expiresAt;
    });
    await expect(
      discovery({ ...OWNER, expiresAt }).discover(fields()),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT result_json FROM github_discovery_cache",
      ).first("result_json"),
    ).toBeNull();
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM github_repository_identities",
      ).first("n"),
    ).toBe(0);
  });
  it("caches bounded reads without changing evidence time, HQ metadata or collection scope", async () => {
    const fetcher = provider();
    const before = await as().repository({
      workspaceId: "alpha",
      repositoryId: "first",
    });
    const first = await discovery().discover(fields());
    now += 1000;
    const second = await discovery().discover(fields());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: "ready",
      candidates: [
        {
          state: "unchanged",
          identity: "name_lookup",
          repository: { collected: true },
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await as().repository({ workspaceId: "alpha", repositoryId: "first" }),
    ).toEqual(before);
    const saved = await bindings.HQ_DB.prepare(
      "SELECT * FROM github_repository_identities",
    ).first();
    expect(saved).toMatchObject({
      source_id: "github",
      repository_id: "first",
      github_id: "node-first",
      full_name: "example/first",
    });
    expect(
      JSON.stringify(
        await bindings.HQ_DB.prepare(
          "SELECT * FROM github_discovery_cache",
        ).first(),
      ),
    ).not.toContain(TOKEN);
  });
  it("checks metadata-only HQ repositories without silently collecting them", async () => {
    await bindings.HQ_DB.prepare(
      "DELETE FROM source_repositories WHERE repository_id='first'",
    ).run();
    provider();
    const result = await discovery().discover(fields());
    expect(result.candidates[0].repository?.collected).toBe(false);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM source_repositories",
      ).first("n"),
    ).toBe(0);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM github_repository_identities",
      ).first("n"),
    ).toBe(1);
  });
  it("pins accepted identity through ordinary scope edits and expectation revisions, not manual name changes", async () => {
    const fetcher = provider();
    await discovery().discover(fields());
    await as().githubSourceUpdate({
      workspaceId: "alpha",
      sourceId: "github",
      revision: 1,
      source: {
        name: "Selected read authority",
        enabled: true,
        freshnessMinutes: 30,
        repositoryIds: ["first"],
        credentialRef: "personal",
        refreshIntervalMinutes: 15,
      },
    });
    await bindings.HQ_DB.prepare(
      "UPDATE repositories SET revision=revision+1",
    ).run();
    await discovery().discover({ ...fields(), sourceRevision: 2 });
    expect(
      JSON.parse(String(fetcher.mock.calls[1][1]?.body)).variables,
    ).toEqual({ id0: "node-first" });
    await bindings.HQ_DB.prepare(
      "UPDATE repositories SET full_name='example/renamed',revision=revision+1",
    ).run();
    await discovery().discover({ ...fields(), sourceRevision: 2 });
    expect(
      JSON.parse(String(fetcher.mock.calls[2][1]?.body)).variables,
    ).toEqual({ owner0: "example", name0: "renamed" });
  });
  it("catalog discovery suggests new rows without assigning tracking, projects or enrollment", async () => {
    provider(() => catalog([api("example/new", "node-new")]));
    const result = await discovery().discover({
      ...fields(),
      scope: { kind: "owner", owner: "example", cursor: null },
    });
    expect(result.candidates[0]).toMatchObject({
      state: "new",
      repository: null,
      identity: "catalog",
    });
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM repositories",
      ).first("n"),
    ).toBe(1);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM github_repository_identities",
      ).first("n"),
    ).toBe(0);
  });
  it.each(["viewer", "operator", "outsider"])(
    "refuses %s authority before provider reads",
    async (subject) => {
      const fetcher = provider();
      await expect(
        discovery({ subject, displayName: subject }).discover(fields()),
      ).rejects.toMatchObject({ status: subject === "outsider" ? 404 : 403 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("refuses foreign sources, stale source revisions and reporter principals", async () => {
    const fetcher = provider();
    await expect(
      discovery().discover({ ...fields(), workspaceId: "beta" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      discovery().discover({ ...fields(), sourceRevision: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      discovery({ ...OWNER, reporterId: "reports" }).discover(fields()),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["disabled", "credential", "configuration"])(
    "does not read a source with unavailable %s",
    async (variant) => {
      if (variant === "disabled")
        await bindings.HQ_DB.prepare("UPDATE connections SET enabled=0").run();
      if (variant === "credential") runtime.GITHUB_CREDENTIALS = "{}";
      if (variant === "configuration")
        await bindings.HQ_DB.prepare(
          "UPDATE connections SET configuration_json='{}'",
        ).run();
      const fetcher = provider();
      expect((await discovery().discover(fields())).state).toBe(
        variant === "disabled" ? "disabled" : "not_configured",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("shares bounded credential quotas and cooldowns with repository context reads", async () => {
    const hash = await credentialHash(TOKEN);
    const window =
      Math.floor(now / GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS) *
      GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS;
    await bindings.HQ_DB.prepare(
      "INSERT INTO github_context_budgets(credential_hash,window_start,reads) VALUES (?,?,?)",
    )
      .bind(hash, window, GITHUB_CONTEXT_LIMITS.READS_PER_WINDOW)
      .run();
    const fetcher = provider();
    expect((await discovery().discover(fields())).state).toBe("waiting");
    now += GITHUB_CONTEXT_LIMITS.BUDGET_WINDOW_MS;
    const retryAt = new Date(now + 600000).toISOString();
    await bindings.HQ_DB.prepare(
      "INSERT INTO github_cooldowns(credential_hash,retry_at) VALUES (?,?)",
    )
      .bind(hash, retryAt)
      .run();
    expect(await discovery().discover(fields())).toMatchObject({
      state: "waiting",
      nextReadAt: retryAt,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("serializes source reads across different discovery scopes", async () => {
    const fetcher = provider(async () => {
      const competing = await discovery().discover({
        ...fields(),
        scope: { kind: "owner", owner: "example", cursor: null },
      });
      expect(competing.state).toBe("waiting");
    });
    expect((await discovery().discover(fields())).state).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["member", "source", "credential", "repository"])(
    "refuses evidence after a live %s change",
    async (variant) => {
      provider(async () => {
        if (variant === "member")
          await bindings.HQ_DB.prepare(
            "UPDATE members SET role='viewer',revision=revision+1 WHERE subject='owner'",
          ).run();
        if (variant === "source")
          await bindings.HQ_DB.prepare(
            "UPDATE connections SET revision=revision+1",
          ).run();
        if (variant === "credential") runtime.GITHUB_CREDENTIALS = "{}";
        if (variant === "repository")
          await bindings.HQ_DB.prepare(
            "UPDATE repositories SET full_name='example/new',revision=revision+1",
          ).run();
      });
      await expect(discovery().discover(fields())).rejects.toMatchObject({
        status: variant === "member" ? 403 : 409,
      });
      expect(
        (
          await bindings.HQ_DB.prepare(
            "SELECT result_json FROM github_discovery_cache",
          ).first()
        )?.result_json,
      ).toBeNull();
      expect(
        await bindings.HQ_DB.prepare(
          "SELECT count(*) AS n FROM github_repository_identities",
        ).first("n"),
      ).toBe(0);
    },
  );
  it("bounds repository pages independently of provider visibility", async () => {
    await bindings.HQ_DB.batch(
      Array.from({ length: 26 }, (_, index) =>
        bindings.HQ_DB.prepare(
          "INSERT INTO repositories(workspace_id,id,full_name,description,project_id,classification,lifecycle,expectations_json,updated_at,write_id) VALUES ('alpha',?,?,'','project','reference','active',?,?,'seed')",
        ).bind(
          "repo-" + String(index).padStart(2, "0"),
          "example/repo-" + index,
          JSON.stringify(DEFAULT_EXPECTATIONS),
          new Date(now).toISOString(),
        ),
      ),
    );
    provider(({ variables }) =>
      Response.json({
        data: Object.fromEntries(
          Object.keys(variables)
            .filter((key) => key.startsWith("name"))
            .map((key) => ["repository" + key.slice(4), null]),
        ),
      }),
    );
    const first = await discovery().discover(fields());
    expect(first.candidates).toHaveLength(25);
    expect(first.candidates.every((row) => row.state === "unavailable")).toBe(
      true,
    );
    const second = await discovery().discover({
      ...fields(),
      scope: first.nextScope!,
    });
    expect(second.candidates).toHaveLength(2);
    expect(second.nextScope).toBeNull();
    expect(
      new Set([...first.candidates, ...second.candidates].map((row) => row.key))
        .size,
    ).toBe(27);
  });
  it("drops old-workspace derived identities before repository moves without moving their authority", async () => {
    provider();
    await discovery().discover(fields());
    await bindings.HQ_DB.batch([
      bindings.HQ_DB.prepare(
        "DELETE FROM source_repositories WHERE repository_id='first'",
      ),
      bindings.HQ_DB.prepare(
        "UPDATE repositories SET workspace_id='beta',project_id='beta-project' WHERE id='first'",
      ),
    ]);
    expect(
      await bindings.HQ_DB.prepare(
        "SELECT count(*) AS n FROM github_repository_identities",
      ).first("n"),
    ).toBe(0);
    expect((await discovery().discover(fields())).candidates).toEqual([]);
  });
  it("requires live read and admin client scopes even for an owner", async () => {
    await bindings.HQ_DB.prepare(
      "INSERT INTO credentials(id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at) VALUES ('client','alpha','owner','Client','hash',?,?,?)",
    )
      .bind(
        JSON.stringify([CAPABILITY.ADMIN]),
        new Date(now).toISOString(),
        new Date(now + 600000).toISOString(),
      )
      .run();
    const fetcher = provider();
    await expect(
      discovery({
        ...OWNER,
        tokenId: "client",
        scopes: [CAPABILITY.READ, CAPABILITY.ADMIN],
      }).discover(fields()),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
