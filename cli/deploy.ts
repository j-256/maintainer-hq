import { Command, CommanderError } from "commander";
import { DeploymentPathError } from "../scripts/deployment-paths";
import { ClientError } from "./client";
import { fileURLToPath } from "node:url";
import { deploy, saveProfile, DeploymentError, type DeploymentMode } from "../scripts/deployment";

const mode = process.argv[2] as DeploymentMode;
const program = new Command().name(mode === "docs" ? "hq-docs-deploy" : "hq-deploy")
  .description("Build, test, verify, and deploy an existing reviewed Maintainer HQ installation")
  .option("-p, --profile <file>", "Override the saved deployment profile JSON path")
  .option("-s, --save-profile <file>", "Save an installation profile path and exit without deploying")
  .option("-n, --dry-run", "Run local checks and package verification without production reads or writes")
  .addHelpText("after", "\nSetup: npm ci; npm --prefix site ci; npx playwright install chromium. Requires Git, Node.js >=22.22, and Python 3 with sqlite3 for app recovery rehearsal.\nProfile schema: docs/release.md. Save its path once with --save-profile; private config is $XDG_CONFIG_HOME/hq-deploy/config.json (default ~/.config). Recovery artifacts and receipts use $XDG_STATE_HOME/hq-deploy (default ~/.local/state).\nLive deployment requires CLOUDFLARE_API_TOKEN with Worker, D1 (app only), and Access-read (app only) permissions. App smoke checks require HQ_TOKEN + HQ_ACCESS_CLIENT_ID + HQ_ACCESS_CLIENT_SECRET, or HQ_ACCESS_TOKEN; an optional named Keychain reader can be configured in private JSON. See docs/release.md.\nDeployment does not create resources, grant credentials, or attach hostnames. A failed migration/upload may have taken effect: inspect its receipt before another invocation.\nExit statuses: 0 success/help, 1 runtime failure, 2 usage/precondition error, 3 missing dependency.\n")
  .exitOverride();
try {
  if (!["app", "docs"].includes(mode)) throw new DeploymentError("Choose app or docs", 2);
  program.parse([process.argv[0], process.argv[1], ...process.argv.slice(3)]);
  const options = program.opts<{ profile?: string; saveProfile?: string; dryRun?: boolean }>();
  if (Object.values(options).some(value => value === "") || (options.saveProfile && (options.profile || options.dryRun))) throw new DeploymentError("Provide nonempty paths; --save-profile cannot be combined with deployment options", 2);
  if (options.saveProfile) console.log(JSON.stringify({ configuration: await saveProfile(options.saveProfile) }));
  else console.log(JSON.stringify(await deploy(fileURLToPath(new URL("..", import.meta.url)), mode, options), null, 2));
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    console.error((error instanceof DeploymentError || error instanceof ClientError || error instanceof DeploymentPathError) ? error.message : "Deployment input or operation failed; check the profile, dependencies, credentials, and retained receipt");
    process.exitCode = (error instanceof DeploymentError || error instanceof ClientError || error instanceof DeploymentPathError) ? error.exitCode : 1;
  }
}
