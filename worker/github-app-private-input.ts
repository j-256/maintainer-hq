import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppRegistrationSelectionInput,
} from "../shared/github-apps";
import { githubAppPrivateInputSchema } from "../shared/github-app-input";
import { DomainError } from "./errors";
import { GitHubAppClient } from "./github-app-client";
import {
  normalizeGitHubAppKey,
  sealGitHubAppMaterial,
  type GitHubMaterialContext,
} from "./github-app-crypto";
import { assertGitHubAppInputOrigin } from "./github-app-origin";
import { GitHubApps } from "./github-app-registrations";
import { readSecretInput } from "./secret-private-input";
import type { WorkspaceService } from "./service";

export async function uploadGitHubAppMaterial(
  request: Request,
  context: WorkspaceService,
  input: { workspaceId: string; planId: string },
) {
  assertGitHubAppInputOrigin(request, context);
  if (request.method !== "POST")
    throw new DomainError("method", "Use POST for protected App input", 405);
  const selection = githubAppRegistrationSelectionInput.parse({
    ...input,
    fingerprint: request.headers.get("If-Match"),
  });
  const apps = new GitHubApps(context);
  const selected = await apps.privateInputContext(selection);
  if (selected.review.applied)
    return { submitted: false, review: selected.review };
  const value = githubAppPrivateInputSchema.safeParse(
    await readSecretInput(request, {
      bytes: LIMITS.PRIVATE_INPUT_BYTES,
      timeoutMs: LIMITS.REQUEST_TIMEOUT_MS,
    }),
  );
  if (!value.success)
    throw new DomainError(
      "github_app_input_invalid",
      "Use a bounded private App input envelope, without ordinary credential arguments.",
    );
  const normalized = await normalizeGitHubAppKey(value.data.privateKey);
  const identity = await new GitHubAppClient({
    appId: selected.appId,
    privateKey: normalized.pkcs8,
    now: context.now,
  }).getApp();
  const materialId = crypto.randomUUID();
  const binding: GitHubMaterialContext = {
    env: context.env,
    deploymentId: context.env.GITHUB_APP_DEPLOYMENT_ID!,
    administrativeWorkspaceId: input.workspaceId,
    registrationId: selected.registrationId,
    kind: "private-key",
    materialId,
    revision: selected.keyRevision,
  };
  const keyBytes = new TextEncoder().encode(normalized.pkcs8);
  const secretBytes = value.data.webhookSecret
    ? new TextEncoder().encode(value.data.webhookSecret)
    : null;
  try {
    const encrypted = await sealGitHubAppMaterial(binding, keyBytes);
    const webhookId = crypto.randomUUID();
    const webhookSecret = secretBytes
      ? {
          materialId: webhookId,
          encrypted: await sealGitHubAppMaterial(
            {
              ...binding,
              kind: "webhook-secret",
              materialId: webhookId,
              revision: selected.webhookRevision,
            },
            secretBytes,
          ),
        }
      : undefined;
    const review = await apps.accept(selection, {
      identity,
      fingerprint: normalized.fingerprint,
      privateKey: { materialId, encrypted },
      webhookSecret,
    });
    return { submitted: true, review };
  } finally {
    keyBytes.fill(0);
    secretBytes?.fill(0);
  }
}
