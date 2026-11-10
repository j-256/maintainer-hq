import { DiscardDialog, useCloseGuard } from "./source-editor";
import { useDateTime } from "./date-time";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, idSchema, type Snapshot } from "../shared/domain";
import {
  type GitHubAppMetadata,
  type GitHubAppGrant,
  type GitHubAppGrantReview,
  type GitHubAppRegistrationReview,
  type GitHubAppManifestAttempt,
  type GitHubCapability,
  GITHUB_CAPABILITY,
  githubAppRegistrationSelectionInput,
} from "../shared/github-apps";
import {
  supplyGitHubAppMaterial,
  GitHubAppInputError,
} from "../shared/github-app-input";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  GitHubAppRegistrationEditor,
  GitHubAppGrantEditor,
  GitHubCapabilities,
  GITHUB_CAPABILITY_LABELS,
} from "./github-app-editor";
import { useSecretClock } from "./secret-components";
import "./github-apps.css";
type GrantPage = {
  grants: GitHubAppGrant[];
  offers: GitHubAppGrantReview[];
  limited: boolean;
};
type RegistrationPage = {
  registrations: GitHubAppMetadata[];
  limited: boolean;
};
type RequestsPage = {
  requests: {
    id: string;
    workspaceId: string;
    requestedCapabilities: GitHubCapability[];
  }[];
  limited: boolean;
};
const textError = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This request could not be completed. Inspect its saved review before retrying.";
function AppReviewClose({
  busy,
  dirty,
  uncertain = false,
  label,
  onClose,
}: {
  busy: boolean;
  dirty: boolean;
  uncertain?: boolean;
  label: string;
  onClose: () => void;
}) {
  const guard = useCloseGuard(busy || dirty, onClose);
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={guard.requestClose}>
        {label}
      </Button>
      <DiscardDialog
        guard={guard}
        busy={busy}
        uncertain={uncertain}
        recoveryHref={window.location.href}
      />
    </>
  );
}
export function GitHubApps({
  snapshot,
  onEditingChange,
}: {
  snapshot: Snapshot;
  onEditingChange?: (editing: boolean) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const owner = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const [params, setParams] = useSearchParams();
  const attemptId = params.get("githubAppAttempt");
  const [manage, setManage] = useState(
    Boolean(attemptId || params.get("githubAppReview")),
  );
  const [editing, setEditing] = useState<{
    mode: "guided" | "import" | "edit";
    initial?: GitHubAppMetadata;
  } | null>(null);
  const [grantApp, setGrantApp] = useState<GitHubAppMetadata | null>(null);
  const [registrationReviewValue, storeRegistrationReview] =
    useState<GitHubAppRegistrationReview | null>(null);
  const [grantReviewValue, storeGrantReview] =
    useState<GitHubAppGrantReview | null>(null);
  const [uncertainInput, setUncertainInput] = useState(false);
  const [attempt, setAttempt] = useState<GitHubAppManifestAttempt | null>(null);
  const [capabilities, setCapabilities] = useState<GitHubCapability[]>([
    GITHUB_CAPABILITY.COLLECTION,
  ]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const now = useSecretClock();
  const dates = useDateTime();
  useEffect(() => {
    if (!owner) setFile(null);
  }, [owner]);
  const client = useQueryClient();
  const registrations = useQuery({
    queryKey: ["github-apps", workspaceId, "administration"],
    enabled: owner && manage,
    queryFn: ({ signal }) =>
      command<RegistrationPage>(
        "github_apps_list",
        { workspaceId, scope: "administration" },
        signal,
      ),
    retry: false,
  });
  const grants = useQuery({
    queryKey: ["github-apps", workspaceId, "grants"],
    enabled: owner,
    queryFn: ({ signal }) =>
      command<GrantPage>("github_app_grant_list", { workspaceId }, signal),
  });
  const requests = useQuery({
    queryKey: ["github-apps", workspaceId, "requests", manage],
    enabled: owner && manage,
    queryFn: ({ signal }) =>
      command<RequestsPage>(
        "github_app_connection_requests_list",
        { workspaceId, scope: "administration" },
        signal,
      ),
    retry: false,
  });
  const recovery = useQuery({
    queryKey: ["github-apps", workspaceId, "attempt", attemptId],
    enabled:
      owner && Boolean(attemptId) && idSchema.safeParse(attemptId).success,
    queryFn: ({ signal }) =>
      command<GitHubAppManifestAttempt>(
        "github_app_manifest_get",
        { workspaceId, attemptId },
        signal,
      ),
    retry: false,
  });
  const registrationSelection = githubAppRegistrationSelectionInput.safeParse({
    workspaceId,
    planId: params.get("githubAppReview"),
    fingerprint: params.get("githubAppReviewFingerprint"),
  });
  const grantSelection = githubAppRegistrationSelectionInput.safeParse({
    workspaceId,
    planId: params.get("githubAppGrantReview"),
    fingerprint: params.get("githubAppGrantFingerprint"),
  });
  const registrationMatches =
    registrationSelection.success &&
    registrationReviewValue?.id === registrationSelection.data.planId &&
    registrationReviewValue.fingerprint ===
      registrationSelection.data.fingerprint;
  const grantMatches =
    grantSelection.success &&
    grantReviewValue?.id === grantSelection.data.planId &&
    grantReviewValue.fingerprint === grantSelection.data.fingerprint;
  const restoredRegistration = useQuery({
    queryKey: [
      "github-apps",
      workspaceId,
      "registration-review",
      params.get("githubAppReview"),
      params.get("githubAppReviewFingerprint"),
    ],
    enabled: owner && registrationSelection.success && !registrationMatches,
    queryFn: ({ signal }) =>
      command<GitHubAppRegistrationReview>(
        "github_app_registration_get",
        registrationSelection.success ? registrationSelection.data : {},
        signal,
      ),
    retry: false,
  });
  const restoredGrant = useQuery({
    queryKey: [
      "github-apps",
      workspaceId,
      "grant-review",
      params.get("githubAppGrantReview"),
      params.get("githubAppGrantFingerprint"),
    ],
    enabled:
      owner &&
      !registrationSelection.success &&
      grantSelection.success &&
      !grantMatches,
    queryFn: ({ signal }) =>
      command<GitHubAppGrantReview>(
        "github_app_grant_get",
        grantSelection.success ? grantSelection.data : {},
        signal,
      ),
    retry: false,
  });
  const registrationReview =
    owner && registrationSelection.success
      ? registrationMatches
        ? registrationReviewValue
        : (restoredRegistration.data ?? null)
      : null;
  const grantReview =
    owner && !registrationSelection.success && grantSelection.success
      ? grantMatches
        ? grantReviewValue
        : (restoredGrant.data ?? null)
      : null;
  function reviewLocation(
    kind: "registration" | "grant",
    review: { id: string; fingerprint: string } | null,
  ) {
    setParams(
      (before) => {
        const next = new URLSearchParams(before);
        for (const key of [
          "githubAppReview",
          "githubAppReviewFingerprint",
          "githubAppGrantReview",
          "githubAppGrantFingerprint",
        ])
          next.delete(key);
        if (review) {
          next.set(
            kind === "registration"
              ? "githubAppReview"
              : "githubAppGrantReview",
            review.id,
          );
          next.set(
            kind === "registration"
              ? "githubAppReviewFingerprint"
              : "githubAppGrantFingerprint",
            review.fingerprint,
          );
        }
        return next;
      },
      { replace: true },
    );
  }
  function setRegistrationReview(review: GitHubAppRegistrationReview | null) {
    storeRegistrationReview(review);
    if (review?.applied) setFile(null);
    if (
      !review ||
      params.get("githubAppReview") !== review.id ||
      params.get("githubAppReviewFingerprint") !== review.fingerprint
    )
      reviewLocation("registration", review);
  }
  function setGrantReview(review: GitHubAppGrantReview | null) {
    storeGrantReview(review);
    if (
      !review ||
      params.get("githubAppGrantReview") !== review.id ||
      params.get("githubAppGrantFingerprint") !== review.fingerprint
    )
      reviewLocation("grant", review);
  }
  const selectedAttempt = owner ? (attempt ?? recovery.data) : undefined;
  const activeForm = Boolean(
    editing || grantApp || registrationReview || grantReview,
  );
  useEffect(() => {
    onEditingChange?.(activeForm);
    return () => onEditingChange?.(false);
  }, [activeForm, onEditingChange]);

  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const id = registrationReview
      ? "app-registration-review"
      : grantReview
        ? "workspace-grant-review"
        : selectedAttempt
          ? "app-attempt-title"
          : null;
    if (id) root.current?.querySelector<HTMLElement>("#" + id)?.focus();
  }, [registrationReview?.id, grantReview?.id, selectedAttempt?.id]);
  function restoreFocus() {
    requestAnimationFrame(() => {
      const target = returnFocus.current;
      (target?.isConnected && !target.hasAttribute("disabled")
        ? target
        : root.current?.querySelector<HTMLElement>("#workspace-app-title")
      )?.focus();
    });
  }

  async function refresh() {
    await client.invalidateQueries({ queryKey: ["github-apps", workspaceId] });
    void client.invalidateQueries({
      queryKey: ["github-credentials", workspaceId],
    });
    void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
  }
  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(textError(failure));
    } finally {
      setBusy(false);
    }
  }
  function prepared(review: GitHubAppRegistrationReview) {
    setFile(null);
    setUncertainInput(false);
    setRegistrationReview(review);
  }
  async function registrationChange(
    registration: GitHubAppMetadata,
    kind: "rotate" | "disconnect",
  ) {
    await action(async () =>
      prepared(
        await command<GitHubAppRegistrationReview>(
          "github_app_registration_plan",
          {
            workspaceId,
            registrationId: registration.id,
            revision: registration.revision,
            change: { kind },
          },
        ),
      ),
    );
  }
  async function acceptRegistration() {
    if (!registrationReview) return;
    const selection = {
      workspaceId,
      planId: registrationReview.id,
      fingerprint: registrationReview.fingerprint,
    };
    await action(async () => {
      if (registrationReview.privateInputRequired) {
        if (!file)
          throw new Error(
            "Choose a private App JSON envelope before supplying material.",
          );
        let result;
        try {
          result = await supplyGitHubAppMaterial({
            selection,
            review: (input) => command("github_app_registration_get", input),
            read: async () => new Uint8Array(await file.arrayBuffer()),
            send: (path, init) =>
              fetch(path, {
                ...init,
                credentials: "same-origin",
                redirect: "error",
              }),
          });
        } catch (failure) {
          setUncertainInput(
            failure instanceof GitHubAppInputError && failure.uncertain,
          );
          throw failure;
        }
        setUncertainInput(false);
        setRegistrationReview(result.review);
      } else
        setRegistrationReview(
          await command<GitHubAppRegistrationReview>(
            "github_app_registration_apply",
            selection,
          ),
        );
      setFile(null);
      setNotice(
        "App registration saved. Workspace grants and GitHub installation access remain separate.",
      );
      await refresh();
    });
  }
  async function acceptGrant() {
    if (!grantReview) return;
    await action(async () => {
      const result = await command<GitHubAppGrantReview>(
        "github_app_grant_accept",
        {
          workspaceId,
          planId: grantReview.id,
          fingerprint: grantReview.fingerprint,
        },
      );
      setGrantReview(result);
      setNotice(
        result.kind === "revoke"
          ? "Workspace grant revoked locally. GitHub installation and other workspace grants remain separate."
          : "Workspace grant accepted. Select its reference in a connection to use it.",
      );
      await refresh();
    });
  }
  async function inspectOffer(review: GitHubAppGrantReview) {
    await action(async () =>
      setGrantReview(
        await command<GitHubAppGrantReview>("github_app_grant_get", {
          workspaceId,
          planId: review.id,
          fingerprint: review.fingerprint,
        }),
      ),
    );
  }
  return (
    <div
      ref={root}
      className="github-app-settings"
      onClickCapture={(event) => {
        if (!activeForm) {
          const target = (event.target as Element).closest<HTMLElement>(
            "button",
          );
          if (target) returnFocus.current = target;
        }
      }}
    >
      {restoredRegistration.error || restoredGrant.error ? (
        <p role="alert" className="source-error">
          The saved App review could not be restored.{" "}
          {textError(restoredRegistration.error ?? restoredGrant.error)}{" "}
          Reauthenticate in another tab, then reload this review URL.
        </p>
      ) : null}
      <section aria-labelledby="workspace-app-title">
        <div className="source-section-heading">
          <h2 id="workspace-app-title" tabIndex={-1}>
            Workspace App access
          </h2>
          {owner ? (
            <Button
              variant="outline"
              disabled={busy || activeForm}
              onClick={() => setManage(!manage)}
            >
              {manage ? "Show workspace Apps" : "Manage deployment Apps"}
            </Button>
          ) : null}
        </div>
        <p>
          GitHub App is the recommended connection method. An installation
          becomes usable here only after a deployment operator offers a scope
          and a workspace owner accepts it. One person can hold both roles.
        </p>
        <p className="field-help">
          Each operation verifies its current scope. Missing permissions,
          suspension or removed access can stop a capability even when an older
          observation succeeded. An App failure never switches to a manual
          token.
        </p>
        {notice ? (
          <p role="status" className="save-notice">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="source-error">
            {error}
          </p>
        ) : null}
        {!owner ? (
          <p className="permission-notice">
            Workspace owners configure and accept App access. Ask an owner for
            changes.
          </p>
        ) : (
          <>
            {grants.isPending ? (
              <p role="status">Loading workspace grants...</p>
            ) : null}
            {grants.error ? (
              <p role="alert" className="source-error">
                {grants.error.message}
                <Button variant="outline" onClick={() => void grants.refetch()}>
                  Retry workspace grants
                </Button>
              </p>
            ) : null}
            {grants.data?.offers.map((review) => (
              <div className="github-app-row" key={review.id}>
                <div>
                  <h3>
                    {review.kind === "revoke"
                      ? "Pending local revocation"
                      : "Workspace grant offered"}
                  </h3>
                  <p>
                    {review.repositories
                      .map((repo) => repo.fullName)
                      .join(", ")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || activeForm}
                  onClick={() => void inspectOffer(review)}
                >
                  Review workspace grant
                </Button>
              </div>
            ))}
            {grants.data?.grants.map((grant) => (
              <div className="github-app-row" key={grant.id}>
                <div>
                  <h3>{grant.appName}</h3>
                  <p>
                    <code>{grant.credentialRef}</code>
                  </p>
                  <p>
                    {grant.state === "active"
                      ? "Accepted local grant; provider permissions are checked when used."
                      : grant.state === "revoked"
                        ? "Revoked: request a new reviewed grant."
                        : "Expired: request a new reviewed grant."}
                  </p>
                  <p>
                    {grant.account.login}:{" "}
                    {grant.repositories.map((repo) => repo.fullName).join(", ")}
                  </p>
                  <p>
                    {grant.capabilities
                      .map((value) => GITHUB_CAPABILITY_LABELS[value])
                      .join(", ")}
                    .{" "}
                    {grant.expiresAt
                      ? "Local expiry: " + dates.dateTime(grant.expiresAt)
                      : "No local expiry."}
                  </p>
                </div>
                {grant.state === "active" ? (
                  <Button
                    variant="outline"
                    disabled={busy || activeForm}
                    onClick={() =>
                      void action(async () =>
                        setGrantReview(
                          await command<GitHubAppGrantReview>(
                            "github_app_grant_revoke_plan",
                            {
                              workspaceId,
                              grantId: grant.id,
                              revision: grant.revision,
                            },
                          ),
                        ),
                      )
                    }
                  >
                    Review revocation
                  </Button>
                ) : null}
              </div>
            ))}
            {grants.data &&
            !grants.data.grants.length &&
            !grants.data.offers.length ? (
              <p>
                No App grant has been accepted for this workspace. Request
                access from the deployment operator, or use advanced token
                configuration in a GitHub connection.
              </p>
            ) : null}
            {grants.data?.limited ? (
              <p className="permission-notice">
                The grant list is partial. Ask the deployment operator to review
                its bounded inventory.
              </p>
            ) : null}
            <details>
              <summary>Request App access</summary>
              <GitHubCapabilities
                value={capabilities}
                onChange={(value) => {
                  setCapabilities(value);
                  setRequestId(crypto.randomUUID());
                  setRequested(false);
                }}
                disabled={busy}
              />
              <Button
                disabled={busy || requested || !capabilities.length}
                onClick={() =>
                  void action(async () => {
                    await command("github_app_connection_request", {
                      workspaceId,
                      requestId,
                      requestedCapabilities: capabilities,
                    });
                    setRequested(true);
                  })
                }
              >
                {requested ? "Request recorded" : "Send access request"}
              </Button>
              <p className="field-help">
                This records your requested capabilities. It does not grant
                access.
              </p>
            </details>
          </>
        )}
      </section>
      {manage && owner ? (
        <section aria-labelledby="deployment-app-title">
          <h2 id="deployment-app-title">Deployment Apps</h2>
          <p>
            A deployment registration can serve several workspaces through
            separate grants. Only a setup operator with an active deployment
            permit can manage it.
          </p>
          {registrations.isPending ? (
            <p role="status">Loading deployment registrations...</p>
          ) : null}
          {registrations.error ? (
            <p role="alert" className="source-error">
              {registrations.error.message} Ask the deployment operator to
              verify the setup permit for this administrative workspace.
              <Button
                variant="outline"
                onClick={() => void registrations.refetch()}
              >
                Retry deployment access
              </Button>
            </p>
          ) : null}
          {registrations.data ? (
            <>
              <div className="github-app-actions">
                <Button
                  disabled={busy || activeForm}
                  onClick={() => setEditing({ mode: "guided" })}
                >
                  Register a GitHub App
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || activeForm}
                  onClick={() => setEditing({ mode: "import" })}
                >
                  Import existing App
                </Button>
              </div>
              {registrations.data.registrations.map((registration) => (
                <div className="github-app-row" key={registration.id}>
                  <div>
                    <h3>{registration.name}</h3>
                    <p>
                      <code>{registration.id}</code>
                    </p>
                    <p>
                      GitHub App {registration.appId}: {registration.visibility}{" "}
                      installation visibility.{" "}
                      {registration.state === "active"
                        ? "Registration active."
                        : "Locally disconnected."}
                    </p>
                    <p>
                      {registration.lifecycleIngress === "ready"
                        ? "Lifecycle signing configured; live delivery is verified separately."
                        : registration.lifecycleIngress ===
                            "requires_webhook_secret"
                          ? "Lifecycle delivery unavailable: import the matching webhook signing secret through protected input."
                          : "Lifecycle delivery disabled."}
                    </p>
                    <p className="field-help">
                      Signing fingerprint:{" "}
                      <code>{registration.keyFingerprint}</code>
                    </p>
                    <div className="github-app-actions">
                      {registration.state === "active" ? (
                        <>
                          <a
                            className="quiet-link"
                            href={
                              "https://github.com/apps/" +
                              encodeURIComponent(registration.slug) +
                              "/installations/new"
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            Install on GitHub
                          </a>
                          <Button
                            variant="outline"
                            disabled={busy || activeForm}
                            onClick={() => setGrantApp(registration)}
                          >
                            Offer workspace grant
                          </Button>
                        </>
                      ) : null}
                      <Button
                        variant="outline"
                        disabled={busy || activeForm}
                        onClick={() =>
                          setEditing({ mode: "edit", initial: registration })
                        }
                      >
                        Edit registration
                      </Button>
                      {registration.state === "active" ? (
                        <>
                          <Button
                            variant="outline"
                            disabled={busy || activeForm}
                            onClick={() =>
                              void registrationChange(registration, "rotate")
                            }
                          >
                            Review key rotation
                          </Button>
                          <Button
                            variant="outline"
                            disabled={busy || activeForm}
                            onClick={() =>
                              void registrationChange(
                                registration,
                                "disconnect",
                              )
                            }
                          >
                            Review disconnection
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {registrations.data.limited ? (
                <p className="permission-notice">
                  The registration list is partial. Narrow the deployment
                  inventory before creating more registrations.
                </p>
              ) : null}
            </>
          ) : null}
          {requests.data?.requests.length ? (
            <details>
              <summary>Workspace access requests</summary>
              {requests.data.requests.map((item) => (
                <p key={item.workspaceId + item.id}>
                  <code>{item.workspaceId}</code>:{" "}
                  {item.requestedCapabilities
                    .map((capability) => GITHUB_CAPABILITY_LABELS[capability])
                    .join(", ")}
                </p>
              ))}
              {requests.data.limited ? (
                <p>Request inventory is partial.</p>
              ) : null}
            </details>
          ) : null}
          {requests.error ? (
            <p role="alert" className="source-error">
              Access requests could not be loaded. {requests.error.message}
            </p>
          ) : null}
        </section>
      ) : null}
      {owner && editing ? (
        <GitHubAppRegistrationEditor
          workspaceId={workspaceId}
          {...editing}
          onClose={(saved) => {
            setEditing(null);
            if (!saved) restoreFocus();
          }}
          onPrepared={(value) => {
            setAttempt(value);
            setNotice("");
          }}
          onReview={prepared}
        />
      ) : null}
      {owner && grantApp ? (
        <GitHubAppGrantEditor
          key={grantApp.id}
          workspaceId={workspaceId}
          registration={grantApp}
          onClose={(saved) => {
            setGrantApp(null);
            if (!saved) restoreFocus();
          }}
          onPrepared={setGrantReview}
        />
      ) : null}
      {recovery.error ? (
        <p role="alert" className="source-error">
          Registration status is unavailable. {recovery.error.message}{" "}
          Reauthenticate in another tab, then inspect the same attempt.
          <Button variant="outline" onClick={() => void recovery.refetch()}>
            Retry attempt status
          </Button>
        </p>
      ) : null}
      {selectedAttempt ? (
        <section
          className="github-app-form"
          aria-labelledby="app-attempt-title"
        >
          <h3 id="app-attempt-title" tabIndex={-1}>
            {selectedAttempt.recovery === "protected_import_required"
              ? "Registration recovery"
              : "GitHub registration status"}
          </h3>
          <p>
            Attempt <code>{selectedAttempt.id}</code>: {selectedAttempt.state}.
          </p>
          {selectedAttempt.state === "pending" ? (
            <>
              <p>
                Continue in the authenticated browser ceremony. GitHub will ask
                you to confirm the registration and its requested permissions.
              </p>
              <a className="quiet-link" href={selectedAttempt.browserUrl}>
                Continue to GitHub
              </a>
            </>
          ) : selectedAttempt.state === "complete" ? (
            <p>
              Registration saved. Install the App on GitHub, then offer and
              accept the exact workspace grant.
            </p>
          ) : (
            <p>
              The conversion did not establish complete local custody. Do not
              retry its provider code. Inspect the upstream App, recover or
              replace its signing key and supply the matching webhook secret
              through protected import. A replacement private key alone does not
              restore lifecycle signing.
            </p>
          )}
          <div className="github-app-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setAttempt(
                    await command<GitHubAppManifestAttempt>(
                      "github_app_manifest_get",
                      { workspaceId, attemptId: selectedAttempt.id },
                    ),
                  );
                  await refresh();
                })
              }
            >
              Refresh registration status
            </Button>
            {selectedAttempt.recovery === "protected_import_required" ? (
              <Button
                disabled={activeForm}
                onClick={() => setEditing({ mode: "import" })}
              >
                Import recovered App
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {registrationReview ? (
        <section
          className="github-app-form"
          aria-labelledby="app-registration-review"
        >
          <h3 id="app-registration-review" tabIndex={-1}>
            Registration review
          </h3>
          <p>
            {registrationReview.change.kind}:{" "}
            <code>{registrationReview.registrationId}</code>. Review expires{" "}
            {dates.dateTime(registrationReview.expiresAt)}.
          </p>
          <p>
            This change affects the following workspaces:{" "}
            {registrationReview.impact.affectedWorkspaceIds.join(", ")}.
            Disconnection is local; it does not uninstall the App, revoke an
            upstream key or remove repository hooks.
          </p>
          {registrationReview.privateInputRequired &&
          !registrationReview.applied ? (
            <>
              <p>
                Supply an App JSON envelope containing version 1, privateKey
                and, when recovering lifecycle signing, the matching
                webhookSecret. The exact live review is checked before this file
                is read. Material is never sent through ordinary commands.
              </p>
              <label className="form-field">
                Private App input file
                <Input
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </>
          ) : null}
          {registrationReview.applied ? (
            <p role="status">
              Registration saved. Private material is not returned or compared
              by this receipt.
            </p>
          ) : null}
          <div className="github-app-actions">
            <Button
              disabled={
                busy ||
                registrationReview.applied ||
                registrationReview.expired ||
                Date.parse(registrationReview.expiresAt) <= now ||
                (registrationReview.privateInputRequired && !file)
              }
              onClick={() => void acceptRegistration()}
            >
              {registrationReview.privateInputRequired
                ? "Supply protected App material"
                : "Save registration change"}
            </Button>
            <AppReviewClose
              busy={busy}
              dirty={Boolean(file)}
              uncertain={uncertainInput}
              label="Close review"
              onClose={() => {
                setRegistrationReview(null);
                setFile(null);
                restoreFocus();
              }}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setRegistrationReview(
                    await command<GitHubAppRegistrationReview>(
                      "github_app_registration_get",
                      {
                        workspaceId,
                        planId: registrationReview.id,
                        fingerprint: registrationReview.fingerprint,
                      },
                    ),
                  );
                  await refresh();
                })
              }
            >
              Refresh review status
            </Button>
          </div>
        </section>
      ) : null}
      {grantReview ? (
        <section
          className="github-app-form"
          aria-labelledby="workspace-grant-review"
          role="region"
        >
          <h3 id="workspace-grant-review" tabIndex={-1}>
            Workspace grant review
          </h3>
          <p>
            {grantReview.kind === "revoke"
              ? "Revoke local access for"
              : "Offer access to"}{" "}
            <code>{grantReview.targetWorkspaceId}</code> through installation{" "}
            {grantReview.installationId}.
          </p>
          <ul>
            {grantReview.repositories.map((repo) => (
              <li key={repo.id}>
                {repo.fullName} {repo.private ? "(private)" : "(public)"}
              </li>
            ))}
          </ul>
          <p>
            {grantReview.capabilities
              .map((capability) => GITHUB_CAPABILITY_LABELS[capability])
              .join(", ")}
            .{" "}
            {grantReview.grantExpiresAt
              ? "Grant expiry: " + dates.dateTime(grantReview.grantExpiresAt)
              : "No local grant expiry."}
          </p>
          <p>
            Review <code>{grantReview.id}</code> expires{" "}
            {dates.dateTime(grantReview.expiresAt)}. Acceptance authorizes this
            exact scope, not every repository accessible to the App.
          </p>
          {grantReview.targetWorkspaceId !== workspaceId ? (
            <p>
              Ask an owner of the target workspace to inspect and accept this
              review there. Preparing an offer does not activate it.
            </p>
          ) : null}
          <div className="github-app-actions">
            {grantReview.targetWorkspaceId === workspaceId ? (
              <Button
                disabled={
                  busy ||
                  grantReview.state !== "offered" ||
                  Date.parse(grantReview.expiresAt) <= now
                }
                onClick={() => void acceptGrant()}
              >
                {grantReview.kind === "revoke"
                  ? "Revoke workspace grant"
                  : "Accept workspace grant"}
              </Button>
            ) : null}
            <AppReviewClose
              busy={busy}
              dirty={false}
              label="Close grant review"
              onClose={() => {
                setGrantReview(null);
                restoreFocus();
              }}
            />
          </div>
        </section>
      ) : null}
      <p className="field-help">
        Manual tokens remain available for new and existing connections. Open
        Connect GitHub and choose Advanced token configuration. Actions
        configuration and maintenance tokens retain their protected
        provider-access setup.
      </p>
      <Link
        className="quiet-link"
        to={
          "/settings/github?workspace=" +
          encodeURIComponent(workspaceId) +
          "&view=connections"
        }
      >
        Open GitHub connections
      </Link>
    </div>
  );
}
