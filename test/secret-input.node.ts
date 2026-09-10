import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readPrivateValue } from "../cli/secret-input";

const VALUE = "synthetic-sealed-input-\u03bb\r\nlast line\n";
const environment = {
  ...process.env,
  HQ_URL: "",
  HQ_TOKEN: "",
  HQ_ACCESS_TOKEN: "",
  HQ_ACCESS_CLIENT_ID: "",
  HQ_ACCESS_CLIENT_SECRET: "",
  HQ_SECRET_INPUT_MODE: "",
  HQ_SYNTHETIC_VALUE: VALUE,
};
function cli(args: string[], input?: string, extra = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/secret-input-transport.mjs",
      "cli/index.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
      "secret-input",
      ...args,
    ],
    { encoding: "utf8", input, env: { ...environment, ...extra } },
  );
}
test("private input CLI preserves exact UTF-8 bytes through stdin, an inherited variable, and an owner-only file", async () => {
  for (const args of [
    ["-walpha", "-rreview", "-i-"],
    [
      "--workspace=alpha",
      "--review=review",
      "--environment-variable=HQ_SYNTHETIC_VALUE",
    ],
  ]) {
    const result = cli(args, VALUE);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).submitted, true);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(VALUE));
    assert.doesNotMatch(result.stdout, /ciphertext/);
  }
  const dir = await mkdtemp(join(tmpdir(), "hq-secret-client-"));
  const path = join(dir, "private-input");
  try {
    await writeFile(path, VALUE, { mode: 0o600 });
    const result = cli(["-w", "alpha", "-r", "review", "--input", path, "--"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).submitted, true);
    await chmod(path, 0o644);
    const refused = cli(["-walpha", "-rreview", "-i", path]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /owner-only/);
    assert.equal(refused.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("input help, invalid options, stale reviews, and uncertain responses have safe distinct outcomes", () => {
  for (const flag of ["-h", "--help"]) {
    const result = cli([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /trailing newlines/);
  }
  for (const args of [
    ["-walpha", "-rreview"],
    ["-walpha", "-rreview", "-i-", "-eHQ_SYNTHETIC_VALUE"],
    ["-walpha", "-rreview", "-e"],
    ["-walpha", "-rreview", "--environment-variable="],
    ["-walpha", "-rreview", "--unknown"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(VALUE));
  }
  const expired = cli(
    ["-walpha", "-rreview", "-eHQ_DOES_NOT_EXIST"],
    undefined,
    { HQ_SECRET_INPUT_MODE: "expired" },
  );
  assert.equal(expired.status, 2);
  assert.match(expired.stderr, /expired/);
  const accepted = cli(
    ["-walpha", "-rreview", "-eHQ_DOES_NOT_EXIST"],
    undefined,
    { HQ_SECRET_INPUT_MODE: "accepted" },
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).submitted, false);
  const lost = cli(["-walpha", "-rreview", "-eHQ_SYNTHETIC_VALUE"], undefined, {
    HQ_SECRET_INPUT_MODE: "lost",
  });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /uncertain/);
  assert.ok(!lost.stderr.includes(VALUE));
});
test("stdio MCP supplies named inherited input and recovers a lost response without replacing it", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/secret-input-transport.mjs",
      "cli/mcp.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
    ],
    env: Object.fromEntries(
      Object.entries({ ...environment, HQ_SECRET_INPUT_MODE: "lost" }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "secret-input-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(
      (tool) => tool.name === "secrets_supply",
    );
    assert.ok(tool);
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema),
      /"(?:value|ciphertext|token)"/,
    );
    const result = await client.callTool({
      name: "secrets_supply",
      arguments: {
        workspaceId: "alpha",
        reviewId: "review",
        environmentVariable: "HQ_SYNTHETIC_VALUE",
      },
    });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(VALUE));
    const recovered = await client.callTool({
      name: "secrets_supply",
      arguments: {
        workspaceId: "alpha",
        reviewId: "review",
        environmentVariable: "HQ_DOES_NOT_EXIST",
      },
    });
    assert.notEqual(recovered.isError, true);
    assert.equal(
      JSON.parse((recovered.content as { text: string }[])[0]!.text).submitted,
      false,
    );
    assert.doesNotMatch(JSON.stringify(recovered), /ciphertext/);
  } finally {
    await client.close();
  }
  assert.equal(stderr, "");
});
test("private readers require one explicit source and never include values in failures", async () => {
  await assert.rejects(readPrivateValue({}), /exactly one/);
  await assert.rejects(
    readPrivateValue({ environmentVariable: "bad=name" }),
    /variable name/,
  );
  await assert.rejects(
    readPrivateValue({ environmentVariable: "HQ_DOES_NOT_EXIST" }),
    /missing/,
  );
});
