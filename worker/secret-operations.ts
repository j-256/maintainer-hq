import { z } from "zod";
import { CAPABILITY } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretApplyInput,
  secretRunInput,
  secretStepInput,
  secretWriteResultSchema,
  secretTargetSnapshotSchema,
  sealedSecretIndexes,
  type SecretTransientReceipt,
  type SecretMetadata,
  type SecretReceipt,
  type SecretWriteResult,
} from "../shared/secrets";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import {
  SecretReviews,
  secretReviewConflict,
  type SecretReviewRow,
  type CapturedSecretDestination,
} from "./secret-reviews";
import { readSecretReceipts } from "./secret-receipts";
import { secretAdapter } from "./secret-adapter-registry";
import { DomainError } from "./errors";
import { captureSecretProjectActivity } from "./project-resources";
import type { WorkspaceService } from "./service";
import { readSecretInput, privateInputError } from "./secret-private-input";
import { CLOUDFLARE_SECRET_LIMITS } from "../shared/cloudflare-secrets";

const transientInputSchema = z
  .object({
    version: z.literal(1),
    value: z.string().min(1).max(CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES),
  })
  .strict();
const transientSelectionSchema = secretStepInput.extend({
  destinationIndex: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .transform(Number)
    .pipe(secretStepInput.shape.destinationIndex),
});

export class SecretOperations {
  readonly reviews: SecretReviews;
  constructor(readonly context: WorkspaceService) {
    this.reviews = new SecretReviews(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }

  private async selected(workspaceId: string, reviewId: string) {
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.reviews.row(workspaceId, reviewId);
    if (!this.reviews.matchesActor(row)) secretReviewConflict();
    return row;
  }
  private async receipt(row: SecretReviewRow, destinationIndex: number) {
    const receipt = (
      await readSecretReceipts(this.db, row.workspace_id, row.id)
    ).find((item) => item.destinationIndex === destinationIndex);
    if (!receipt) secretReviewConflict();
    return receipt;
  }
  private leaseGuard(row: SecretReviewRow, leaseId: string, reserve = 0) {
    return {
      sql: `EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_id=?
        AND lease_expires_at>? AND julianday(lease_expires_at)>julianday('now',?))`,
      values: [
        row.workspace_id,
        row.id,
        leaseId,
        new Date(this.context.now() + reserve).toISOString(),
        "+" + reserve / 1000 + " seconds",
      ],
    };
  }
  private async release(row: SecretReviewRow, leaseId: string) {
    await this.db
      .prepare(
        `UPDATE secret_operations SET lease_id=NULL,lease_expires_at=NULL WHERE workspace_id=? AND review_id=? AND lease_id=?
      AND NOT EXISTS (SELECT 1 FROM secret_receipts WHERE workspace_id=? AND review_id=? AND phase IN ('preparing','submitted'))`,
      )
      .bind(row.workspace_id, row.id, leaseId, row.workspace_id, row.id)
      .run();
  }
  private audit(
    row: SecretReviewRow,
    index: number,
    writeId: string,
    title: string,
    summary: string,
  ) {
    const eventId = crypto.randomUUID();
    return [
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'secrets.operation.updated',?,?,? WHERE EXISTS
        (SELECT 1 FROM secret_receipts WHERE workspace_id=? AND review_id=? AND destination_index=? AND write_id=?)`,
        )
        .bind(
          eventId,
          row.workspace_id,
          this.context.principal.subject,
          this.context.principal.displayName,
          title,
          summary,
          this.timestamp(),
          row.workspace_id,
          row.id,
          index,
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
  async apply(input: unknown) {
    const selection = secretApplyInput.parse(input);
    const { workspaceId, reviewId, fingerprint } = selection;
    const row = await this.selected(workspaceId, reviewId);
    if (row.fingerprint !== fingerprint) secretReviewConflict();
    if (row.stage === "accepted")
      return this.reviews.get({ workspaceId, reviewId });
    if (
      row.stage !== "reviewed" ||
      Date.parse(row.input_expires_at) <= this.context.now()
    )
      secretReviewConflict();
    const captured = this.reviews.captured(row);
    await this.reviews.ready(row, captured);
    const guard = this.reviews.guard(row);
    const writeId = crypto.randomUUID();
    const now = this.timestamp();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_reviews SET stage='accepted',write_id=? WHERE workspace_id=? AND id=? AND stage='reviewed'
        AND fingerprint=? AND expires_at>? AND julianday(expires_at)>julianday('now') AND input_expires_at>?
        AND (SELECT COUNT(*) FROM secret_payloads WHERE workspace_id=? AND review_id=?)=? AND ${guard.sql}`,
        )
        .bind(
          writeId,
          workspaceId,
          reviewId,
          fingerprint,
          now,
          now,
          workspaceId,
          reviewId,
          sealedSecretIndexes(captured.destinations).length,
          ...guard.values,
        ),
      this.db
        .prepare(
          `INSERT INTO secret_operations (workspace_id,review_id,accepted_at)
        SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
        )
        .bind(workspaceId, reviewId, now, workspaceId, reviewId, writeId),
      ...captured.destinations.map((_item, index) =>
        this.db
          .prepare(
            `INSERT INTO secret_receipts
        (workspace_id,review_id,destination_index,phase,write_status,observation_status,updated_at,write_id)
        SELECT ?,?,?,'pending','not-sent','unknown',?,? WHERE EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND write_id=?)`,
          )
          .bind(
            workspaceId,
            reviewId,
            index,
            now,
            writeId,
            workspaceId,
            reviewId,
            writeId,
          ),
      ),
      ...this.reviews.audit(
        row,
        writeId,
        "secrets.operation.accepted",
        "Secrets distribution accepted",
        "Recorded the exact reviewed distribution before provider effects. Each destination has its own execution receipt.",
      ),
    ]);
    if (
      !saved[0]!.meta.changes &&
      (await this.reviews.row(workspaceId, reviewId)).stage !== "accepted"
    )
      secretReviewConflict();
    return this.reviews.get({ workspaceId, reviewId });
  }

  async settleExpired(row: SecretReviewRow) {
    const guard = actorGuard(
      this.context,
      row.workspace_id,
      CAPABILITY.SECRETS,
    );
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_receipts SET phase='finished',write_status=CASE WHEN phase='submitted' THEN 'indeterminate' ELSE write_status END,
        reason='execution_interrupted',updated_at=?,revision=revision+1,write_id=? WHERE workspace_id=? AND review_id=? AND phase IN ('preparing','submitted')
        AND EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_expires_at<=?) AND ${guard.sql}`,
        )
        .bind(
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          row.workspace_id,
          row.id,
          this.timestamp(),
          ...guard.values,
        ),
      this.db
        .prepare(
          `UPDATE secret_operations SET lease_id=NULL,lease_expires_at=NULL WHERE workspace_id=? AND review_id=? AND lease_expires_at<=? AND ${guard.sql}`,
        )
        .bind(row.workspace_id, row.id, this.timestamp(), ...guard.values),
      ...this.reviews
        .captured(row)
        .destinations.flatMap((_item, index) =>
          this.audit(
            row,
            index,
            writeId,
            "Secrets execution lease expired",
            "Recorded interrupted execution without retrying a provider write. Submitted work remains indeterminate.",
          ),
        ),
    ]);
  }
  private async claim(row: SecretReviewRow, index: number) {
    const guard = this.reviews.guard(row);
    const leaseId = crypto.randomUUID();
    const now = this.timestamp();
    const leaseUntil = new Date(
      this.context.now() + SECRET_LIMITS.LEASE_MS,
    ).toISOString();
    const claimed = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_operations SET lease_id=?,lease_expires_at=? WHERE workspace_id=? AND review_id=? AND lease_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM secret_operations o WHERE o.workspace_id=? AND o.lease_expires_at>?)
        AND EXISTS (SELECT 1 FROM secret_receipts WHERE workspace_id=? AND review_id=? AND destination_index=? AND phase='pending') AND ${guard.sql}`,
        )
        .bind(
          leaseId,
          leaseUntil,
          row.workspace_id,
          row.id,
          row.workspace_id,
          now,
          row.workspace_id,
          row.id,
          index,
          ...guard.values,
        ),
      this.db
        .prepare(
          `UPDATE secret_receipts SET phase='preparing',updated_at=?,revision=revision+1,write_id=? WHERE workspace_id=? AND review_id=?
        AND destination_index=? AND phase='pending' AND EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_id=?)`,
        )
        .bind(
          now,
          leaseId,
          row.workspace_id,
          row.id,
          index,
          row.workspace_id,
          row.id,
          leaseId,
        ),
    ]);
    return claimed[0]!.meta.changes ? leaseId : null;
  }
  private async writeResult(
    row: SecretReviewRow,
    index: number,
    leaseId: string,
    result:
      | SecretWriteResult
      | { status: "not-sent"; reason: SecretReceipt["reason"] },
  ) {
    const lease = this.leaseGuard(row, leaseId);
    const writeId = crypto.randomUUID();
    const saved = await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_receipts SET phase='finished',write_status=?,reason=?,updated_at=?,revision=revision+1,write_id=?
        WHERE workspace_id=? AND review_id=? AND destination_index=? AND phase=? AND ${lease.sql}`,
        )
        .bind(
          result.status,
          result.reason,
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          index,
          result.status === "not-sent" ? "preparing" : "submitted",
          ...lease.values,
        ),
      ...this.audit(
        row,
        index,
        writeId,
        "Secrets destination receipt recorded",
        result.status === "accepted"
          ? "The provider accepted this destination write. Stored value equality and runtime usability are not observable."
          : result.status === "not-sent"
            ? "This destination was not submitted. Inspect the receipt and prepare a fresh review before retrying."
            : result.status === "rejected"
              ? "The provider rejected this destination write. No automatic retry was made."
              : "Provider acceptance is uncertain. Metadata reconciliation cannot prove which stored value is present.",
      ),
    ]);
    return Boolean(saved[0]!.meta.changes);
  }
  private async observation(
    row: SecretReviewRow,
    receipt: SecretReceipt,
    status: SecretReceipt["observationStatus"],
    metadata: SecretMetadata | null,
    leaseId?: string,
  ) {
    const guard = actorGuard(
      this.context,
      row.workspace_id,
      CAPABILITY.SECRETS,
    );
    const lease = leaseId
      ? this.leaseGuard(row, leaseId)
      : {
          sql: "NOT EXISTS (SELECT 1 FROM secret_operations WHERE workspace_id=? AND review_id=? AND lease_expires_at>?)",
          values: [row.workspace_id, row.id, this.timestamp()],
        };
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE secret_receipts SET observation_status=?,metadata_json=?,observed_at=?,updated_at=?,revision=revision+1,write_id=?
        WHERE workspace_id=? AND review_id=? AND destination_index=? AND phase='finished' AND revision=? AND ${guard.sql} AND ${lease.sql}`,
        )
        .bind(
          status,
          metadata ? JSON.stringify(metadata) : null,
          this.timestamp(),
          this.timestamp(),
          writeId,
          row.workspace_id,
          row.id,
          receipt.destinationIndex,
          receipt.revision,
          ...guard.values,
          ...lease.values,
        ),
      ...this.audit(
        row,
        receipt.destinationIndex,
        writeId,
        "Secrets destination metadata observed",
        "Recorded a bounded metadata observation independently of provider write acceptance. It does not reveal or compare stored values.",
      ),
      this.db
        .prepare(
          `DELETE FROM secret_payloads WHERE workspace_id=? AND review_id=? AND destination_index=? AND EXISTS
        (SELECT 1 FROM secret_receipts WHERE workspace_id=? AND review_id=? AND destination_index=? AND write_id=? AND write_status='accepted' AND observation_status='present')`,
        )
        .bind(
          row.workspace_id,
          row.id,
          receipt.destinationIndex,
          row.workspace_id,
          row.id,
          receipt.destinationIndex,
          writeId,
        ),
    ]);
  }
  async run(input: unknown) {
    return this.execute(input);
  }
  async supply(
    request: Request,
    input: unknown,
  ): Promise<SecretTransientReceipt> {
    const selection = transientSelectionSchema.parse(input);
    const { workspaceId, reviewId, destinationIndex } = selection;
    const row = await this.selected(workspaceId, reviewId);
    const fingerprint = request.headers.get("If-Match");
    if (
      row.stage !== "accepted" ||
      !fingerprint ||
      row.fingerprint !== fingerprint
    )
      secretReviewConflict();
    await this.settleExpired(row);
    if ((await this.receipt(row, destinationIndex)).phase !== "pending")
      return {
        inputConsumed: false,
        review: await this.reviews.get({ workspaceId, reviewId }),
      };
    const captured = this.reviews.captured(row);
    const item = captured.destinations[destinationIndex]!;
    if (item.snapshot.input.kind !== "private-transient")
      throw new DomainError(
        "secret_input_unsupported",
        "This destination requires provider-sealed input, not transient execution input. No input was consumed.",
        409,
      );
    const providers = await this.reviews.ready(row, captured);
    if (
      await this.db
        .prepare(
          "SELECT 1 FROM secret_operations WHERE workspace_id=? AND lease_expires_at>? LIMIT 1",
        )
        .bind(workspaceId, this.timestamp())
        .first()
    )
      throw new DomainError(
        "secret_execution_busy",
        "Another Secrets step holds the workspace execution lease. Inspect its receipt before supplying input. No input was consumed.",
        409,
      );
    const parsed = transientInputSchema.safeParse(
      await readSecretInput(request, {
        bytes: CLOUDFLARE_SECRET_LIMITS.TRANSIENT_INPUT_BYTES,
        timeoutMs: SECRET_LIMITS.INPUT_READ_MS,
      }),
    );
    if (
      !parsed.success ||
      !providers[destinationIndex]!.validateTransientInput?.(
        item.snapshot,
        parsed.data.value,
      )
    )
      privateInputError();
    try {
      return {
        inputConsumed: true,
        review: await this.execute(
          { ...selection, fingerprint },
          parsed.data.value,
        ),
      };
    } finally {
      parsed.data.value = "";
    }
  }
  private async execute(input: unknown, transientValue?: string) {
    const { workspaceId, reviewId, fingerprint, destinationIndex } =
      secretRunInput.parse(input);
    const row = await this.selected(workspaceId, reviewId);
    if (row.stage !== "accepted" || row.fingerprint !== fingerprint)
      secretReviewConflict();
    await this.settleExpired(row);
    const receipt = await this.receipt(row, destinationIndex);
    if (receipt.phase !== "pending")
      return this.reviews.get({ workspaceId, reviewId });
    const item = this.reviews.captured(row).destinations[destinationIndex]!;
    if (
      item.snapshot.input.kind === "private-transient" &&
      transientValue === undefined
    )
      throw new DomainError(
        "secret_transient_input_required",
        "This accepted destination needs a value through dedicated private input. Nothing was submitted; its receipt remains pending.",
        409,
      );
    const authorized = await this.reviews.ready(row);
    if (
      transientValue !== undefined &&
      !authorized[destinationIndex]!.validateTransientInput?.(
        item.snapshot,
        transientValue,
      )
    )
      privateInputError();
    const leaseId = await this.claim(row, destinationIndex);
    if (!leaseId) return this.reviews.get({ workspaceId, reviewId });
    let submitted = false;
    let recorded = false;
    let refusal: SecretReceipt["reason"] = "authority_changed";
    try {
      const providers = await this.reviews.ready(row);
      const provider = providers[destinationIndex]!;
      const current = secretTargetSnapshotSchema.parse(
        await provider.prepare(
          item.resource,
          item.snapshot.scope,
          item.snapshot.name,
        ),
      );
      if (JSON.stringify(current) !== JSON.stringify(item.snapshot)) {
        refusal = "preflight_changed";
        throw new Error("Preflight changed");
      }
      const inputRow =
        item.snapshot.input.kind === "provider-sealed"
          ? await this.db
              .prepare(
                "SELECT ciphertext FROM secret_payloads WHERE workspace_id=? AND review_id=? AND destination_index=?",
              )
              .bind(workspaceId, reviewId, destinationIndex)
              .first<{ ciphertext: string }>()
          : null;
      if (
        Date.parse(row.input_expires_at) <= this.context.now() ||
        (item.snapshot.input.kind === "provider-sealed"
          ? !inputRow ||
            !provider.validateSealedInput(item.snapshot, inputRow.ciphertext)
          : transientValue === undefined ||
            !provider.validateTransientInput?.(item.snapshot, transientValue))
      ) {
        refusal = "input_expired";
        throw new Error("Input expired");
      }
      await this.reviews.ready(row);
      const authority = this.reviews.guard(row);
      const lease = this.leaseGuard(
        row,
        leaseId,
        SECRET_LIMITS.SEND_RESERVE_MS,
      );
      const marked = await this.db
        .prepare(
          `UPDATE secret_receipts SET phase='submitted',submitted_at=?,updated_at=?,revision=revision+1
        WHERE workspace_id=? AND review_id=? AND destination_index=? AND phase='preparing' AND ${authority.sql} AND ${lease.sql}
        AND EXISTS (SELECT 1 FROM secret_reviews WHERE workspace_id=? AND id=? AND expires_at>? AND julianday(expires_at)>julianday('now') AND input_expires_at>?)`,
        )
        .bind(
          this.timestamp(),
          this.timestamp(),
          workspaceId,
          reviewId,
          destinationIndex,
          ...authority.values,
          ...lease.values,
          workspaceId,
          reviewId,
          this.timestamp(),
          this.timestamp(),
        )
        .run();
      if (!marked.meta.changes) throw new Error("Execution authority changed");
      submitted = true;
      const result = secretWriteResultSchema.parse(
        item.snapshot.input.kind === "provider-sealed"
          ? await provider.writeSealed(
              item.resource,
              item.snapshot,
              inputRow!.ciphertext,
            )
          : await provider.writeTransient!(
              item.resource,
              item.snapshot,
              transientValue!,
            ),
      );
      recorded = await this.writeResult(row, destinationIndex, leaseId, result);
      if (recorded && result.status === "accepted") {
        const written = await this.receipt(row, destinationIndex);
        try {
          await this.selected(workspaceId, reviewId);
          const metadata = await provider.observe(item.resource, item.snapshot);
          await this.observation(
            row,
            written,
            metadata ? "present" : "absent",
            metadata,
            leaseId,
          );
        } catch {
          await this.observation(row, written, "unavailable", null, leaseId);
        }
      }
    } catch {
      if (!recorded)
        await this.writeResult(
          row,
          destinationIndex,
          leaseId,
          submitted
            ? { status: "indeterminate", reason: "provider_result_uncertain" }
            : { status: "not-sent", reason: refusal },
        );
    } finally {
      await this.release(row, leaseId);
    }
    return this.reviews.get({ workspaceId, reviewId });
  }
  private async recoveryProvider(
    workspaceId: string,
    item: CapturedSecretDestination,
  ) {
    const provider = await secretAdapter(item.providerKind).connect(
      this.context,
      workspaceId,
      item.providerRef,
    );
    if (provider.identity !== item.providerIdentity)
      throw new DomainError(
        "secret_recovery_authority",
        "The original Secrets provider identity is unavailable. Restore its scoped recovery credential before reconciling.",
        409,
      );
    await provider.checkResources([item.resource]);
    return provider;
  }
  async reconcile(input: unknown) {
    const { workspaceId, reviewId, destinationIndex } =
      secretStepInput.parse(input);
    const row = await this.selected(workspaceId, reviewId);
    if (row.stage !== "accepted") secretReviewConflict();
    await this.settleExpired(row);
    const receipt = await this.receipt(row, destinationIndex);
    if (receipt.phase !== "finished")
      return this.reviews.get({ workspaceId, reviewId });
    const item = this.reviews.captured(row).destinations[destinationIndex]!;
    const provider = await this.recoveryProvider(workspaceId, item);
    let metadata: SecretMetadata | null = null;
    let status: SecretReceipt["observationStatus"] = "unavailable";
    try {
      metadata = await provider.observe(item.resource, item.snapshot);
      status = metadata ? "present" : "absent";
    } catch {
      // Read failures do not overwrite the recorded provider acceptance
    }
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    await this.observation(row, receipt, status, metadata);
    return this.reviews.get({ workspaceId, reviewId });
  }
}
