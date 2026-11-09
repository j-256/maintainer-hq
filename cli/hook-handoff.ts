import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import { HANDOFF_PRIVATE_BYTES, normalizeHandoffRepository, handoffPlanInput, handoffExportInput, handoffRecordSchema, handoffExportSchema, handoffReviewSchema } from "../shared/hook-handoff";
import { clientConfiguration, CLIENT_LIMITS, ClientError } from "./client";

const path = z.string().min(1).max(4096);
export const handoffAdoptFileInput = handoffPlanInput.safeExtend({ manifestPath: path }).strict();
export const handoffExportFileInput = handoffExportInput.extend({ outputPath: path }).strict();
async function privateRequest(configuration: ReturnType<typeof clientConfiguration>, action: string, input: unknown) {
  const body = JSON.stringify({ action, input });
  if (Buffer.byteLength(body) > HANDOFF_PRIVATE_BYTES) throw new ClientError("Private request exceeds the handoff limit", 2);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(new URL("/api/hooks/handoff/private", configuration.origin), { method: "POST", redirect: "error", headers: configuration.headers, body, signal: AbortSignal.timeout(CLIENT_LIMITS.REQUEST_TIMEOUT_MS) });
    if (response.status !== 200 || response.headers.get("cache-control") !== "no-store" || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !response.body) throw new Error();
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > HANDOFF_PRIVATE_BYTES) throw new Error(); chunks.push(value); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch { throw new ClientError("Private handoff response is unavailable or uncertain. Inspect the same review before another attempt; retain any existing private export."); }
  finally { void reader?.cancel().catch(() => {}); }
}
export async function adoptHandoffFile(configuration: ReturnType<typeof clientConfiguration>, input: unknown) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const { manifestPath, ...selection } = handoffAdoptFileInput.parse(input);
    file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw new Error();
    const text = await file.readFile("utf8"); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
    const manifest = z.object({ version: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), repositories: z.record(z.string(), z.unknown()), retiredRepositories: z.record(z.string(), z.unknown()) }).strict().parse(JSON.parse(text));
    const matches = Object.entries(manifest.repositories).filter(([repo]) => repo.toLowerCase() === normalizeHandoffRepository(selection.repository).toLowerCase());
    if (matches.length !== 1 || Object.keys(manifest.retiredRepositories).some(repo => repo.toLowerCase() === normalizeHandoffRepository(selection.repository).toLowerCase())) throw new Error();
    const record = handoffRecordSchema.parse(matches[0]![1]);
    return handoffReviewSchema.parse(await privateRequest(configuration, "adopt_plan", { ...selection, record }));
  } catch (error) { if (error instanceof ClientError) throw error; throw new ClientError("The selected recovery record or private manifest is unsupported. Use an active unbound record in a regular non-symlink mode-0600 file.", 2); }
  finally { await file?.close(); }
}
export async function exportHandoffFile(configuration: ReturnType<typeof clientConfiguration>, input: unknown) {
  let file: Awaited<ReturnType<typeof open>> | undefined; let created = false;
  let outputPath: string | undefined;
  try {
    const { outputPath: destination, ...selection } = handoffExportFileInput.parse(input); outputPath = destination;
    file = await open(outputPath, "wx", 0o600); created = true;
    const value = handoffExportSchema.parse(await privateRequest(configuration, "export", selection));
    if (value.record.provider.repositoryId !== selection.repositoryId || value.record.provider.workspaceId !== selection.workspaceId) throw new Error();
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text) > HANDOFF_PRIVATE_BYTES) throw new Error();
    await file.chmod(0o600); await file.writeFile(text); await file.sync();
    if ((await file.stat()).mode % 0o1000 !== 0o600) throw new Error();
    await file.close(); file = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if ((await file.stat()).mode % 0o1000 !== 0o600 || await file.readFile("utf8") !== text) throw new Error();
    return { repository: value.repository, repositoryId: selection.repositoryId, outputPath, profiles: value.record.profiles, saved: true };
  } catch (error) {
    await file?.close(); file = undefined;
    if (created && outputPath) await unlink(outputPath).catch(() => {});
    if (error instanceof ClientError) throw error;
    throw new ClientError("Private recovery export could not be saved. Choose a new file in an existing owner-controlled directory; provider credentials remain available.");
  } finally { await file?.close(); }
}
