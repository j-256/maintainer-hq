import { z } from "zod";
import {
  GITHUB_APP_LIMITS,
  githubAppRegistrationReviewSchema,
  githubAppRegistrationSelectionInput,
} from "./github-apps";

export const githubAppWebhookSecretSchema = z
  .string()
  .min(1)
  .max(GITHUB_APP_LIMITS.WEBHOOK_SECRET_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      GITHUB_APP_LIMITS.WEBHOOK_SECRET_BYTES,
  );
export const githubAppPrivateInputSchema = z
  .object({
    version: z.literal(1),
    privateKey: z.string().min(1).max(GITHUB_APP_LIMITS.PRIVATE_INPUT_BYTES),
    webhookSecret: githubAppWebhookSecretSchema.optional(),
  })
  .strict();
export type GitHubAppPrivateInput = z.infer<typeof githubAppPrivateInputSchema>;

export class GitHubAppInputError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export async function supplyGitHubAppMaterial(input: {
  selection: unknown;
  review: (
    selection: z.infer<typeof githubAppRegistrationSelectionInput>,
  ) => Promise<unknown>;
  read: () => Promise<Uint8Array>;
  send: (path: string, init: RequestInit) => Promise<Response>;
}) {
  const selected = githubAppRegistrationSelectionInput.safeParse(
    input.selection,
  );
  if (!selected.success)
    throw new GitHubAppInputError(
      "Select the exact App review and fingerprint before supplying private input.",
    );
  const selection = selected.data;
  const parsed = githubAppRegistrationReviewSchema.safeParse(
    await input.review(selection),
  );
  if (
    !parsed.success ||
    parsed.data.id !== selection.planId ||
    parsed.data.fingerprint !== selection.fingerprint
  )
    throw new GitHubAppInputError(
      "The App review changed or belongs to another actor. No private input was read.",
    );
  const review = parsed.data;
  if (review.applied) return { submitted: false, review };
  if (
    review.expired ||
    Date.parse(review.expiresAt) <= Date.now() ||
    !review.privateInputRequired
  )
    throw new GitHubAppInputError(
      "This App review expired or does not accept private input. No private input was read.",
    );
  const value = await input.read();
  try {
    if (
      !value.byteLength ||
      value.byteLength > GITHUB_APP_LIMITS.PRIVATE_INPUT_BYTES
    )
      throw new GitHubAppInputError(
        "Supply a bounded private App JSON envelope through file or stdin.",
      );
    let body: string;
    try {
      body = JSON.stringify(
        githubAppPrivateInputSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)),
        ),
      );
    } catch {
      throw new GitHubAppInputError(
        "Use the documented private App JSON envelope. Nothing was submitted.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      GITHUB_APP_LIMITS.INPUT_REQUEST_TIMEOUT_MS,
    );
    const interrupted = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("App input deadline")),
        { once: true },
      ),
    );
    try {
      const response = await Promise.race([
        input.send(
          "/api/github-apps/input?" +
            new URLSearchParams({
              workspaceId: selection.workspaceId,
              planId: selection.planId,
            }),
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "If-Match": selection.fingerprint,
            },
            body,
            signal: controller.signal,
          },
        ),
        interrupted,
      ]);
      if (
        !response.ok ||
        response.headers.get("Content-Type")?.split(";")[0]?.trim() !==
          "application/json"
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await Promise.race([reader.read(), interrupted]);
          if (next.done) break;
          size += next.value.byteLength;
          if (size > GITHUB_APP_LIMITS.RESPONSE_BYTES) throw new Error();
          chunks.push(next.value);
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
      const result = z
        .object({
          submitted: z.boolean(),
          review: githubAppRegistrationReviewSchema,
        })
        .strict()
        .parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      if (
        result.review.id !== selection.planId ||
        result.review.fingerprint !== selection.fingerprint ||
        !result.review.applied
      )
        throw new Error();
      return result;
    } catch {
      throw new GitHubAppInputError(
        "App acceptance is uncertain or was refused. Inspect the same review before retrying. A submitted:false receipt does not compare the supplied material.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    value.fill(0);
  }
}
