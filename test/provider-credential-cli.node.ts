import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PRIVATE = "synthetic-private-provider-token";
const fingerprint = "sha256:" + "a".repeat(64);
const environment = {
  ...process.env,
  HQ_URL: "",
  HQ_TOKEN: "",
  HQ_ACCESS_TOKEN: "",
  HQ_ACCESS_CLIENT_ID: "",
  HQ_ACCESS_CLIENT_SECRET: "",
  HQ_CREDENTIAL_INPUT_MODE: "",
  HQ_SYNTHETIC_PROVIDER_TOKEN: PRIVATE,
};
function cli(args: string[], input?: string, extra = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/provider-credential-transport.mjs",
      "cli/index.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
      "credential-input",
      ...args,
    ],
    { encoding: "utf8", input, env: { ...environment, ...extra } },
  );
}
test("credential input CLI supports exact reviewed private stdin, environment and owner-only files without token output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hq-provider-input-"));
  const path = join(dir, "token");
  try {
    await writeFile(path, PRIVATE, { mode: 0o600 });
    for (const args of [
      ["-walpha", "-rreview", "-p" + fingerprint, "-i-"],
      [
        "--workspace=alpha",
        "--review=review",
        "--fingerprint=" + fingerprint,
        "--environment-variable=HQ_SYNTHETIC_PROVIDER_TOKEN",
      ],
      ["-i", path, "-w", "alpha", "-r", "review", "-p", fingerprint, "--"],
    ]) {
      const result = cli(args, PRIVATE);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(JSON.parse(result.stdout).submitted, true);
      assert.ok(!result.stdout.includes(PRIVATE));
      assert.doesNotMatch(result.stdout, /ciphertext/);
    }
    await chmod(path, 0o644);
    const refused = cli([
      "-walpha",
      "-rreview",
      "-p" + fingerprint,
      "-i",
      path,
    ]);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /owner-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("credential CLI help, option errors, newline rejection and uncertain acceptance have safe exit statuses", () => {
  for (const flag of ["-h", "--help"]) {
    const result = cli([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /fingerprint/);
    assert.match(result.stdout, /trailing newline/);
  }
  for (const args of [
    [],
    ["-walpha", "-rreview", "-i-"],
    [
      "-walpha",
      "-rreview",
      "-p" + fingerprint,
      "-i-",
      "-eHQ_SYNTHETIC_PROVIDER_TOKEN",
    ],
    ["--unknown"],
    ["-walpha", "-rreview", "--fingerprint=", "-i-"],
  ]) {
    const result = cli(args, PRIVATE);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(PRIVATE));
  }
  const newline = cli(
    ["-walpha", "-rreview", "-p" + fingerprint, "-i-"],
    PRIVATE + "\n",
  );
  assert.equal(newline.status, 2);
  assert.match(newline.stderr, /Nothing was submitted/);
  const expired = cli(
    ["-walpha", "-rreview", "-p" + fingerprint, "-eHQ_DOES_NOT_EXIST"],
    undefined,
    { HQ_CREDENTIAL_INPUT_MODE: "expired" },
  );
  assert.equal(expired.status, 2);
  assert.match(expired.stderr, /expired/);
  const lost = cli(
    [
      "-walpha",
      "-rreview",
      "-p" + fingerprint,
      "-eHQ_SYNTHETIC_PROVIDER_TOKEN",
    ],
    undefined,
    { HQ_CREDENTIAL_INPUT_MODE: "lost" },
  );
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /uncertain/);
  assert.ok(!lost.stderr.includes(PRIVATE));
  const done = cli(
    ["-walpha", "-rreview", "-p" + fingerprint, "-eHQ_DOES_NOT_EXIST"],
    undefined,
    { HQ_CREDENTIAL_INPUT_MODE: "accepted" },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).submitted, false);
});
test("stdio credential input requires exact metadata approval and recovers a lost receipt without replacement input", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/provider-credential-transport.mjs",
      "cli/mcp.ts",
      "--dev",
      "-uhttp://127.0.0.1:5178",
    ],
    env: Object.fromEntries(
      Object.entries({
        ...environment,
        HQ_CREDENTIAL_INPUT_MODE: "lost",
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
  const client = new Client({
    name: "provider-credential-test",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "provider_credential_supply",
    );
    assert.ok(tool);
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema),
      /"(?:value|token|ciphertext)"/,
    );
    const input = {
      workspaceId: "alpha",
      planId: "review",
      fingerprint,
      environmentVariable: "HQ_SYNTHETIC_PROVIDER_TOKEN",
    };
    const first = await client.callTool({
      name: "provider_credential_supply",
      arguments: input,
    });
    assert.equal(first.isError, true);
    assert.ok(!JSON.stringify(first).includes(PRIVATE));
    const next = await client.callTool({
      name: "provider_credential_supply",
      arguments: { ...input, environmentVariable: "HQ_DOES_NOT_EXIST" },
    });
    assert.notEqual(next.isError, true);
    assert.equal(
      JSON.parse((next.content as { text: string }[])[0]!.text).submitted,
      false,
    );
  } finally {
    await client.close();
  }
  assert.equal(stderr, "");
});
test("CLI exposes provider credential scope schemas without a token field", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "cli/index.ts", "schema", "provider_credential_plan"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /repositoryNames/);
  assert.doesNotMatch(result.stdout, /"token"/);
});
