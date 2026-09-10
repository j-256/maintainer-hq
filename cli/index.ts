import { Command, CommanderError } from "commander";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { commands, type CommandName } from "../shared/commands";
import { callCommand, clientConfiguration, ClientError } from "./client";
import { LIMITS } from "../shared/domain";
import { readPrivateValue, supplySecretInput } from "./secret-input";
import { supplyProviderCredentialInput } from "./provider-credential-input";
import { PROVIDER_CREDENTIAL_LIMITS } from "../shared/provider-credentials";
import { supplyTransientSecretInput } from "./secret-transient-input";
import { CLOUDFLARE_SECRET_LIMITS } from "../shared/cloudflare-secrets";
import { SECRET_LIMITS } from "../shared/secrets";

const program = new Command()
  .name("hq")
  .description(
    "Workspace-scoped Maintainer HQ commands. Results are JSON on stdout; diagnostics are on stderr.",
  )
  .option(
    "-u, --url <origin>",
    "Workspace origin; defaults to HQ_URL",
    process.env.HQ_URL,
  )
  .option(
    "--dev",
    "Use the isolated loopback development identity; never sends credentials",
  )
  .addHelpText(
    "after",
    "\nEnvironment: HQ_URL sets the origin. Use HQ_TOKEN for an enrolled automation credential or HQ_ACCESS_TOKEN for a signed-in human Access session, never both. For an Access-protected automation origin, also set the paired HQ_ACCESS_CLIENT_ID and HQ_ACCESS_CLIENT_SECRET. Never pass secrets as command arguments. Credential issuance returns a one-time value on stdout; use a private destination.\nExit statuses: 0 success/help, 1 runtime failure, 2 usage/precondition error. Requires Node.js and installed project dependencies.\nExamples:\n  npm run cli -- --url http://127.0.0.1:5178 --dev call activity_list -i input.json\n  npm run cli -- schema goal_sync\n\nInput is one JSON object. Use schema <command> for exact fields, types, and bounds. Workspace operations require workspaceId; account onboarding commands use the verified identity. Goal sync preserves objective verbatim, including whitespace. Reuse eventId when retrying an activity write.",
  )
  .exitOverride();

function commandName(value: string): CommandName {
  if (!Object.hasOwn(commands, value))
    throw new ClientError(
      "Unknown command. Run hq list for supported commands.",
      2,
    );
  return value as CommandName;
}

program
  .command("list")
  .description("List the bounded workspace commands")
  .action(() => {
    console.log(
      JSON.stringify(
        Object.entries(commands).map(([name, command]) => ({
          name,
          description: command.title,
          readOnly: command.readOnly,
        })),
        null,
        2,
      ),
    );
  });
program
  .command("schema <command>")
  .description("Print the JSON Schema for one command")
  .action((name) => {
    console.log(
      JSON.stringify(
        z.toJSONSchema(commands[commandName(name)].schema),
        null,
        2,
      ),
    );
  });
program
  .command("call <command>")
  .description("Call a workspace command using a JSON file or stdin")
  .requiredOption("-i, --input <file>", "UTF-8 JSON file; use - for stdin")
  .action(async (name, options: { input: string }) => {
    const parsedName = commandName(name);
    const global = program.opts<{ url?: string; dev?: boolean }>();
    if (!global.url) throw new ClientError("Provide --url or HQ_URL", 2);
    const configuration = clientConfiguration(global.url, Boolean(global.dev));
    let source: string;
    if (options.input === "-") {
      if (process.stdin.isTTY)
        throw new ClientError(
          "Pipe one JSON object to stdin or provide a file",
          2,
        );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += Buffer.byteLength(chunk);
        if (size > LIMITS.BODY_BYTES)
          throw new ClientError("Input exceeds the request size limit", 2);
        chunks.push(Buffer.from(chunk));
      }
      source = Buffer.concat(chunks).toString("utf8");
    } else {
      try {
        source = await readFile(options.input, "utf8");
      } catch {
        throw new ClientError("Input file could not be read", 2);
      }
      if (Buffer.byteLength(source) > LIMITS.BODY_BYTES)
        throw new ClientError("Input exceeds the request size limit", 2);
    }
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch {
      throw new ClientError("Input must be valid JSON", 2);
    }
    console.log(
      JSON.stringify(
        await callCommand(configuration, parsedName, input),
        null,
        2,
      ),
    );
  });

program
  .command("secret-input")
  .description(
    "Seal a supplied UTF-8 value for an existing review; never changes provider secrets",
  )
  .requiredOption(
    "-w, --workspace <id>",
    "Workspace ID from the prepared review",
  )
  .requiredOption(
    "-r, --review <id>",
    "Exact review ID returned by secrets_draft",
  )
  .option(
    "-i, --input <file>",
    "Owner-only private UTF-8 file; use - for piped stdin",
  )
  .option(
    "-e, --environment-variable <name>",
    "Inherited environment variable name, never its value",
  )
  .addHelpText(
    "after",
    "\nChoose exactly one of --input or --environment-variable. Whitespace and trailing newlines are preserved. Only the name of a file or inherited variable belongs in arguments. Input is read after checking the review and sealed separately for its public keys. A previously accepted input is reported with submitted:false without reading or replacing the value. On interruption, inspect the same review. Output is metadata only. Provider execution requires a separate reviewed confirmation.",
  )
  .action(
    async (options: {
      workspace: string;
      review: string;
      input?: string;
      environmentVariable?: string;
    }) => {
      if (
        Number(options.input !== undefined) +
          Number(options.environmentVariable !== undefined) !==
        1
      )
        throw new ClientError(
          "Choose exactly one --input or --environment-variable option",
          2,
        );
      const global = program.opts<{ url?: string; dev?: boolean }>();
      if (!global.url) throw new ClientError("Provide --url or HQ_URL", 2);
      const result = await supplySecretInput(
        clientConfiguration(global.url, Boolean(global.dev)),
        { workspaceId: options.workspace, reviewId: options.review },
        () => readPrivateValue(options),
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );

program
  .command("secret-run-input")
  .description(
    "Execute one accepted Cloudflare destination using private transient UTF-8 input",
  )
  .requiredOption(
    "-w, --workspace <id>",
    "Workspace ID from the accepted review",
  )
  .requiredOption("-r, --review <id>", "Exact accepted Secrets review ID")
  .requiredOption(
    "-p, --fingerprint <sha256:digest>",
    "Exact fingerprint of the accepted distribution",
  )
  .requiredOption(
    "-d, --destination <index>",
    "Zero-based destination index from the receipt",
    (value: string) => {
      if (
        !/^(0|[1-9][0-9]{0,2})$/.test(value) ||
        Number(value) >= SECRET_LIMITS.DESTINATIONS
      )
        throw new ClientError(
          "Select a supported zero-based destination index from the accepted review",
          2,
        );
      return Number(value);
    },
  )
  .option(
    "-i, --input <file>",
    "Owner-only private UTF-8 file; use - for piped stdin",
  )
  .option(
    "-e, --environment-variable <name>",
    "Inherited value variable name, never its value",
  )
  .addHelpText(
    "after",
    "\nChoose exactly one --input or --environment-variable. Input is read only for a pending destination of the exact accepted review. Cloudflare text secrets are limited to " +
      CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES +
      " UTF-8 bytes. Whitespace, a UTF-8 BOM and trailing newlines are preserved. A successful provider write deploys a new Worker version immediately. HQ does not stage, hash, or retain this value for recovery. Submitted steps are never replayed; inputConsumed:false means this request did not read its input, not that the supplied value matches earlier work. Check writeStatus and observationStatus separately. On an interrupted request, inspect the same destination receipt. Output contains metadata only. Use secrets_apply to accept the review before this command; source removal requires its own review.",
  )
  .action(
    async (options: {
      workspace: string;
      review: string;
      fingerprint: string;
      destination: number;
      input?: string;
      environmentVariable?: string;
    }) => {
      if (
        Number(options.input !== undefined) +
          Number(options.environmentVariable !== undefined) !==
        1
      )
        throw new ClientError(
          "Choose exactly one --input or --environment-variable option",
          2,
        );
      const global = program.opts<{ url?: string; dev?: boolean }>();
      if (!global.url) throw new ClientError("Provide --url or HQ_URL", 2);
      const result = await supplyTransientSecretInput(
        clientConfiguration(global.url, Boolean(global.dev)),
        {
          workspaceId: options.workspace,
          reviewId: options.review,
          fingerprint: options.fingerprint,
          destinationIndex: options.destination,
        },
        () => readPrivateValue(options, CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES),
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );

program
  .command("credential-input")
  .description(
    "Apply an exact reviewed provider credential replacement through private input",
  )
  .requiredOption(
    "-w, --workspace <id>",
    "Workspace ID from the credential review",
  )
  .requiredOption(
    "-r, --review <id>",
    "Exact plan ID returned by provider_credential_plan",
  )
  .requiredOption(
    "-p, --fingerprint <sha256:digest>",
    "Exact fingerprint of the owner-reviewed scope and replacement",
  )
  .option("-i, --input <file>", "Owner-only token file; use - for piped stdin")
  .option(
    "-e, --environment-variable <name>",
    "Inherited token variable name, never its value",
  )
  .addHelpText(
    "after",
    "\nChoose exactly one --input or --environment-variable. Token input must be printable ASCII without spaces, newlines or a trailing newline, at most " +
      PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES +
      " bytes. This saves an encrypted provider authentication credential, not a reusable destination-secret value. The exact review is checked before input is read. Already-applied reviews return submitted:false without reading or comparing the token. On interruption, inspect provider_credential_review for the same plan ID; do not silently create a replacement. Output contains metadata only. No upstream token is created or revoked and no provider secret is changed.",
  )
  .action(
    async (options: {
      workspace: string;
      review: string;
      fingerprint: string;
      input?: string;
      environmentVariable?: string;
    }) => {
      if (
        Number(options.input !== undefined) +
          Number(options.environmentVariable !== undefined) !==
        1
      ) {
        throw new ClientError(
          "Choose exactly one --input or --environment-variable option",
          2,
        );
      }
      const global = program.opts<{ url?: string; dev?: boolean }>();
      if (!global.url) throw new ClientError("Provide --url or HQ_URL", 2);
      const result = await supplyProviderCredentialInput(
        clientConfiguration(global.url, Boolean(global.dev)),
        {
          workspaceId: options.workspace,
          planId: options.review,
          fingerprint: options.fingerprint,
        },
        () => readPrivateValue(options, PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES),
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    console.error(
      error instanceof ClientError
        ? error.message
        : "This command could not be completed",
    );
    process.exitCode = error instanceof ClientError ? error.exitCode : 1;
  }
}
