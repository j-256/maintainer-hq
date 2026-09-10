import { Command, CommanderError } from "commander";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { z } from "zod";
import {
  commands,
  commandAnnotations,
  type CommandName,
} from "../shared/commands";
import { callCommand, clientConfiguration, ClientError } from "./client";
import {
  providerCredentialEnvironmentInput,
  supplyProviderCredentialInput,
} from "./provider-credential-input";
import { PROVIDER_CREDENTIAL_LIMITS } from "../shared/provider-credentials";
import { CLOUDFLARE_SECRET_LIMITS } from "../shared/cloudflare-secrets";
import {
  secretTransientEnvironmentInput,
  supplyTransientSecretInput,
} from "./secret-transient-input";
import {
  readPrivateValue,
  secretEnvironmentInput,
  supplySecretInput,
} from "./secret-input";

const program = new Command()
  .name("hq-mcp")
  .description(
    "Bounded Maintainer HQ MCP tools over stdio; calls the shared authenticated workspace API",
  )
  .option(
    "-u, --url <origin>",
    "Workspace origin; defaults to HQ_URL",
    process.env.HQ_URL,
  )
  .option(
    "--dev",
    "Use isolated loopback development identity; never sends credentials",
  )
  .addHelpText(
    "after",
    "\nEnvironment: HQ_URL is the workspace origin. Use HQ_TOKEN for an enrolled automation credential or HQ_ACCESS_TOKEN for a signed-in human Access session, never both. For Access-protected automation, also set the paired HQ_ACCESS_CLIENT_ID and HQ_ACCESS_CLIENT_SECRET. Requires Node.js and installed project dependencies. Credential issuance returns a one-time value; only use an owner session in a trusted client that protects tool results.\nExit statuses: 0 help/normal shutdown, 1 runtime failure, 2 usage/precondition error. Stdout is reserved for MCP messages.\nRun npm run cli -- schema <command> to inspect input fields. Run directly with npx tsx cli/mcp.ts so package-manager output does not enter the protocol stream.",
  )
  .exitOverride();

try {
  program.parse();
  const options = program.opts<{ url?: string; dev?: boolean }>();
  if (!options.url) throw new ClientError("Provide --url or HQ_URL", 2);
  const configuration = clientConfiguration(options.url, Boolean(options.dev));
  const server = new McpServer({ name: "maintainer-hq", version: "0.1.0" });
  server.registerTool(
    "secrets_run_supply",
    {
      title:
        "Execute an accepted transient destination from a named inherited variable",
      description:
        "Trusted local private execution adapter. Requires the exact accepted review fingerprint and zero-based destination index. Reads only the named inherited environment variable after checking live review state, then supplies its UTF-8 value through the dedicated transient boundary. Never pass a value as an argument. Cloudflare writes activate a new Worker deployment. Values are not staged or recoverable from HQ. Submitted steps are not replayed; inputConsumed:false does not compare the supplied value. Inspect provider acceptance and metadata observation separately. Interrupted requests require inspection of the same receipt, not an automatic retry. Hosted MCP cannot read a client's environment.",
      inputSchema: secretTransientEnvironmentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const { environmentVariable, ...selection } =
          secretTransientEnvironmentInput.parse(input);
        const result = await supplyTransientSecretInput(
          configuration,
          selection,
          () =>
            readPrivateValue(
              { environmentVariable },
              CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES,
            ),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof ClientError
                  ? error.message
                  : "Private execution input failed. Inspect the same destination receipt before continuing.",
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "provider_credential_supply",
    {
      title:
        "Apply an owner-reviewed provider credential from a named inherited variable",
      description:
        "Trusted local private-input adapter. Requires the exact workspace, plan ID and reviewed fingerprint. Reads only the explicitly named inherited environment variable after checking the review, sends the token through the dedicated private boundary, and returns metadata only. Never pass a token value as an argument. This stores an encrypted provider authentication credential, not a reusable supplied-value vault. It does not create or revoke upstream tokens or change provider secrets. A submitted:false receipt does not compare or confirm this variable's value. Hosted MCP cannot read a client's environment.",
      inputSchema: providerCredentialEnvironmentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const { environmentVariable, ...selection } =
          providerCredentialEnvironmentInput.parse(input);
        const result = await supplyProviderCredentialInput(
          configuration,
          selection,
          () =>
            readPrivateValue(
              { environmentVariable },
              PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES,
            ),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof ClientError
                  ? error.message
                  : "Private credential input failed. Inspect the same review before retrying.",
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "secrets_supply",
    {
      title: "Supply private input from an explicitly named inherited variable",
      description:
        "Trusted local input adapter only. Reads the named inherited environment variable after checking the exact review, seals its value locally for reviewed public keys, and uploads ciphertext to the dedicated boundary. Never pass a value as an argument. Returns metadata only and never executes a provider operation. A submitted:false result means existing input was retained without reading or comparing this variable. Hosted MCP exposes the same review and public input requirements but cannot read client environment variables.",
      inputSchema: secretEnvironmentInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (input) => {
      try {
        const { environmentVariable, ...selection } =
          secretEnvironmentInput.parse(input);
        const result = await supplySecretInput(configuration, selection, () =>
          readPrivateValue({ environmentVariable }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof ClientError
                  ? error.message
                  : "Private input could not be supplied; inspect the same review before retrying",
            },
          ],
        };
      }
    },
  );
  for (const [name, command] of Object.entries(commands))
    server.registerTool(
      name,
      {
        title: command.title,
        description:
          command.title +
          ". Authorization is enforced by the workspace service.",
        inputSchema: command.schema as z.ZodType,
        annotations: commandAnnotations(name, command.readOnly),
      },
      async (input: unknown) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await callCommand(configuration, name as CommandName, input),
                ),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  error instanceof ClientError
                    ? error.message
                    : "Workspace request failed",
              },
            ],
          };
        }
      },
    );
  await server.connect(new StdioServerTransport());
} catch (error) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    console.error(
      error instanceof ClientError
        ? error.message
        : "MCP server could not start",
    );
    process.exitCode = error instanceof ClientError ? error.exitCode : 1;
  }
}
