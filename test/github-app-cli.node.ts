import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { commands } from "../shared/commands";
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "cli/index.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, HQ_URL: "" },
  });
test("exposes guided registration and bounded repository selection through shared CLI contracts", () => {
  const list = JSON.parse(cli("list"));
  for (const name of [
    "github_app_manifest_start",
    "github_app_manifest_get",
    "github_apps_list",
    "github_app_installations_list",
    "github_app_repositories_list",
    "github_app_grant_plan",
    "github_app_grant_accept",
    "github_app_connection_request",
  ]) {
    assert(list.some((item: { name: string }) => item.name === name));
    const schema = JSON.parse(cli("schema", name));
    assert(schema.properties.workspaceId);
    assert.equal(schema.additionalProperties, false);
    assert(!/privateKey|webhookSecret|"token"/.test(JSON.stringify(schema)));
  }
  assert.equal(commands.github_app_repositories_list.readOnly, true);
});
test("keeps protected App material outside ordinary CLI arguments", () => {
  const help = cli("github-app-input", "--help");
  assert.match(help, /owner-only/);
  assert.match(help, /stdin/);
  assert.match(help, /fingerprint/);
  assert(!/--private-key|--webhook-secret|--token/.test(help));
});
