import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { GITHUB_APP_LIMITS } from "../shared/github-apps";
import {
  GitHubAppInputError,
  supplyGitHubAppMaterial,
} from "../shared/github-app-input";
import { callCommand, ClientError, type clientConfiguration } from "./client";
import { githubAppRegistrationSelectionInput } from "../shared/github-apps";
import { z } from "zod";

export const githubAppFileInput = githubAppRegistrationSelectionInput
  .extend({
    inputFile: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) => value !== "-",
        "Use a named private file for MCP input",
      ),
  })
  .strict();
export async function readGitHubAppInputFile(
  path: string,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let stream: AsyncIterable<Buffer | string>;
    if (path === "-") {
      if (process.stdin.isTTY) throw new Error();
      stream = process.stdin;
    } else {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size > GITHUB_APP_LIMITS.PRIVATE_INPUT_BYTES ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new Error();
      stream = file.createReadStream({ autoClose: false });
    }
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > GITHUB_APP_LIMITS.PRIVATE_INPUT_BYTES) {
        bytes.fill(0);
        throw new Error();
      }
      chunks.push(bytes);
    }
    if (!size) throw new Error();
    return Buffer.concat(chunks);
  } catch {
    throw new ClientError(
      "Use a bounded owner-only regular non-symlink App input file, or piped stdin (-). No material was supplied.",
      2,
    );
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await file?.close();
  }
}
export async function supplyGitHubAppInput(
  configuration: ReturnType<typeof clientConfiguration>,
  selection: unknown,
  read: () => Promise<Uint8Array>,
) {
  try {
    return await supplyGitHubAppMaterial({
      selection,
      review: (input) =>
        callCommand(configuration, "github_app_registration_get", input),
      read,
      send: (path, init) =>
        fetch(new URL(path, configuration.origin), {
          ...init,
          headers: {
            ...configuration.headers,
            ...Object.fromEntries(new Headers(init.headers)),
          },
        }),
    });
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      error instanceof GitHubAppInputError
        ? error.message
        : "Private App input did not complete. Inspect the same review before retrying.",
      error instanceof GitHubAppInputError && !error.uncertain ? 2 : 1,
    );
  }
}
