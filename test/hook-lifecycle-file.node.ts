import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLifecycleFile, lifecycleFileInput } from "../cli/hook-lifecycle-input.ts";
import { HOOK_LIFECYCLE_PRIVATE_BYTES } from "../shared/hook-lifecycle.ts";
test("private file adapter accepts only bounded owner-only regular files and rejects MCP stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-lifecycle-input-"));
  try {
    const file = join(directory, "private.json"); const link = join(directory, "link.json");
    await writeFile(file, '{"type":"ntfy","topic":"synthetic-private"}', { mode: 0o600 });
    const value = await readLifecycleFile(file); assert.ok(value.byteLength > 0); value.fill(0);
    await chmod(file, 0o644); await assert.rejects(readLifecycleFile(file));
    await chmod(file, 0o600); await symlink(file, link); await assert.rejects(readLifecycleFile(link));
    await writeFile(file, "x".repeat(HOOK_LIFECYCLE_PRIVATE_BYTES + 1)); await assert.rejects(readLifecycleFile(file));
    await assert.rejects(readLifecycleFile(directory));
    assert.equal(lifecycleFileInput.safeParse({ workspaceId: "alpha", planId: "00000000-0000-4000-8000-000000000001", fingerprint: "b".repeat(64), inputFile: "-" }).success, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI private input reports malformed metadata as usage failure without echoing its content", async () => {
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "hq-lifecycle-cli-"));
  try {
    const selection = join(directory, "selection.json"); await writeFile(selection, "synthetic-private-invalid-json");
    const result = spawnSync(process.execPath, ["--import", "tsx", "cli/index.ts", "--url", "http://127.0.0.1:5207", "--dev", "hook-lifecycle-input", "-i", selection, "--private-file", join(directory, "unread.json")], { encoding: "utf8" });
    assert.equal(result.status, 2); assert.equal(result.stdout, ""); assert.ok(!result.stderr.includes("synthetic-private-invalid-json"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
