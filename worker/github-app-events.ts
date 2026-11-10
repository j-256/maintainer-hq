import { z } from "zod";
import { idSchema } from "../shared/domain";
import { githubAppMetadataSchema } from "../shared/github-apps";
import { openGitHubAppMaterial } from "./github-app-crypto";
import { verifyGitHubAppAuthority } from "./github-app-authority";
import type { GitHubAppAuthorityScope } from "./github-app-authority";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { Env } from "./types";
export const GITHUB_APP_EVENT_LIMITS = Object.freeze({
  BODY_BYTES: 1024 * 1024,
  BODY_TIMEOUT_MS: 8000,
  RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
  RECONCILE_SCOPES: 100,
  RECONCILE_REQUESTS: 40,
  RECONCILE_BUDGET_MS: 20000,
  RETIRE_ROWS: 100,
  RECONCILE_RETRY_MS: 60000,
});
const EVENT_ACTIONS: Record<string, readonly string[]> = Object.freeze({
  installation: [
    "created",
    "deleted",
    "suspend",
    "unsuspend",
    "new_permissions_accepted",
  ],
  installation_repositories: ["added", "removed"],
  installation_target: ["renamed"],
  ping: ["ping"],
});
const identitySchema = z.object({
  action: z.string().optional(),
  installation: z
    .object({
      id: z.number().int().positive().safe(),
      app_id: z.number().int().positive().safe(),
    })
    .optional(),
});
async function rawBody(request: Request) {
  if (
    Number(request.headers.get("Content-Length")) >
    GITHUB_APP_EVENT_LIMITS.BODY_BYTES
  )
    throw new DomainError(
      "github_app_event_too_large",
      "Lifecycle delivery exceeds its byte limit",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new DomainError(
      "github_app_event_invalid",
      "Lifecycle delivery has no body",
      400,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(
        new DomainError(
          "github_app_event_timeout",
          "Lifecycle delivery exceeded its read deadline",
          408,
        ),
      );
    }, GITHUB_APP_EVENT_LIMITS.BODY_TIMEOUT_MS);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timedOut]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > GITHUB_APP_EVENT_LIMITS.BODY_BYTES)
        throw new DomainError(
          "github_app_event_too_large",
          "Lifecycle delivery exceeds its byte limit",
          413,
        );
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
export async function handleGitHubAppLifecycle(
  request: Request,
  env: Env,
  now: () => number = Date.now,
): Promise<Response> {
  const correlationId = crypto.randomUUID();
  const started = performance.now();
  let state: "rejected" | "processed" | "duplicate" = "rejected";
  let code: string | null = null;
  try {
    const url = new URL(request.url);
    const match = /^\/api\/github-apps\/events\/([^/]+)$/.exec(url.pathname);
    const parsedId = idSchema.safeParse(match?.[1]);
    if (!parsedId.success || url.search || request.method !== "POST")
      throw new DomainError(
        "github_app_event_not_found",
        "Lifecycle ingress not found",
        404,
      );
    const row = await env.HQ_DB.prepare(
      "SELECT id,administrative_workspace_id,revision,webhook_revision,metadata_json FROM github_app_registrations WHERE id=?",
    )
      .bind(parsedId.data)
      .first<{
        id: string;
        administrative_workspace_id: string;
        revision: number;
        webhook_revision: number | null;
        metadata_json: string;
      }>();
    const metadata =
      row && githubAppMetadataSchema.parse(JSON.parse(row.metadata_json));
    if (
      !row ||
      !metadata ||
      metadata.state !== "active" ||
      metadata.lifecycleIngress !== "ready" ||
      !row.webhook_revision
    )
      throw new DomainError(
        "github_app_event_not_found",
        "Lifecycle ingress not found",
        404,
      );
    const signature = request.headers.get("X-Hub-Signature-256");
    if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      throw new DomainError(
        "github_app_event_signature_invalid",
        "Invalid lifecycle signature",
        401,
      );
    const body = await rawBody(request);
    const material = await env.HQ_DB.prepare(
      "SELECT material_id,key_id,nonce,ciphertext FROM github_app_material WHERE registration_id=? AND kind='webhook-secret' AND revision=?",
    )
      .bind(row.id, row.webhook_revision)
      .first<{
        material_id: string;
        key_id: string;
        nonce: string;
        ciphertext: string;
      }>();
    if (!material)
      throw new DomainError(
        "github_app_material_unavailable",
        "Lifecycle signing material is unavailable",
        503,
      );
    const secret = await openGitHubAppMaterial(
      {
        env,
        deploymentId: env.GITHUB_APP_DEPLOYMENT_ID ?? "",
        administrativeWorkspaceId: row.administrative_workspace_id,
        registrationId: row.id,
        kind: "webhook-secret",
        materialId: material.material_id,
        revision: row.webhook_revision,
      },
      {
        keyId: material.key_id,
        nonce: material.nonce,
        ciphertext: material.ciphertext,
      },
    );
    let valid: boolean;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const sig = new Uint8Array(
        signature
          .slice(7)
          .match(/../g)!
          .map((value) => parseInt(value, 16)),
      );
      valid = await crypto.subtle.verify("HMAC", key, sig, body);
    } finally {
      secret.fill(0);
    }
    if (!valid)
      throw new DomainError(
        "github_app_event_signature_invalid",
        "Invalid lifecycle signature",
        401,
      );
    const event = request.headers.get("X-GitHub-Event") ?? "";
    const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(deliveryId))
      throw new DomainError(
        "github_app_event_invalid",
        "A bounded delivery ID is required",
        400,
      );
    let payload: z.infer<typeof identitySchema>;
    try {
      payload = identitySchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
    } catch {
      throw new DomainError(
        "github_app_event_invalid",
        "Invalid lifecycle metadata",
        400,
      );
    }
    const action = event === "ping" ? "ping" : (payload.action ?? "");
    if (
      !EVENT_ACTIONS[event]?.includes(action) ||
      (event !== "ping" &&
        (!payload.installation ||
          payload.installation.app_id !== metadata.appId))
    )
      throw new DomainError(
        "github_app_event_invalid",
        "Unsupported lifecycle event, action or App identity",
        400,
      );
    const installationId = payload.installation?.id ?? null;
    const timestamp = new Date(now()).toISOString();
    const bodyDigest = hex(await crypto.subtle.digest("SHA-256", body));
    const claimed =
      "EXISTS(SELECT 1 FROM github_app_deliveries WHERE app_id=? AND delivery_id=? AND write_id=?)";
    const args = [metadata.appId, deliveryId, correlationId];
    const batch = [
      env.HQ_DB.prepare(
        `INSERT OR IGNORE INTO github_app_deliveries(app_id,delivery_id,registration_id,event,action,installation_id,body_digest,received_at,write_id)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM github_app_registrations WHERE id=? AND revision=? AND webhook_revision=? AND json_extract(metadata_json,'$.state')='active')`,
      ).bind(
        metadata.appId,
        deliveryId,
        row.id,
        event,
        action,
        installationId,
        bodyDigest,
        timestamp,
        correlationId,
        row.id,
        row.revision,
        row.webhook_revision,
      ),
    ];
    if (event !== "ping") {
      batch.push(
        env.HQ_DB.prepare(
          `UPDATE github_app_authority SET generation=generation+1,state='unknown',digest=NULL,observation_json=NULL,observed_at=NULL,valid_until=NULL,invalidated_at=?,reconcile_after=NULL,write_id=?
        WHERE installation_id=? AND registration_id IN (SELECT id FROM github_app_registrations WHERE json_extract(metadata_json,'$.appId')=?) AND ${claimed}`,
        ).bind(
          timestamp,
          correlationId,
          installationId,
          metadata.appId,
          ...args,
        ),
      );
      if (event === "installation" && action === "deleted")
        batch.push(
          env.HQ_DB.prepare(
            `UPDATE github_app_grants SET state='revoked',revision=revision+1,metadata_json=json_set(metadata_json,'$.state','revoked','$.revision',revision+1),write_id=?
          WHERE state='active' AND installation_id=? AND registration_id IN (SELECT id FROM github_app_registrations WHERE json_extract(metadata_json,'$.appId')=?) AND ${claimed}`,
          ).bind(correlationId, installationId, metadata.appId, ...args),
        );
    }
    const result = await env.HQ_DB.batch(batch);
    if (!result[0].meta.changes) {
      const existing = await env.HQ_DB.prepare(
        "SELECT body_digest,event FROM github_app_deliveries WHERE app_id=? AND delivery_id=?",
      )
        .bind(metadata.appId, deliveryId)
        .first<{ body_digest: string; event: string }>();
      if (!existing)
        throw new DomainError(
          "github_app_conflict",
          "Lifecycle registration changed during verification",
          409,
        );
      if (existing.body_digest !== bodyDigest || existing.event !== event)
        throw new DomainError(
          "github_app_event_invalid",
          "Delivery ID conflicts with prior metadata",
          409,
        );
      state = "duplicate";
    } else state = "processed";
    return Response.json(
      { accepted: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    code =
      error instanceof DomainError
        ? error.code
        : "github_app_event_unavailable";
    return Response.json(
      { error: code },
      {
        status: error instanceof DomainError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } finally {
    emitDiagnostic({
      event: "hq.github.app.lifecycle",
      correlationId,
      state,
      code,
      elapsedMs: Math.round(performance.now() - started),
    });
  }
}
export type GitHubAppReconciliationSummary = {
  checked: number;
  denied: number;
  failed: number;
  requests: number;
  remaining: number;
  incomplete: boolean;
  retiredAttempts: number;
  retiredDeliveries: number;
};
export async function reconcileGitHubAppAuthority(
  env: Env,
  now: number,
): Promise<GitHubAppReconciliationSummary> {
  const started = performance.now();
  const timestamp = new Date(now).toISOString();
  const db = env.HQ_DB;
  const result: GitHubAppReconciliationSummary = {
    checked: 0,
    denied: 0,
    failed: 0,
    requests: 0,
    remaining: 0,
    incomplete: false,
    retiredAttempts: 0,
    retiredDeliveries: 0,
  };
  let failureCode: string | null = null;
  try {
    const retired = await db.batch([
      db
        .prepare(
          "UPDATE github_app_manifest_attempts SET state=CASE WHEN state='conversion_claimed' THEN 'indeterminate' ELSE 'expired' END,error_code='github_app_setup_expired' WHERE id IN (SELECT id FROM github_app_manifest_attempts WHERE state IN ('pending','conversion_claimed') AND expires_at<=? ORDER BY expires_at,id LIMIT ?)",
        )
        .bind(timestamp, GITHUB_APP_EVENT_LIMITS.RETIRE_ROWS),
      db
        .prepare(
          "DELETE FROM github_app_deliveries WHERE (app_id,delivery_id) IN (SELECT app_id,delivery_id FROM github_app_deliveries WHERE received_at<? ORDER BY received_at LIMIT ?)",
        )
        .bind(
          new Date(now - GITHUB_APP_EVENT_LIMITS.RETENTION_MS).toISOString(),
          GITHUB_APP_EVENT_LIMITS.RETIRE_ROWS,
        ),
    ]);
    result.retiredAttempts = retired[0].meta.changes;
    result.retiredDeliveries = retired[1].meta.changes;
    const dueSql = `FROM github_app_grants g JOIN github_app_registrations r ON r.id=g.registration_id JOIN json_each(g.metadata_json,'$.repositories') repo
    LEFT JOIN github_app_authority a ON a.registration_id=r.id AND a.installation_id=g.installation_id AND a.repository_id=json_extract(repo.value,'$.id')
    WHERE g.state='active' AND (g.expires_at IS NULL OR g.expires_at>?) AND json_extract(r.metadata_json,'$.state')='active'
    AND (a.valid_until IS NULL OR a.valid_until<=? OR a.registration_revision<>r.revision OR a.key_revision<>r.key_revision)
    AND (a.reconcile_after IS NULL OR a.reconcile_after<=?)`;
    const due = (
      await db
        .prepare(
          `SELECT g.workspace_id AS workspaceId,g.registration_id AS registrationId,g.installation_id AS installationId,g.id AS grantId,g.revision AS grantRevision,json_extract(repo.value,'$.id') AS repositoryId ${dueSql}
    GROUP BY r.id,g.installation_id,json_extract(repo.value,'$.id') ORDER BY COALESCE(a.observed_at,''),r.id,g.installation_id,repositoryId LIMIT ?`,
        )
        .bind(
          timestamp,
          timestamp,
          timestamp,
          GITHUB_APP_EVENT_LIMITS.RECONCILE_SCOPES,
        )
        .all<GitHubAppAuthorityScope>()
    ).results;
    const fetcher: typeof fetch = async (...args) => {
      result.requests++;
      return fetch(...args);
    };
    for (const scope of due) {
      if (
        performance.now() - started >=
          GITHUB_APP_EVENT_LIMITS.RECONCILE_BUDGET_MS ||
        result.requests + 2 > GITHUB_APP_EVENT_LIMITS.RECONCILE_REQUESTS
      )
        break;
      result.checked++;
      try {
        await verifyGitHubAppAuthority(
          {
            env,
            db,
            now: () => now,
            fetch: fetcher,
            remainingBudgetMs: () =>
              GITHUB_APP_EVENT_LIMITS.RECONCILE_BUDGET_MS -
              (performance.now() - started),
          },
          scope,
          "bounded_read",
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === "github_app_denied")
          result.denied++;
        else result.failed++;
      } finally {
        await db
          .prepare(
            "UPDATE github_app_authority SET reconcile_after=? WHERE registration_id=? AND installation_id=? AND repository_id=?",
          )
          .bind(
            new Date(
              now + GITHUB_APP_EVENT_LIMITS.RECONCILE_RETRY_MS,
            ).toISOString(),
            scope.registrationId,
            scope.installationId,
            scope.repositoryId,
          )
          .run();
      }
    }
    result.remaining =
      (await db
        .prepare(
          `SELECT count(*) AS remaining FROM (SELECT r.id,g.installation_id,json_extract(repo.value,'$.id') ${dueSql} GROUP BY r.id,g.installation_id,json_extract(repo.value,'$.id'))`,
        )
        .bind(timestamp, timestamp, timestamp)
        .first<number>("remaining")) ?? 0;
    result.incomplete =
      result.remaining > 0 ||
      result.failed > 0 ||
      result.retiredAttempts === GITHUB_APP_EVENT_LIMITS.RETIRE_ROWS ||
      result.retiredDeliveries === GITHUB_APP_EVENT_LIMITS.RETIRE_ROWS;
    return result;
  } catch (error) {
    result.incomplete = true;
    failureCode =
      error instanceof DomainError
        ? error.code
        : "github_app_reconciliation_unavailable";
    throw error;
  } finally {
    emitDiagnostic({
      event: "hq.github.app.reconciliation",
      correlationId: crypto.randomUUID(),
      ...result,
      code: failureCode,
      elapsedMs: Math.round(performance.now() - started),
    });
  }
}
