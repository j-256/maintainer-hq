import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import type { SecretReview } from "../shared/secrets";
import type { SecretCleanupReview } from "../shared/secret-cleanup";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import {
  SecretError,
  SecretPagination,
  SecretTargetFacts,
  SecretTime,
  SecretReceiptFacts,
} from "./secret-components";

type CleanupHistory = {
  items: {
    id: string;
    phase: string;
    writeStatus: string;
    observationStatus: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
};
export function SecretCleanupPanel({
  snapshot,
  distribution,
  busy,
  onBusyChange: setBusy,
  now,
}: {
  snapshot: Snapshot;
  distribution: SecretReview;
  busy: boolean;
  onBusyChange: (value: boolean) => void;
  now: number;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const cleanupId = params.get("cleanup");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const [error, setError] = useState<unknown>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);
  const attempt = useRef<string | null>(null);
  const canWrite = snapshot.capabilities.includes(CAPABILITY.SECRETS);
  const history = useQuery({
    queryKey: [
      "secrets",
      workspaceId,
      "cleanup-history",
      distribution.id,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<CleanupHistory>(
        "secrets_cleanup_history",
        {
          workspaceId,
          reviewId: distribution.id,
          ...(cursor ? { before: cursor } : {}),
        },
        signal,
      ),
    retry: false,
  });
  const query = useQuery({
    queryKey: ["secrets", workspaceId, "cleanup", cleanupId],
    queryFn: ({ signal }) =>
      command<SecretCleanupReview>(
        "secrets_cleanup_review",
        { workspaceId, cleanupId },
        signal,
      ),
    enabled: Boolean(cleanupId),
    retry: false,
  });
  const review =
    query.data?.reviewId === distribution.id ? query.data : undefined;
  const expired = review ? Date.parse(review.expiresAt) <= now : false;
  function select(id: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("cleanup", id);
      return next;
    });
  }
  function update(value: SecretCleanupReview) {
    client.setQueryData(["secrets", workspaceId, "cleanup", value.id], value);
    void client.invalidateQueries({
      queryKey: ["secrets", workspaceId, "cleanup-history", distribution.id],
    });
  }
  async function plan() {
    if (busy || !acknowledged || !distribution.fingerprint) return;
    setBusy(true);
    setError(null);
    try {
      attempt.current ??= crypto.randomUUID();
      const value = await command<SecretCleanupReview>("secrets_cleanup_plan", {
        workspaceId,
        reviewId: distribution.id,
        fingerprint: distribution.fingerprint,
        cleanupId: attempt.current,
        acknowledgeNonAtomicMove: true,
      });
      update(value);
      select(value.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function apply(reconcile = false) {
    if (!review || busy || (!reconcile && !confirmAcknowledged)) return;
    setBusy(true);
    setError(null);
    setConfirm(false);
    try {
      update(
        await command<SecretCleanupReview>(
          reconcile ? "secrets_cleanup_reconcile" : "secrets_cleanup_apply",
          {
            workspaceId,
            cleanupId: review.id,
            ...(reconcile ? {} : { fingerprint: review.fingerprint }),
          },
        ),
      );
    } catch (failure) {
      setError(failure);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="secret-panel" aria-labelledby="source-removal-title">
      <h3 id="source-removal-title">Optional source removal</h3>
      <p className="hook-muted">
        All destination writes must be accepted with fresh, unchanged metadata,
        including any reviewed recovery. The original source must also be
        unchanged. A separate review controls one deletion; this is not an
        atomic move or a comparison of values.
      </p>
      {canWrite ? (
        <>
          <label className="secret-checkbox">
            <Checkbox
              checked={acknowledged}
              disabled={busy}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            <span>
              I understand removal is non-atomic and the source value cannot be
              recovered from GitHub.
            </span>
          </label>
          <div className="secret-actions">
            <Button
              variant="outline"
              disabled={busy || !acknowledged}
              onClick={() => void plan()}
            >
              {busy
                ? "Checking source removal..."
                : "Prepare source-removal review"}
            </Button>
            {attempt.current ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  attempt.current = null;
                  setAcknowledged(false);
                }}
              >
                Start a separate removal review
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <SecretError error={error} /> : null}
      {query.error ? (
        <>
          <SecretError error={query.error} />
          <Button
            variant="outline"
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Reload removal receipt
          </Button>
        </>
      ) : null}
      {cleanupId && query.isPending ? (
        <p role="status">Loading removal review...</p>
      ) : null}
      {query.data && !review ? (
        <p role="alert">
          This removal review belongs to a different distribution.
        </p>
      ) : null}
      {review ? (
        <div className="secret-form">
          <SecretTargetFacts value={review.source} />
          <p className="hook-muted">
            Removal review expires <SecretTime value={review.expiresAt} />.
          </p>
          {review.receipt.phase === "reviewed" ? (
            <p>Ready for separate confirmation. No deletion has been sent.</p>
          ) : (
            <SecretReceiptFacts
              receipt={{ ...review.receipt, phase: review.receipt.phase }}
            />
          )}
          {review.receipt.writeStatus === "indeterminate" ? (
            <p className="hook-notice">
              Acceptance is uncertain. Even a later absent-name observation
              cannot prove whether this request succeeded. Deletion is not
              automatically retried.
            </p>
          ) : null}
          {expired ? (
            <p className="hook-notice">
              This removal review expired. Its receipt can still be read and
              reconciled.
            </p>
          ) : null}
          <div className="secret-actions">
            {review.receipt.phase === "reviewed" ? (
              <Button
                variant="destructive"
                disabled={busy || !canWrite || !review.actorMatches || expired}
                onClick={() => {
                  setConfirmAcknowledged(false);
                  setConfirm(true);
                }}
              >
                Review source deletion
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !canWrite ||
                  !review.actorMatches ||
                  Boolean(
                    review.receipt.leaseExpiresAt &&
                    Date.parse(review.receipt.leaseExpiresAt) > now,
                  )
                }
                onClick={() => void apply(true)}
              >
                Check source metadata
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || query.isFetching}
              onClick={() => void query.refetch()}
            >
              Reload removal receipt
            </Button>
          </div>
        </div>
      ) : null}
      <details>
        <summary>Source-removal history</summary>
        {history.error ? <SecretError error={history.error} /> : null}
        {history.isPending ? (
          <p role="status">Loading removal history...</p>
        ) : null}
        <div className="secret-list">
          {history.data?.items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>
                  {item.phase === "reviewed"
                    ? "Awaiting review"
                    : item.writeStatus.replaceAll("-", " ")}
                </strong>
                <p className="hook-muted">
                  <SecretTime value={item.createdAt} />
                </p>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => select(item.id)}
              >
                Open removal review
              </Button>
            </article>
          ))}
        </div>
        {history.data && !history.data.items.length ? (
          <p className="hook-muted">
            No removal has been reviewed for this distribution.
          </p>
        ) : null}
        <SecretPagination
          page={cursors.length}
          previous={
            cursors.length > 1
              ? () => setCursors((items) => items.slice(0, -1))
              : undefined
          }
          next={
            history.data?.nextCursor
              ? () =>
                  setCursors((items) => [...items, history.data!.nextCursor])
              : undefined
          }
          busy={busy || history.isFetching}
          label="Source-removal history pages"
        />
      </details>
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <AlertDialogContent className="secret-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this original source?</AlertDialogTitle>
            <AlertDialogDescription>
              HQ will recheck the reviewed source and destinations, then submit
              one deletion. Another provider client can race these checks. There
              is no automatic retry or value recovery.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review ? (
            <>
              <SecretTargetFacts value={review.source} />
              <p>Destination receipts checked for this review:</p>
              <div className="secret-list">
                {review.destinations.map((item) => (
                  <article key={item.originalDestinationIndex}>
                    <SecretTargetFacts value={item.destination} />
                  </article>
                ))}
              </div>
            </>
          ) : null}
          <label className="secret-checkbox">
            <Checkbox
              checked={confirmAcknowledged}
              onCheckedChange={(value) =>
                setConfirmAcknowledged(value === true)
              }
            />
            <span>
              Delete this source after the fresh checks. I have an independent
              trusted source for any needed recovery.
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep source
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy || !confirmAcknowledged}
              onClick={() => void apply()}
            >
              Confirm source deletion
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
