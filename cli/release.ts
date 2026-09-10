import { Command, CommanderError } from "commander";
import { fileURLToPath } from "node:url";
import {
  buildArtifact,
  verifyArtifact,
  MissingBuildDependency,
} from "../scripts/release-artifact";
import { readReleaseProfile } from "../scripts/release-profile";

const root = fileURLToPath(new URL("..", import.meta.url));
const program = new Command()
  .name("hq-release")
  .description(
    "Inspect, build, and verify an offline release artifact. Never deploys or attaches hostnames.",
  )
  .addHelpText(
    "after",
    "\nRequires Node.js, Git, and locked project dependencies. Profile: bounded JSON with schemaVersion=1, accountId, workerName, databaseName, databaseId, retainedWorkerName, retainedDatabaseId, intendedHostname, accessIssuer, accessAudience, and scheduledCollection. No secrets, routes, or preview ingress. See docs/release.md.\nThe review is a SHA-256 profile fingerprint, not deployment permission. Output must not exist; its parent must exist. Results go to stdout, build diagnostics to stderr.\nExit statuses: 0 success/help, 1 runtime or artifact failure, 2 usage/profile/review error, 3 missing build dependency.",
  )
  .exitOverride();
program
  .command("inspect")
  .description("Validate a profile and print its exact review fingerprint")
  .requiredOption("-p, --profile <file>", "Deployment profile JSON file")
  .action(async ({ profile }: { profile: string }) => {
    if (!profile)
      throw new CommanderError(2, "profile", "Provide a profile file");
    try {
      const result = await readReleaseProfile(profile);
      console.log(
        JSON.stringify({ ...result, deploymentAuthorized: false }, null, 2),
      );
    } catch (error) {
      throw new CommanderError(
        2,
        "profile",
        error instanceof Error ? error.message : "Invalid profile",
      );
    }
  });
program
  .command("build")
  .description("Build and package the exact reviewed profile without deploying")
  .requiredOption("-p, --profile <file>", "Deployment profile JSON file")
  .requiredOption("-r, --review <sha256>", "Fingerprint returned by inspect")
  .requiredOption(
    "-o, --output <directory>",
    "New artifact directory with an existing parent",
  )
  .action(
    async ({
      profile,
      review,
      output,
    }: {
      profile: string;
      review: string;
      output: string;
    }) => {
      if (!profile || !output || !/^[a-f0-9]{64}$/.test(review))
        throw new CommanderError(
          2,
          "options",
          "Provide nonempty profile/output values and a SHA-256 review",
        );
      const parsed = await readReleaseProfile(profile).catch(() => {
        throw new CommanderError(2, "profile", "Invalid deployment profile");
      });
      if (parsed.fingerprint !== review)
        throw new CommanderError(
          2,
          "review",
          "Profile changed: inspect and review again",
        );
      console.log(
        JSON.stringify(
          await buildArtifact(root, profile, review, output),
          null,
          2,
        ),
      );
    },
  );
program
  .command("verify")
  .description(
    "Verify a portable artifact and its reviewed profile fingerprint",
  )
  .requiredOption("-a, --artifact <directory>", "Release artifact directory")
  .requiredOption("-r, --review <sha256>", "Expected profile fingerprint")
  .requiredOption(
    "-d, --digest <sha256>",
    "Separately retained artifact fingerprint returned by build",
  )
  .action(
    async ({
      artifact,
      review,
      digest,
    }: {
      artifact: string;
      review: string;
      digest: string;
    }) => {
      if (
        !artifact ||
        !/^[a-f0-9]{64}$/.test(review) ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new CommanderError(
          2,
          "options",
          "Provide an artifact directory and SHA-256 review",
        );
      console.log(
        JSON.stringify(await verifyArtifact(artifact, review, digest), null, 2),
      );
    },
  );
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    if (
      error.code !== "commander.helpDisplayed" &&
      !error.code.startsWith("commander.")
    )
      console.error(error.message);
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    console.error(
      error instanceof Error && !(error as NodeJS.ErrnoException).code
        ? error.message
        : "Release artifact operation failed; check dependencies, source files, and the chosen paths",
    );
    process.exitCode = error instanceof MissingBuildDependency ? 3 : 1;
  }
}
