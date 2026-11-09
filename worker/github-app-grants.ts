import { z } from "zod";
import { CAPABILITY } from "../shared/domain";
import { MANAGED_CREDENTIAL_PREFIX } from "../shared/provider-credentials";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubAppMetadataSchema,
  githubAppGrantSchema,
  githubAppGrantPlanInput,
  githubAppGrantRevokeInput,
  githubAppGrantListInput,
  githubAppRegistrationSelectionInput,
  githubAppConnectionRequestInput,
  githubAppConnectionRequestsInput,
  githubAppInstallationsInput,
  githubAppRepositoryIdentitySchema,
  githubCapabilitiesSchema,
  type GitHubAppGrant,
  type GitHubAppGrantReview,
} from "../shared/github-apps";
import { credentialHash } from "./credential-hash";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  GitHubApps,
  githubAppConflict,
  type GitHubAppRegistrationRow,
} from "./github-app-registrations";
import { openGitHubAppClient } from "./github-app-material-store";
import {
  requireGitHubAppOperator,
  githubAppOperatorAuthoritySchema,
  githubAppOperatorGuard,
  assertGitHubAppIssuer,
  githubAppIssuerGuard,
  type GitHubAppOperatorAuthority,
} from "./github-app-setup-authority";
import type { WorkspaceService } from "./service";

export type GitHubAppGrantRow = {
  id: string;
  workspace_id: string;
  registration_id: string;
  installation_id: number;
  revision: number;
  state: "active" | "revoked";
  metadata_json: string;
  expires_at: string | null;
};
type ReviewRow = {
  id: string;
  workspace_id: string;
  issuing_workspace_id: string;
  actor_subject: string;
  input_json: string;
  fingerprint: string;
  expires_at: string;
  applied_at: string | null;
  result_json: string | null;
};
const capturedSchema = z
  .object({
    kind: z.enum(["offer", "revoke"]),
    request: githubAppGrantPlanInput,
    registrationRevision: z.number().int().positive(),
    keyRevision: z.number().int().positive(),
    authority: githubAppOperatorAuthoritySchema.nullable(),
    ownerRevision: z.number().int().positive().nullable(),
    repositories: z
      .array(githubAppRepositoryIdentitySchema)
      .min(1)
      .max(LIMITS.REPOSITORIES),
    account: githubAppGrantSchema.shape.account,
  })
  .strict();
type Captured = z.infer<typeof capturedSchema>;
const grantColumns =
  "id,workspace_id,registration_id,installation_id,revision,state,metadata_json,expires_at";
const reviewColumns =
  "id,workspace_id,issuing_workspace_id,actor_subject,input_json,fingerprint,expires_at,applied_at,result_json";
export class GitHubAppGrants {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  private timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  async row(grantId: string) {
    return this.db
      .prepare(`SELECT ${grantColumns} FROM github_app_grants WHERE id=?`)
      .bind(grantId)
      .first<GitHubAppGrantRow>();
  }
  private describe(row: ReviewRow, captured: Captured): GitHubAppGrantReview {
    const grant = row.result_json
      ? githubAppGrantSchema.parse(JSON.parse(row.result_json))
      : null;
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      targetWorkspaceId: row.workspace_id,
      registrationId: captured.request.registrationId,
      installationId: captured.request.installationId,
      grantId: captured.request.grantId,
      revision: captured.request.revision,
      kind: captured.kind,
      repositories: captured.repositories,
      capabilities: captured.request.capabilities,
      expiresAt: row.expires_at,
      grantExpiresAt: captured.request.expiresAt ?? null,
      state:
        grant?.state ??
        (row.expires_at <= this.timestamp() ? "expired" : "offered"),
      grant,
    };
  }
  private async administrativeRegistration(
    workspaceId: string,
    registrationId: string,
  ) {
    const authority = await requireGitHubAppOperator(this.context, workspaceId);
    const registration = await new GitHubApps(this.context).registration(
      registrationId,
    );
    if (
      !registration ||
      registration.administrative_workspace_id !== workspaceId ||
      githubAppMetadataSchema.parse(JSON.parse(registration.metadata_json))
        .state !== "active"
    )
      githubAppConflict();
    return { authority, registration };
  }
  async installations(input: unknown) {
    const request = githubAppInstallationsInput.parse(input);
    const { authority, registration } = await this.administrativeRegistration(
      request.workspaceId,
      request.registrationId,
    );
    const client = await openGitHubAppClient(this.context, registration);
    const result = await client.listInstallations(request.cursor);
    await assertGitHubAppIssuer(this.context, authority);
    if (
      (await new GitHubApps(this.context).registration(registration.id))
        ?.revision !== registration.revision
    )
      githubAppConflict();
    return result;
  }
  async request(input: unknown) {
    const request = githubAppConnectionRequestInput.parse(input);
    const revision = await authorizeHooks(
      this.context,
      request.workspaceId,
      CAPABILITY.ADMIN,
    );
    const guard = hookActorGuard(
      this.context,
      request.workspaceId,
      CAPABILITY.ADMIN,
      revision,
    );
    const result = await this.db
      .prepare(
        `INSERT INTO github_app_connection_requests(id,workspace_id,actor_subject,capabilities_json,created_at)
      SELECT ?,?,?,?,? WHERE ${guard.sql} AND (SELECT count(*) FROM github_app_connection_requests WHERE workspace_id=?)<?
      ON CONFLICT(workspace_id,id) DO NOTHING`,
      )
      .bind(
        request.requestId,
        request.workspaceId,
        this.context.principal.subject,
        JSON.stringify(request.requestedCapabilities),
        this.timestamp(),
        ...guard.values,
        request.workspaceId,
        LIMITS.PENDING_REVIEWS,
      )
      .run();
    const row = await this.db
      .prepare(
        "SELECT actor_subject,capabilities_json FROM github_app_connection_requests WHERE workspace_id=? AND id=?",
      )
      .bind(request.workspaceId, request.requestId)
      .first<{ actor_subject: string; capabilities_json: string }>();
    if (
      (!result.meta.changes && !row) ||
      row?.actor_subject !== this.context.principal.subject ||
      JSON.stringify(
        githubCapabilitiesSchema.parse(JSON.parse(row.capabilities_json)),
      ) !== JSON.stringify(request.requestedCapabilities)
    )
      githubAppConflict();
    return {
      id: request.requestId,
      workspaceId: request.workspaceId,
      requestedCapabilities: request.requestedCapabilities,
      state: "requested" as const,
    };
  }
  async requests(input: unknown) {
    const request = githubAppConnectionRequestsInput.parse(input);
    let guard: { sql: string; values: unknown[] };
    if (request.scope === "administration")
      guard = githubAppOperatorGuard(
        this.context,
        await requireGitHubAppOperator(this.context, request.workspaceId),
      );
    else
      guard = hookActorGuard(
        this.context,
        request.workspaceId,
        CAPABILITY.ADMIN,
        await authorizeHooks(
          this.context,
          request.workspaceId,
          CAPABILITY.ADMIN,
        ),
      );
    const result = await this.db
      .prepare(
        `SELECT id,workspace_id,capabilities_json,created_at FROM github_app_connection_requests WHERE (?='administration' OR workspace_id=?) AND ${guard.sql} ORDER BY created_at,id LIMIT ?`,
      )
      .bind(
        request.scope,
        request.workspaceId,
        ...guard.values,
        LIMITS.GRANTS + 1,
      )
      .all<{
        id: string;
        workspace_id: string;
        capabilities_json: string;
        created_at: string;
      }>();
    return {
      requests: result.results.slice(0, LIMITS.GRANTS).map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        requestedCapabilities: githubCapabilitiesSchema.parse(
          JSON.parse(row.capabilities_json),
        ),
        createdAt: row.created_at,
        state: "requested" as const,
      })),
      limited: result.results.length > LIMITS.GRANTS,
    };
  }
  async list(input: unknown) {
    const { workspaceId } = githubAppGrantListInput.parse(input);
    const revision = await authorizeHooks(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const guard = hookActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      revision,
    );
    const rows = await this.db
      .prepare(
        `SELECT ${grantColumns} FROM github_app_grants WHERE workspace_id=? AND ${guard.sql} ORDER BY id LIMIT ?`,
      )
      .bind(workspaceId, ...guard.values, LIMITS.GRANTS + 1)
      .all<GitHubAppGrantRow>();
    const reviews = await this.db
      .prepare(
        `SELECT ${reviewColumns} FROM github_app_grant_reviews WHERE workspace_id=? AND applied_at IS NULL AND expires_at>? AND ${guard.sql} ORDER BY created_at DESC,id LIMIT ?`,
      )
      .bind(workspaceId, this.timestamp(), ...guard.values, LIMITS.GRANTS + 1)
      .all<ReviewRow>();
    return {
      grants: rows.results.slice(0, LIMITS.GRANTS).map((row) => {
        const grant = githubAppGrantSchema.parse(JSON.parse(row.metadata_json));
        return {
          ...grant,
          state:
            row.state === "active" &&
            row.expires_at &&
            row.expires_at <= this.timestamp()
              ? ("expired" as const)
              : row.state,
        };
      }),
      offers: reviews.results
        .slice(0, LIMITS.GRANTS)
        .map((row) =>
          this.describe(row, capturedSchema.parse(JSON.parse(row.input_json))),
        ),
      limited:
        rows.results.length > LIMITS.GRANTS ||
        reviews.results.length > LIMITS.GRANTS,
    };
  }
  private async noReferenceCollision(workspaceId: string, grantId: string) {
    if (grantId.startsWith(MANAGED_CREDENTIAL_PREFIX)) githubAppConflict();
    for (const raw of [
      this.context.env.GITHUB_CREDENTIALS,
      this.context.env.GITHUB_SECRET_CREDENTIALS,
    ]) {
      if (!raw) continue;
      if (
        new TextEncoder().encode(raw).byteLength >
        LIMITS.CREDENTIAL_CATALOG_BYTES
      )
        githubAppConflict();
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        githubAppConflict();
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        githubAppConflict();
      if (Object.prototype.hasOwnProperty.call(value, grantId))
        githubAppConflict();
    }
    if (
      await this.db
        .prepare(
          "SELECT 1 FROM provider_credentials WHERE workspace_id=? AND id=?",
        )
        .bind(workspaceId, grantId)
        .first()
    )
      githubAppConflict();
    const existing = await this.db
      .prepare(
        "SELECT 1 FROM github_app_credential_references WHERE workspace_id=? AND reference_id=? AND grant_id=?",
      )
      .bind(workspaceId, grantId, grantId)
      .first();
    if (
      !existing &&
      (await this.db
        .prepare(
          `SELECT 1 WHERE EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND credential_ref=?) OR EXISTS(SELECT 1 FROM secret_connections WHERE workspace_id=? AND credential_ref=?)`,
        )
        .bind(workspaceId, grantId, workspaceId, grantId)
        .first())
    )
      githubAppConflict();
  }
  private async verify(
    registration: GitHubAppRegistrationRow,
    request: z.infer<typeof githubAppGrantPlanInput>,
  ) {
    const metadata = githubAppMetadataSchema.parse(
      JSON.parse(registration.metadata_json),
    );
    if (
      metadata.state !== "active" ||
      request.capabilities.some(
        (capability) => !metadata.capabilities.includes(capability),
      )
    )
      githubAppConflict();
    const client = await openGitHubAppClient(this.context, registration);
    const installation = await client.getInstallation(request.installationId);
    if (installation.suspendedAt) githubAppConflict();
    const token = await client.mintToken({
      installationId: request.installationId,
      repositoryIds: request.repositoryIds,
      permissions: { metadata: "read" },
    });
    if (
      token.repositories.some(
        (repository) => repository.ownerId !== installation.account.id,
      )
    )
      githubAppConflict();
    return {
      installation,
      repositories: token.repositories
        .map((repository) =>
          githubAppRepositoryIdentitySchema.parse(repository),
        )
        .sort((a, b) => a.id - b.id),
    };
  }
  async plan(input: unknown) {
    const request = githubAppGrantPlanInput.parse(input);
    const { authority, registration } = await this.administrativeRegistration(
      request.workspaceId,
      request.registrationId,
    );
    if (request.expiresAt && request.expiresAt <= this.timestamp())
      githubAppConflict();
    const current = await this.row(request.grantId);
    if (
      (current?.revision ?? 0) !== request.revision ||
      (current && current.workspace_id !== request.targetWorkspaceId)
    )
      githubAppConflict();
    await this.noReferenceCollision(request.targetWorkspaceId, request.grantId);
    if (
      !(await this.db
        .prepare("SELECT 1 FROM workspaces WHERE id=?")
        .bind(request.targetWorkspaceId)
        .first())
    )
      githubAppConflict();
    const verified = await this.verify(registration, request);
    return this.saveReview({
      kind: "offer",
      request,
      registrationRevision: registration.revision,
      keyRevision: registration.key_revision,
      authority,
      ownerRevision: null,
      repositories: verified.repositories,
      account: verified.installation.account,
    });
  }
  async revokePlan(input: unknown) {
    const request = githubAppGrantRevokeInput.parse(input);
    const current = await this.row(request.grantId);
    const targetWorkspaceId = request.targetWorkspaceId ?? request.workspaceId;
    if (
      !current ||
      current.workspace_id !== targetWorkspaceId ||
      current.revision !== request.revision ||
      current.state !== "active"
    ) {
      await authorizeHooks(this.context, request.workspaceId, CAPABILITY.ADMIN);
      githubAppConflict();
    }
    let authority: GitHubAppOperatorAuthority | null = null;
    let ownerRevision: number | null = null;
    if (request.workspaceId === targetWorkspaceId)
      ownerRevision = await authorizeHooks(
        this.context,
        request.workspaceId,
        CAPABILITY.ADMIN,
      );
    else
      authority = await requireGitHubAppOperator(
        this.context,
        request.workspaceId,
      );
    const registration = await new GitHubApps(this.context).registration(
      current.registration_id,
    );
    if (
      !registration ||
      (authority &&
        registration.administrative_workspace_id !== request.workspaceId)
    )
      githubAppConflict();
    const grant = githubAppGrantSchema.parse(JSON.parse(current.metadata_json));
    return this.saveReview({
      kind: "revoke",
      request: {
        workspaceId: request.workspaceId,
        targetWorkspaceId,
        registrationId: current.registration_id,
        installationId: current.installation_id,
        grantId: current.id,
        revision: current.revision,
        repositoryIds: grant.repositories.map((row) => row.id),
        capabilities: grant.capabilities,
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      },
      registrationRevision: registration.revision,
      keyRevision: registration.key_revision,
      authority,
      ownerRevision,
      repositories: grant.repositories,
      account: grant.account,
    });
  }
  private async saveReview(captured: Captured) {
    const { request, authority } = captured;
    if (authority) await assertGitHubAppIssuer(this.context, authority);
    const guard = authority
      ? githubAppOperatorGuard(this.context, authority)
      : hookActorGuard(
          this.context,
          request.workspaceId,
          CAPABILITY.ADMIN,
          captured.ownerRevision,
        );
    const id = crypto.randomUUID();
    const expiresAt = new Date(
      Math.min(
        this.context.now() + LIMITS.SETUP_TTL_MS,
        authority ? Date.parse(authority.expiresAt) : Infinity,
        this.context.principal.expiresAt ?? Infinity,
      ),
    ).toISOString();
    const inputJson = JSON.stringify(captured);
    const fingerprint =
      "sha256:" +
      (await credentialHash(JSON.stringify({ id, inputJson, expiresAt })));
    const result = await this.db
      .prepare(
        `INSERT INTO github_app_grant_reviews(id,workspace_id,issuing_workspace_id,actor_subject,input_json,fingerprint,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
      AND COALESCE((SELECT revision FROM github_app_grants WHERE id=?),0)=?
      AND EXISTS(SELECT 1 FROM github_app_registrations WHERE id=? AND revision=? AND key_revision=?)
      AND (SELECT count(*) FROM github_app_grant_reviews WHERE issuing_workspace_id=? AND actor_subject=? AND applied_at IS NULL AND expires_at>?)<?`,
      )
      .bind(
        id,
        request.targetWorkspaceId,
        request.workspaceId,
        this.context.principal.subject,
        inputJson,
        fingerprint,
        this.timestamp(),
        expiresAt,
        ...guard.values,
        request.grantId,
        request.revision,
        request.registrationId,
        captured.registrationRevision,
        captured.keyRevision,
        request.workspaceId,
        this.context.principal.subject,
        this.timestamp(),
        LIMITS.PENDING_REVIEWS,
      )
      .run();
    if (!result.meta.changes) githubAppConflict();
    return this.describe(
      {
        id,
        workspace_id: request.targetWorkspaceId,
        issuing_workspace_id: request.workspaceId,
        actor_subject: this.context.principal.subject,
        input_json: inputJson,
        fingerprint,
        expires_at: expiresAt,
        applied_at: null,
        result_json: null,
      },
      captured,
    );
  }
  private async selection(input: unknown) {
    const selection = githubAppRegistrationSelectionInput.parse(input);
    const memberRevision = await authorizeHooks(
      this.context,
      selection.workspaceId,
      CAPABILITY.ADMIN,
    );
    const row = await this.db
      .prepare(
        `SELECT ${reviewColumns} FROM github_app_grant_reviews WHERE id=? AND (workspace_id=? OR issuing_workspace_id=?)`,
      )
      .bind(selection.planId, selection.workspaceId, selection.workspaceId)
      .first<ReviewRow>();
    if (!row || row.fingerprint !== selection.fingerprint) githubAppConflict();
    const captured = capturedSchema.parse(JSON.parse(row.input_json));
    if (captured.kind === "offer" && selection.workspaceId !== row.workspace_id)
      githubAppConflict();
    if (
      captured.kind === "revoke" &&
      (selection.workspaceId !== row.issuing_workspace_id ||
        this.context.principal.subject !== row.actor_subject)
    )
      githubAppConflict();
    return { selection, row, captured, memberRevision };
  }
  async get(input: unknown) {
    const { row, captured } = await this.selection(input);
    return this.describe(row, captured);
  }
  async accept(input: unknown) {
    const { selection, row, captured, memberRevision } =
      await this.selection(input);
    if (row.applied_at) return this.describe(row, captured);
    if (row.expires_at <= this.timestamp()) githubAppConflict();
    const { request, authority } = captured;
    try {
      if (authority) await assertGitHubAppIssuer(this.context, authority);
    } catch {
      githubAppConflict();
    }
    const current = await this.row(request.grantId);
    if (
      (current?.revision ?? 0) !== request.revision ||
      (current && current.workspace_id !== row.workspace_id)
    )
      githubAppConflict();
    const registration = await new GitHubApps(this.context).registration(
      request.registrationId,
    );
    if (
      !registration ||
      registration.revision !== captured.registrationRevision ||
      registration.key_revision !== captured.keyRevision
    )
      githubAppConflict();
    if (captured.kind === "offer") {
      if (request.expiresAt && request.expiresAt <= this.timestamp())
        githubAppConflict();
      await this.noReferenceCollision(row.workspace_id, request.grantId);
      const verified = await this.verify(registration, request);
      if (
        JSON.stringify(verified.repositories) !==
          JSON.stringify(captured.repositories) ||
        JSON.stringify(verified.installation.account) !==
          JSON.stringify(captured.account)
      )
        githubAppConflict();
      try {
        if (authority) await assertGitHubAppIssuer(this.context, authority);
      } catch {
        githubAppConflict();
      }
    } else if (
      !current ||
      current.state !== "active" ||
      (!authority && captured.ownerRevision !== memberRevision)
    )
      githubAppConflict();
    const metadata = githubAppMetadataSchema.parse(
      JSON.parse(registration.metadata_json),
    );
    const grant: GitHubAppGrant = githubAppGrantSchema.parse({
      id: request.grantId,
      workspaceId: row.workspace_id,
      credentialRef: request.grantId,
      registrationId: request.registrationId,
      appId: metadata.appId,
      appName: metadata.name,
      installationId: request.installationId,
      account: captured.account,
      repositories: captured.repositories,
      capabilities: request.capabilities,
      revision: request.revision + 1,
      state: captured.kind === "revoke" ? "revoked" : "active",
      expiresAt: request.expiresAt ?? null,
      issuerSubject:
        captured.kind === "revoke" && current
          ? githubAppGrantSchema.parse(JSON.parse(current.metadata_json))
              .issuerSubject
          : row.actor_subject,
      acceptedBy: this.context.principal.subject,
      acceptedAt: this.timestamp(),
    });
    const ownerGuard = hookActorGuard(
      this.context,
      selection.workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const issuerGuard = authority
      ? githubAppIssuerGuard(this.context, authority)
      : { sql: "1", values: [] };
    const writeId = crypto.randomUUID();
    const identityExpiry =
      this.context.principal.expiresAt === undefined
        ? null
        : new Date(this.context.principal.expiresAt).toISOString();
    const savedSql =
      "EXISTS(SELECT 1 FROM github_app_grants WHERE id=? AND write_id=?)";
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO github_app_grants(id,workspace_id,registration_id,installation_id,revision,state,metadata_json,expires_at,write_id)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${ownerGuard.sql} AND ${issuerGuard.sql}
        AND (? IS NULL OR ?>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND (?='revoke' OR ? IS NULL OR (?>? AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
        AND EXISTS(SELECT 1 FROM github_app_registrations WHERE id=? AND revision=? AND key_revision=?)
        AND COALESCE((SELECT revision FROM github_app_grants WHERE id=?),0)=?
        AND EXISTS(SELECT 1 FROM github_app_grant_reviews WHERE id=? AND applied_at IS NULL AND expires_at>? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND (? > 0 OR (SELECT count(*) FROM github_app_grants WHERE workspace_id=?)<?)
        AND (? > 0 OR (SELECT count(*) FROM github_app_grants WHERE registration_id=?)<?)
        ON CONFLICT(id) DO UPDATE SET registration_id=excluded.registration_id,installation_id=excluded.installation_id,revision=excluded.revision,state=excluded.state,metadata_json=excluded.metadata_json,expires_at=excluded.expires_at,write_id=excluded.write_id`,
        )
        .bind(
          grant.id,
          grant.workspaceId,
          grant.registrationId,
          grant.installationId,
          grant.revision,
          grant.state,
          JSON.stringify(grant),
          grant.expiresAt,
          writeId,
          ...ownerGuard.values,
          ...issuerGuard.values,
          identityExpiry,
          identityExpiry,
          captured.kind,
          grant.expiresAt,
          grant.expiresAt,
          this.timestamp(),
          grant.expiresAt,
          registration.id,
          captured.registrationRevision,
          captured.keyRevision,
          grant.id,
          request.revision,
          row.id,
          this.timestamp(),
          request.revision,
          grant.workspaceId,
          LIMITS.GRANTS,
          request.revision,
          grant.registrationId,
          LIMITS.GRANTS,
        ),
      this.db
        .prepare(
          `INSERT INTO github_app_credential_references(workspace_id,reference_id,grant_id) SELECT ?,?,? WHERE ${savedSql} ON CONFLICT(workspace_id,reference_id) DO NOTHING`,
        )
        .bind(
          grant.workspaceId,
          grant.credentialRef,
          grant.id,
          grant.id,
          writeId,
        ),
      this.db
        .prepare(
          `UPDATE github_app_grant_reviews SET applied_at=?,result_json=?,write_id=? WHERE id=? AND ${savedSql}`,
        )
        .bind(
          this.timestamp(),
          JSON.stringify(grant),
          writeId,
          row.id,
          grant.id,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${savedSql}`,
        )
        .bind(
          crypto.randomUUID(),
          grant.workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "github.app.grant",
          captured.kind === "offer"
            ? "GitHub App grant accepted"
            : "GitHub App grant revoked",
          "Local workspace authority changed",
          grant.id,
          this.timestamp(),
          grant.id,
          writeId,
        ),
    ]);
    if (!results[0].meta.changes) githubAppConflict();
    return this.get(input);
  }
}
