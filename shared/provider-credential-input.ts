import {
  PROVIDER_CREDENTIAL_LIMITS as LIMITS,
  providerCredentialApplyInput,
  providerCredentialInputReceiptSchema,
  providerCredentialReviewSchema,
} from "./provider-credentials";

export class ProviderCredentialInputError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

export async function supplyProviderCredential(input: {
  selection: unknown;
  review: (selection: {
    workspaceId: string;
    planId: string;
  }) => Promise<unknown>;
  send: (path: string, init: RequestInit) => Promise<Response>;
  read: () => Promise<Uint8Array>;
}) {
  const selection = providerCredentialApplyInput.safeParse(input.selection);
  if (!selection.success)
    throw new ProviderCredentialInputError(
      "Select the exact workspace, credential review ID and reviewed fingerprint. No private input was read.",
    );
  const { workspaceId, planId, fingerprint } = selection.data;
  const result = providerCredentialReviewSchema.safeParse(
    await input.review({ workspaceId, planId }),
  );
  if (
    !result.success ||
    result.data.id !== planId ||
    result.data.fingerprint !== fingerprint ||
    !result.data.actorMatches
  ) {
    throw new ProviderCredentialInputError(
      "The credential review changed or belongs to another actor. Inspect the review before supplying a token.",
    );
  }
  const review = result.data;
  if (review.appliedAt) return { submitted: false, review };
  if (
    Date.parse(review.expiresAt) <= Date.now() ||
    review.change.kind !== "save" ||
    !review.change.replaceToken
  ) {
    throw new ProviderCredentialInputError(
      "This review expired or does not accept a replacement token. No private input was read.",
    );
  }
  const value = await input.read();
  try {
    if (
      !value.byteLength ||
      value.byteLength > LIMITS.TOKEN_BYTES ||
      value.some((byte) => byte < 0x21 || byte > 0x7e)
    ) {
      throw new ProviderCredentialInputError(
        "Use a nonempty token within the byte limit, without whitespace or trailing newlines. Nothing was submitted.",
      );
    }
    const body = JSON.stringify({
      version: 1,
      token: new TextDecoder().decode(value),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIMITS.REQUEST_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Private receipt deadline exceeded")),
        { once: true },
      );
    });
    try {
      const response = await Promise.race([
        input.send(
          "/api/provider-credentials/input?" +
            new URLSearchParams({ workspaceId, planId }),
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
        throw new Error("Private receipt unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Private receipt missing");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next.done) break;
          length += next.value.byteLength;
          if (length > LIMITS.RESPONSE_BYTES)
            throw new Error("Private receipt too large");
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
      const accepted = providerCredentialInputReceiptSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        accepted.review.id !== planId ||
        accepted.review.fingerprint !== fingerprint ||
        !accepted.review.appliedAt
      )
        throw new Error("Private receipt identity changed");
      return accepted;
    } catch {
      throw new ProviderCredentialInputError(
        "Credential acceptance is uncertain or was refused. Inspect this same review before trying again. A submitted:false receipt means the review was already applied; it does not prove that your supplied token was stored.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    value.fill(0);
  }
}
