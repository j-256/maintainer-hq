import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const COVER = "docs/screenshots/cover.png";
const WAIT_MS = 120_000;
const POLL_MS = 2_000;

export async function startCoverChecks({ repository, sourceSha, number, workflows, api, now = Date.now, sleep = delay, log = console.log }) {
  assert.match(repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(number) && number > 0);
  assert.ok(workflows.length > 0 && workflows.every(name => /^[a-zA-Z0-9_-]+\.yml$/.test(name)));
  const expected = new Set(workflows.map(name => `.github/workflows/${name}`));
  const prefix = `repos/${repository}`;
  const pr = await api(`${prefix}/pulls/${number}`);
  assert.equal(pr.state, "open");
  assert.equal(pr.draft, false);
  assert.equal(pr.base.ref, "main");
  assert.equal(pr.base.sha, sourceSha, "A newer source revision superseded this cover");
  assert.equal(pr.base.repo.full_name, repository);
  assert.equal(pr.head.repo.full_name, repository);
  assert.equal(pr.user.login, "github-actions[bot]");
  assert.equal(pr.head.ref, `automation/project-cover-${sourceSha}`);
  assert.equal(pr.changed_files, 1);
  const files = await api(`${prefix}/pulls/${number}/files`);
  assert.deepEqual(files.map(file => [file.filename, file.status]), [[COVER, "modified"]]);
  const started = new Set();
  const deadline = now() + WAIT_MS;
  while (now() < deadline) {
    const result = await api(`${prefix}/actions/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`);
    assert.ok(result.total_count <= 100, "Too many matching workflow runs to verify safely");
    for (const run of result.workflow_runs) {
      if (!expected.has(run.path) || started.has(run.path)) continue;
      assert.equal(run.event, "pull_request");
      assert.equal(run.head_sha, pr.head.sha);
      assert.equal(run.head_repository.full_name, repository);
      assert.ok(run.pull_requests.some(item => item.number === number));
      if (run.conclusion === "action_required") {
        await api(`${prefix}/actions/runs/${run.id}/approve`, "POST");
      }
      started.add(run.path);
      log(`Started ${run.path} for verified cover PR #${number}`);
    }
    if (started.size === expected.size) return;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for cover PR workflows: ${[...expected].filter(path => !started.has(path)).join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/start-cover-checks.mjs PR_NUMBER\n\nStart normal PR checks for the verified generated cover only. Requires Node, gh,\nGH_TOKEN with Actions write and repository/PR read permissions, GITHUB_REPOSITORY,\nGITHUB_SHA for the source build, and COVER_WORKFLOWS as comma-separated workflow\nfilenames. Does not approve PR reviews or bypass required status checks.\nExit status: 0 checks started, 1 verification/API failure, 2 usage, 3 missing dependency.");
    return 0;
  }
  if (args.length !== 1 || !/^[1-9][0-9]*$/.test(args[0])) {
    console.error("start-cover-checks: expected a pull request number; see --help");
    return 2;
  }
  if (!["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_SHA", "COVER_WORKFLOWS"].every(name => process.env[name])) {
    console.error("start-cover-checks: required GitHub workflow environment is missing; see --help");
    return 2;
  }
  try {
    await startCoverChecks({
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
      number: Number(args[0]),
      workflows: process.env.COVER_WORKFLOWS.split(","),
      api(path, method = "GET") {
        const text = execFileSync("gh", ["api", "--method", method, path], {
          encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
        return text.trim() ? JSON.parse(text) : null;
      },
    });
    return 0;
  } catch (error) {
    console.error(`start-cover-checks: ${error.message}`);
    return error.code === "ENOENT" ? 3 : 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
