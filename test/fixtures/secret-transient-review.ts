import type { SecretReview } from "../../shared/secrets";

export const TRANSIENT_VALUE =
  "\ufeffsynthetic-transient-\u03bb\r\nlast line\n";
export const TRANSIENT_FINGERPRINT = "sha256:" + "a".repeat(64);
export function transientReview(
  extra: Partial<SecretReview> = {},
): SecretReview {
  const now = new Date().toISOString();
  return {
    id: "review",
    stage: "accepted",
    draftFingerprint: TRANSIENT_FINGERPRINT,
    fingerprint: TRANSIENT_FINGERPRINT,
    actorMatches: true,
    createdAt: now,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    inputExpiresAt: new Date(Date.now() + 60000).toISOString(),
    inputPresent: false,
    source: null,
    recovery: null,
    destinations: [
      {
        destination: {
          connectionId: "workers",
          connectionRevision: 1,
          target: { resourceId: "worker", scope: { kind: "worker" } },
          name: "Token",
        },
        providerKind: "cloudflare-workers",
        connectionName: "Selected Worker",
        resource: { id: "worker", label: "selected", repositoryIds: [] },
        snapshot: {
          name: "Token",
          scope: { kind: "worker" },
          resourceIdentity: "a".repeat(32) + "/" + "b".repeat(32),
          scopeIdentity: null,
          resourceRevision:
            '["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]',
          before: null,
          input: { kind: "private-transient", maxValueBytes: 5120 },
          activation: "worker-deployment",
          workerDeployment: {
            accountId: "a".repeat(32),
            workerName: "selected",
            deploymentId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    ],
    operation: {
      acceptedAt: now,
      leaseExpiresAt: null,
      leaseExpired: false,
      receipts: [
        {
          destinationIndex: 0,
          phase: "pending",
          writeStatus: "not-sent",
          reason: null,
          observationStatus: "unknown",
          metadata: null,
          observedAt: null,
          submittedAt: null,
          updatedAt: now,
          revision: 1,
          recoveryReviewId: null,
        },
      ],
    },
    ...extra,
  };
}
export function transientCompleted() {
  const review = transientReview();
  review.operation!.receipts[0] = {
    ...review.operation!.receipts[0]!,
    phase: "finished",
    writeStatus: "accepted",
    observationStatus: "present",
    submittedAt: review.createdAt,
    observedAt: review.createdAt,
    metadata: {
      name: "Token",
      createdAt: null,
      updatedAt: null,
      version: "opaque-worker-deployment",
    },
    revision: 4,
  };
  return review;
}
