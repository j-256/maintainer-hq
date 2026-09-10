import {
  secretOperationSchema,
  secretReceiptSchema,
  type SecretReceipt,
} from "../shared/secrets";

type ReceiptRow = Omit<SecretReceipt, "metadata"> & {
  metadata_json: string | null;
};
export async function readSecretReceipts(
  db: D1Database,
  workspaceId: string,
  reviewId: string,
) {
  const rows = await db
    .prepare(
      `SELECT destination_index AS destinationIndex,phase,write_status AS writeStatus,reason,
    observation_status AS observationStatus,metadata_json,observed_at AS observedAt,submitted_at AS submittedAt,
    updated_at AS updatedAt,revision,
    (SELECT child_review_id FROM secret_recovery_links l WHERE l.workspace_id=secret_receipts.workspace_id
      AND l.parent_review_id=secret_receipts.review_id AND l.parent_destination_index=secret_receipts.destination_index) AS recoveryReviewId
    FROM secret_receipts WHERE workspace_id=? AND review_id=? ORDER BY destination_index`,
    )
    .bind(workspaceId, reviewId)
    .all<ReceiptRow>();
  return rows.results.map(({ metadata_json, ...row }) =>
    secretReceiptSchema.parse({
      ...row,
      metadata: metadata_json === null ? null : JSON.parse(metadata_json),
    }),
  );
}
export async function readSecretOperation(
  db: D1Database,
  workspaceId: string,
  reviewId: string,
  now: number,
) {
  const row = await db
    .prepare(
      "SELECT accepted_at AS acceptedAt,lease_expires_at AS leaseExpiresAt FROM secret_operations WHERE workspace_id=? AND review_id=?",
    )
    .bind(workspaceId, reviewId)
    .first<{ acceptedAt: string; leaseExpiresAt: string | null }>();
  if (!row) return null;
  return secretOperationSchema.parse({
    ...row,
    leaseExpired:
      row.leaseExpiresAt !== null && Date.parse(row.leaseExpiresAt) <= now,
    receipts: await readSecretReceipts(db, workspaceId, reviewId),
  });
}
