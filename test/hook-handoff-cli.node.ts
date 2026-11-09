import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptHandoffFile, exportHandoffFile } from "../cli/hook-handoff";
import { clientConfiguration } from "../cli/client";
const configuration = clientConfiguration("http://127.0.0.1:5178", true);
const repositoryId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const record = { hmac: { name: "HMAC_GITHUB_OWNER_REPO", value: "synthetic-private-shared-hmac" }, slugs: { activity: "synthetic-private-activity-route", stars: "synthetic-private-stars-route", alerts: "synthetic-private-alerts-route" }, profiles: ["activity"], state: "active" };
const now = new Date().toISOString();
test("trusted adoption selects only one repository and export writes a new private file with metadata-only results", async () => {
  const root = await mkdtemp(join(tmpdir(), "hq-handoff-cli-")); const original = globalThis.fetch; let calls = 0;
  try {
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: 4, repositories: { "owner/repo": record, "unrelated/repo": { private: "synthetic-unrelated-never-uploaded" } }, retiredRepositories: {} }), { mode: 0o600 });
    globalThis.fetch = async (_url, init) => {
      calls++; assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body)); assert.ok(!JSON.stringify(body).includes("synthetic-unrelated"));
      if (body.action === "adopt_plan") {
        assert.deepEqual(body.input.record, record);
        return Response.json({ id: resourceId, fingerprint: "a".repeat(64), connectionId: "hooks", connectionName: "Synthetic", projectId: "project", repository: "owner/repo", actorMatches: true, createdAt: now, expiresAt: now, linked: false, provider: null, operation: null }, { headers: { "cache-control": "no-store" } });
      }
      return Response.json({ version: 1, repository: "owner/repo", origin: "https://hooks.example", record: { ...record, provider: { kind: "hookrelay-handoff-v1", authorityId: "a".repeat(32), workspaceId: "alpha", repositoryId, bundleRevision: 1, resources: { activity: { resourceId, authMode: "environment" } } } }, routes: [{}], exportedAt: now }, { headers: { "cache-control": "no-store" } });
    };
    const selection = { workspaceId: "alpha", connectionId: "hooks", reviewId: resourceId, connectionRevision: 1, projectId: "project", projectRevision: 1, authorityId: "a".repeat(32), revision: 1, repository: "owner/repo", profile: "activity", sinks: ["phone"], manifestPath };
    const review = await adoptHandoffFile(configuration, selection);
    assert.ok(!JSON.stringify(review).includes(record.hmac.value));
    const outputPath = join(root, "export.json");
    const result = await exportHandoffFile(configuration, { workspaceId: "alpha", connectionId: "hooks", repositoryId, outputPath });
    assert.ok(!JSON.stringify(result).includes(record.hmac.value));
    const file = await open(outputPath, constants.O_RDONLY); try { assert.equal((await file.stat()).mode & 0o777, 0o600); } finally { await file.close(); }
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).record.hmac.value, record.hmac.value);
    await assert.rejects(exportHandoffFile(configuration, { workspaceId: "alpha", connectionId: "hooks", repositoryId, outputPath }));
    assert.equal(calls, 2);
    const link = join(root, "link.json"); await symlink(manifestPath, link);
    await assert.rejects(adoptHandoffFile(configuration, { ...selection, manifestPath: link }));
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }); }
});
