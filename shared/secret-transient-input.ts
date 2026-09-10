import {
  SECRET_LIMITS,
  secretReviewSchema,
  secretRunInput,
  secretTransientReceiptSchema,
} from "./secrets";
import { CLOUDFLARE_SECRET_LIMITS } from "./cloudflare-secrets";
import { SECRET_CLIENT_TIMEOUTS } from "./secret-command-timeouts";

export class SecretTransientInputError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export async function supplyTransientSecret(input: {
  selection: unknown;
  review: (selection: {
    workspaceId: string;
    reviewId: string;
  }) => Promise<unknown>;
  send: (path: string, init: RequestInit) => Promise<Response>;
  read: () => Promise<Uint8Array>;
}) {
  const selection = secretRunInput.safeParse(input.selection);
  if (!selection.success)
    throw new SecretTransientInputError(
      "Select the exact workspace, accepted review, fingerprint and destination index. No private input was read.",
    );
  const { workspaceId, reviewId, fingerprint, destinationIndex } =
    selection.data;
  const parsed = secretReviewSchema.safeParse(
    await input.review({ workspaceId, reviewId }),
  );
  if (
    !parsed.success ||
    parsed.data.id !== reviewId ||
    parsed.data.fingerprint !== fingerprint ||
    !parsed.data.actorMatches ||
    parsed.data.stage !== "accepted"
  )
    throw new SecretTransientInputError(
      "The accepted review changed or belongs to another actor. Inspect the same review before supplying a value.",
    );
  const review = parsed.data;
  const destination = review.destinations[destinationIndex];
  const receipt = review.operation?.receipts.find(
    (item) => item.destinationIndex === destinationIndex,
  );
  if (
    !destination ||
    !receipt ||
    destination.snapshot.input.kind !== "private-transient"
  )
    throw new SecretTransientInputError(
      "This destination does not accept transient input. No private input was read.",
    );
  if (receipt.phase !== "pending") return { inputConsumed: false, review };
  if (
    Date.parse(review.expiresAt) <= Date.now() ||
    Date.parse(review.inputExpiresAt) <= Date.now()
  )
    throw new SecretTransientInputError(
      "This review expired. Inspect its receipts and prepare a fresh review; no private input was read.",
    );
  if (
    review.operation?.leaseExpiresAt &&
    Date.parse(review.operation.leaseExpiresAt) > Date.now()
  )
    throw new SecretTransientInputError(
      "An execution step is still active. Inspect its receipt before supplying input; no private input was read.",
    );
  const value = await input.read();
  try {
    if (
      !value.byteLength ||
      value.byteLength > destination.snapshot.input.maxValueBytes ||
      value.byteLength > CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES
    )
      throw new SecretTransientInputError(
        "Supply nonempty UTF-8 text within the reviewed destination's byte limit. Nothing was submitted.",
      );
    let body: string;
    try {
      body = JSON.stringify({
        version: 1,
        value: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(value),
      });
    } catch {
      throw new SecretTransientInputError(
        "Supply valid UTF-8 bytes. Nothing was submitted.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SECRET_CLIENT_TIMEOUTS.EXECUTION_MS,
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Private execution receipt deadline")),
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        input.send(
          "/api/secrets/transient-input?" +
            new URLSearchParams({
              workspaceId,
              reviewId,
              destinationIndex: String(destinationIndex),
            }),
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "If-Match": fingerprint,
            },
            body,
            signal: controller.signal,
          },
        ),
        aborted,
      ]);
      if (
        !response.ok ||
        response.headers.get("Content-Type")?.split(";")[0]?.trim() !==
          "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Private execution receipt unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Private execution receipt missing");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) break;
          length += next.value.byteLength;
          if (length > SECRET_LIMITS.REVIEW_RESPONSE_BYTES)
            throw new Error("Private execution receipt too large");
          chunks.push(next.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const accepted = secretTransientReceiptSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        accepted.review.id !== reviewId ||
        accepted.review.fingerprint !== fingerprint ||
        accepted.review.draftFingerprint !== review.draftFingerprint ||
        !accepted.review.actorMatches ||
        accepted.review.stage !== "accepted" ||
        !accepted.review.operation?.receipts.some(
          (item) => item.destinationIndex === destinationIndex,
        )
      )
        throw new Error("Private execution receipt changed");
      return accepted;
    } catch {
      throw new SecretTransientInputError(
        "The private execution request was interrupted or refused. Inspect this same destination receipt before continuing. Input consumed is not proof of provider acceptance, and an uncertain submitted write must not be replayed.",
        true,
      );
    } finally {
      body = "";
      clearTimeout(timer);
    }
  } finally {
    value.fill(0);
  }
}
