import { Buffer } from "node:buffer";
import { z } from "zod";
import { githubAppWebhookSecretSchema } from "../shared/github-app-input";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppManifestStartInput,
  githubAppManifestGetInput,
  githubAppMetadataSchema,
  githubAppPermissions,
  githubProviderIdSchema,
  type GitHubAppManifestAttempt,
} from "../shared/github-apps";
import {
  API_CACHE_CONTROL,
  SECURITY_HEADERS,
  secureResponse,
} from "../shared/security";
import { credentialHash } from "./credential-hash";
import { emitDiagnostic, type GitHubAppManifestStage } from "./diagnostics";
import { DomainError } from "./errors";
import { deliverWorkspacePush } from "./workspace-push";
import {
  GitHubAppClient,
  readGitHubAppResponse,
  GITHUB_APP_USER_AGENT,
} from "./github-app-client";
import {
  normalizeGitHubAppKey,
  sealGitHubAppMaterial,
  type GitHubMaterialContext,
} from "./github-app-crypto";
import { githubAppOrigin } from "./github-app-origin";
import { GitHubApps, githubAppConflict } from "./github-app-registrations";
import {
  githubAppOperatorAuthoritySchema,
  githubAppOperatorGuard,
  requireGitHubAppOperator,
} from "./github-app-setup-authority";
import type { WorkspaceService } from "./service";

export const GITHUB_APP_MANIFEST_CALLBACK =
  "/api/github-apps/manifest/callback";
export const GITHUB_APP_MANIFEST_FORM = "/api/github-apps/manifest/start";
const CONVERSION_PENDING_MS = 25000;
const captureSchema = z
  .object({
    request: githubAppManifestStartInput,
    authority: githubAppOperatorAuthoritySchema,
    origin: z.url(),
  })
  .strict();
type AttemptRow = {
  id: string;
  workspace_id: string;
  actor_subject: string;
  input_json: string;
  state_hash: string;
  state: GitHubAppManifestAttempt["state"];
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  registration_id: string | null;
};
const ATTEMPT_COLUMNS =
  "id,workspace_id,actor_subject,input_json,state_hash,state,created_at,expires_at,claimed_at,registration_id";
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
export function githubAppManifestReturn(
  origin: string,
  outcome: string,
  details: {
    attemptId?: string;
    workspaceId?: string;
    reference?: string;
  } = {},
) {
  const target = new URL("/settings", origin);
  target.searchParams.set("githubAppOutcome", outcome);
  if (details.attemptId && /^[a-zA-Z0-9_-]{1,100}$/.test(details.attemptId))
    target.searchParams.set("githubAppAttempt", details.attemptId);
  if (details.workspaceId && /^[a-zA-Z0-9_-]{1,100}$/.test(details.workspaceId))
    target.searchParams.set("githubAppWorkspace", details.workspaceId);
  if (details.reference && /^[a-f0-9-]{36}$/.test(details.reference))
    target.searchParams.set("supportReference", details.reference);
  return secureResponse(
    new Response(null, {
      status: 303,
      headers: { Location: target.href, "Cache-Control": API_CACHE_CONTROL },
    }),
  );
}
export class GitHubAppManifests {
  constructor(readonly context: WorkspaceService) {}
  private timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  async start(input: unknown): Promise<GitHubAppManifestAttempt> {
    const request = githubAppManifestStartInput.parse(input);
    const authority = await requireGitHubAppOperator(
      this.context,
      request.workspaceId,
    );
    const origin = githubAppOrigin(this.context);
    if (await new GitHubApps(this.context).registration(request.registrationId))
      githubAppConflict();
    const id = crypto.randomUUID();
    const now = this.timestamp();
    const expiresAt = new Date(
      Math.min(
        this.context.now() + LIMITS.SETUP_TTL_MS,
        Date.parse(authority.expiresAt),
      ),
    ).toISOString();
    const guard = githubAppOperatorGuard(this.context, authority);
    const result = await this.context.db
      .prepare(
        `INSERT INTO github_app_manifest_attempts(id,workspace_id,actor_subject,input_json,state_hash,state,created_at,expires_at)
      SELECT ?,?,?,?,'','pending',?,? WHERE ${guard.sql}
      AND NOT EXISTS(SELECT 1 FROM github_app_registrations WHERE id=?)
      AND (SELECT count(*) FROM github_app_manifest_attempts WHERE workspace_id=? AND actor_subject=? AND state IN ('pending','conversion_claimed') AND expires_at>?)<?`,
      )
      .bind(
        id,
        request.workspaceId,
        this.context.principal.subject,
        JSON.stringify({ request, authority, origin }),
        now,
        expiresAt,
        ...guard.values,
        request.registrationId,
        request.workspaceId,
        this.context.principal.subject,
        now,
        LIMITS.PENDING_REVIEWS,
      )
      .run();
    if (!result.meta.changes) githubAppConflict();
    return this.get({ workspaceId: request.workspaceId, attemptId: id });
  }
  async attempt(
    workspaceId: string,
    attemptId: string,
    requireOriginalAuthority = false,
  ) {
    const authority = await requireGitHubAppOperator(this.context, workspaceId);
    const guard = githubAppOperatorGuard(this.context, authority);
    const row = await this.context.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM github_app_manifest_attempts WHERE id=? AND workspace_id=? AND actor_subject=? AND ${guard.sql}`,
      )
      .bind(
        attemptId,
        workspaceId,
        this.context.principal.subject,
        ...guard.values,
      )
      .first<AttemptRow>();
    if (!row) githubAppConflict();
    const captured = captureSchema.parse(JSON.parse(row.input_json));
    if (
      captured.origin !== githubAppOrigin(this.context) ||
      captured.request.workspaceId !== workspaceId ||
      (requireOriginalAuthority &&
        JSON.stringify(captured.authority) !== JSON.stringify(authority))
    )
      githubAppConflict();
    return { row, captured, authority };
  }
  async get(input: unknown): Promise<GitHubAppManifestAttempt> {
    const { workspaceId, attemptId } = githubAppManifestGetInput.parse(input);
    let { row, captured } = await this.attempt(workspaceId, attemptId);
    if (
      (row.state === "pending" && row.expires_at <= this.timestamp()) ||
      (row.state === "conversion_claimed" &&
        row.claimed_at &&
        Date.parse(row.claimed_at) + CONVERSION_PENDING_MS <=
          this.context.now())
    ) {
      const next = row.state === "pending" ? "expired" : "indeterminate";
      const transition = await this.context.db
        .prepare(
          "UPDATE github_app_manifest_attempts SET state=? WHERE id=? AND state=?",
        )
        .bind(next, row.id, row.state)
        .run();
      if (transition.meta.changes) row = { ...row, state: next };
      else ({ row } = await this.attempt(workspaceId, attemptId));
    }
    const registration =
      row.registration_id &&
      (await new GitHubApps(this.context).registration(row.registration_id));
    const browser = new URL(GITHUB_APP_MANIFEST_FORM, captured.origin);
    browser.searchParams.set("workspaceId", workspaceId);
    browser.searchParams.set("attemptId", row.id);
    return {
      id: row.id,
      registrationId: captured.request.registrationId,
      state: row.state,
      expiresAt: row.expires_at,
      browserUrl: browser.href,
      registration: registration
        ? githubAppMetadataSchema.parse(JSON.parse(registration.metadata_json))
        : null,
      recovery:
        row.state === "indeterminate" ? "protected_import_required" : "none",
    };
  }
}
export async function renderGitHubAppManifest(
  request: Request,
  context: WorkspaceService,
): Promise<Response> {
  const url = new URL(request.url);
  const input = githubAppManifestGetInput.parse(
    Object.fromEntries(url.searchParams),
  );
  if (request.method !== "GET" || url.origin !== githubAppOrigin(context))
    githubAppConflict();
  const { row, captured, authority } = await new GitHubAppManifests(
    context,
  ).attempt(input.workspaceId, input.attemptId, true);
  if (
    row.state !== "pending" ||
    row.expires_at <= new Date(context.now()).toISOString()
  )
    githubAppConflict();
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const state = row.id + "." + nonce;
  const stateHash = await credentialHash(state);
  const guard = githubAppOperatorGuard(context, authority);
  const saved = await context.db
    .prepare(
      `UPDATE github_app_manifest_attempts SET state_hash=? WHERE id=? AND state='pending' AND state_hash=? AND expires_at>? AND ${guard.sql}`,
    )
    .bind(
      stateHash,
      row.id,
      row.state_hash,
      new Date(context.now()).toISOString(),
      ...guard.values,
    )
    .run();
  if (!saved.meta.changes) githubAppConflict();
  const target = new URL(
    captured.request.account.type === "Organization"
      ? `https://github.com/organizations/${captured.request.account.login}/settings/apps/new`
      : "https://github.com/settings/apps/new",
  );
  target.searchParams.set("state", state);
  const manifest = {
    name: captured.request.name,
    url: captured.origin,
    public: captured.request.visibility === "public",
    redirect_url: captured.origin + GITHUB_APP_MANIFEST_CALLBACK,
    hook_attributes: {
      url:
        captured.origin +
        "/api/github-apps/events/" +
        captured.request.registrationId,
      active: true,
    },
    default_permissions: githubAppPermissions(captured.request.capabilities),
    default_events: [],
    request_oauth_on_install: false,
  };
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Create GitHub App</title><main><h1>Create GitHub App</h1><p>Review the App name, installation visibility and permissions on GitHub. Registration does not grant a workspace access or install repository hooks.</p><pre>${escapeHtml(JSON.stringify(manifest.default_permissions, null, 2))}</pre><form method="post" action="${escapeHtml(target.href)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Create GitHub App</button></form></main></html>`;
  const response = secureResponse(
    new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
  response.headers.set(
    "Content-Security-Policy",
    SECURITY_HEADERS["Content-Security-Policy"].replace(
      "form-action 'self'",
      "form-action https://github.com",
    ),
  );
  return response;
}
export async function completeGitHubAppManifest(
  request: Request,
  context: WorkspaceService,
): Promise<Response> {
  const started = performance.now();
  const correlationId = crypto.randomUUID();
  let attemptId: string | undefined;
  let workspaceId: string | undefined;
  let claimed = false;
  let stage: GitHubAppManifestStage = "validation";
  let providerStatus: number | undefined;
  let origin: string;
  try {
    origin = githubAppOrigin(context);
  } catch {
    return githubAppManifestReturn(new URL(request.url).origin, "unavailable");
  }
  try {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.origin !== origin ||
      [...url.searchParams.keys()].some(
        (key) => !["code", "state"].includes(key),
      ) ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("state").length !== 1
    )
      githubAppConflict();
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (
      !code ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(code) ||
      !state ||
      !/^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9_-]{43}$/.test(state)
    )
      githubAppConflict();
    attemptId = state.split(".")[0];
    const candidate = await context.db
      .prepare(
        "SELECT workspace_id FROM github_app_manifest_attempts WHERE id=? AND actor_subject=?",
      )
      .bind(attemptId, context.principal.subject)
      .first<{ workspace_id: string }>();
    if (!candidate) githubAppConflict();
    workspaceId = candidate.workspace_id;
    const manifests = new GitHubAppManifests(context);
    const { row, captured, authority } = await manifests.attempt(
      candidate.workspace_id,
      attemptId,
      true,
    );
    if (
      row.state !== "pending" ||
      row.state_hash !== (await credentialHash(state)) ||
      row.expires_at <= new Date(context.now()).toISOString()
    )
      githubAppConflict();
    const guard = githubAppOperatorGuard(context, authority);
    stage = "claim";
    const claim = await context.db
      .prepare(
        `UPDATE github_app_manifest_attempts SET state='conversion_claimed',claimed_at=? WHERE id=? AND state='pending' AND state_hash=? AND expires_at>? AND ${guard.sql}
      AND NOT EXISTS(SELECT 1 FROM github_app_registrations WHERE id=?)`,
      )
      .bind(
        new Date(context.now()).toISOString(),
        row.id,
        row.state_hash,
        new Date(context.now()).toISOString(),
        ...guard.values,
        captured.request.registrationId,
      )
      .run();
    if (!claim.meta.changes) githubAppConflict();
    claimed = true;
    stage = "exchange";
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      LIMITS.REQUEST_TIMEOUT_MS,
    );
    let conversion: { id: number; pem: string; webhook_secret: string };
    try {
      const result = await fetch(
        "https://api.github.com/app-manifests/" +
          encodeURIComponent(code) +
          "/conversions",
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": GITHUB_APP_USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        },
      );
      if (!result.ok) {
        providerStatus = result.status;
        await result.body?.cancel();
        throw new Error();
      }
      const parsed = z
        .object({
          id: githubProviderIdSchema,
          pem: z.string().min(1).max(LIMITS.PRIVATE_INPUT_BYTES),
          webhook_secret: githubAppWebhookSecretSchema,
        })
        .safeParse(await readGitHubAppResponse(result));
      if (!parsed.success) throw new Error();
      conversion = parsed.data;
    } finally {
      clearTimeout(timer);
    }
    stage = "verify_app";
    const normalized = await normalizeGitHubAppKey(conversion.pem);
    const identity = await new GitHubAppClient({
      appId: conversion.id,
      privateKey: normalized.pkcs8,
      now: context.now,
    }).getApp();
    if (
      identity.account.type !== captured.request.account.type ||
      identity.account.login.toLowerCase() !==
        captured.request.account.login.toLowerCase()
    )
      githubAppConflict();
    await manifests.attempt(candidate.workspace_id, attemptId, true);
    stage = "persist";
    const apps = new GitHubApps(context);
    const review = await apps.plan({
      workspaceId: candidate.workspace_id,
      registrationId: captured.request.registrationId,
      revision: 0,
      change: {
        kind: "save",
        fields: {
          name: captured.request.name,
          appId: identity.id,
          visibility: captured.request.visibility,
          capabilities: captured.request.capabilities,
        },
        replaceKey: true,
      },
    });
    const keyId = crypto.randomUUID();
    const binding: GitHubMaterialContext = {
      env: context.env,
      deploymentId: context.env.GITHUB_APP_DEPLOYMENT_ID!,
      administrativeWorkspaceId: candidate.workspace_id,
      registrationId: captured.request.registrationId,
      kind: "private-key",
      materialId: keyId,
      revision: 1,
    };
    const keyBytes = new TextEncoder().encode(normalized.pkcs8);
    const secretBytes = new TextEncoder().encode(conversion.webhook_secret);
    try {
      const encrypted = await sealGitHubAppMaterial(binding, keyBytes);
      const webhookId = crypto.randomUUID();
      const webhookSecret = {
        materialId: webhookId,
        encrypted: await sealGitHubAppMaterial(
          { ...binding, kind: "webhook-secret", materialId: webhookId },
          secretBytes,
        ),
      };
      const accepted = await apps.accept(
        {
          workspaceId: candidate.workspace_id,
          planId: review.id,
          fingerprint: review.fingerprint,
        },
        {
          identity,
          fingerprint: normalized.fingerprint,
          privateKey: { materialId: keyId, encrypted },
          webhookSecret,
        },
        attemptId,
      );
      await Promise.all(
        accepted.impact.affectedWorkspaceIds.map((workspaceId) =>
          deliverWorkspacePush(context.env, workspaceId),
        ),
      ).catch(() =>
        emitDiagnostic({ event: "hq.push.interrupted", pendingRetained: true }),
      );
    } finally {
      keyBytes.fill(0);
      secretBytes.fill(0);
    }
    emitDiagnostic({
      event: "hq.github.app.manifest",
      correlationId,
      attemptId,
      state: "complete",
      stage: "complete",
      elapsedMs: Math.round(performance.now() - started),
    });
    return githubAppManifestReturn(origin, "complete", {
      attemptId,
      workspaceId,
      reference: correlationId,
    });
  } catch (error) {
    if (claimed && attemptId)
      await context.db
        .prepare(
          "UPDATE github_app_manifest_attempts SET state='indeterminate',error_code='conversion_indeterminate' WHERE id=? AND state='conversion_claimed'",
        )
        .bind(attemptId)
        .run()
        .catch(() => {});
    emitDiagnostic({
      event: "hq.github.app.manifest",
      correlationId,
      attemptId: attemptId ?? null,
      state: claimed ? "indeterminate" : "denied",
      stage,
      code: error instanceof DomainError ? error.code : "unavailable",
      providerStatus,
      elapsedMs: Math.round(performance.now() - started),
    });
    return githubAppManifestReturn(
      origin,
      claimed ? "indeterminate" : "denied",
      { attemptId, workspaceId, reference: correlationId },
    );
  }
}
