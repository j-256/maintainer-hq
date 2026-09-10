import {
  SECRET_LIMITS,
  secretReviewSchema,
  type SecretReview,
} from "../../shared/secrets";
import { sealGitHubSecret } from "../../shared/github-secret-crypto";
import { command } from "./api";
import { supplyTransientSecret } from "../../shared/secret-transient-input";

export async function supplyBrowserTransientSecret(
  workspaceId: string,
  review: SecretReview,
  destinationIndex: number,
  read: () => Uint8Array,
) {
  return supplyTransientSecret({
    selection: {
      workspaceId,
      reviewId: review.id,
      fingerprint: review.fingerprint,
      destinationIndex,
    },
    review: (input) => command("secrets_review", input),
    send: (path, init) => fetch(path, { ...init, credentials: "same-origin" }),
    read: async () => read(),
  });
}

export async function supplyBrowserSecret(
  workspaceId: string,
  expected: SecretReview,
  read: () => Uint8Array,
) {
  const review = secretReviewSchema.parse(
    await command("secrets_review", { workspaceId, reviewId: expected.id }),
  );
  if (
    !review.actorMatches ||
    review.draftFingerprint !== expected.draftFingerprint ||
    Date.parse(review.expiresAt) <= Date.now() ||
    Date.parse(review.inputExpiresAt) <= Date.now()
  )
    throw new Error(
      "The private-input review changed, expired, or belongs to another actor. Inspect the review before supplying a value.",
    );
  if (review.stage === "reviewed" && review.inputPresent) return review;
  if (
    review.stage !== "awaiting-input" ||
    review.recovery ||
    !review.destinations.some(
      (item) => item.snapshot.input.kind === "provider-sealed",
    )
  )
    throw new Error(
      "This review does not accept browser-sealed private input. Inspect its supported input and recovery requirements.",
    );
  const value = read();
  try {
    if (!value.byteLength || value.byteLength > SECRET_LIMITS.INPUT_BYTES)
      throw new Error(
        "Supply a nonempty value within the reviewed byte limit.",
      );
    const items = [];
    for (const [destinationIndex, item] of review.destinations.entries()) {
      const requirement = item.snapshot.input;
      if (value.byteLength > requirement.maxValueBytes)
        throw new Error(
          "The value exceeds a reviewed destination's byte limit.",
        );
      if (requirement.kind !== "provider-sealed") continue;
      items.push({
        destinationIndex,
        ciphertext: await sealGitHubSecret(value, requirement.publicKey),
      });
    }
    const body = JSON.stringify({ version: 1, items });
    if (new TextEncoder().encode(body).byteLength > SECRET_LIMITS.UPLOAD_BYTES)
      throw new Error("The sealed upload exceeds its size limit.");
    const params = new URLSearchParams({ workspaceId, reviewId: review.id });
    try {
      const response = await fetch("/api/secrets/input?" + params, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "If-Match": review.draftFingerprint,
        },
        body,
        signal: AbortSignal.timeout(SECRET_LIMITS.REQUEST_MS),
      });
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("application/json")
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Input receipt unavailable");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > SECRET_LIMITS.REVIEW_RESPONSE_BYTES)
            throw new Error("Input receipt exceeds its size limit");
          chunks.push(result.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const accepted = secretReviewSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        accepted.id !== review.id ||
        accepted.draftFingerprint !== review.draftFingerprint ||
        accepted.stage !== "reviewed" ||
        !accepted.inputPresent
      )
        throw new Error("Invalid private-input receipt");
      return accepted;
    } catch {
      throw new Error(
        "Input acceptance is uncertain or was refused. Inspect this same review before supplying again. Do not assume a replacement value matches earlier input.",
      );
    }
  } finally {
    value.fill(0);
  }
}
