import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkDependencies,
  dependencyCheckExitCode,
  DependencyCheckError,
} from "../scripts/dependency-check";
import {
  DEPENDENCY_LIMITS,
  DEPENDENCY_POLICY_PATH,
} from "../shared/dependency-policy";
import {
  dependencyFixture,
  DEPENDENCY_TEST_NOW as NOW,
} from "./fixtures/dependencies";

const cli = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "cli/dependencies.ts", ...args],
    { encoding: "utf8" },
  );
async function withFixture(
  run: (
    root: string,
    fixture: ReturnType<typeof dependencyFixture>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "hq-dependency-check-"));
  const fixture = dependencyFixture();
  await mkdir(join(root, ".maintainer-hq"));
  await writeFile(
    join(root, DEPENDENCY_POLICY_PATH),
    JSON.stringify(fixture.policy),
  );
  await writeFile(join(root, "package.json"), JSON.stringify(fixture.manifest));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify(fixture.lock),
  );
  try {
    await run(root, fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dependency CLI supports help without inspecting a repository or making upstream requests", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["check", "--help"],
    ["check", "-h"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
  }
});
test("dependency CLI rejects unknown, missing and empty option values without private input echoes", () => {
  for (const args of [
    ["check", "--unknown"],
    ["check", "--root"],
    ["check", "--policy"],
    ["check", "--root="],
    ["check", "--policy="],
    ["check", "--", "unexpected"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 2, args.join(" "));
  }
});
test("dependency reports contain only bounded lifecycle evidence and input digests", async () => {
  await withFixture(async (root) => {
    const calls: string[] = [];
    const report = await checkDependencies({
      root,
      now: NOW,
      fetcher: async (input) => {
        calls.push(String(input));
        throw new Error("Unexpected network request");
      },
    });
    assert.equal(report.analysis.outcome, "passed");
    assert.equal(report.kind, "npm-override-lifecycle");
    assert.match(report.policyDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(report.files[0]!.manifestPath, "package.json");
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(dependencyCheckExitCode(report, false), 0);
  });
});
test("upstream evidence deduplicates the installed parents and never sends credentials", async () => {
  await withFixture(async (root) => {
    const calls: string[] = [];
    const report = await checkDependencies({
      root,
      now: NOW,
      upstream: true,
      fetcher: async (input, init) => {
        calls.push(String(input));
        assert.equal(String(input), "https://registry.npmjs.org/runner/latest");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        return Response.json({
          name: "runner",
          version: "3.0.0",
          dependencies: { decoder: "1.0.1" },
          private: "not retained",
        });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(report.analysis.findings[0]!.status, "mitigated");
    assert.equal(report.analysis.findings[0]!.upstream.state, "fix_available");
    assert.equal(JSON.stringify(report).includes("not retained"), false);
    assert.equal(dependencyCheckExitCode(report, true), 0);
  });
});
test("failed and oversized upstream reads stay unknown and fail the requested maintenance check", async () => {
  await withFixture(async (root) => {
    for (const fetcher of [
      async () => {
        throw new Error("provider-private-response");
      },
      async () => new Response("provider-private-response", { status: 403 }),
      async () =>
        new Response("x".repeat(DEPENDENCY_LIMITS.UPSTREAM_BYTES + 1)),
      async () => new Response("invalid-json-provider-private-response"),
    ]) {
      const report = await checkDependencies({
        root,
        now: NOW,
        upstream: true,
        fetcher,
      });
      assert.equal(report.analysis.outcome, "passed");
      assert.equal(report.analysis.findings[0]!.upstream.state, "unavailable");
      assert.equal(dependencyCheckExitCode(report, true), 1);
      assert.equal(
        JSON.stringify(report).includes("provider-private-response"),
        false,
      );
    }
  });
});
test("lifecycle failures have their own exit status and never alter repository inputs", async () => {
  await withFixture(async (root, fixture) => {
    const before = await readFile(join(root, "package.json"), "utf8");
    const report = await checkDependencies({
      root,
      now: Date.parse(fixture.rule.reviewBy),
    });
    assert.equal(report.analysis.findings[0]!.status, "review_due");
    assert.equal(dependencyCheckExitCode(report, false), 4);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
    fixture.rule.reviewBy = "2020-01-02T00:00:00.000Z";
    fixture.rule.reviewedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(
      join(root, DEPENDENCY_POLICY_PATH),
      JSON.stringify(fixture.policy),
    );
    for (const args of [
      ["check", "--root", root, "--json"],
      ["check", "--root=" + root, "--json"],
      ["check", "-r" + root, "--json"],
      ["check", "-r", root, "-p" + DEPENDENCY_POLICY_PATH, "--json"],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 4);
      assert.equal(
        JSON.parse(result.stdout).analysis.findings[0].status,
        "review_due",
      );
      assert.equal(result.stderr, "");
    }
    const human = cli(["check", "-r", root]);
    assert.equal(human.status, 4);
    assert.match(human.stderr, /review_due/);
    assert.match(human.stdout, /checks failed/);
  });
});
test("missing, invalid, oversized, linked and escaping inputs fail closed without exposing contents", async () => {
  await withFixture(async (root) => {
    await assert.rejects(
      checkDependencies({ root, policy: "../package.json", now: NOW }),
      DependencyCheckError,
    );
    await assert.rejects(
      checkDependencies({ root, policy: "missing.json", now: NOW }),
      DependencyCheckError,
    );
    await writeFile(join(root, "invalid.json"), "private-content-not-json");
    await assert.rejects(
      checkDependencies({ root, policy: "invalid.json", now: NOW }),
      (error: unknown) =>
        error instanceof DependencyCheckError &&
        !error.message.includes("private-content"),
    );
    await writeFile(
      join(root, "oversized.json"),
      "x".repeat(DEPENDENCY_LIMITS.POLICY_BYTES + 1),
    );
    await assert.rejects(
      checkDependencies({ root, policy: "oversized.json", now: NOW }),
      DependencyCheckError,
    );
    await symlink(
      join(root, DEPENDENCY_POLICY_PATH),
      join(root, "linked.json"),
    );
    await assert.rejects(
      checkDependencies({ root, policy: "linked.json", now: NOW }),
      DependencyCheckError,
    );
    await symlink(join(root, ".maintainer-hq"), join(root, "linked"));
    await assert.rejects(
      checkDependencies({ root, policy: "linked/dependencies.json", now: NOW }),
      DependencyCheckError,
    );
  });
});
test(
  "special files cannot stall dependency inspection",
  { skip: process.platform === "win32" },
  async () => {
    await withFixture(async (root) => {
      const pipe = join(root, "input.pipe");
      const created = spawnSync("mkfifo", [pipe], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(created.status, 0);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "cli/dependencies.ts",
          "check",
          "--root",
          root,
          "--policy",
          "input.pipe",
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 2);
      assert.equal(result.error, undefined);
    });
  },
);
