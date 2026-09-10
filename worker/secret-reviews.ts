import { z } from "zod";
import { CAPABILITY } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretDestinationSchema,
  secretDraftInput,
  secretReviewInput,
  secretHistoryInput,
  secretProviderKindSchema,
  secretTargetSnapshotSchema,
  secretRecoveryContextSchema,
  sealedSecretIndexes,
  type SecretRecoveryContext,
  type SecretDestination,
  type SecretReview,
  type SecretReviewedDestination,
} from "../shared/secrets";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  describeSecretResource,
  secretResourceBindingSchema,
} from "./secret-adapters";
import { SecretsService } from "./secrets";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { captureSecretProjectActivity } from "./project-resources";
import { privateInputError, readSecretInput } from "./secret-private-input";
import type { WorkspaceService } from "./service";
import { readSecretOperation } from "./secret-receipts";
import {
  capturedSecretGuard,
  connectCapturedSecrets,
  secretReviewConflict,
} from "./secret-authority";
export { secretReviewConflict } from "./secret-authority";

export const capturedDestinationSchema = z
  .object({
    destination: secretDestinationSchema,
    providerKind: secretProviderKindSchema,
    providerRef: z.string(),
    providerIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    connectionName: z.string(),
    resource: secretResourceBindingSchema,
    snapshot: secretTargetSnapshotSchema,
  })
  .strict();
export const capturedSecretsSchema = z
  .object({
    destinations: z
      .array(capturedDestinationSchema)
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
    source: capturedDestinationSchema.nullable(),
    recovery: secretRecoveryContextSchema.nullable().default(null),
  })
  .strict();
export type CapturedSecretDestination = z.infer<
  typeof capturedDestinationSchema
>;
export type CapturedSecrets = z.infer<typeof capturedSecretsSchema>;
export type SecretReviewRow = {
  workspace_id: string;
  id: string;
  actor_subject: string;
  actor_name: string;
  actor_token_id: string | null;
  member_revision: number;
  request_json: string;
  request_hash: string;
  captured_json: string;
  draft_fingerprint: string;
  fingerprint: string | null;
  input_hash: string | null;
  stage: SecretReview["stage"];
  created_at: string;
  expires_at: string;
  input_expires_at: string;
};
const COLUMNS =
  "workspace_id,id,actor_subject,actor_name,actor_token_id,member_revision,request_json,request_hash,captured_json,draft_fingerprint,fingerprint,input_hash,stage,created_at,expires_at,input_expires_at";
const sealedInputSchema = z
  .object({
    version: z.literal(1),
    items: z
      .array(
        z
          .object({
            destinationIndex: z
              .number()
              .int()
              .min(0)
              .max(SECRET_LIMITS.DESTINATIONS - 1),
            ciphertext: z.string().min(1).max(SECRET_LIMITS.UPLOAD_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(SECRET_LIMITS.DESTINATIONS),
  })
  .strict();

export function capturedSecretKey(item: CapturedSecretDestination) {
  return JSON.stringify([
    item.providerKind,
    item.snapshot.resourceIdentity,
    item.snapshot.scope.kind,
    item.snapshot.scopeIdentity,
    item.snapshot.name,
  ]);
}
export function describeCapturedSecret(
  item: CapturedSecretDestination,
): SecretReviewedDestination {
  return {
    destination: item.destination,
    providerKind: item.providerKind,
    connectionName: item.connectionName,
    resource: describeSecretResource(item.resource),
    snapshot: item.snapshot,
  };
}

export class SecretReviews {
  readonly secrets: SecretsService;
  constructor(readonly context: WorkspaceService) {
    this.secrets = new SecretsService(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }

  audit(
    row: SecretReviewRow,
    writeId: string,
    type: string,
    title: string,
    summary: string,
  ) {
    const eventId = crypto.randomUUID();
    return [
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          eventId,
          row.workspace_id,
          this.context.principal.subject,
          this.context.principal.displayName,
          type,
          title,
          summary,
          this.timestamp(),
          row.workspace_id,
          row.id,
          writeId,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links (workspace_id,event_id,repository_id)
        SELECT workspace_id,?,repository_id FROM secret_review_repositories WHERE workspace_id=? AND review_id=?
          AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
        )
        .bind(eventId, row.workspace_id, row.id, row.workspace_id, eventId),
      captureSecretProjectActivity(this.db, row.workspace_id, eventId, row.id),
    ];
  }

  async row(workspaceId: string, reviewId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM secret_reviews WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, reviewId, ...guard.values)
      .first<SecretReviewRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Secrets review not found or access changed.",
        404,
      );
    return row;
  }
  captured(row: SecretReviewRow): CapturedSecrets {
    try {
      return capturedSecretsSchema.parse(JSON.parse(row.captured_json));
    } catch {
      throw new DomainError(
        "secret_review_invalid",
        "This Secrets review cannot be safely interpreted. No provider operation was attempted.",
        409,
      );
    }
  }
  matchesActor(row: SecretReviewRow) {
    return (
      row.actor_subject === this.context.principal.subject &&
      row.actor_token_id === (this.context.principal.tokenId ?? null)
    );
  }
  async get(input: unknown): Promise<SecretReview> {
    const { workspaceId, reviewId } = secretReviewInput.parse(input);
    await authorize(this.context, workspaceId);
    const row = await this.row(workspaceId, reviewId);
    const captured = this.captured(row);
    const present = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM secret_payloads WHERE workspace_id=? AND review_id=?",
      )
      .bind(workspaceId, reviewId)
      .first<{ count: number }>();
    const operation = await readSecretOperation(
      this.db,
      workspaceId,
      reviewId,
      this.context.now(),
    );
    await authorize(this.context, workspaceId);
    return {
      id: row.id,
      stage: row.stage,
      draftFingerprint: row.draft_fingerprint,
      fingerprint: row.fingerprint,
      actorMatches: this.matchesActor(row),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      inputExpiresAt: row.input_expires_at,
      inputPresent:
        Date.parse(row.input_expires_at) > this.context.now() &&
        sealedSecretIndexes(captured.destinations).length > 0 &&
        present?.count === sealedSecretIndexes(captured.destinations).length,
      destinations: captured.destinations.map(describeCapturedSecret),
      source: captured.source ? describeCapturedSecret(captured.source) : null,
      operation,
      recovery: captured.recovery,
    };
  }
  async history(input: unknown) {
    const { workspaceId, repositoryId, before } =
      secretHistoryInput.parse(input);
    await authorize(this.context, workspaceId);
    if (repositoryId)
      await this.context.repository({ workspaceId, repositoryId });
    let cursor: { createdAt: string; id: string } | null = null;
    if (before) {
      try {
        cursor = z
          .object({
            createdAt: z.iso.datetime(),
            id: secretReviewInput.shape.reviewId,
          })
          .strict()
          .parse(JSON.parse(atob(before)));
      } catch {
        throw new DomainError(
          "validation",
          "Select a valid Secrets history page.",
          400,
        );
      }
    }
    const rows = await this.db
      .prepare(
        `SELECT id,stage,created_at,captured_json FROM secret_reviews r WHERE workspace_id=?
      AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM secret_review_repositories s WHERE s.workspace_id=r.workspace_id AND s.review_id=r.id AND s.repository_id=?))
      ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        workspaceId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        repositoryId ?? null,
        repositoryId ?? null,
        SECRET_LIMITS.HISTORY_PAGE + 1,
      )
      .all<
        Pick<SecretReviewRow, "id" | "stage" | "created_at" | "captured_json">
      >();
    await authorize(this.context, workspaceId);
    const page = rows.results.slice(0, SECRET_LIMITS.HISTORY_PAGE);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        stage: row.stage,
        createdAt: row.created_at,
        destinations: capturedSecretsSchema
          .parse(JSON.parse(row.captured_json))
          .destinations.map((item) => ({
            connectionName: item.connectionName,
            resource: describeSecretResource(item.resource),
            name: item.snapshot.name,
            scope: item.snapshot.scope,
            providerKind: item.providerKind,
          })),
      })),
      nextCursor:
        rows.results.length > SECRET_LIMITS.HISTORY_PAGE && last
          ? btoa(JSON.stringify({ createdAt: last.created_at, id: last.id }))
          : null,
    };
  }
  async capture(
    workspaceId: string,
    destination: SecretDestination,
  ): Promise<CapturedSecretDestination> {
    const selected = await this.secrets.resource(
      workspaceId,
      destination.connectionId,
      destination.target.resourceId,
    );
    if (selected.row.revision !== destination.connectionRevision)
      secretReviewConflict();
    if (!selected.provider.writable)
      throw new DomainError(
        "secret_read_only",
        "This Secrets connection permits metadata reads only.",
        403,
      );
    if (
      !selected.adapter.capabilities.secretMutationScopeKinds.includes(
        destination.target.scope.kind,
      )
    )
      throw new DomainError(
        "secret_scope_read_only",
        "This provider scope is available for inventory but not supported by the reviewed secret-change workflow.",
        409,
      );
    const snapshot = secretTargetSnapshotSchema.parse(
      await selected.provider.prepare(
        selected.resource,
        destination.target.scope,
        destination.name,
      ),
    );
    await this.secrets.recheck(
      workspaceId,
      selected.row,
      selected.resource,
      selected.provider.identity,
    );
    return {
      destination: {
        ...destination,
        name: snapshot.name,
        target: { ...destination.target, scope: snapshot.scope },
      },
      providerKind: selected.row.provider_kind,
      providerRef: selected.row.credential_ref,
      providerIdentity: selected.provider.identity,
      connectionName: selected.row.name,
      resource: selected.resource,
      snapshot,
    };
  }
  async ready(row: SecretReviewRow, captured = this.captured(row)) {
    if (
      !this.matchesActor(row) ||
      Date.parse(row.expires_at) <= this.context.now()
    )
      secretReviewConflict();
    const revision = await authorize(
      this.context,
      row.workspace_id,
      CAPABILITY.SECRETS,
    );
    if (revision !== row.member_revision) secretReviewConflict();
    if (captured.recovery) {
      const guard = this.guard(row, false);
      if (
        !(await this.db
          .prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
          .bind(...guard.values)
          .first())
      )
        secretReviewConflict();
    }
    return connectCapturedSecrets(this.context, row.workspace_id, [
      ...captured.destinations,
      ...(captured.source ? [captured.source] : []),
    ]);
  }
  guard(row: SecretReviewRow, reservation = row.stage !== "awaiting-input") {
    const captured = this.captured(row);
    const items = [
      ...captured.destinations,
      ...(captured.source ? [captured.source] : []),
    ];
    const recovery = captured.recovery;
    const authority = capturedSecretGuard(
      this.context,
      row.workspace_id,
      row.member_revision,
      items,
    );
    const recoverySql = recovery
      ? ` AND EXISTS (SELECT 1 FROM secret_receipts p JOIN secret_reviews r ON r.workspace_id=p.workspace_id AND r.id=p.review_id
      WHERE p.workspace_id=? AND p.review_id=? AND p.destination_index=? AND p.revision=? AND p.phase='finished'
      AND NOT (p.write_status='accepted' AND p.observation_status='present') AND r.fingerprint=? AND r.input_expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_expires_at>?)`
      : "";
    const reservationSql =
      recovery && reservation
        ? " AND EXISTS (SELECT 1 FROM secret_recovery_links WHERE workspace_id=? AND parent_review_id=? AND parent_destination_index=? AND child_review_id=?)"
        : "";
    return {
      sql: `${authority.sql}${recoverySql}${reservationSql}`,
      values: [
        ...authority.values,
        ...(recovery
          ? [
              row.workspace_id,
              recovery.reviewId,
              recovery.destinationIndex,
              recovery.receiptRevision,
              recovery.fingerprint,
              this.timestamp(),
              row.workspace_id,
              recovery.reviewId,
              this.timestamp(),
            ]
          : []),
        ...(recovery && reservation
          ? [
              row.workspace_id,
              recovery.reviewId,
              recovery.destinationIndex,
              row.id,
            ]
          : []),
      ],
    };
  }
  async draft(
    input: unknown,
    reuse?: { recovery: SecretRecoveryContext; inputExpiresAt: string },
  ): Promise<SecretReview> {
    const logicalStart = this.context.now();
    const realStart = Date.now();
    const checkBudget = () => {
      if (
        Math.max(this.context.now() - logicalStart, Date.now() - realStart) >=
        SECRET_LIMITS.DRAFT_PREPARE_MS
      )
        throw new DomainError(
          "secret_preparation_deadline",
          "Destination preparation exceeded its bounded read window. No provider write was sent. Reduce the selection or retry this same preparation after inspecting state.",
          409,
        );
    };
    const request = secretDraftInput.parse(input);
    const { workspaceId, reviewId } = request;
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    const requestHash = await credentialHash(
      JSON.stringify(reuse ? { request, reuse } : request),
    );
    const existing = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM secret_reviews WHERE workspace_id=? AND id=?`,
      )
      .bind(workspaceId, reviewId)
      .first<SecretReviewRow>();
    if (existing) {
      if (!this.matchesActor(existing) || existing.request_hash !== requestHash)
        secretReviewConflict();
      return this.get({ workspaceId, reviewId });
    }
    const captured: CapturedSecrets = {
      destinations: [],
      source: null,
      recovery: reuse?.recovery ?? null,
    };
    for (const destination of request.destinations) {
      checkBudget();
      captured.destinations.push(await this.capture(workspaceId, destination));
      checkBudget();
    }
    if (request.source) {
      checkBudget();
      captured.source = await this.capture(workspaceId, request.source);
      checkBudget();
      if (!captured.source.snapshot.before)
        throw new DomainError(
          "secret_source_missing",
          "The selected source secret is not present. No scope change was prepared.",
          409,
        );
    }
    const keys = captured.destinations.map(capturedSecretKey);
    if (
      new Set(keys).size !== keys.length ||
      (captured.source && keys.includes(capturedSecretKey(captured.source)))
    )
      throw new DomainError(
        "secret_duplicate_destination",
        "Select distinct provider destinations. The source cannot also be a destination, including through another connection.",
        400,
      );
    const createdAt = this.timestamp();
    const workers = [
      ...captured.destinations,
      ...(captured.source ? [captured.source] : []),
    ]
      .filter((item) => item.snapshot.activation === "worker-deployment")
      .map((item) => item.snapshot.resourceIdentity);
    if (new Set(workers).size !== workers.length)
      throw new DomainError(
        "secret_worker_distribution_conflict",
        "Select one binding per Worker in this distribution, including its source. Each Cloudflare change deploys a new version and would invalidate another reviewed step on that same Worker. Use separate fresh reviews; same-Worker rename cleanup is not supported.",
        409,
      );
    const sealedIndexes = sealedSecretIndexes(captured.destinations);
    const expiresAt = new Date(
      Math.min(
        this.context.now() + SECRET_LIMITS.REVIEW_MS,
        reuse ? Date.parse(reuse.inputExpiresAt) : Infinity,
      ),
    ).toISOString();
    const inputExpiresAt =
      reuse?.inputExpiresAt ??
      new Date(
        this.context.now() + SECRET_LIMITS.INPUT_RETENTION_MS,
      ).toISOString();
    const draftFingerprint =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({
          workspaceId,
          reviewId,
          actor: this.context.principal.subject,
          tokenId: this.context.principal.tokenId ?? null,
          memberRevision,
          requestHash,
          captured,
          createdAt,
          expiresAt,
          inputExpiresAt,
        }),
      ));
    const row: SecretReviewRow = {
      workspace_id: workspaceId,
      id: reviewId,
      actor_subject: this.context.principal.subject,
      actor_name: this.context.principal.displayName,
      actor_token_id: this.context.principal.tokenId ?? null,
      member_revision: memberRevision,
      request_json: JSON.stringify(request),
      request_hash: requestHash,
      captured_json: JSON.stringify(captured),
      draft_fingerprint: draftFingerprint,
      fingerprint: sealedIndexes.length ? null : draftFingerprint,
      input_hash: null,
      stage: sealedIndexes.length ? "awaiting-input" : "reviewed",
      created_at: createdAt,
      expires_at: expiresAt,
      input_expires_at: inputExpiresAt,
    };
    await this.ready(row, captured);
    const guard = this.guard(row);
    const writeId = crypto.randomUUID();
    const repositories = [
      ...new Set(
        [
          ...captured.destinations,
          ...(captured.source ? [captured.source] : []),
        ].flatMap((item) =>
          item.resource.repositories.map((repository) => repository.id),
        ),
      ),
    ];
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO secret_reviews (${COLUMNS},write_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND (SELECT COUNT(*) FROM secret_reviews WHERE workspace_id=? AND stage IN ('awaiting-input','reviewed','accepted') AND input_expires_at>?)<?`,
        )
        .bind(
          workspaceId,
          reviewId,
          row.actor_subject,
          row.actor_name,
          row.actor_token_id,
          memberRevision,
          row.request_json,
          requestHash,
          row.captured_json,
          draftFingerprint,
          row.fingerprint,
          null,
          row.stage,
          createdAt,
          expiresAt,
          inputExpiresAt,
          writeId,
          ...guard.values,
          workspaceId,
          createdAt,
          SECRET_LIMITS.STAGED_WORKSPACE,
        ),
      this.db
        .prepare(
          `INSERT INTO secret_review_repositories (workspace_id,review_id,repository_id) SELECT ?,?,value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(
          workspaceId,
          reviewId,
          JSON.stringify(repositories),
          workspaceId,
          reviewId,
          writeId,
        ),
      ...this.audit(
        row,
        writeId,
        "secrets.review.created",
        "Secrets review prepared",
        "Prepared exact destinations for supplied-value input. No provider secret was changed.",
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      const concurrent = await this.db
        .prepare(
          `SELECT ${COLUMNS} FROM secret_reviews WHERE workspace_id=? AND id=?`,
        )
        .bind(workspaceId, reviewId)
        .first<SecretReviewRow>();
      if (!concurrent)
        throw new DomainError(
          "secret_review_capacity",
          "Secrets review capacity or authority changed. Cancel unused reviews or wait for their private inputs to expire.",
          409,
        );
      if (
        !this.matchesActor(concurrent) ||
        concurrent.request_hash !== requestHash
      )
        secretReviewConflict();
    }
    return this.get({ workspaceId, reviewId });
  }
  async upload(request: Request, input: unknown) {
    const { workspaceId, reviewId } = secretReviewInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, reviewId);
    if (
      !this.matchesActor(row) ||
      request.headers.get("If-Match") !== row.draft_fingerprint ||
      !["awaiting-input", "reviewed"].includes(row.stage) ||
      Date.parse(row.input_expires_at) <= this.context.now()
    )
      secretReviewConflict();
    const captured = this.captured(row);
    if (captured.recovery)
      throw new DomainError(
        "secret_recovery_input",
        "A retained-input recovery cannot accept replacement input. Inspect the original review or start a deliberate new distribution.",
        409,
      );
    const sealedIndexes = sealedSecretIndexes(captured.destinations);
    if (!sealedIndexes.length)
      throw new DomainError(
        "secret_input_unsupported",
        "This review does not stage input. Accept the exact review, then use dedicated private input for its transient execution steps. No input was consumed.",
        409,
      );
    const providers = await this.ready(row, captured);
    const parsed = sealedInputSchema.safeParse(await readSecretInput(request));
    if (!parsed.success) privateInputError();
    const items = parsed.data.items.sort(
      (a, b) => a.destinationIndex - b.destinationIndex,
    );
    if (
      items.length !== sealedIndexes.length ||
      items.some(
        (item, index) =>
          item.destinationIndex !== sealedIndexes[index] ||
          !providers[item.destinationIndex]!.validateSealedInput(
            captured.destinations[item.destinationIndex]!.snapshot,
            item.ciphertext,
          ),
      )
    )
      privateInputError();
    const inputHash = await credentialHash(JSON.stringify(items));
    const fingerprint =
      "sha256:" +
      (await credentialHash(
        JSON.stringify({ draftFingerprint: row.draft_fingerprint, inputHash }),
      ));
    await this.ready(row, captured);
    const guard = this.guard(row);
    const writeId = crypto.randomUUID();
    const now = this.timestamp();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_reviews SET stage='reviewed',fingerprint=?,input_hash=?,write_id=? WHERE workspace_id=? AND id=? AND stage='awaiting-input'
        AND draft_fingerprint=? AND expires_at>? AND julianday(expires_at)>julianday('now') AND ${guard.sql}`,
        )
        .bind(
          fingerprint,
          inputHash,
          writeId,
          workspaceId,
          reviewId,
          row.draft_fingerprint,
          now,
          ...guard.values,
        ),
      ...items.map((item) =>
        this.db
          .prepare(
            `INSERT INTO secret_payloads (workspace_id,review_id,destination_index,ciphertext)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=? AND stage='reviewed')`,
          )
          .bind(
            workspaceId,
            reviewId,
            item.destinationIndex,
            item.ciphertext,
            workspaceId,
            reviewId,
            writeId,
          ),
      ),
      ...this.audit(
        row,
        writeId,
        "secrets.input.accepted",
        "Sealed input ready for review",
        "Accepted bounded provider-encrypted input for the reviewed destinations. No provider secret was changed.",
      ),
    ]);
    if (!saved[0]!.meta.changes) {
      const current = await this.row(workspaceId, reviewId);
      if (
        !this.matchesActor(current) ||
        current.stage !== "reviewed" ||
        current.input_hash !== inputHash ||
        current.fingerprint !== fingerprint
      )
        secretReviewConflict();
    }
    return this.get({ workspaceId, reviewId });
  }
  async cancel(input: unknown) {
    const { workspaceId, reviewId } = secretReviewInput.parse(input);
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, reviewId);
    if (!this.matchesActor(row) || row.stage === "accepted")
      secretReviewConflict();
    const guard = actorGuard(this.context, workspaceId, CAPABILITY.SECRETS);
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_reviews SET stage='cancelled',write_id=? WHERE workspace_id=? AND id=? AND actor_subject=? AND stage IN ('awaiting-input','reviewed') AND ${guard.sql}`,
        )
        .bind(
          writeId,
          workspaceId,
          reviewId,
          row.actor_subject,
          ...guard.values,
        ),
      this.db
        .prepare(
          "DELETE FROM secret_payloads WHERE workspace_id=? AND review_id=? AND EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND stage='cancelled')",
        )
        .bind(workspaceId, reviewId, workspaceId, reviewId),
      this.db
        .prepare(
          "DELETE FROM secret_recovery_links WHERE workspace_id=? AND child_review_id=? AND EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND stage='cancelled')",
        )
        .bind(workspaceId, reviewId, workspaceId, reviewId),
      ...this.audit(
        row,
        writeId,
        "secrets.review.cancelled",
        "Secrets review cancelled",
        "Discarded staged input for this review. No provider secret was changed.",
      ),
    ]);
    return this.get({ workspaceId, reviewId });
  }
}
