import { Command, CommanderError } from "commander";
import {
  DependencyCheckError,
  checkDependencies,
  dependencyCheckExitCode,
} from "../scripts/dependency-check";
import { DEPENDENCY_POLICY_PATH } from "../shared/dependency-policy";

const program = new Command()
  .name("hq-dependencies")
  .description(
    "Inspect repository-owned npm override lifecycles without changing repository or provider state",
  )
  .addHelpText(
    "after",
    "\nRequires Node.js 22.18 or newer and this project's installed dependencies. No environment variables or credentials are required. Results go to stdout; diagnostics go to stderr. Exit status: 0 checks pass, 1 runtime/upstream failure, 2 invalid input, 4 policy violations.\nThe policy is a schemaVersion 1 document containing manifests and reviewed version-scoped overrides. Each manifest needs an adjacent npm lockfileVersion 3 package-lock.json. See docs/dependencies.md for fields, bounds, and supported override shapes.\nExamples:\n  npm run check:dependencies\n  npm run dependencies:report -- --upstream\n  npm run check:dependencies -- --root /path/to/repository --policy .maintainer-hq/dependencies.json\n",
  )
  .exitOverride();
program
  .command("check")
  .description(
    "Check tracked overrides, patched lock resolutions, and review deadlines",
  )
  .option("-r, --root <directory>", "Repository root", process.cwd())
  .option(
    "-p, --policy <file>",
    "Relative lifecycle policy file",
    DEPENDENCY_POLICY_PATH,
  )
  .option("--json", "Print bounded lifecycle evidence as JSON")
  .option(
    "--upstream",
    "Also query the public npm registry for the declared parent package names",
  )
  .action(
    async (options: {
      root: string;
      policy: string;
      json?: boolean;
      upstream?: boolean;
    }) => {
      if (!options.root || !options.policy)
        throw new DependencyCheckError(
          "Root and policy values must not be empty",
        );
      const report = await checkDependencies(options);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log("Dependency lifecycle checks " + report.analysis.outcome);
        for (const finding of report.analysis.findings)
          console.log(
            `${finding.manifestPath}: ${finding.rule.package} ${finding.status}; review by ${finding.rule.reviewBy}${options.upstream ? "; upstream " + finding.upstream.state : ""}`,
          );
        for (const issue of report.analysis.issues)
          console.error(
            `${issue.code}: ${issue.manifestPath}${issue.overrideId ? " / " + issue.overrideId : ""}: ${issue.message}`,
          );
      }
      process.exitCode = dependencyCheckExitCode(
        report,
        Boolean(options.upstream),
      );
    },
  );
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.help"
        ? 0
        : 2;
  } else if (error instanceof DependencyCheckError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    console.error(
      "Dependency inspection failed; no repository changes were made",
    );
    process.exitCode = 1;
  }
}
