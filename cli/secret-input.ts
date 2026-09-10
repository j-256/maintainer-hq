import { open } from "node:fs/promises";
import { z } from "zod";
import {
  SECRET_LIMITS,
  secretReviewInput,
  secretReviewSchema,
} from "../shared/secrets";
import { sealGitHubSecret } from "../shared/github-secret-crypto";
import {
  callCommand,
  clientConfiguration,
  CLIENT_LIMITS,
  ClientError,
} from "./client";

export const secretEnvironmentInput = secretReviewInput
  .extend({
    environmentVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  })
  .strict();
async function readAcceptance(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing acceptance receipt");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SECRET_LIMITS.REVIEW_RESPONSE_BYTES)
        throw new Error("Oversized acceptance receipt");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export async function readPrivateValue(
  options: {
    input?: string;
    environmentVariable?: string;
  },
  maxBytes: number = SECRET_LIMITS.INPUT_BYTES,
) {
  if (
    Number(options.input !== undefined) +
      Number(options.environmentVariable !== undefined) !==
    1
  )
    throw new ClientError(
      "Choose exactly one private input file, stdin (-), or inherited environment variable",
      2,
    );
  if (options.environmentVariable !== undefined) {
    if (
      !secretEnvironmentInput.shape.environmentVariable.safeParse(
        options.environmentVariable,
      ).success
    )
      throw new ClientError(
        "Use a valid inherited environment variable name, never its value",
        2,
      );
    const value = process.env[options.environmentVariable];
    if (!value || Buffer.byteLength(value) > maxBytes)
      throw new ClientError(
        "The selected inherited value is missing, empty, or too large",
        2,
      );
    return new TextEncoder().encode(value);
  }
  if (!options.input)
    throw new ClientError("Select a private input file or stdin (-)", 2);
  const chunks: Buffer[] = [];
  let size = 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let stream: AsyncIterable<Buffer | string>;
  try {
    if (options.input === "-") {
      if (process.stdin.isTTY)
        throw new ClientError(
          "Pipe private UTF-8 input to stdin; interactive input is not accepted",
          2,
        );
      stream = process.stdin;
    } else {
      file = await open(options.input, "r");
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes)
        throw new ClientError(
          "Use an owner-only regular input file within the value size limit",
          2,
        );
      stream = file.createReadStream({ autoClose: false });
    }
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        bytes.fill(0);
        throw new ClientError("Private input exceeds the value size limit", 2);
      }
      chunks.push(bytes);
    }
    if (!size) throw new ClientError("Supply a nonempty private value", 2);
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError("The private input could not be read", 2);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await file?.close().catch(() => {});
  }
}

export async function supplySecretInput(
  configuration: ReturnType<typeof clientConfiguration>,
  input: unknown,
  read: () => Promise<Uint8Array>,
) {
  let selection: z.infer<typeof secretReviewInput>;
  try {
    selection = secretReviewInput.parse(input);
  } catch {
    throw new ClientError("Select a workspace and exact Secrets review ID", 2);
  }
  const result = secretReviewSchema.safeParse(
    await callCommand(configuration, "secrets_review", selection),
  );
  if (!result.success || result.data.id !== selection.reviewId)
    throw new ClientError("The workspace returned an invalid Secrets review");
  const review = result.data;
  if (
    !review.actorMatches ||
    Date.parse(review.expiresAt) <= Date.now() ||
    Date.parse(review.inputExpiresAt) <= Date.now()
  )
    throw new ClientError(
      "This review expired or belongs to another actor; no input was read",
      2,
    );
  if (review.stage === "reviewed" && review.inputPresent)
    return { submitted: false, review };
  if (
    review.stage !== "awaiting-input" ||
    !review.destinations.some(
      (item) => item.snapshot.input.kind === "provider-sealed",
    )
  )
    throw new ClientError(
      "This review does not accept GitHub-sealed input; no value was read",
      2,
    );
  const value = await read();
  try {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw new ClientError(
        "Supply valid UTF-8 bytes; the value was not submitted",
        2,
      );
    }
    const items = [];
    for (const [
      destinationIndex,
      destination,
    ] of review.destinations.entries()) {
      const requirement = destination.snapshot.input;
      if (value.byteLength > requirement.maxValueBytes)
        throw new ClientError(
          "Private input exceeds a reviewed destination's limit",
          2,
        );
      try {
        if (requirement.kind !== "provider-sealed") continue;
        items.push({
          destinationIndex,
          ciphertext: await sealGitHubSecret(value, requirement.publicKey),
        });
      } catch {
        throw new ClientError(
          "Private input could not be sealed; no value was submitted",
        );
      }
    }
    const body = JSON.stringify({ version: 1, items });
    if (Buffer.byteLength(body) > SECRET_LIMITS.UPLOAD_BYTES)
      throw new ClientError("Sealed input exceeds the upload limit", 2);
    const url = new URL("/api/secrets/input", configuration.origin);
    url.searchParams.set("workspaceId", selection.workspaceId);
    url.searchParams.set("reviewId", selection.reviewId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          ...configuration.headers,
          "If-Match": review.draftFingerprint,
        },
        body,
        signal: AbortSignal.timeout(CLIENT_LIMITS.REQUEST_TIMEOUT_MS),
      });
      if (
        !response.ok ||
        response.headers.get("Content-Type")?.split(";")[0]?.trim() !==
          "application/json"
      ) {
        void response.body?.cancel();
        throw new Error("Input acceptance unavailable");
      }
      const accepted = secretReviewSchema.safeParse(
        await readAcceptance(response),
      );
      if (
        !accepted.success ||
        accepted.data.id !== review.id ||
        accepted.data.draftFingerprint !== review.draftFingerprint ||
        accepted.data.stage !== "reviewed" ||
        !accepted.data.inputPresent
      )
        throw new Error("Invalid acceptance receipt");
      return { submitted: true, review: accepted.data };
    } catch {
      throw new ClientError(
        "Input acceptance is uncertain or was refused. Inspect this same review before another attempt; do not prepare a replacement or assume this value was accepted",
      );
    }
  } finally {
    value.fill(0);
  }
}
