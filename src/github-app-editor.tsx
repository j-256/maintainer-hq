import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GITHUB_CAPABILITY,
  GITHUB_APP_LIMITS,
  githubAppPermissions,
  type GitHubAppMetadata,
  type GitHubCapability,
  type GitHubAppManifestAttempt,
  type GitHubAppRegistrationReview,
  type GitHubAppGrantReview,
  type GitHubAppRepositoryPage,
} from "../shared/github-apps";
import type { GitHubInstallationPage } from "../worker/github-app-client";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { DiscardDialog, useCloseGuard } from "./source-editor";
export const GITHUB_CAPABILITY_LABELS: Record<GitHubCapability, string> = {
  collection: "Evidence collection",
  "repository-maintenance": "Maintenance PRs",
  "configuration-read": "Read Actions configuration",
  "configuration-write": "Change Actions configuration",
};
export function GitHubCapabilities({
  value,
  onChange,
  disabled = false,
  allowed = Object.values(GITHUB_CAPABILITY),
}: {
  value: GitHubCapability[];
  onChange: (value: GitHubCapability[]) => void;
  disabled?: boolean;
  allowed?: GitHubCapability[];
}) {
  return (
    <fieldset className="github-app-choices" disabled={disabled}>
      <legend>Capabilities</legend>
      {allowed.map((capability) => (
        <label key={capability}>
          <Checkbox
            checked={value.includes(capability)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...value, capability]
                  : value.filter((item) => item !== capability),
              )
            }
          />
          <span>{GITHUB_CAPABILITY_LABELS[capability]}</span>
        </label>
      ))}
    </fieldset>
  );
}
function useSetupFocus() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("h3")?.focus();
  }, []);
  return root;
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This review could not be prepared. Your draft is preserved.";
export function GitHubAppRegistrationEditor({
  workspaceId,
  initial,
  mode,
  onClose,
  onPrepared,
  onReview,
}: {
  workspaceId: string;
  initial?: GitHubAppMetadata;
  mode: "guided" | "import" | "edit";
  onClose: (saved?: boolean) => void;
  onPrepared: (attempt: GitHubAppManifestAttempt) => void;
  onReview: (review: GitHubAppRegistrationReview) => void;
}) {
  const [draft, setDraft] = useState({
    name: initial?.name ?? "",
    appId: initial ? String(initial.appId) : "",
    account: "",
    accountType: "User" as "User" | "Organization",
    visibility: initial?.visibility ?? ("public" as "public" | "private"),
    capabilities: initial?.capabilities ?? [GITHUB_CAPABILITY.COLLECTION],
    replaceKey: !initial,
  });
  const [registrationId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const root = useSetupFocus();
  const planned = useRef(false);
  const guard = useCloseGuard(dirty || busy, () => onClose(planned.current));
  const change = (next: Partial<typeof draft>) => {
    setDirty(true);
    setDraft({ ...draft, ...next });
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    if (!draft.capabilities.length) {
      setError("Choose at least one capability.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "guided") {
        const result = await command<GitHubAppManifestAttempt>(
          "github_app_manifest_start",
          {
            workspaceId,
            registrationId,
            name: draft.name,
            visibility: draft.visibility,
            capabilities: draft.capabilities,
            account: { login: draft.account, type: draft.accountType },
          },
        );
        planned.current = true;
        guard.saved();
        onPrepared(result);
      } else {
        const result = await command<GitHubAppRegistrationReview>(
          "github_app_registration_plan",
          {
            workspaceId,
            registrationId,
            revision: initial?.revision ?? 0,
            change: {
              kind: "save",
              fields: {
                name: draft.name,
                appId: Number(draft.appId),
                visibility: draft.visibility,
                capabilities: draft.capabilities,
              },
              replaceKey: draft.replaceKey,
            },
          },
        );
        planned.current = true;
        guard.saved();
        onReview(result);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section
        ref={root}
        className="github-app-form"
        aria-labelledby="app-registration-title"
      >
        <h3 id="app-registration-title" tabIndex={-1}>
          {mode === "guided"
            ? "Register a GitHub App"
            : mode === "import"
              ? "Import existing App"
              : "Edit registration"}
        </h3>
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="github-app-fields">
            <label className="form-field">
              App name
              <Input
                required
                maxLength={80}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            {mode === "guided" ? (
              <>
                <label className="form-field">
                  GitHub account
                  <Input
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9-]{0,38}"
                    value={draft.account}
                    onChange={(event) =>
                      change({ account: event.target.value })
                    }
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label className="form-field">
                  Account type
                  <select
                    className="github-app-select"
                    value={draft.accountType}
                    onChange={(event) =>
                      change({
                        accountType: event.target.value as
                          "User" | "Organization",
                      })
                    }
                  >
                    <option value="User">Personal account</option>
                    <option value="Organization">Organization</option>
                  </select>
                </label>
              </>
            ) : (
              <label className="form-field">
                GitHub App ID
                <Input
                  required
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  readOnly={Boolean(initial)}
                  value={draft.appId}
                  onChange={(event) => change({ appId: event.target.value })}
                />
              </label>
            )}
            <label className="form-field">
              Installation visibility
              <select
                className="github-app-select"
                value={draft.visibility}
                disabled={Boolean(initial)}
                onChange={(event) =>
                  change({
                    visibility: event.target.value as "public" | "private",
                  })
                }
              >
                <option value="public">
                  Public: other accounts may install
                </option>
                <option value="private">
                  Private: registration owner only
                </option>
              </select>
            </label>
            <p className="field-help">
              {mode === "guided"
                ? "This requests visibility during GitHub registration. "
                : "This declaration is unverified. Confirm actual visibility in the GitHub App settings. HQ does not change it. "}
              Public installation visibility lets other repository owners
              install this App. It does not make their repositories or HQ
              workspace public.
            </p>
            <GitHubCapabilities
              value={draft.capabilities}
              onChange={(capabilities) => change({ capabilities })}
            />
            <p className="field-help">
              Requested permissions still need GitHub account approval.
              Registration does not grant workspace access.
            </p>
            {initial ? (
              <label className="github-app-choice">
                <Checkbox
                  checked={draft.replaceKey}
                  onCheckedChange={(checked) =>
                    change({ replaceKey: checked === true })
                  }
                />
                Replace signing material through protected input after review
              </label>
            ) : null}
          </fieldset>
          {error ? (
            <p role="alert" className="source-error">
              {error}
            </p>
          ) : null}
          <div className="github-app-actions">
            <Button type="submit" disabled={busy}>
              {busy
                ? "Preparing..."
                : mode === "guided"
                  ? "Prepare GitHub registration"
                  : "Review registration"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={guard.requestClose}
            >
              Cancel
            </Button>
          </div>
        </form>
      </section>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
export function GitHubAppGrantEditor({
  workspaceId,
  registration,
  onClose,
  onPrepared,
}: {
  workspaceId: string;
  registration: GitHubAppMetadata;
  onClose: (saved?: boolean) => void;
  onPrepared: (review: GitHubAppGrantReview) => void;
}) {
  const [installationId, setInstallationId] = useState("");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(workspaceId);
  const [capabilities, setCapabilities] = useState<GitHubCapability[]>([
    registration.capabilities[0],
  ]);
  const [selected, setSelected] = useState<GitHubAppRepositoryPage["items"]>(
    [],
  );
  const [cursor, setCursor] = useState<string>();
  const [installationCursor, setInstallationCursor] = useState<string>();
  const [grantId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useSetupFocus();
  const planned = useRef(false);
  const guard = useCloseGuard(
    Boolean(
      installationId || targetWorkspaceId !== workspaceId || selected.length,
    ) || busy,
    () => onClose(planned.current),
  );
  const installations = useQuery({
    queryKey: [
      "github-app-installations",
      workspaceId,
      registration.id,
      registration.revision,
      installationCursor,
    ],
    queryFn: ({ signal }) =>
      command<GitHubInstallationPage>(
        "github_app_installations_list",
        {
          workspaceId,
          registrationId: registration.id,
          ...(installationCursor ? { cursor: installationCursor } : {}),
        },
        signal,
      ),
  });
  const installation = installations.data?.items.find(
    (item) => item.id === Number(installationId),
  );
  const repositories = useQuery({
    queryKey: [
      "github-app-repositories",
      workspaceId,
      registration.id,
      registration.revision,
      installationId,
      cursor,
    ],
    enabled: Boolean(installationId),
    queryFn: ({ signal }) =>
      command<GitHubAppRepositoryPage>(
        "github_app_repositories_list",
        {
          workspaceId,
          registrationId: registration.id,
          installationId: Number(installationId),
          ...(cursor ? { cursor } : {}),
        },
        signal,
      ),
  });
  const missing = installation
    ? Object.entries(
        githubAppPermissions(
          capabilities.length ? capabilities : [GITHUB_CAPABILITY.COLLECTION],
        ),
      )
        .filter(
          ([permission, level]) =>
            installation.permissions[permission] !== level &&
            installation.permissions[permission] !== "write",
        )
        .map(([permission]) => permission)
    : [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    if (!selected.length || !capabilities.length) {
      setError("Choose repositories and at least one capability.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const review = await command<GitHubAppGrantReview>(
        "github_app_grant_plan",
        {
          workspaceId,
          targetWorkspaceId,
          registrationId: registration.id,
          installationId: Number(installationId),
          grantId,
          revision: 0,
          repositoryIds: selected.map((item) => item.id),
          capabilities,
        },
      );
      planned.current = true;
      guard.saved();
      onPrepared(review);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section
        ref={root}
        className="github-app-form"
        aria-labelledby="app-grant-title"
      >
        <h3 id="app-grant-title" tabIndex={-1}>
          Offer workspace grant
        </h3>
        <p>
          {registration.name}: select the exact installation, repositories and
          capabilities. The target workspace owner must accept this review.
        </p>
        <form onSubmit={submit}>
          <fieldset className="github-app-fields" disabled={busy}>
            <label className="form-field">
              Target workspace ID
              <Input
                required
                maxLength={100}
                value={targetWorkspaceId}
                onChange={(event) => setTargetWorkspaceId(event.target.value)}
              />
            </label>
            <label className="form-field">
              Installation
              <select
                className="github-app-select"
                required
                value={installationId}
                onChange={(event) => {
                  setInstallationId(event.target.value);
                  setCursor(undefined);
                  setSelected([]);
                }}
              >
                <option value="">Choose an installation</option>
                {installations.data?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.account.login} ({item.account.type})
                    {item.suspendedAt ? " - suspended" : ""}
                  </option>
                ))}
              </select>
            </label>
            {installations.isPending ? (
              <p role="status">Loading installations...</p>
            ) : null}
            {installations.error ? (
              <p role="alert" className="source-error">
                {installations.error.message}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void installations.refetch()}
                >
                  Retry installations
                </Button>
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || installations.isFetching}
              onClick={() => void installations.refetch()}
            >
              Refresh installations
            </Button>
            {installations.data?.nextCursor || installationCursor ? (
              <div className="github-app-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!installationCursor}
                  onClick={() => {
                    setInstallationCursor(undefined);
                    setInstallationId("");
                    setSelected([]);
                  }}
                >
                  First installation page
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!installations.data?.nextCursor}
                  onClick={() => {
                    setInstallationCursor(installations.data!.nextCursor!);
                    setInstallationId("");
                    setSelected([]);
                  }}
                >
                  Next installation page
                </Button>
              </div>
            ) : null}
            <GitHubCapabilities
              value={capabilities}
              allowed={registration.capabilities}
              onChange={setCapabilities}
            />
            {missing.length ? (
              <p className="permission-notice">
                Missing approved permissions: {missing.join(", ")}. Ask the
                GitHub account owner to approve the requested permissions, then
                refresh installations.
              </p>
            ) : null}
            {installation?.suspendedAt ? (
              <p role="alert" className="permission-notice">
                Installation suspended. Ask its GitHub account owner to restore
                access.
              </p>
            ) : null}
            {installationId ? (
              <fieldset className="github-app-choices">
                <legend>
                  Repositories ({selected.length} /{" "}
                  {GITHUB_APP_LIMITS.REPOSITORIES} selected)
                </legend>
                {repositories.isPending ? (
                  <p role="status">Loading repositories...</p>
                ) : null}
                {repositories.error ? (
                  <p role="alert" className="source-error">
                    {repositories.error.message}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void repositories.refetch()}
                    >
                      Retry repositories
                    </Button>
                  </p>
                ) : null}
                {repositories.data?.items.map((repo) => (
                  <label key={repo.id}>
                    <Checkbox
                      checked={selected.some((item) => item.id === repo.id)}
                      disabled={
                        !selected.some((item) => item.id === repo.id) &&
                        selected.length >= GITHUB_APP_LIMITS.REPOSITORIES
                      }
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked === true
                            ? [...selected, repo]
                            : selected.filter((item) => item.id !== repo.id),
                        )
                      }
                    />
                    <span>{repo.fullName}</span>
                  </label>
                ))}
                {repositories.data?.items.length === 0 ? (
                  <p>
                    No accessible repositories on this page. Check the GitHub
                    installation selection.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {repositories.data?.nextCursor || cursor ? (
              <div className="github-app-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!cursor}
                  onClick={() => setCursor(undefined)}
                >
                  First repository page
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!repositories.data?.nextCursor}
                  onClick={() => setCursor(repositories.data!.nextCursor!)}
                >
                  Next repository page
                </Button>
              </div>
            ) : null}
            {installations.data?.limited || repositories.data?.limited ? (
              <p className="permission-notice">
                This inventory is partial. Narrow the GitHub installation
                selection before continuing.
              </p>
            ) : null}
          </fieldset>
          {error ? (
            <p role="alert" className="source-error">
              {error}
            </p>
          ) : null}
          <div className="github-app-actions">
            <Button
              type="submit"
              disabled={
                busy ||
                !installation ||
                Boolean(installation.suspendedAt) ||
                Boolean(missing.length) ||
                !selected.length ||
                !capabilities.length
              }
            >
              {busy ? "Preparing..." : "Review workspace offer"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={guard.requestClose}
            >
              Cancel
            </Button>
          </div>
        </form>
      </section>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
