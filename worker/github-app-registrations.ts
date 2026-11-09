import { hookActorGuard, authorizeHooks } from "./hook-authority";
import {
  githubAppGrantSchema,
  githubCapabilitiesSchema,
} from "../shared/github-apps";
import { z } from "zod";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppListInput,
  githubAppMetadataSchema,
  githubAppRegistrationPlanInput,
  githubAppRegistrationSelectionInput,
  githubAppSetupPermitRevokeInput,
  type GitHubAppMetadata,
  type GitHubAppRegistrationReview,
} from "../shared/github-apps";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { providerCredentialKeyStatus } from "./provider-credential-crypto";
import {
  githubAppOperatorAuthoritySchema,
  githubAppOperatorGuard,
  requireGitHubAppOperator,
  type GitHubAppOperatorAuthority,
} from "./github-app-setup-authority";
import type { EncryptedGitHubAppMaterial } from "./github-app-crypto";
import type { GitHubAppIdentity } from "./github-app-client";
import type { WorkspaceService } from "./service";
import { uploadGitHubAppMaterial } from "./github-app-private-input";

export type GitHubAppRegistrationRow = {
  id: string;
  administrative_workspace_id: string;
  metadata_json: string;
  identity_json: string;
  revision: number;
  key_revision: number;
  grants_revision: number;
  webhook_revision: number | null;
};
type ReviewRow = {
  id: string;
  workspace_id: string;
  actor_subject: string;
  input_json: string;
  fingerprint: string;
  expires_at: string;
  applied_at: string | null;
  result_json: string | null;
};
const capturedSchema = z
  .object({
    request: githubAppRegistrationPlanInput,
    authority: githubAppOperatorAuthoritySchema,
    grantsRevision: z.number().int().nonnegative().default(0),
    affectedWorkspaceIds: z.array(z.string()).max(LIMITS.GRANTS + 1),
  })
  .strict();
type Captured = z.infer<typeof capturedSchema>;
export type GitHubAppAcceptedMaterial = {
  identity: GitHubAppIdentity;
  fingerprint: string;
  privateKey: { materialId: string; encrypted: EncryptedGitHubAppMaterial };
  webhookSecret?: { materialId: string; encrypted: EncryptedGitHubAppMaterial };
};
const REGISTRATION_COLUMNS =
  "id,administrative_workspace_id,metadata_json,identity_json,revision,key_revision,webhook_revision,grants_revision";
const REVIEW_COLUMNS =
  "id,workspace_id,actor_subject,input_json,fingerprint,expires_at,applied_at,result_json";
export function githubAppConflict(): never {
  throw new DomainError(
    "github_app_conflict",
    "This App review changed, expired or lost its original authority. Preserve the draft and review the exact scope again.",
    409,
  );
}
export class GitHubApps {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  private timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  async registration(
    registrationId: string,
  ): Promise<GitHubAppRegistrationRow | null> {
    return this.db
      .prepare(
        `SELECT ${REGISTRATION_COLUMNS} FROM github_app_registrations WHERE id=?`,
      )
      .bind(registrationId)
      .first<GitHubAppRegistrationRow>();
  }
  private describe(
    row: ReviewRow,
    captured: Captured,
  ): GitHubAppRegistrationReview {
    return {
      id: row.id,
      registrationId: captured.request.registrationId,
      revision: captured.request.revision,
      change: captured.request.change,
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
      privateInputRequired:
        captured.request.change.kind === "rotate" ||
        (captured.request.change.kind === "save" &&
          captured.request.change.replaceKey),
      applied: row.applied_at !== null,
      expired: Date.parse(row.expires_at) <= this.context.now(),
      impact: { affectedWorkspaceIds: captured.affectedWorkspaceIds },
      registration: row.result_json
        ? githubAppMetadataSchema.parse(JSON.parse(row.result_json))
        : null,
    };
  }
  async list(
    input: unknown,
  ): Promise<{ registrations: GitHubAppMetadata[]; limited: boolean }> {
    const { workspaceId, scope } = githubAppListInput.parse(input);
    if (scope === "workspace") {
      const memberRevision = await authorizeHooks(this.context, workspaceId);
      const guard = hookActorGuard(
        this.context,
        workspaceId,
        undefined,
        memberRevision,
      );
      const rows = await this.db
        .prepare(
          `SELECT r.metadata_json,g.metadata_json AS grant_json FROM github_app_registrations r JOIN github_app_grants g ON g.registration_id=r.id WHERE g.workspace_id=? AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at>?) AND ${guard.sql} ORDER BY r.id,g.id LIMIT ?`,
        )
        .bind(workspaceId, this.timestamp(), ...guard.values, LIMITS.GRANTS + 1)
        .all<{ metadata_json: string; grant_json: string }>();
      const registrations = new Map<string, GitHubAppMetadata>();
      for (const row of rows.results.slice(0, LIMITS.GRANTS)) {
        const metadata = githubAppMetadataSchema.parse(
          JSON.parse(row.metadata_json),
        );
        const grant = githubAppGrantSchema.parse(JSON.parse(row.grant_json));
        const previous = registrations.get(metadata.id);
        registrations.set(metadata.id, {
          ...metadata,
          capabilities: githubCapabilitiesSchema.parse([
            ...new Set([
              ...(previous?.capabilities ?? []),
              ...grant.capabilities,
            ]),
          ]),
        });
      }
      return {
        registrations: [...registrations.values()],
        limited: rows.results.length > LIMITS.GRANTS,
      };
    }
    const authority = await requireGitHubAppOperator(this.context, workspaceId);
    const guard = githubAppOperatorGuard(this.context, authority);
    const rows = await this.db
      .prepare(
        `SELECT ${REGISTRATION_COLUMNS} FROM github_app_registrations WHERE administrative_workspace_id=? AND ${guard.sql} ORDER BY id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, LIMITS.REGISTRATIONS + 1)
      .all<GitHubAppRegistrationRow>();
    return {
      registrations: rows.results
        .slice(0, LIMITS.REGISTRATIONS)
        .map((row) =>
          githubAppMetadataSchema.parse(JSON.parse(row.metadata_json)),
        ),
      limited: rows.results.length > LIMITS.REGISTRATIONS,
    };
  }
  async plan(input: unknown): Promise<GitHubAppRegistrationReview> {
    const request = githubAppRegistrationPlanInput.parse(input);
    const authority = await requireGitHubAppOperator(
      this.context,
      request.workspaceId,
    );
    const current = await this.registration(request.registrationId);
    if (
      (current?.revision ?? 0) !== request.revision ||
      (current && current.administrative_workspace_id !== request.workspaceId)
    )
      githubAppConflict();
    const metadata =
      current &&
      githubAppMetadataSchema.parse(JSON.parse(current.metadata_json));
    if (request.change.kind === "save") {
      if (!providerCredentialKeyStatus(this.context.env))
        throw new DomainError(
          "github_app_storage_missing",
          "App setup requires the deployment's protected encryption keyring.",
          503,
        );
      if (
        (!current || metadata?.state === "disconnected") &&
        !request.change.replaceKey
      )
        githubAppConflict();
      if (metadata && metadata.appId !== request.change.fields.appId)
        githubAppConflict();
    } else if (!current || metadata?.state !== "active") githubAppConflict();
    const granted = await this.db
      .prepare(
        "SELECT DISTINCT workspace_id FROM github_app_grants WHERE registration_id=? AND state='active' ORDER BY workspace_id LIMIT ?",
      )
      .bind(request.registrationId, LIMITS.GRANTS + 1)
      .all<{ workspace_id: string }>();
    if (granted.results.length > LIMITS.GRANTS) githubAppConflict();
    const captured: Captured = {
      request,
      authority,
      grantsRevision: current?.grants_revision ?? 0,
      affectedWorkspaceIds: [
        ...new Set([
          request.workspaceId,
          ...granted.results.map((row) => row.workspace_id),
        ]),
      ],
    };
    const id = crypto.randomUUID();
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      Math.min(
        this.context.now() + LIMITS.SETUP_TTL_MS,
        Date.parse(authority.expiresAt),
      ),
    ).toISOString();
    const serialized = JSON.stringify(captured);
    const fingerprint =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({ id, serialized, createdAt, expiresAt }),
      ));
    const guard = githubAppOperatorGuard(this.context, authority);
    const result = await this.db
      .prepare(
        `INSERT INTO github_app_reviews(id,workspace_id,actor_subject,input_json,fingerprint,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}
      AND COALESCE((SELECT revision FROM github_app_registrations WHERE id=?),0)=?
      AND COALESCE((SELECT grants_revision FROM github_app_registrations WHERE id=?),0)=?
      AND (SELECT count(*) FROM github_app_reviews WHERE workspace_id=? AND actor_subject=? AND applied_at IS NULL AND expires_at>?)<?`,
      )
      .bind(
        id,
        request.workspaceId,
        this.context.principal.subject,
        serialized,
        fingerprint,
        createdAt,
        expiresAt,
        ...guard.values,
        request.registrationId,
        request.revision,
        request.registrationId,
        captured.grantsRevision,
        request.workspaceId,
        this.context.principal.subject,
        createdAt,
        LIMITS.PENDING_REVIEWS,
      )
      .run();
    if (!result.meta.changes) githubAppConflict();
    return this.get({
      workspaceId: request.workspaceId,
      planId: id,
      fingerprint,
    });
  }
  private async selection(input: unknown, requireLiveReview: boolean) {
    const selection = githubAppRegistrationSelectionInput.parse(input);
    let authority: GitHubAppOperatorAuthority;
    try {
      authority = await requireGitHubAppOperator(
        this.context,
        selection.workspaceId,
      );
    } catch (error) {
      if (
        requireLiveReview &&
        error instanceof DomainError &&
        error.code === "forbidden"
      )
        githubAppConflict();
      throw error;
    }
    const guard = githubAppOperatorGuard(this.context, authority);
    const row = await this.db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM github_app_reviews WHERE id=? AND workspace_id=? AND actor_subject=? AND ${guard.sql}`,
      )
      .bind(
        selection.planId,
        selection.workspaceId,
        this.context.principal.subject,
        ...guard.values,
      )
      .first<ReviewRow>();
    if (!row || row.fingerprint !== selection.fingerprint) githubAppConflict();
    const captured = capturedSchema.parse(JSON.parse(row.input_json));
    if (
      captured.request.workspaceId !== selection.workspaceId ||
      captured.authority.subject !== this.context.principal.subject
    )
      githubAppConflict();
    if (
      requireLiveReview &&
      !row.applied_at &&
      (row.expires_at <= this.timestamp() ||
        JSON.stringify(captured.authority) !== JSON.stringify(authority))
    )
      githubAppConflict();
    return { row, captured, authority };
  }
  async get(input: unknown): Promise<GitHubAppRegistrationReview> {
    const { row, captured } = await this.selection(input, false);
    return this.describe(row, captured);
  }
  async apply(input: unknown): Promise<GitHubAppRegistrationReview> {
    return this.accept(input);
  }
  upload(request: Request, input: { workspaceId: string; planId: string }) {
    return uploadGitHubAppMaterial(request, this.context, input);
  }
  async privateInputContext(input: unknown) {
    const { row, captured } = await this.selection(input, true);
    const review = this.describe(row, captured);
    const current = await this.registration(captured.request.registrationId);
    if (
      !row.applied_at &&
      ((current?.revision ?? 0) !== captured.request.revision ||
        (current?.grants_revision ?? 0) !== captured.grantsRevision)
    )
      githubAppConflict();
    const previous =
      current &&
      githubAppMetadataSchema.parse(JSON.parse(current.metadata_json));
    const appId =
      captured.request.change.kind === "save"
        ? captured.request.change.fields.appId
        : previous?.appId;
    if (!appId || !review.privateInputRequired) githubAppConflict();
    return {
      review,
      appId,
      registrationId: captured.request.registrationId,
      keyRevision: (current?.key_revision ?? 0) + 1,
      webhookRevision: (current?.webhook_revision ?? 0) + 1,
    };
  }
  async accept(
    input: unknown,
    material?: GitHubAppAcceptedMaterial,
    manifestAttemptId?: string,
  ): Promise<GitHubAppRegistrationReview> {
    const { row, captured, authority } = await this.selection(input, true);
    if (row.applied_at) return this.describe(row, captured);
    const { request } = captured;
    const current = await this.registration(request.registrationId);
    if (
      (current?.revision ?? 0) !== request.revision ||
      (current && current.administrative_workspace_id !== request.workspaceId)
    )
      githubAppConflict();
    const previous =
      current &&
      githubAppMetadataSchema.parse(JSON.parse(current.metadata_json));
    const privateInputRequired =
      request.change.kind === "rotate" ||
      (request.change.kind === "save" && request.change.replaceKey);
    if (privateInputRequired && !material)
      throw new DomainError(
        "github_app_private_input_required",
        "Use protected App input for this exact review. Private keys are never ordinary command arguments.",
        409,
      );
    if (!privateInputRequired && material) githubAppConflict();
    const fields =
      request.change.kind === "save" ? request.change.fields : previous;
    if (!fields || (material && material.identity.id !== fields.appId))
      githubAppConflict();
    const nextRevision = request.revision + 1;
    const identityJson = material
      ? JSON.stringify(material.identity)
      : current?.identity_json;
    if (!identityJson) githubAppConflict();
    const keyRevision = material
      ? (current?.key_revision ?? 0) + 1
      : current?.key_revision;
    if (!keyRevision) githubAppConflict();
    const webhookRevision = material?.webhookSecret
      ? (current?.webhook_revision ?? 0) + 1
      : (current?.webhook_revision ?? null);
    const metadata = githubAppMetadataSchema.parse({
      ...fields,
      id: request.registrationId,
      slug: material?.identity.slug ?? previous?.slug,
      revision: nextRevision,
      keyFingerprint: material?.fingerprint ?? previous?.keyFingerprint,
      state: request.change.kind === "disconnect" ? "disconnected" : "active",
      lifecycleIngress:
        request.change.kind === "disconnect"
          ? "disabled"
          : webhookRevision
            ? "ready"
            : "requires_webhook_secret",
    });
    const guard = githubAppOperatorGuard(this.context, authority);
    const writeId = crypto.randomUUID();
    const now = this.timestamp();
    const savedSql =
      "EXISTS(SELECT 1 FROM github_app_registrations WHERE id=? AND write_id=?)";
    const statements = [
      this.db
        .prepare(
          `INSERT INTO github_app_registrations(id,administrative_workspace_id,metadata_json,identity_json,revision,key_revision,webhook_revision,created_at,updated_at,write_id)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
      AND COALESCE((SELECT revision FROM github_app_registrations WHERE id=?),0)=?
      AND COALESCE((SELECT grants_revision FROM github_app_registrations WHERE id=?),0)=?
      AND EXISTS(SELECT 1 FROM github_app_reviews WHERE id=? AND applied_at IS NULL AND expires_at>? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM github_app_manifest_attempts WHERE id=? AND workspace_id=? AND actor_subject=? AND state='conversion_claimed' AND expires_at>?
        AND json_extract(input_json,'$.request.registrationId')=? AND json_extract(input_json,'$.authority.memberRevision')=? AND json_extract(input_json,'$.authority.permitFingerprint')=?))
      AND (? > 0 OR (SELECT count(*) FROM github_app_registrations)<?)
      ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,identity_json=excluded.identity_json,revision=excluded.revision,key_revision=excluded.key_revision,webhook_revision=excluded.webhook_revision,updated_at=excluded.updated_at,write_id=excluded.write_id`,
        )
        .bind(
          request.registrationId,
          request.workspaceId,
          JSON.stringify(metadata),
          identityJson,
          nextRevision,
          keyRevision,
          webhookRevision,
          now,
          now,
          writeId,
          ...guard.values,
          request.registrationId,
          request.revision,
          request.registrationId,
          captured.grantsRevision,
          row.id,
          now,
          manifestAttemptId ?? null,
          manifestAttemptId ?? null,
          request.workspaceId,
          this.context.principal.subject,
          now,
          request.registrationId,
          authority.memberRevision,
          authority.permitFingerprint,
          request.revision,
          LIMITS.REGISTRATIONS,
        ),
    ];
    if (material) {
      for (const item of [
        {
          kind: "private-key",
          revision: keyRevision,
          value: material.privateKey,
        },
        ...(material.webhookSecret
          ? [
              {
                kind: "webhook-secret",
                revision: webhookRevision,
                value: material.webhookSecret,
              },
            ]
          : []),
      ])
        statements.push(
          this.db
            .prepare(
              `INSERT INTO github_app_material(registration_id,kind,material_id,revision,key_id,nonce,ciphertext,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${savedSql}`,
            )
            .bind(
              request.registrationId,
              item.kind,
              item.value.materialId,
              item.revision,
              item.value.encrypted.keyId,
              item.value.encrypted.nonce,
              item.value.encrypted.ciphertext,
              now,
              request.registrationId,
              writeId,
            ),
        );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE github_app_reviews SET applied_at=?,result_json=?,write_id=? WHERE id=? AND ${savedSql}`,
        )
        .bind(
          now,
          JSON.stringify(metadata),
          writeId,
          row.id,
          request.registrationId,
          writeId,
        ),
    );
    statements.push(
      this.db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${savedSql}`,
        )
        .bind(
          crypto.randomUUID(),
          request.workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "github.app.registration",
          "GitHub App registration changed",
          request.change.kind,
          request.registrationId,
          now,
          request.registrationId,
          writeId,
        ),
    );
    if (manifestAttemptId)
      statements.push(
        this.db
          .prepare(
            `UPDATE github_app_manifest_attempts SET state='complete',completed_at=?,registration_id=? WHERE id=? AND state='conversion_claimed' AND ${savedSql}`,
          )
          .bind(
            now,
            request.registrationId,
            manifestAttemptId,
            request.registrationId,
            writeId,
          ),
      );
    const results = await this.db.batch(statements);
    if (!results[0].meta.changes) githubAppConflict();
    return this.get(input);
  }
  async revokeSetupPermit(input: unknown) {
    const request = githubAppSetupPermitRevokeInput.parse(input);
    const authority = await requireGitHubAppOperator(
      this.context,
      request.workspaceId,
    );
    if (
      authority.permitId !== request.permitId ||
      authority.permitRevision !== request.revision
    )
      githubAppConflict();
    const guard = githubAppOperatorGuard(this.context, authority);
    const writeId = crypto.randomUUID();
    const now = this.timestamp();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO github_app_setup_revocations(permit_id,permit_revision,administrative_workspace_id,subject,fingerprint,revoked_at,write_id) SELECT ?,?,?,?,?,?,? WHERE ${guard.sql}`,
        )
        .bind(
          authority.permitId,
          authority.permitRevision,
          authority.workspaceId,
          authority.subject,
          authority.permitFingerprint,
          now,
          writeId,
          ...guard.values,
        ),
      this.db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM github_app_setup_revocations WHERE permit_id=? AND permit_revision=? AND write_id=?)`,
        )
        .bind(
          crypto.randomUUID(),
          authority.workspaceId,
          authority.subject,
          this.context.principal.displayName,
          "github.app.setup.revoked",
          "GitHub App setup permit revoked",
          "New setup actions require a new deployment-issued permit",
          authority.permitId,
          now,
          authority.permitId,
          authority.permitRevision,
          writeId,
        ),
    ]);
    if (!results[0].meta.changes) githubAppConflict();
    return {
      permitId: authority.permitId,
      revision: authority.permitRevision,
      revoked: true,
    };
  }
}
