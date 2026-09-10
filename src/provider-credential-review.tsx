import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LockKeyhole, RefreshCw } from "lucide-react";
import {
  PROVIDER_CREDENTIAL_LIMITS,
  providerCredentialReviewSchema,
  providerResourceNames,
  PROVIDER_CREDENTIAL_LABELS,
  PROVIDER_CREDENTIAL_KIND,
  type ProviderCredentialKind,
  type ProviderCredentialReview,
} from "../shared/provider-credentials";
import { SECRET_PROVIDER_KIND } from "../shared/secrets";
import { command } from "./lib/api";
import { supplyBrowserCredential } from "./lib/provider-credential-input";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { useCloseGuard } from "./source-editor";
import { SecretError, SecretTime, useSecretClock } from "./secret-components";

export function ProviderCredentialReviewPanel({
  workspaceId,
  planId,
  onClose,
  onConnect,
  queryPrefix = "secrets",
}: {
  workspaceId: string;
  planId: string;
  onClose: () => void;
  onConnect: (reference: string, kind: ProviderCredentialKind) => void;
  queryPrefix?: "secrets" | "dependency-access";
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hasInput, setHasInput] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [unchangedReceipt, setUnchangedReceipt] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  const tokenRef = useCallback((element: HTMLInputElement | null) => {
    if (token.current && token.current !== element) token.current.value = "";
    token.current = element;
  }, []);
  const heading = useRef<HTMLHeadingElement>(null);
  const now = useSecretClock();
  const key = [queryPrefix, workspaceId, "credential-review", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      providerCredentialReviewSchema.parse(
        await command(
          "provider_credential_review",
          { workspaceId, planId },
          signal,
        ),
      ),
    retry: false,
  });
  const review = query.data;
  const guard = useCloseGuard(hasInput || busy, onClose);
  const expired = Boolean(review && Date.parse(review.expiresAt) <= now);
  const disabled =
    busy ||
    query.isFetching ||
    !review?.actorMatches ||
    expired ||
    Boolean(review?.appliedAt);
  const replacement =
    review?.change.kind === "save" && review.change.replaceToken;
  useEffect(() => {
    heading.current?.focus();
  }, [planId]);
  function clearInput() {
    if (token.current) token.current.value = "";
    setHasInput(false);
  }
  function accepted(result: ProviderCredentialReview) {
    client.setQueryData(key, result);
    void client.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    void client.invalidateQueries({
      queryKey: ["dependency-access", workspaceId],
    });
  }
  async function apply(event?: FormEvent) {
    event?.preventDefault();
    if (!review || disabled) return;
    setBusy(true);
    setError(null);
    try {
      if (replacement) {
        const result = await supplyBrowserCredential(
          workspaceId,
          review,
          async () => new TextEncoder().encode(token.current?.value ?? ""),
        );
        setUnchangedReceipt(!result.submitted);
        accepted(result.review);
      } else {
        accepted(
          await command<ProviderCredentialReview>("provider_credential_apply", {
            workspaceId,
            planId,
            fingerprint: review.fingerprint,
          }),
        );
      }
      setRetiring(false);
    } catch (failure) {
      setError(failure);
    } finally {
      clearInput();
      setBusy(false);
      heading.current?.focus();
    }
  }
  return (
    <section
      className="secret-panel provider-review"
      aria-labelledby="credential-review-heading"
    >
      <div className="hook-section-heading">
        <div>
          <h2 ref={heading} tabIndex={-1} id="credential-review-heading">
            Provider access review
          </h2>
          <p>
            Exact scope and protected credential custody. No repository or
            destination secret changes happen here.
          </p>
        </div>
        <Button variant="outline" onClick={guard.requestClose} disabled={busy}>
          <ArrowLeft size={16} aria-hidden="true" /> Provider access
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Loading credential review...</p>
      ) : null}
      {query.error ? <SecretError error={query.error} /> : null}
      {error ? <SecretError error={error} /> : null}
      <div className="secret-actions">
        <Button
          variant="outline"
          disabled={busy || query.isFetching}
          onClick={async () => {
            setError(null);
            const result = await query.refetch();
            if (
              result.data?.appliedAt ||
              !result.data?.actorMatches ||
              Date.parse(result.data.expiresAt) <= Date.now()
            )
              clearInput();
            if (result.data?.appliedAt) accepted(result.data);
            heading.current?.focus();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" /> Check review status
        </Button>
        <span className="hook-muted">
          Review ID: <code>{planId}</code>
        </span>
      </div>
      {review ? (
        <>
          <div className="secret-target-facts">
            <Badge variant="outline">
              {review.appliedAt
                ? "Applied"
                : expired
                  ? "Expired"
                  : "Awaiting confirmation"}
            </Badge>
            <span>
              {review.appliedAt ? (
                <>
                  Applied <SecretTime value={review.appliedAt} />
                </>
              ) : (
                <>
                  Review expires <SecretTime value={review.expiresAt} />
                </>
              )}
            </span>
          </div>
          {!review.actorMatches ? (
            <p className="hook-notice">
              Only the original owner session or exact client credential can
              confirm this review.
            </p>
          ) : null}
          {review.change.kind === "save" ? (
            <>
              <dl className="provider-facts">
                <div>
                  <dt>Credential</dt>
                  <dd>{review.change.settings.name}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {
                      PROVIDER_CREDENTIAL_LABELS[
                        review.change.settings.providerKind
                      ]
                    }
                  </dd>
                </div>
                <div>
                  <dt>Allowed operations</dt>
                  <dd>
                    {review.change.settings.writable
                      ? "Configuration reads and explicitly reviewed writes"
                      : "Configuration reads only"}
                  </dd>
                </div>
                <div>
                  <dt>HQ cutoff</dt>
                  <dd>
                    <SecretTime value={review.change.settings.expiresAt} />
                  </dd>
                </div>
                <div>
                  <dt>Private input</dt>
                  <dd>
                    {replacement
                      ? "Replace the token after confirming this scope"
                      : "Retain and re-encrypt the existing token"}
                  </dd>
                </div>
                {review.change.settings.providerKind ===
                SECRET_PROVIDER_KIND.CLOUDFLARE ? (
                  <div>
                    <dt>Account</dt>
                    <dd>
                      <code>{review.change.settings.scope.accountId}</code>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div>
                <h3>Exact resource allowlist</h3>
                <ul
                  className="provider-resource-list"
                  tabIndex={0}
                  aria-label="Reviewed resource allowlist"
                >
                  {providerResourceNames({
                    settings: review.change.settings,
                  }).map((name) => (
                    <li key={name}>
                      <code>{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="hook-notice">
              Retiring{" "}
              <strong>
                {review.previousSettings?.name ?? review.credentialId}
              </strong>{" "}
              discards HQ's usable encrypted token and disables its connections.
              It does not revoke the upstream token, erase old backups, or
              recall work already submitted.
            </p>
          )}
          {review.previousSettings ? (
            <details className="hook-signals">
              <summary>
                {review.change.kind === "retire"
                  ? "Exact saved scope being retired"
                  : "Compare saved access"}
              </summary>
              <p>
                {review.previousSettings.name} /{" "}
                {review.previousSettings.writable
                  ? "Reviewed writes allowed"
                  : "Read only"}{" "}
                / Cutoff{" "}
                <SecretTime value={review.previousSettings.expiresAt} />
              </p>
              {review.previousSettings.providerKind ===
              SECRET_PROVIDER_KIND.CLOUDFLARE ? (
                <p>
                  Cloudflare account{" "}
                  <code>{review.previousSettings.scope.accountId}</code>
                </p>
              ) : null}
              <ul
                className="provider-resource-list"
                tabIndex={0}
                aria-label="Previously saved resource allowlist"
              >
                {providerResourceNames({
                  settings: review.previousSettings,
                }).map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="provider-impact">
            <h3>Connection and review impact</h3>
            {review.connections.length ? (
              <ul>
                {review.connections.map((connection) => (
                  <li key={connection.id}>
                    {connection.name}: revision {connection.revision} will
                    change
                    {review.change.kind === "retire" && connection.enabled
                      ? " and this connection will be disabled"
                      : ""}
                    .
                  </li>
                ))}
              </ul>
            ) : (
              <p>No enrolled connections depend on this credential.</p>
            )}
            <p>
              Earlier prepared operations do not inherit replacement authority.{" "}
              {review.pendingReviews} unexpired reviews reference this
              credential; {review.unsettledDestinations} destinations or
              repository operations have an unsettled outcome. Older receipts
              remain historical evidence. Changing access cannot make an
              uncertain write safe to replay.
            </p>
          </div>
          {review.appliedAt ? (
            <div role="status" className="hook-notice">
              <p>
                {review.change.kind === "retire"
                  ? "The credential was retired from HQ. Revoke the token with its provider if it should no longer exist."
                  : "The reviewed credential change is applied. Verify the required read access before connecting its resources."}
              </p>
              {unchangedReceipt ? (
                <p>
                  The review was already applied. This receipt does not prove
                  that the token supplied in this attempt was stored.
                </p>
              ) : null}
              <div className="secret-actions">
                <Button variant="outline" onClick={onClose}>
                  Done
                </Button>
                {review.change.kind === "save" ? (
                  <Button
                    onClick={() => {
                      if (review.change.kind === "save")
                        onConnect(
                          review.credentialId,
                          review.change.settings.providerKind,
                        );
                    }}
                  >
                    {review.change.kind === "save" &&
                    review.change.settings.providerKind ===
                      PROVIDER_CREDENTIAL_KIND.REPOSITORY
                      ? "Return to maintenance"
                      : "Connect resources"}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : review.change.kind === "retire" ? (
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => setRetiring(true)}
            >
              Retire credential from HQ
            </Button>
          ) : (
            <form className="secret-form" onSubmit={apply}>
              {replacement ? (
                <div className="provider-private-input">
                  <label
                    className="hook-field"
                    htmlFor="provider-private-token"
                  >
                    <span>
                      <LockKeyhole size={16} aria-hidden="true" /> Private
                      provider token
                    </span>
                    <Input
                      id="provider-private-token"
                      ref={tokenRef}
                      type="password"
                      required
                      maxLength={PROVIDER_CREDENTIAL_LIMITS.TOKEN_BYTES}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      disabled={disabled}
                      onChange={(event) =>
                        setHasInput(Boolean(event.currentTarget.value))
                      }
                      aria-describedby="provider-private-help"
                    />
                  </label>
                  <p className="hook-muted" id="provider-private-help">
                    Use a dedicated token for the reviewed scope, without
                    whitespace or trailing newlines. HQ encrypts this provider
                    credential for future authentication. The input is cleared
                    after every submission attempt.
                  </p>
                </div>
              ) : null}
              <Button
                type="submit"
                disabled={disabled || Boolean(replacement && !hasInput)}
              >
                {busy
                  ? "Saving reviewed access..."
                  : replacement
                    ? "Save credential with this scope"
                    : "Save reviewed settings"}
              </Button>
            </form>
          )}
        </>
      ) : null}
      <AlertDialog
        open={retiring}
        onOpenChange={(open) => {
          if (!busy) setRetiring(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Retire this provider credential?
            </AlertDialogTitle>
            <AlertDialogDescription>
              HQ will discard usable ciphertext and disable the reviewed
              connections. Upstream access and submitted operations are not
              revoked. This can prevent recovery of pending work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep credential
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disabled}
              onClick={(event) => {
                event.preventDefault();
                void apply();
              }}
            >
              {busy ? "Retiring..." : "Retire from HQ"}
            </AlertDialogAction>
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
            <AlertDialogTitle>Leave private input?</AlertDialogTitle>
            <AlertDialogDescription>
              The token field will be cleared. The review remains available at
              this URL. If a submission was interrupted, inspect its status
              before assuming it was not saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={guard.keep}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                clearInput();
                guard.discard();
              }}
            >
              Leave review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
