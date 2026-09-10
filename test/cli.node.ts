import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { callCommand, clientConfiguration } from "../cli/client";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commands } from "../shared/commands";

const isolatedEnvironment = {
  ...process.env,
  HQ_URL: "",
  HQ_TOKEN: "",
  HQ_ACCESS_TOKEN: "",
  HQ_ACCESS_CLIENT_ID: "",
  HQ_ACCESS_CLIENT_SECRET: "",
};
const transportEnvironment = {
  ...isolatedEnvironment,
  HQ_TOKEN: "synthetic-workspace-token",
  HQ_ACCESS_CLIENT_ID: "synthetic-client",
  HQ_ACCESS_CLIENT_SECRET: "synthetic-service-secret",
};
const transportInput = {
  workspaceId: "alpha",
  goalId: "goal",
  sourceId: "agent",
  objective: "  A verbatim /goal\nthrough the shared client.  ",
  status: "active",
  startedAt: "2026-01-01T00:00:00.000Z",
  reportedAt: "2026-01-01T00:00:01.000Z",
};
const attentionInputs = {
  repository_coverage: { workspaceId: "alpha", repositoryId: "repo" },
  repository_coverage_get: { workspaceId: "alpha", repositoryId: "repo" },
  projects_organize_plan: {
    workspaceId: "alpha",
    repositories: [
      { repositoryId: "repo", revision: 3, targetKey: "existing" },
    ],
    targets: [
      {
        key: "existing",
        kind: "existing",
        projectId: "project",
        revision: 2,
        patch: { importance: "high" },
      },
    ],
  },
  projects_organize_review: { workspaceId: "alpha", planId: "review" },
  projects_organize_apply: {
    workspaceId: "alpha",
    planId: "review",
    fingerprint: "b".repeat(64),
  },
  expectations_plan: {
    workspaceId: "alpha",
    repositories: [
      {
        repositoryId: "repo",
        revision: 3,
        patch: { ci: "optional", reviewDate: null },
      },
    ],
  },
  expectations_review: { workspaceId: "alpha", planId: "review" },
  expectations_apply: {
    workspaceId: "alpha",
    planId: "review",
    fingerprint: "a".repeat(64),
  },
  workspace_attention: {
    workspaceId: "alpha",
    category: "coverage",
    search: "project",
    page: 2,
  },
  attention_connection: {
    workspaceId: "alpha",
    connectionId: "hooks",
    revision: 3,
  },
} as const;

function cli(args: string[], input?: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "cli/index.ts", ...args],
    {
      encoding: "utf8",
      input,
      env: isolatedEnvironment,
    },
  );
}

test("both help forms succeed with stdout only", () => {
  for (const arg of ["-h", "--help"]) {
    const result = cli([arg]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Exit statuses/);
    assert.equal(result.stderr, "");
  }
});

test("Access service transport validates pairs and modes and keeps development credential-free", () => {
  const config = clientConfiguration(
    "https://workspace.example",
    false,
    "synthetic-workspace-token",
    "",
    "synthetic-client",
    "synthetic-service-secret",
  );
  assert.equal(
    config.headers.Authorization,
    "Bearer synthetic-workspace-token",
  );
  assert.equal(config.headers["CF-Access-Client-Id"], "synthetic-client");
  assert.equal(
    config.headers["CF-Access-Client-Secret"],
    "synthetic-service-secret",
  );
  assert.equal(config.headers.Cookie, undefined);
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "token",
        "",
        "id",
        "",
      ),
    /both HQ_ACCESS_CLIENT/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "token",
        "",
        "",
        "secret",
      ),
    /both HQ_ACCESS_CLIENT/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "",
        "a.b.c",
        "id",
        "secret",
      ),
    /not both/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "token",
        "",
        "id",
        "bad\nvalue",
      ),
    /header-safe/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "token",
        "",
        "id",
        "x".repeat(1025),
      ),
    /header-safe/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "",
        "",
        "id",
        "secret",
      ),
    /Set HQ_TOKEN/,
  );
  assert.deepEqual(
    clientConfiguration(
      "http://127.0.0.1:5178",
      true,
      "token",
      "a.b.c",
      "id",
      "secret",
    ).headers,
    { "Content-Type": "application/json", "X-HQ-Client": "cli" },
  );
});

test("the real CLI sends Access and workspace credentials through one transport without exposing either", () => {
  const run = (env = transportEnvironment) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./test/fixtures/access-transport.mjs",
        "cli/index.ts",
        "--url",
        "https://workspace.example",
        "call",
        "goal_sync",
        "-i",
        "-",
      ],
      { input: JSON.stringify(transportInput), encoding: "utf8", env },
    );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).objective, transportInput.objective);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /synthetic-(workspace-token|service-secret|client)/,
  );
  const gateDenied = run({
    ...transportEnvironment,
    HQ_ACCESS_CLIENT_ID: "",
    HQ_ACCESS_CLIENT_SECRET: "",
  });
  assert.equal(gateDenied.status, 1);
  assert.match(gateDenied.stderr, /sign-in page or non-API response/);
  assert.doesNotMatch(gateDenied.stderr, /synthetic-private-proxy-body/);
  const workspaceDenied = run({
    ...transportEnvironment,
    HQ_TOKEN: "wrong-workspace-token",
  });
  assert.equal(workspaceDenied.status, 1);
  assert.match(workspaceDenied.stderr, /Workspace credential denied/);
});

test("the real stdio MCP shares the service transport, schemas and exact goal payload", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/access-transport.mjs",
      "cli/mcp.ts",
      "--url",
      "https://workspace.example",
    ],
    env: Object.fromEntries(
      Object.entries(transportEnvironment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "transport-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    for (const [name, command] of Object.entries(commands).filter(([name]) =>
      /^(projects_organize_|expectations_|hooks_|monitoring_|resource_repositories|repository_resources|repository_context|repository_coverage|github_coverage|workspace_attention|attention_connection)/.test(
        name,
      ),
    )) {
      const tool = list.tools.find((tool) => tool.name === name);
      assert.ok(tool, name);
      assert.equal(tool.annotations?.readOnlyHint, command.readOnly);
      assert.doesNotMatch(
        JSON.stringify(tool.inputSchema),
        /"(?:token|sql|binding)"/,
      );
    }
    assert.ok(
      list.tools.some((tool) => tool.name === "automation_credential_issue"),
    );
    const result = await client.callTool({
      name: "goal_sync",
      arguments: transportInput,
    });
    assert.notEqual(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    assert.equal(
      JSON.parse(content[0]!.text).objective,
      transportInput.objective,
    );
    assert.equal(JSON.parse(content[0]!.text).transportVerified, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic-(workspace-token|service-secret|client)/,
    );
    for (const [name, input] of Object.entries(attentionInputs)) {
      const result = await client.callTool({ name, arguments: input });
      assert.notEqual(result.isError, true);
      const content = result.content as { type: string; text: string }[];
      assert.deepEqual(JSON.parse(content[0]!.text), {
        name,
        input,
        transportVerified: true,
      });
    }
  } finally {
    await client.close();
  }
  assert.equal(diagnostics, "");
});
test("the real CLI sends bounded coverage, attention, expectation and organization inputs through the shared authenticated transport", () => {
  for (const [name, input] of Object.entries(attentionInputs)) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./test/fixtures/access-transport.mjs",
        "cli/index.ts",
        "--url",
        "https://workspace.example",
        "call",
        name,
        "-i",
        "-",
      ],
      {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: transportEnvironment,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      name,
      input,
      transportVerified: true,
    });
  }
});
test("schemas need no URL, and command names are bounded", () => {
  assert.equal(cli(["schema", "goal_sync"]).status, 0);
  for (const name of Object.keys(commands).filter((name) =>
    /^(hooks_|monitoring_|resource_repositories|repository_resources|repository_context|repository_coverage|github_coverage|workspace_attention|attention_connection)/.test(
      name,
    ),
  )) {
    const result = cli(["schema", name]);
    assert.equal(result.status, 0, name);
    assert.doesNotMatch(result.stdout, /"(?:token|sql|binding)"/);
  }
  for (const name of [
    "source_enroll",
    "source_update",
    "publisher_credential_issue",
    "publisher_credential_revoke",
    "observations_publish",
    "automation_credentials_list",
    "automation_credential_plan",
    "automation_credential_issue",
    "automation_credential_revoke",
  ]) {
    assert.equal(cli(["schema", name]).status, 0);
  }
  for (const name of [
    "github_source_enroll",
    "github_source_update",
    "github_source_get",
    "github_credentials_list",
    "github_refresh",
    "github_refresh_get",
    "github_refreshes_list",
    "github_refresh_cancel",
  ]) {
    const schema = cli(["schema", name]);
    assert.equal(schema.status, 0);
    assert.doesNotMatch(schema.stdout, /"token"/);
  }
  assert.equal(cli(["schema", "constructor"]).status, 2);
  assert.equal(cli(["--unknown"]).status, 2);
  assert.equal(cli(["--url"]).status, 2);
  assert.equal(
    cli(["--url=", "--dev", "call", "activity_list", "-i", "-"], "{}").status,
    2,
  );
});

test("the Node client does not follow credential-bearing redirects", async () => {
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") {
      redirected = true;
      response.end("{}");
      return;
    }
    response.writeHead(307, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      callCommand(
        {
          origin: "http://127.0.0.1:" + address.port,
          headers: { Authorization: "Bearer synthetic-test-only" },
        },
        "observations_publish",
        {
          workspaceId: "test",
          sourceId: "source",
          reportId: "report",
          observations: [
            {
              repositoryId: "repository",
              observedAt: new Date().toISOString(),
              branch: "main",
              dirty: false,
              ahead: 0,
            },
          ],
        },
      ),
      /could not be reached/,
    );
    assert.equal(redirected, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("option spellings, short-option glue, and interleaving share validation", () => {
  for (const args of [
    ["-uhttp://127.0.0.1:5178", "--dev", "call", "activity_list", "-i-"],
    [
      "call",
      "activity_list",
      "--dev",
      "--url=http://127.0.0.1:5178",
      "--input=-",
    ],
    [
      "--dev",
      "-u",
      "http://127.0.0.1:5178",
      "call",
      "--input",
      "-",
      "--",
      "activity_list",
    ],
  ]) {
    const result = cli(args, '{"unexpected":true}');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /command schema/);
  }
});
test("remote dev identities and insecure credential destinations are refused", () => {
  assert.throws(
    () => clientConfiguration("https://remote.example", true),
    /loopback/,
  );
  assert.throws(
    () => clientConfiguration("http://remote.example", false, "synthetic"),
    /HTTPS/,
  );
  assert.throws(
    () => clientConfiguration("https://remote.example", false, ""),
    /HQ_TOKEN/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://user:pass@remote.example",
        false,
        "synthetic",
      ),
    /without credentials/,
  );
  assert.equal(
    clientConfiguration("http://127.0.0.1:5178", true, "must-not-be-sent")
      .headers.Authorization,
    undefined,
  );
});

test("human CLI and MCP transport uses an explicit Access cookie without bearer fallback or identity headers", async () => {
  const configured = clientConfiguration(
    "https://workspace.example",
    false,
    "",
    "synthetic.session.signature",
  );
  assert.equal(
    configured.headers.Cookie,
    "CF_Authorization=synthetic.session.signature",
  );
  assert.equal(configured.headers.Origin, "https://workspace.example");
  assert.equal(configured.headers.Authorization, undefined);
  assert.equal(configured.headers["Cf-Access-Jwt-Assertion"], undefined);
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "token",
        "synthetic.session.signature",
      ),
    /not both/,
  );
  assert.throws(
    () =>
      clientConfiguration(
        "https://workspace.example",
        false,
        "",
        "bad; other=cookie",
      ),
    /bounded/,
  );
  const development = clientConfiguration(
    "http://localhost:5178",
    true,
    "secret-token",
    "synthetic.session.signature",
  );
  assert.deepEqual(development.headers, {
    "Content-Type": "application/json",
    "X-HQ-Client": "cli",
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "https://workspace.example/api/commands/setup_status",
    );
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Cookie"),
      configured.headers.Cookie,
    );
    assert.equal(new Headers(init?.headers).get("Origin"), configured.origin);
    return Response.json({ state: "unavailable" });
  };
  try {
    assert.deepEqual(await callCommand(configured, "setup_status", {}), {
      state: "unavailable",
    });
  } finally {
    globalThis.fetch = original;
  }
  for (const name of [
    "setup_status",
    "setup_apply",
    "invitations_mine",
    "invitation_accept",
    "members_list",
    "member_update",
    "member_remove",
    "invitation_create",
    "invitation_revoke",
    "invitations_list",
  ])
    assert.equal(cli(["schema", name]).status, 0);
});
