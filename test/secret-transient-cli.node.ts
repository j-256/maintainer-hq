import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  TRANSIENT_FINGERPRINT as fingerprint,
  TRANSIENT_VALUE as value,
} from "./fixtures/secret-transient-review";

const environment = {
  ...process.env,
  HQ_URL: "",
  HQ_TOKEN: "",
  HQ_ACCESS_TOKEN: "",
  HQ_ACCESS_CLIENT_ID: "",
  HQ_ACCESS_CLIENT_SECRET: "",
  HQ_TRANSIENT_INPUT_MODE: "",
  HQ_SYNTHETIC_TRANSIENT: value,
};
const selection = ["-walpha", "-rreview", "-p" + fingerprint, "-d0"];
function cli(args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/secret-transient-transport.mjs",
      "cli/index.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
      "secret-run-input",
      ...args,
    ],
    { encoding: "utf8", input, env: { ...environment, ...extra } },
  );
}
test("private execution CLI preserves exact bytes through stdin, inherited variables and owner-only files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hq-transient-input-"));
  const path = join(dir, "input");
  try {
    await writeFile(path, value, { mode: 0o600 });
    for (const args of [
      [...selection, "-i-"],
      [
        "--workspace=alpha",
        "--review=review",
        "--fingerprint=" + fingerprint,
        "--destination=0",
        "--environment-variable=HQ_SYNTHETIC_TRANSIENT",
      ],
      ["-i", path, ...selection, "--"],
    ]) {
      const result = cli(args, value);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(
        JSON.parse(result.stdout).review.operation.receipts[0].writeStatus,
        "accepted",
      );
      assert.equal(JSON.parse(result.stdout).inputConsumed, true);
      assert.ok(!result.stdout.includes(value));
    }
    await chmod(path, 0o644);
    const rejected = cli([...selection, "-i", path]);
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /owner-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("private execution CLI help, usage failures, expiry and uncertain responses have distinct safe outcomes", () => {
  for (const flag of ["-h", "--help"]) {
    const result = cli([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /new Worker version/);
    assert.match(result.stdout, /trailing newlines/);
  }
  for (const args of [
    [],
    selection,
    [...selection, "-i-", "-eHQ_SYNTHETIC_TRANSIENT"],
    [...selection, "--destination="],
    [...selection, "--destination=-1", "-i-"],
    [...selection, "-d10", "-i-"],
    [...selection, "--unknown"],
  ]) {
    const result = cli(args, value);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(value));
  }
  const expired = cli([...selection, "-eHQ_DOES_NOT_EXIST"], undefined, {
    HQ_TRANSIENT_INPUT_MODE: "expired",
  });
  assert.equal(expired.status, 2);
  assert.match(expired.stderr, /expired/);
  const completed = cli([...selection, "-eHQ_DOES_NOT_EXIST"], undefined, {
    HQ_TRANSIENT_INPUT_MODE: "completed",
  });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).inputConsumed, false);
  const lost = cli([...selection, "-eHQ_SYNTHETIC_TRANSIENT"], undefined, {
    HQ_TRANSIENT_INPUT_MODE: "lost",
  });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /interrupted or refused/);
  assert.ok(!lost.stderr.includes(value));
});
test("stdio private execution accepts only a named inherited variable and recovers receipts without replay", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/secret-transient-transport.mjs",
      "cli/mcp.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
    ],
    env: Object.fromEntries(
      Object.entries({
        ...environment,
        HQ_TRANSIENT_INPUT_MODE: "lost",
      }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "transient-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "secrets_run_supply",
    );
    assert.ok(tool);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema),
      /"(?:value|token|ciphertext)"/,
    );
    const args = {
      workspaceId: "alpha",
      reviewId: "review",
      fingerprint,
      destinationIndex: 0,
    };
    const result = await client.callTool({
      name: "secrets_run_supply",
      arguments: { ...args, environmentVariable: "HQ_SYNTHETIC_TRANSIENT" },
    });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(value));
    const repeated = await client.callTool({
      name: "secrets_run_supply",
      arguments: { ...args, environmentVariable: "HQ_DOES_NOT_EXIST" },
    });
    assert.notEqual(repeated.isError, true);
    assert.equal(
      JSON.parse((repeated.content as { text: string }[])[0]!.text)
        .inputConsumed,
      false,
    );
    assert.ok(!stderr.includes(value));
  } finally {
    await client.close();
  }
});
