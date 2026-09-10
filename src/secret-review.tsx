import { useEffect, useRef, useState } from "react";
import type { Location } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "../shared/domain";
import { CAPABILITY } from "../shared/domain";
import {
  sealedSecretIndexes,
  secretStagedInputReady,
  type SecretDestination,
  type SecretReview,
} from "../shared/secrets";
import { command } from "./lib/api";
import {
  supplyBrowserSecret,
  supplyBrowserTransientSecret,
} from "./lib/secret-input";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Textarea } from "./components/ui/textarea";
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
import { useCloseGuard } from "./source-editor";
import {
  SecretError,
  SecretTargetFacts,
  SecretTime,
  SecretReceiptFacts,
  useSecretClock,
} from "./secret-components";
import { SecretCleanupPanel } from "./secret-cleanup";

function sameSecretReview(current: Location, next: Location) {
  if (current.pathname !== next.pathname) return false;
  const currentParams = new URLSearchParams(current.search);
  const nextParams = new URLSearchParams(next.search);
  currentParams.delete("cleanup");
  nextParams.delete("cleanup");
  return currentParams.toString() === nextParams.toString();
}

export function SecretReviewPanel({
  snapshot,
  reviewId,
  onClose,
  onReview,
  onNewDraft,
}: {
  snapshot: Snapshot;
  reviewId: string;
  onClose: () => void;
  onReview: (id: string) => void;
  onNewDraft: (
    destinations: SecretDestination[],
    source?: SecretDestination,
  ) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const now = useSecretClock();
  const client = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const confirmed = useRef(false);
  const valueInput = useRef<HTMLTextAreaElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [valueSealed, setValueSealed] = useState(false);
  const [operationBusy, setBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const busy = operationBusy || cleanupBusy;
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<"distribute" | number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const recoveryIds = useRef(new Map<number, string>());
  const guard = useCloseGuard(hasValue || busy, onClose, sameSecretReview);
  const key = ["secrets", workspaceId, "review", reviewId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<SecretReview>(
        "secrets_review",
        { workspaceId, reviewId },
        signal,
      ),
    retry: false,
  });
  const data = query.data;
  useEffect(() => {
    heading.current?.focus();
  }, [reviewId]);
  const canWrite =
    snapshot.capabilities.includes(CAPABILITY.SECRETS) &&
    Boolean(data?.actorMatches);
  const expired = data ? Date.parse(data.expiresAt) <= now : false;
  const leaseActive = Boolean(
    data?.operation?.leaseExpiresAt &&
    Date.parse(data.operation.leaseExpiresAt) > now,
  );
  const pending =
    data?.operation?.receipts.filter((item) => item.phase === "pending") ?? [];
  const hasSealed = Boolean(
    data && sealedSecretIndexes(data.destinations).length,
  );
  const needsTransient = Boolean(
    data?.destinations.some(
      (item, index) =>
        item.snapshot.input.kind === "private-transient" &&
        (!data.operation ||
          data.operation.receipts[index]?.phase === "pending"),
    ),
  );
  const hasDeployment = Boolean(
    data?.destinations.some(
      (item) => item.snapshot.activation === "worker-deployment",
    ),
  );
  function clearValue() {
    if (valueInput.current) valueInput.current.value = "";
    setHasValue(false);
    setValueSealed(false);
  }
  function update(value: SecretReview) {
    client.setQueryData(key, value);
    void client.invalidateQueries({
      queryKey: ["secrets", workspaceId, "history"],
    });
  }
  async function inputValue() {
    if (busy || !data) return;
    setBusy(true);
    setError(null);
    let keepValue = false;
    let readValue = false;
    try {
      update(
        await supplyBrowserSecret(workspaceId, data, () => {
          readValue = true;
          return new TextEncoder().encode(valueInput.current?.value ?? "");
        }),
      );
      keepValue = needsTransient && readValue;
      if (keepValue) setValueSealed(true);
    } catch (failure) {
      setError(failure);
      await query.refetch();
    } finally {
      if (!keepValue) clearValue();
      setBusy(false);
      heading.current?.focus();
    }
  }
  async function run() {
    if (busy || !data?.fingerprint || !acknowledged) return;
    setBusy(true);
    setError(null);
    setConfirm(null);
    let transient: Uint8Array | undefined;
    try {
      if (needsTransient) {
        const text = valueInput.current?.value ?? "";
        transient = new TextEncoder().encode(text);
        if (
          !transient.byteLength ||
          /[\uD800-\uDFFF]/u.test(text) ||
          data.destinations.some(
            (item) => transient!.byteLength > item.snapshot.input.maxValueBytes,
          )
        )
          throw new Error(
            "Supply valid nonempty text within every destination's byte limit before confirming.",
          );
      }
      clearValue();
      let current =
        data.stage === "accepted"
          ? data
          : await command<SecretReview>("secrets_apply", {
              workspaceId,
              reviewId,
              fingerprint: data.fingerprint,
            });
      update(current);
      for (const receipt of current.operation?.receipts ?? []) {
        if (receipt.phase !== "pending") continue;
        const destination = current.destinations[receipt.destinationIndex]!;
        current =
          destination.snapshot.input.kind === "private-transient"
            ? (
                await supplyBrowserTransientSecret(
                  workspaceId,
                  current,
                  receipt.destinationIndex,
                  () => transient!.slice(),
                )
              ).review
            : await command<SecretReview>("secrets_run", {
                workspaceId,
                reviewId,
                fingerprint: data.fingerprint,
                destinationIndex: receipt.destinationIndex,
              });
        update(current);
        if (
          current.operation?.receipts[receipt.destinationIndex]?.phase !==
          "finished"
        )
          break;
      }
    } catch (failure) {
      setError(failure);
      await query.refetch();
    } finally {
      transient?.fill(0);
      clearValue();
      setBusy(false);
      heading.current?.focus();
    }
  }
  async function reconcile(destinationIndex: number) {
    setBusy(true);
    setError(null);
    try {
      update(
        await command<SecretReview>("secrets_reconcile", {
          workspaceId,
          reviewId,
          destinationIndex,
        }),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  }
  async function recover(destinationIndex: number) {
    if (!data?.fingerprint || busy || !acknowledged) return;
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      if (!recoveryIds.current.has(destinationIndex))
        recoveryIds.current.set(destinationIndex, crypto.randomUUID());
      const review = await command<SecretReview>("secrets_recovery_plan", {
        workspaceId,
        reviewId,
        fingerprint: data.fingerprint,
        destinationIndex,
        newReviewId: recoveryIds.current.get(destinationIndex),
        acknowledgePossibleOverwrite: true,
      });
      guard.saved();
      onReview(review.id);
    } catch (failure) {
      setError(failure);
      await query.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError(null);
    clearValue();
    try {
      update(
        await command<SecretReview>("secrets_cancel", {
          workspaceId,
          reviewId,
        }),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  }
  return (
    <section className="hook-section" aria-labelledby="secret-review-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="secret-review-title" ref={heading} tabIndex={-1}>
            {data?.operation
              ? "Distribution receipts"
              : data?.recovery
                ? "Retained-input recovery review"
                : "Review secret distribution"}
          </h2>
          <p>
            Exact destinations, provider acceptance, and independent metadata
            evidence.
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={guard.requestClose}>
          Back to Secrets
        </Button>
      </div>
      {query.isPending ? <p role="status">Loading secret review...</p> : null}
      {error || query.error ? (
        <>
          <SecretError error={error ?? query.error} />
          <p className="hook-notice">
            An interrupted request may have reached HQ or the provider. Reload
            this receipt before continuing. Submitted work is never
            automatically retried.
          </p>
          <Button
            variant="outline"
            disabled={busy || query.isFetching}
            onClick={async () => {
              setError(null);
              await query.refetch();
              heading.current?.focus();
            }}
          >
            Reload receipt
          </Button>
        </>
      ) : null}
      {data ? (
        <>
          <p className="hook-muted">
            Prepared <SecretTime value={data.createdAt} />. Review expires{" "}
            <SecretTime value={data.expiresAt} />.
          </p>
          {!data.actorMatches ? (
            <p className="hook-notice">
              This review belongs to another actor or credential. You can
              inspect its metadata; only its original actor may execute it.
            </p>
          ) : null}
          {expired ? (
            <p className="hook-notice">
              This review has expired. Receipts remain readable, and metadata
              can still be reconciled. New writes need a fresh review.
            </p>
          ) : null}
          {data.recovery ? (
            <p className="hook-notice">
              This review reuses the exact retained sealed input from an earlier
              destination. It does not extend input expiry or change the
              parent's uncertain outcome.{" "}
              <Button
                variant="link"
                disabled={busy}
                onClick={() => onReview(data.recovery!.reviewId)}
              >
                Open parent receipt
              </Button>
            </p>
          ) : null}
          {data.source ? (
            <section className="secret-panel">
              <h3>Source kept in place</h3>
              <SecretTargetFacts value={data.source} />
              <p className="hook-muted">
                Distribution does not remove this source or read its value.
                Removal requires a separate review after all destinations are
                confirmed.
              </p>
            </section>
          ) : null}
          <div className="secret-list">
            {data.destinations.map((destination, index) => {
              const receipt = data.operation?.receipts[index];
              return (
                <article key={index}>
                  <div className="secret-form">
                    <SecretTargetFacts value={destination} />
                    {receipt ? (
                      <SecretReceiptFacts receipt={receipt} />
                    ) : (
                      <Badge variant="outline">
                        {destination.snapshot.before
                          ? "Will replace existing name"
                          : "Will create name"}
                      </Badge>
                    )}
                  </div>
                  {receipt ? (
                    <div className="secret-actions">
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          !canWrite ||
                          receipt.phase === "pending" ||
                          leaseActive
                        }
                        onClick={() => void reconcile(index)}
                      >
                        Check metadata {index + 1}
                      </Button>
                      {receipt.recoveryReviewId ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => onReview(receipt.recoveryReviewId!)}
                        >
                          Open recovery {index + 1}
                        </Button>
                      ) : receipt.phase === "finished" &&
                        !(
                          receipt.writeStatus === "accepted" &&
                          receipt.observationStatus === "present"
                        ) &&
                        destination.snapshot.input.kind ===
                          "provider-sealed" ? (
                        <Button
                          variant="outline"
                          disabled={
                            busy ||
                            !canWrite ||
                            Date.parse(data.inputExpiresAt) <= now
                          }
                          onClick={() => {
                            setAcknowledged(false);
                            setConfirm(index);
                          }}
                        >
                          Review recovery {index + 1}
                        </Button>
                      ) : null}
                      {receipt.phase === "finished" &&
                      destination.snapshot.input.kind === "private-transient" &&
                      !(
                        receipt.writeStatus === "accepted" &&
                        receipt.observationStatus === "present"
                      ) ? (
                        <p className="hook-muted">
                          No value is retained for Cloudflare recovery. Inspect
                          this receipt before deliberately starting a new
                          supplied-value distribution.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          <p className="hook-notice">
            Accepted writes and observed names do not prove stored value
            equality or runtime usability. Providers do not reveal these stored
            values. Other provider clients can race these operations.
          </p>
          {hasDeployment ? (
            <p className="hook-notice">
              Each Cloudflare write creates and immediately deploys a new Worker
              version, even if the supplied value is unchanged. HQ requires one
              fully serving version and rechecks its deployment before
              submission; Cloudflare provides no compare-and-swap guarantee.
            </p>
          ) : null}
          {(data.stage === "awaiting-input" ||
            (needsTransient && data.stage !== "cancelled")) &&
          canWrite &&
          !expired ? (
            <form
              className="secret-panel"
              onSubmit={(event) => {
                event.preventDefault();
                if (data.stage === "awaiting-input") void inputValue();
              }}
            >
              <h3>Supply the value privately</h3>
              <p className="hook-muted">
                {hasSealed
                  ? "This browser seals the value for the reviewed GitHub public keys. "
                  : ""}
                {needsTransient
                  ? "Cloudflare receives the value only when you confirm a pending destination write. It is not staged or retained by HQ. "
                  : ""}
                The value is visible only in this input while editing and is
                cleared after an execution attempt. It is not saved in browser
                storage. Spaces and trailing newlines are kept; browser text
                input uses LF line endings. Use private-file input in the CLI
                when exact original file bytes matter.
              </p>
              <label className="hook-field">
                Supplied value (visible while editing)
                <Textarea
                  ref={valueInput}
                  className="secret-value"
                  disabled={busy}
                  readOnly={valueSealed}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  onChange={(event) =>
                    setHasValue(event.target.value.length > 0)
                  }
                />
              </label>
              {data.stage === "awaiting-input" ? (
                <Button type="submit" disabled={busy || !hasValue}>
                  {busy
                    ? "Sealing and submitting..."
                    : "Seal value and prepare final review"}
                </Button>
              ) : null}
              {valueSealed ? (
                <p className="hook-muted">
                  Sealed for GitHub. This unchanged value remains only in this
                  field until you confirm Cloudflare execution or leave. Cancel
                  and prepare a new review to change it.
                </p>
              ) : needsTransient &&
                hasSealed &&
                data.stage !== "awaiting-input" ? (
                <p className="hook-notice">
                  Re-enter the intended Cloudflare value. HQ cannot compare it
                  with the GitHub input already sealed in this review. If
                  unsure, cancel this unaccepted review or inspect accepted
                  receipts before starting a new distribution.
                </p>
              ) : null}
              {hasSealed ? (
                <p className="hook-muted">
                  Sealed staging expires{" "}
                  <SecretTime value={data.inputExpiresAt} />. HQ cannot decrypt
                  this GitHub-sealed value.
                </p>
              ) : null}
            </form>
          ) : null}
          {data.stage === "reviewed" && !secretStagedInputReady(data) ? (
            <p className="hook-notice">
              The reviewed input is unavailable or expired. Do not replace it in
              this review. Start a deliberate new distribution.
            </p>
          ) : null}
          {data.stage === "cancelled" ? (
            <p className="hook-notice">
              This review was cancelled. It cannot send provider writes.
            </p>
          ) : null}
          {busy ? (
            <p role="status">
              Processing the selected operation. Receipts update as each
              destination completes.
            </p>
          ) : null}
          {data.operation?.leaseExpired ? (
            <p className="hook-notice">
              Execution was interrupted. Check metadata to settle the expired
              lease without replaying a submitted request.
            </p>
          ) : null}
          <div className="secret-actions">
            {(data.stage === "reviewed" && secretStagedInputReady(data)) ||
            pending.length ? (
              <Button
                disabled={
                  busy ||
                  !canWrite ||
                  expired ||
                  leaseActive ||
                  (needsTransient && !hasValue)
                }
                onClick={() => {
                  setAcknowledged(false);
                  setConfirm("distribute");
                }}
              >
                {data.operation
                  ? "Review pending destinations"
                  : "Review and confirm distribution"}
              </Button>
            ) : null}
            {!data.operation && data.stage !== "cancelled" ? (
              <Button
                variant="outline"
                disabled={busy || !canWrite}
                onClick={() => void cancel()}
              >
                Cancel review and discard staged input
              </Button>
            ) : null}
            {data.operation || data.stage === "cancelled" || expired ? (
              <Button
                variant="outline"
                disabled={
                  busy || !snapshot.capabilities.includes(CAPABILITY.SECRETS)
                }
                onClick={() => {
                  guard.saved();
                  onNewDraft(
                    data.destinations.map((item) => item.destination),
                    data.source?.destination,
                  );
                }}
              >
                Start a new supplied-value distribution
              </Button>
            ) : null}
          </div>
          {data.operation && data.source && !data.recovery ? (
            <SecretCleanupPanel
              snapshot={snapshot}
              distribution={data}
              busy={busy}
              onBusyChange={setCleanupBusy}
              now={now}
            />
          ) : null}
        </>
      ) : null}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent
          className="secret-dialog"
          onOpenAutoFocus={() => {
            confirmationTrigger.current =
              document.activeElement as HTMLElement;
            confirmed.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = confirmationTrigger.current;
            (!confirmed.current &&
            trigger?.isConnected &&
            !trigger.matches(":disabled")
              ? trigger
              : heading.current
            )?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "distribute"
                ? "Confirm these destination writes?"
                : "Prepare a retained-input recovery?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "distribute"
                ? "HQ will persist intent, recheck state, and submit only pending destinations. Existing names may be overwritten. The source is not removed."
                : "The exact retained input may be written again after another review. An earlier uncertain write may already have succeeded. This step prepares a review only."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === "distribute" && hasDeployment ? (
            <p className="hook-notice">
              Cloudflare changes activate a new Worker deployment immediately.
              The serving deployment shown below is checked again, but another
              provider client can still race the request.
            </p>
          ) : null}
          <div className="secret-list">
            {data?.destinations
              .filter((_item, index) =>
                confirm === "distribute"
                  ? !data.operation ||
                    data.operation.receipts[index]?.phase === "pending"
                  : index === confirm,
              )
              .map((item, index) => (
                <article key={index}>
                  <SecretTargetFacts value={item} />
                </article>
              ))}
          </div>
          <label className="secret-checkbox">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
            />
            <span>
              I understand this may overwrite existing values, cannot verify
              their equality, and is not an atomic transfer.
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep reviewing
            </AlertDialogCancel>
            <Button
              disabled={busy || !acknowledged}
              onClick={() => {
                confirmed.current = true;
                if (confirm === "distribute") void run();
                else if (typeof confirm === "number") void recover(confirm);
              }}
            >
              {confirm === "distribute"
                ? "Confirm distribution"
                : "Prepare recovery review"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={guard.open}
        onOpenChange={(open) => {
          if (!open) guard.keep();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {busy
                ? "An operation is still running"
                : hasValue
                  ? "Discard the supplied value?"
                  : "Leave this receipt?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {busy
                ? "Keep this receipt open until the request finishes or times out. Closing the browser cannot cancel a request that has already reached HQ or the provider."
                : hasValue
                  ? "The value in this input is not saved. Leaving clears the field; it cannot be restored from browser storage."
                  : "The recorded review and outcomes remain available in Operations."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Keep receipt open
            </AlertDialogCancel>
            <Button disabled={busy} onClick={guard.discard}>
              {hasValue ? "Discard value and leave" : "Leave receipt"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
