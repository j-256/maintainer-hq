import { z } from "zod";
import { CAPABILITY, idSchema } from "../shared/domain";
import {
  PROVIDER_CREDENTIAL_LIMITS as LIMITS,
  PROVIDER_CREDENTIAL_KIND,
  providerCredentialApplyInput,
  providerCredentialFieldsSchema,
  providerCredentialPlanInput,
  providerCredentialReviewInput,
  providerCredentialVerifyInput,
  providerCredentialsListInput,
  type ProviderCredentialReview,
  type ProviderCredentialVerification,
} from "../shared/provider-credentials";
import { SECRET_ENTRY_KIND, SECRET_LIMITS } from "../shared/secrets";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  providerCredentialKeyStatus,
  sealProviderCredential,
  type EncryptedProviderCredential,
} from "./provider-credential-crypto";
import {
  PROVIDER_CREDENTIAL_COLUMNS,
  describeProviderCredential,
  managedProviderCredential,
  providerCredentialBinding,
  type ProviderCredentialRow,
} from "./provider-credential-store";
import { readSecretInput } from "./secret-private-input";
import { githubCredential } from "./provider-github-credential";
import { cloudflareCredential } from "./provider-cloudflare-credential";
import type { WorkspaceService } from "./service";
import { dependencyCredential } from "./dependency-credentials";
import { GitHubReader } from "./github-client";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import { repositoryFields } from "../shared/domain";

const PLAN_KIND = "provider.credential.change";
const connectionImpactSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
const reviewedInputSchema = z
  .object({
    request: providerCredentialPlanInput,
    previousSettings: providerCredentialFieldsSchema.nullable().optional(),
    memberRevision: z.number().int().positive(),
    tokenId: idSchema.nullable(),
    connections: z.array(connectionImpactSchema).max(SECRET_LIMITS.CONNECTIONS),
    pendingReviews: z.number().int().nonnegative(),
    unsettledDestinations: z.number().int().nonnegative(),
  })
  .strict();
type ReviewedInput = z.infer<typeof reviewedInputSchema>;
type PlanRow = {
  id: string;
  workspace_id: string;
  actor_subject: string;
  input_json: string;
  fingerprint: string;
  expires_at: string;
  applied_at: string | null;
};
const PLAN_COLUMNS =
  "id,workspace_id,actor_subject,input_json,fingerprint,expires_at,applied_at";
const privateTokenSchema = z
  .object({
    version: z.literal(1),
    token: z
      .string()
      .min(1)
      .max(LIMITS.TOKEN_BYTES)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();

export function providerCredentialConflict(): never {
  throw new DomainError(
    "provider_credential_conflict",
    "This credential review changed, expired, or lost its original authority. Inspect its status and review the current scope before retrying.",
    409,
  );
}

export class ProviderCredentials {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private admin(workspaceId: string) {
    return authorize(this.context, workspaceId, CAPABILITY.ADMIN);
  }
  private async current(workspaceId: string, credentialId: string) {
    const guard = actorGuard(this.context, workspaceId, CAPABILITY.ADMIN);
    return this.db
      .prepare(
        `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM provider_credentials WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, credentialId, ...guard.values)
      .first<ProviderCredentialRow>();
  }
  private captured(row: PlanRow): ReviewedInput {
    try {
      const reviewed = reviewedInputSchema.parse(JSON.parse(row.input_json));
      if (reviewed.request.workspaceId !== row.workspace_id)
        providerCredentialConflict();
      return reviewed;
    } catch {
      return providerCredentialConflict();
    }
  }
  private actorMatches(row: PlanRow, reviewed = this.captured(row)) {
    return (
      row.actor_subject === this.context.principal.subject &&
      reviewed.tokenId === (this.context.principal.tokenId ?? null)
    );
  }
  private async row(workspaceId: string, planId: string) {
    const guard = actorGuard(this.context, workspaceId, CAPABILITY.ADMIN);
    const row = await this.db
      .prepare(
        `SELECT ${PLAN_COLUMNS} FROM action_plans WHERE workspace_id=? AND id=? AND kind=? AND ${guard.sql}`,
      )
      .bind(workspaceId, planId, PLAN_KIND, ...guard.values)
      .first<PlanRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Provider credential review not found or access changed.",
        404,
      );
    return row;
  }
  private describe(row: PlanRow): ProviderCredentialReview {
    const reviewed = this.captured(row);
    return {
      id: row.id,
      credentialId: reviewed.request.credentialId,
      revision: reviewed.request.revision,
      change: reviewed.request.change,
      previousSettings: reviewed.previousSettings,
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
      appliedAt: row.applied_at,
      actorMatches: this.actorMatches(row, reviewed),
      connections: reviewed.connections,
      pendingReviews: reviewed.pendingReviews,
      unsettledDestinations: reviewed.unsettledDestinations,
    };
  }
  async list(input: unknown) {
    const { workspaceId, retired, before, purpose } =
      providerCredentialsListInput.parse(input);
    await this.admin(workspaceId);
    let cursor: { updatedAt: string; id: string } | null = null;
    if (before) {
      try {
        cursor = z
          .object({ updatedAt: z.iso.datetime(), id: idSchema })
          .strict()
          .parse(JSON.parse(atob(before)));
      } catch {
        throw new DomainError(
          "validation",
          "Select a valid provider credential history page.",
          400,
        );
      }
    }
    const guard = actorGuard(this.context, workspaceId, CAPABILITY.ADMIN);
    const result = await this.db
      .prepare(
        `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM provider_credentials WHERE workspace_id=? AND (retired_at IS NOT NULL)=?
      AND (provider_kind='github-repositories')=? AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?)) AND ${guard.sql} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        workspaceId,
        Number(retired),
        Number(purpose === "repositories"),
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        ...guard.values,
        LIMITS.HISTORY_PAGE + 1,
      )
      .all<ProviderCredentialRow>();
    await this.admin(workspaceId);
    const page = result.results.slice(0, LIMITS.HISTORY_PAGE);
    const last = page.at(-1);
    return {
      items: page.map((row) => describeProviderCredential(this.context, row)),
      nextCursor:
        result.results.length > LIMITS.HISTORY_PAGE && last
          ? btoa(JSON.stringify({ updatedAt: last.updated_at, id: last.id }))
          : null,
      storageReady: providerCredentialKeyStatus(this.context.env),
    };
  }
  async review(input: unknown) {
    const { workspaceId, planId } = providerCredentialReviewInput.parse(input);
    await this.admin(workspaceId);
    return this.describe(await this.row(workspaceId, planId));
  }
  async verify(input: unknown): Promise<ProviderCredentialVerification> {
    const {
      workspaceId,
      credentialId,
      revision,
      resourceName,
      scope: selectedScope,
      entryKind,
    } = providerCredentialVerifyInput.parse(input);
    const memberRevision = await this.admin(workspaceId);
    const row = await this.current(workspaceId, credentialId);
    if (!row || row.revision !== revision) providerCredentialConflict();
    const scope = selectedScope ?? {
      kind:
        row.provider_kind === "cloudflare-workers" ? "worker" : "repository",
    };
    let expiresAt: string;
    if (row.provider_kind === "cloudflare-workers") {
      if (scope.kind !== "worker")
        throw new DomainError(
          "validation",
          "Choose Worker configuration access for a Cloudflare credential.",
          400,
        );
      const provider = await cloudflareCredential(
        this.context,
        workspaceId,
        credentialId,
      );
      if (entryKind === SECRET_ENTRY_KIND.VARIABLE)
        await provider.client.variables(resourceName);
      else await provider.client.state(resourceName);
      expiresAt = provider.descriptor.expiresAt;
    } else if (row.provider_kind === PROVIDER_CREDENTIAL_KIND.REPOSITORY) {
      if (
        scope.kind !== "repository" ||
        entryKind !== SECRET_ENTRY_KIND.SECRET
      )
        throw new DomainError(
          "validation",
          "Choose repository read access for a maintenance credential.",
          400,
        );
      const provider = await dependencyCredential(
        this.context,
        workspaceId,
        credentialId,
        resourceName,
        false,
      );
      const reader = new GitHubReader(provider.token, { maxRequests: 1 });
      const result = await reader.request(
        "repository",
        new URL(
          "/repos/" + resourceName.split("/").map(encodeURIComponent).join("/"),
          GITHUB_LIMITS.API_ORIGIN,
        ),
      );
      const identity = z
        .object({ full_name: repositoryFields.shape.fullName })
        .parse(result.data);
      if (identity.full_name.toLowerCase() !== resourceName.toLowerCase())
        providerCredentialConflict();
      expiresAt = provider.settings.expiresAt;
    } else {
      if (scope.kind === "worker")
        throw new DomainError(
          "validation",
          "Choose organization, repository, or environment configuration access for a GitHub credential.",
          400,
        );
      const provider = await githubCredential(
        this.context,
        workspaceId,
        credentialId,
      );
      const repository = await provider.client.repository(resourceName);
      if (repository.full_name.toLowerCase() !== resourceName.toLowerCase())
        throw new DomainError(
          "secret_identity_changed",
          "The provider returned a different resource identity. Check the declared scope.",
          409,
        );
      if (scope.kind === "environment")
        await provider.client.environment(resourceName, scope.name);
      if (
        scope.kind === "organization" &&
        (repository.owner.type !== "Organization" ||
          repository.owner.login.toLowerCase() !== scope.name.toLowerCase())
      )
        throw new DomainError(
          "validation",
          "Choose the organization that owns the selected repository.",
          400,
        );
      await provider.client.configurationInventory(
        resourceName,
        scope,
        entryKind,
        1,
      );
      expiresAt = provider.descriptor.expiresAt;
    }
    const current = await this.current(workspaceId, credentialId);
    if (
      (await this.admin(workspaceId)) !== memberRevision ||
      !current ||
      current.revision !== revision ||
      current.identity !== row.identity ||
      current.retired_at ||
      Date.parse(expiresAt) <= this.context.now()
    )
      providerCredentialConflict();
    return {
      credentialId,
      revision,
      providerKind: row.provider_kind,
      resourceName,
      scope,
      entryKind,
      verifiedAt: this.timestamp(),
      evidence:
        row.provider_kind === PROVIDER_CREDENTIAL_KIND.REPOSITORY
          ? "repository-readable"
          : entryKind === SECRET_ENTRY_KIND.VARIABLE
            ? "variable-values-readable"
            : "secret-metadata-readable",
      writePermissionVerified: false,
    };
  }
  async plan(input: unknown) {
    const request = providerCredentialPlanInput.parse(input);
    const { workspaceId, credentialId, revision, change } = request;
    const memberRevision = await this.admin(workspaceId);
    const current = await this.current(workspaceId, credentialId);
    if ((current?.revision ?? 0) !== revision) providerCredentialConflict();
    if (change.kind === "save") {
      if (!providerCredentialKeyStatus(this.context.env)) {
        throw new DomainError(
          "provider_credential_storage_missing",
          "UI credential setup needs the deployment's protected encryption key. Existing deployment-managed connections remain separate.",
          503,
        );
      }
      if (Date.parse(change.settings.expiresAt) <= this.context.now()) {
        throw new DomainError(
          "validation",
          "Choose the provider token's future expiry. HQ will not use it after that time.",
          400,
        );
      }
      if (current && current.provider_kind !== change.settings.providerKind) {
        throw new DomainError(
          "validation",
          "Use a separate credential identity for a different provider.",
          400,
        );
      }
      if ((!current || current.retired_at) && !change.replaceToken) {
        throw new DomainError(
          "validation",
          "A new or retired credential requires private replacement input.",
          400,
        );
      }
    } else if (!current || current.retired_at) {
      throw new DomainError(
        "provider_credential_retired",
        "This credential is absent or already retired. No provider token was revoked.",
        409,
      );
    }
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const linked = await this.db
      .prepare(
        "SELECT id,name,revision,enabled FROM secret_connections WHERE workspace_id=? AND credential_ref=? ORDER BY id LIMIT ?",
      )
      .bind(workspaceId, credentialId, SECRET_LIMITS.CONNECTIONS + 1)
      .all<{ id: string; name: string; revision: number; enabled: number }>();
    if (linked.results.length > SECRET_LIMITS.CONNECTIONS)
      providerCredentialConflict();
    const selectedReviews = `SELECT r.id FROM secret_reviews r,json_each(r.captured_json,'$.destinations') d
      WHERE r.workspace_id=? AND r.expires_at>? AND json_extract(d.value,'$.providerRef')=?
      UNION SELECT r.id FROM secret_reviews r WHERE r.workspace_id=? AND r.expires_at>? AND json_extract(r.captured_json,'$.source.providerRef')=?`;
    const pending = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM secret_reviews WHERE workspace_id=? AND stage IN ('awaiting-input','reviewed','accepted')
      AND expires_at>? AND id IN (${selectedReviews})`,
      )
      .bind(
        workspaceId,
        this.timestamp(),
        workspaceId,
        this.timestamp(),
        credentialId,
        workspaceId,
        this.timestamp(),
        credentialId,
      )
      .first<number>("total");
    const unsettled = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM secret_receipts WHERE workspace_id=? AND (phase IN ('preparing','submitted') OR write_status='indeterminate')
      AND review_id IN (${selectedReviews})`,
      )
      .bind(
        workspaceId,
        workspaceId,
        this.timestamp(),
        credentialId,
        workspaceId,
        this.timestamp(),
        credentialId,
      )
      .first<number>("total");
    const repositoryImpact = await this.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM action_plans WHERE workspace_id=? AND kind='dependency.change' AND applied_at IS NULL AND expires_at>? AND json_extract(input_json,'$.review.writer.id')=?) AS pending,
      (SELECT count(*) FROM operations o JOIN action_plans p ON p.id=o.plan_id AND p.workspace_id=o.workspace_id WHERE o.workspace_id=? AND o.kind='dependency.change' AND o.status IN ('running','partial','indeterminate') AND json_extract(p.input_json,'$.review.writer.id')=?) AS unsettled`,
      )
      .bind(
        workspaceId,
        this.timestamp(),
        credentialId,
        workspaceId,
        credentialId,
      )
      .first<{ pending: number; unsettled: number }>();
    const reviewed: ReviewedInput = {
      request,
      previousSettings: current
        ? providerCredentialBinding(current).settings
        : null,
      memberRevision,
      tokenId: this.context.principal.tokenId ?? null,
      connections: linked.results.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      pendingReviews: (pending ?? 0) + (repositoryImpact?.pending ?? 0),
      unsettledDestinations:
        (unsettled ?? 0) + (repositoryImpact?.unsettled ?? 0),
    };
    const serialized = JSON.stringify(reviewed);
    const planId = crypto.randomUUID();
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + LIMITS.REVIEW_MS,
    ).toISOString();
    const fingerprint =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({ planId, serialized, createdAt, expiresAt }),
      ));
    const result = await this.db
      .prepare(
        `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
      AND COALESCE((SELECT revision FROM provider_credentials WHERE workspace_id=? AND id=?),0)=?
      AND (SELECT COUNT(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`,
      )
      .bind(
        planId,
        workspaceId,
        this.context.principal.subject,
        PLAN_KIND,
        serialized,
        fingerprint,
        createdAt,
        expiresAt,
        ...guard.values,
        workspaceId,
        credentialId,
        revision,
        workspaceId,
        this.context.principal.subject,
        PLAN_KIND,
        createdAt,
        LIMITS.PENDING_REVIEWS,
      )
      .run();
    if (!result.meta.changes) providerCredentialConflict();
    return this.review({ workspaceId, planId });
  }
  private async acceptedSelection(input: unknown) {
    const selection = providerCredentialApplyInput.parse(input);
    const memberRevision = await this.admin(selection.workspaceId);
    const row = await this.row(selection.workspaceId, selection.planId);
    const reviewed = this.captured(row);
    if (
      !this.actorMatches(row, reviewed) ||
      row.fingerprint !== selection.fingerprint
    )
      providerCredentialConflict();
    if (row.applied_at) return { row, reviewed, current: null };
    if (
      Date.parse(row.expires_at) <= this.context.now() ||
      reviewed.memberRevision !== memberRevision
    )
      providerCredentialConflict();
    const current = await this.current(
      selection.workspaceId,
      reviewed.request.credentialId,
    );
    if ((current?.revision ?? 0) !== reviewed.request.revision)
      providerCredentialConflict();
    return { row, reviewed, current };
  }
  private async commit(
    row: PlanRow,
    reviewed: ReviewedInput,
    current: ProviderCredentialRow | null,
    token?: string,
  ) {
    const { workspaceId, credentialId, revision, change } = reviewed.request;
    if (row.applied_at) return { applied: false, review: this.describe(row) };
    const now = this.timestamp();
    const nextRevision = revision + 1;
    const identity = await credentialHash(crypto.randomUUID());
    const settings =
      change.kind === "save"
        ? change.settings
        : current && providerCredentialBinding(current).settings;
    if (!settings) providerCredentialConflict();
    let encrypted: EncryptedProviderCredential | null = null;
    if (change.kind === "save") {
      if (Date.parse(settings.expiresAt) <= this.context.now())
        providerCredentialConflict();
      if (!change.replaceToken) {
        const retained = await managedProviderCredential(
          this.context,
          workspaceId,
          credentialId,
          settings.providerKind,
        );
        if (retained.revision !== revision) providerCredentialConflict();
        token = retained.token;
      }
      if (!token) providerCredentialConflict();
      encrypted = await sealProviderCredential(
        this.context.env,
        {
          workspaceId,
          credentialId,
          revision: nextRevision,
          identity,
          settings,
        },
        token,
      );
    }
    token = undefined;
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      reviewed.memberRevision,
    );
    const writeId = crypto.randomUUID();
    const retiredAt = change.kind === "retire" ? now : null;
    const dependencySql = `AND (SELECT COUNT(*) FROM secret_connections WHERE workspace_id=? AND credential_ref=?)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) i WHERE NOT EXISTS (SELECT 1 FROM secret_connections c WHERE c.workspace_id=?
      AND c.credential_ref=? AND c.id=json_extract(i.value,'$.id') AND c.revision=json_extract(i.value,'$.revision')))`;
    const applied = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO provider_credentials
        (workspace_id,id,provider_kind,settings_json,revision,identity,key_id,nonce,ciphertext,created_at,updated_at,retired_at,write_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND EXISTS (SELECT 1 FROM action_plans WHERE workspace_id=? AND id=? AND actor_subject=? AND kind=? AND fingerprint=?
          AND input_json=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))
        AND COALESCE((SELECT revision FROM provider_credentials WHERE workspace_id=? AND id=?),0)=?
        AND (? IS NOT NULL OR (SELECT COUNT(*) FROM provider_credentials WHERE workspace_id=? AND retired_at IS NULL AND id<>?)<?)
        AND (? IS NOT NULL OR julianday(?)>julianday('now'))
        ${dependencySql}
        ON CONFLICT(workspace_id,id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,identity=excluded.identity,
          key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at,retired_at=excluded.retired_at,write_id=excluded.write_id`,
        )
        .bind(
          workspaceId,
          credentialId,
          settings.providerKind,
          JSON.stringify(settings),
          nextRevision,
          identity,
          encrypted?.keyId ?? null,
          encrypted?.nonce ?? null,
          encrypted?.ciphertext ?? null,
          current?.created_at ?? now,
          now,
          retiredAt,
          writeId,
          ...guard.values,
          workspaceId,
          row.id,
          row.actor_subject,
          PLAN_KIND,
          row.fingerprint,
          row.input_json,
          now,
          workspaceId,
          credentialId,
          revision,
          retiredAt,
          workspaceId,
          credentialId,
          LIMITS.WORKSPACE,
          retiredAt,
          settings.expiresAt,
          workspaceId,
          credentialId,
          reviewed.connections.length,
          JSON.stringify(reviewed.connections),
          workspaceId,
          credentialId,
        ),
      this.db
        .prepare(
          "UPDATE action_plans SET applied_at=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM provider_credentials WHERE workspace_id=? AND id=? AND write_id=?)",
        )
        .bind(now, workspaceId, row.id, workspaceId, credentialId, writeId),
      this.db
        .prepare(
          `UPDATE secret_connections SET revision=revision+1,enabled=CASE WHEN ?=1 THEN 0 ELSE enabled END,write_id=?
        WHERE workspace_id=? AND credential_ref=? AND EXISTS (SELECT 1 FROM provider_credentials WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          Number(change.kind === "retire"),
          writeId,
          workspaceId,
          credentialId,
          workspaceId,
          credentialId,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM provider_credentials WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          crypto.randomUUID(),
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          change.kind === "retire"
            ? "provider.credential.retired"
            : "provider.credential.saved",
          change.kind === "retire"
            ? "Provider credential retired from HQ"
            : "Provider credential settings saved",
          change.kind === "retire"
            ? "Discarded usable local credential ciphertext and disabled enrolled connections. The upstream token was not revoked and submitted work cannot be recalled."
            : "Stored an encrypted provider credential with reviewed workspace scope. Related connection revisions changed; earlier reviews do not inherit replacement authority. No provider secret was changed.",
          now,
          workspaceId,
          credentialId,
          writeId,
        ),
    ]);
    if (!applied[0]!.meta.changes) {
      const latest = await this.row(workspaceId, row.id);
      if (!latest.applied_at) providerCredentialConflict();
    }
    return {
      applied: Boolean(applied[0]!.meta.changes),
      review: await this.review({ workspaceId, planId: row.id }),
    };
  }
  async apply(input: unknown) {
    const { row, reviewed, current } = await this.acceptedSelection(input);
    if (row.applied_at) return this.describe(row);
    if (
      reviewed.request.change.kind === "save" &&
      reviewed.request.change.replaceToken
    ) {
      throw new DomainError(
        "provider_credential_private_input_required",
        "This review requires the dedicated private credential input. Do not include a token in a command.",
        409,
      );
    }
    return (await this.commit(row, reviewed, current)).review;
  }
  async upload(request: Request, input: unknown) {
    const selection = providerCredentialReviewInput.parse(input);
    const selected = await this.acceptedSelection({
      ...selection,
      fingerprint: request.headers.get("If-Match"),
    });
    const { row, reviewed, current } = selected;
    if (row.applied_at) return { submitted: false, review: this.describe(row) };
    if (
      reviewed.request.change.kind !== "save" ||
      !reviewed.request.change.replaceToken
    ) {
      throw new DomainError(
        "provider_credential_input_unexpected",
        "This review does not accept replacement input. No token was read.",
        409,
      );
    }
    let token: string | undefined;
    try {
      const privateInput = privateTokenSchema.safeParse(
        await readSecretInput(request, {
          bytes: LIMITS.INPUT_BYTES,
          timeoutMs: LIMITS.INPUT_MS,
        }),
      );
      if (!privateInput.success)
        throw new Error("Invalid private credential input");
      token = privateInput.data.token;
    } catch {
      throw new DomainError(
        "provider_credential_input_invalid",
        "Private credential input was not accepted. Inspect the review before retrying.",
        400,
      );
    }
    try {
      const result = await this.commit(row, reviewed, current, token);
      return { submitted: result.applied, review: result.review };
    } finally {
      token = undefined;
    }
  }
}
