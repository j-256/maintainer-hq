import assert from "node:assert/strict";
import { test } from "node:test";
import { startCoverChecks } from "./start-cover-checks.mjs";

const repository = "owner/project";
const sourceSha = "a".repeat(40);
const headSha = "b".repeat(40);
const number = 42;
function fixture() {
  const pr = {
    state: "open", draft: false, changed_files: 1,
    base: { ref: "main", sha: sourceSha, repo: { full_name: repository } },
    head: { ref: `automation/project-cover-${sourceSha}`, sha: headSha, repo: { full_name: repository } },
    user: { login: "github-actions[bot]" },
  };
  const files = [{ filename: "docs/screenshots/cover.png", status: "modified" }];
  const run = { id: 123, event: "pull_request", head_sha: headSha, head_repository: { full_name: repository }, path: ".github/workflows/ci.yml", conclusion: "action_required", pull_requests: [{ number }] };
  const writes = [];
  const data = { pr, files, runs: [run], writes };
  let time = 0;
  data.options = {
    repository, sourceSha, number, workflows: ["ci.yml"],
    now: () => time, sleep: async milliseconds => { time += milliseconds; }, log: () => {},
    api: async (path, method = "GET") => {
      if (method === "POST") { writes.push(path); return null; }
      if (path.endsWith("/files")) return files;
      if (path.includes("/actions/runs?")) return { total_count: data.runs.length, workflow_runs: data.runs };
      return pr;
    },
  };
  return data;
}

test("starts the normal PR workflow after validating the generated image change", async () => {
  const data = fixture();
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

for (const [name, tamper] of [
  ["source code change", data => { data.files[0].filename = "src/app.js"; }],
  ["additional file", data => { data.pr.changed_files = 2; }],
  ["foreign repository", data => { data.pr.head.repo.full_name = "other/project"; }],
  ["different branch", data => { data.pr.head.ref = "feature/new-code"; }],
  ["different author", data => { data.pr.user.login = "contributor"; }],
  ["superseded source", data => { data.pr.base.sha = "c".repeat(40); }],
  ["different checked commit", data => { data.runs[0].head_sha = "c".repeat(40); }],
  ["different pull request", data => { data.runs[0].pull_requests = [{ number: 99 }]; }],
  ["non-PR workflow", data => { data.runs[0].event = "workflow_dispatch"; }],
]) {
  test(`refuses ${name} without approving any workflow`, async () => {
    const data = fixture();
    tamper(data);
    await assert.rejects(startCoverChecks(data.options));
    assert.deepEqual(data.writes, []);
  });
}

test("does not approve an unrelated workflow", async () => {
  const data = fixture();
  data.runs.unshift({ ...data.runs[0], id: 456, path: ".github/workflows/release.yml" });
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

test("waits for delayed workflow creation", async () => {
  const data = fixture();
  const run = data.runs[0];
  data.runs = [];
  const sleep = data.options.sleep;
  data.options.sleep = async milliseconds => {
    await sleep(milliseconds);
    data.runs = [run];
  };
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, [`repos/${repository}/actions/runs/123/approve`]);
});

test("stops when expected workflows never appear", async () => {
  const data = fixture();
  data.runs = [];
  await assert.rejects(startCoverChecks(data.options), /Timed out waiting/);
  assert.deepEqual(data.writes, []);
});

test("does not reapprove workflows that already started", async () => {
  const data = fixture();
  data.runs[0].conclusion = null;
  await startCoverChecks(data.options);
  assert.deepEqual(data.writes, []);
});
