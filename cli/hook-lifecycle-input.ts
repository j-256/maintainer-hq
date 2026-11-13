import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import { HOOK_LIFECYCLE_PRIVATE_BYTES, lifecycleSelectionInput } from "../shared/hook-lifecycle";
import { supplyLifecycleInput, LifecycleInputError } from "../shared/hook-lifecycle-input";
import { callCommand, clientConfiguration, ClientError } from "./client";

export const lifecycleFileInput = lifecycleSelectionInput.extend({ inputFile: z.string().min(1).max(4096).refine(value => value !== "-", "Use a named owner-only file for MCP input") }).strict();
export async function readLifecycleFile(path: string): Promise<Uint8Array> {
  const chunks: Buffer[] = []; let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let stream: AsyncIterable<Buffer | string>;
    if (path === "-") { if (process.stdin.isTTY) throw new Error(); stream = process.stdin; }
    else {
      const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink()) throw new Error();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > HOOK_LIFECYCLE_PRIVATE_BYTES || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
      stream = file.createReadStream({ autoClose: false });
    }
    let size = 0; for await (const chunk of stream) { const value = Buffer.from(chunk); size += value.length; if (size > HOOK_LIFECYCLE_PRIVATE_BYTES) { value.fill(0); throw new Error(); } chunks.push(value); }
    if (!size) throw new Error(); return Buffer.concat(chunks);
  } catch { throw new ClientError("Use a bounded owner-only regular non-symlink destination JSON file, or piped stdin (-). No material was supplied.", 2); }
  finally { for (const chunk of chunks) chunk.fill(0); await file?.close(); }
}
export async function supplyLifecycleFile(configuration: ReturnType<typeof clientConfiguration>, selection: unknown, read: () => Promise<Uint8Array>) {
  try {
    return await supplyLifecycleInput({ selection, read,
      review: input => callCommand(configuration, "hooks_lifecycle_get", { workspaceId: input.workspaceId, planId: input.planId }),
      send: (path, init) => fetch(new URL(path, configuration.origin), { ...init, headers: { ...configuration.headers, ...Object.fromEntries(new Headers(init.headers)) } }),
    });
  } catch (error) { if (error instanceof ClientError) throw error; throw new ClientError(error instanceof LifecycleInputError ? error.message : "Private destination input did not complete. Inspect the same review before continuing.", error instanceof LifecycleInputError && !error.uncertain ? 2 : 1); }
}
