import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Check, KeyRound, Plus, RefreshCw } from "lucide-react";
import { type Snapshot } from "../shared/domain";
import {
  MANAGED_CREDENTIAL_PREFIX,
  providerResourceNames,
  PROVIDER_CREDENTIAL_LABELS,
  PROVIDER_CREDENTIAL_KIND,
  type ProviderCredentialKind,
  type ProviderCredential,
  type ProviderCredentialReview,
  type ProviderCredentialVerification,
} from "../shared/provider-credentials";
import {
  SECRET_ENTRY_KIND,
  SECRET_PROVIDER_KIND,
  type SecretEntryKind,
  type SecretProviderReference,
} from "../shared/secrets";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { SecretError, SecretPagination, SecretTime } from "./secret-components";
import { ProviderCredentialEditor } from "./provider-credential-editor";
import { Input } from "./components/ui/input";
import { ProviderCredentialReviewPanel } from "./provider-credential-review";

type CredentialsPage = {
  items: ProviderCredential[];
  nextCursor: string | null;
  storageReady: boolean;
};
const STATUS_LABELS = {
  available: "Configured",
  expired: "Expired",
  retired: "Retired",
  "key-unavailable": "Encryption key unavailable",
};
function ProviderCredentialRow({
  workspaceId,
  credential,
  storageReady,
  onEdit,
  onReview,
  onConnect,
}: {
  workspaceId: string;
  credential: ProviderCredential;
  storageReady: boolean;
  onEdit: (credential: ProviderCredential) => void;
  onReview: (review: ProviderCredentialReview) => void;
  onConnect: (reference: string, kind: ProviderCredentialKind) => void;
}) {
  const [resource, setResource] = useState(
    () => providerResourceNames(credential)[0]!,
  );
  const [verifying, setVerifying] = useState(false);
  const [scope, setScope] = useState("repository");
  const [entryKind, setEntryKind] = useState<SecretEntryKind>(
    SECRET_ENTRY_KIND.SECRET,
  );
  const [environmentName, setEnvironmentName] = useState("");
  const [retiring, setRetiring] = useState(false);
  const [evidence, setEvidence] =
    useState<ProviderCredentialVerification | null>(null);
  const [error, setError] = useState<unknown>(null);
  const resources = providerResourceNames(credential);
  const busy = verifying || retiring;
  async function verify() {
    if (busy) return;
    setVerifying(true);
    setEvidence(null);
    setError(null);
    try {
      setEvidence(
        await command<ProviderCredentialVerification>(
          "provider_credential_verify",
          {
            workspaceId,
            credentialId: credential.id,
            revision: credential.revision,
            resourceName: resource,
            entryKind,
            scope:
              credential.settings.providerKind ===
              SECRET_PROVIDER_KIND.CLOUDFLARE
                ? { kind: "worker" }
                : scope === "organization"
                  ? {
                      kind: "organization",
                      name: resource.split("/")[0]!,
                    }
                  : scope === "environment"
                    ? { kind: "environment", name: environmentName }
                    : { kind: "repository" },
          },
        ),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setVerifying(false);
    }
  }
  async function retire() {
    if (busy) return;
    setRetiring(true);
    setError(null);
    try {
      onReview(
        await command<ProviderCredentialReview>("provider_credential_plan", {
          workspaceId,
          credentialId: credential.id,
          revision: credential.revision,
          change: { kind: "retire" },
        }),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setRetiring(false);
    }
  }
  return (
    <article className="provider-access-row">
      <div className="provider-row-heading">
        <div>
          <h3>{credential.settings.name}</h3>
          <p className="hook-muted">
            {PROVIDER_CREDENTIAL_LABELS[credential.settings.providerKind]} /{" "}
            {resources.length}{" "}
            {credential.settings.providerKind !==
            SECRET_PROVIDER_KIND.CLOUDFLARE
              ? resources.length === 1
                ? "repository"
                : "repositories"
              : resources.length === 1
                ? "Worker"
                : "Workers"}{" "}
            /{" "}
            {credential.settings.writable
              ? "Reviewed writes allowed"
              : "Read only"}
          </p>
        </div>
        <Badge variant="outline">{STATUS_LABELS[credential.status]}</Badge>
      </div>
      <p className="hook-muted">
        HQ cutoff <SecretTime value={credential.settings.expiresAt} />.{" "}
        {credential.status === "available"
          ? "Configured does not mean provider access has been verified."
          : credential.status === "retired"
            ? "Usable ciphertext was discarded; upstream token revocation is separate."
            : "This credential cannot be used. Review its cutoff, token and deployment key."}
      </p>
      <details>
        <summary>Resource scope and credential identity</summary>
        <p className="hook-muted">
          Credential ID: <code>{credential.id}</code> / Revision{" "}
          {credential.revision}
        </p>
        {credential.settings.providerKind ===
        SECRET_PROVIDER_KIND.CLOUDFLARE ? (
          <p>
            Account: <code>{credential.settings.scope.accountId}</code>
          </p>
        ) : null}
        <ul
          className="provider-resource-list"
          tabIndex={0}
          aria-label="Allowed provider resources"
        >
          {resources.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </details>
      <div className="secret-actions">
        <Button
          variant="outline"
          disabled={busy || !storageReady}
          onClick={() => onEdit(credential)}
        >
          {credential.status === "retired"
            ? "Restore with a new token"
            : "Edit scope or rotate"}
        </Button>
        {credential.status === "available" ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              onConnect(credential.id, credential.settings.providerKind)
            }
          >
            {credential.settings.providerKind ===
            PROVIDER_CREDENTIAL_KIND.REPOSITORY
              ? "Use for maintenance"
              : "Connect resources"}
          </Button>
        ) : null}
        {credential.status !== "retired" ? (
          <Button variant="ghost" disabled={busy} onClick={() => void retire()}>
            {retiring ? "Preparing retirement..." : "Review retirement"}
          </Button>
        ) : null}
      </div>
      {credential.status === "available" ? (
        <div className="provider-verification">
          <div className="hook-field">
            <label htmlFor={"verify-" + credential.id}>
              Check configuration access for
            </label>
            <Select
              value={resource}
              onValueChange={(value) => {
                setResource(value);
                setEvidence(null);
                setError(null);
              }}
              disabled={busy}
            >
              <SelectTrigger id={"verify-" + credential.id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {resources.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {credential.settings.providerKind !==
          PROVIDER_CREDENTIAL_KIND.REPOSITORY ? (
            <div className="hook-field">
              <label htmlFor={"verify-kind-" + credential.id}>
                Configuration kind
              </label>
              <Select
                value={entryKind}
                onValueChange={(value) => {
                  setEntryKind(value as SecretEntryKind);
                  setEvidence(null);
                  setError(null);
                }}
                disabled={busy}
              >
                <SelectTrigger id={"verify-kind-" + credential.id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SECRET_ENTRY_KIND.SECRET}>
                    Secret metadata
                  </SelectItem>
                  <SelectItem value={SECRET_ENTRY_KIND.VARIABLE}>
                    Variable values
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {credential.settings.providerKind === SECRET_PROVIDER_KIND.GITHUB ? (
            <>
              <div className="hook-field">
                <label htmlFor={"verify-scope-" + credential.id}>
                  GitHub scope
                </label>
                <Select
                  value={scope}
                  onValueChange={(value) => {
                    setScope(value);
                    setEvidence(null);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={"verify-scope-" + credential.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organization">
                      Organization configuration shared with repository
                    </SelectItem>
                    <SelectItem value="repository">
                      Repository configuration
                    </SelectItem>
                    <SelectItem value="environment">
                      Environment configuration
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {scope === "environment" ? (
                <label className="hook-field">
                  Environment name
                  <Input
                    value={environmentName}
                    maxLength={255}
                    disabled={busy}
                    onChange={(event) => {
                      setEnvironmentName(event.target.value);
                      setEvidence(null);
                    }}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || (scope === "environment" && !environmentName)}
            onClick={() => void verify()}
          >
            <Check size={16} aria-hidden="true" />
            {verifying ? "Checking access..." : "Verify read access"}
          </Button>
        </div>
      ) : null}
      {evidence ? (
        <p className="hook-notice" role="status">
          {evidence.evidence === "repository-readable"
            ? "Repository metadata"
            : evidence.evidence === "variable-values-readable"
              ? "Variable values"
              : "Secret metadata"}{" "}
          {evidence.evidence === "variable-values-readable"
            ? "were"
            : "was"}{" "}
          readable for {evidence.resourceName}
          {evidence.scope.kind === "environment"
            ? " / environment " + evidence.scope.name
            : evidence.scope.kind === "organization"
              ? " / organization " + evidence.scope.name
              : ""}{" "}
          at <SecretTime value={evidence.verifiedAt} />. This does not verify
          write permission, other resources, or runtime use.
        </p>
      ) : null}
      {error ? <SecretError error={error} /> : null}
    </article>
  );
}

export function ProviderAccessView({
  snapshot,
  onConnect,
  purpose = "secrets",
}: {
  snapshot: Snapshot;
  onConnect: (reference: string, kind: ProviderCredentialKind) => void;
  purpose?: "secrets" | "repositories";
}) {
  const workspaceId = snapshot.workspace.id;
  const queryPrefix =
    purpose === "repositories" ? "dependency-access" : "secrets";
  const [params, setParams] = useSearchParams();
  const [retired, setRetired] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [editing, setEditing] = useState<ProviderCredential | "new" | null>(
    null,
  );
  const focus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cursor = cursors.at(-1);
  const planId = params.get("credentialReview");
  useEffect(() => {
    if (!planId) heading.current?.focus();
  }, [planId]);
  const query = useQuery({
    queryKey: [queryPrefix, workspaceId, "credentials", retired, cursor],
    queryFn: ({ signal }) =>
      command<CredentialsPage>(
        "provider_credentials_list",
        {
          workspaceId,
          purpose,
          retired,
          ...(cursor ? { before: cursor } : {}),
        },
        signal,
      ),
    enabled: !planId,
    retry: false,
  });
  const legacy = useQuery({
    queryKey: ["secrets", workspaceId, "providers"],
    queryFn: ({ signal }) =>
      command<SecretProviderReference[]>(
        "secrets_providers",
        { workspaceId },
        signal,
      ),
    enabled: !planId && purpose === "secrets",
    retry: false,
  });
  const data = query.error ? undefined : query.data;
  const deploymentReferences =
    (purpose === "secrets" && !legacy.error ? legacy.data : undefined)?.filter(
      (item) => !item.id.startsWith(MANAGED_CREDENTIAL_PREFIX),
    ) ?? [];
  function openReview(review: ProviderCredentialReview) {
    setEditing(null);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("credentialReview", review.id);
      return next;
    });
  }
  function closeReview() {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("credentialReview");
      return next;
    });
  }
  function edit(value: ProviderCredential | "new") {
    focus.current = document.activeElement as HTMLElement;
    setEditing(value);
  }
  if (planId)
    return (
      <ProviderCredentialReviewPanel
        key={planId}
        workspaceId={workspaceId}
        queryPrefix={queryPrefix}
        planId={planId}
        onClose={closeReview}
        onConnect={(reference, kind) => {
          closeReview();
          onConnect(reference, kind);
        }}
      />
    );
  return (
    <section className="hook-section" aria-labelledby="provider-access-heading">
      <div className="hook-section-heading">
        <div>
          <h2 ref={heading} tabIndex={-1} id="provider-access-heading">
            {purpose === "repositories"
              ? "Repository write access"
              : "Provider access"}
          </h2>
          <p>
            {purpose === "repositories"
              ? "Dedicated access for reviewed maintenance branches and pull requests. Read-only sources and Secrets stay separate."
              : "Manage the credentials HQ uses to connect to your providers."}
          </p>
        </div>
        <div className="secret-actions">
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh access
          </Button>
          <Button disabled={!data?.storageReady} onClick={() => edit("new")}>
            <Plus size={16} aria-hidden="true" /> Add provider access
          </Button>
        </div>
      </div>
      {data && !data.storageReady ? (
        <p className="hook-notice">
          Private credential storage is not enabled on this deployment. Its
          operator must install and independently back up the encryption keyring
          before UI setup can save tokens. Deployment-managed connections remain
          separate and can still work.
        </p>
      ) : null}
      <nav className="hook-views" aria-label="Credential lifecycle">
        <Button
          variant={!retired ? "secondary" : "ghost"}
          aria-current={!retired ? "page" : undefined}
          onClick={() => {
            setRetired(false);
            setCursors([null]);
          }}
        >
          Active access
        </Button>
        <Button
          variant={retired ? "secondary" : "ghost"}
          aria-current={retired ? "page" : undefined}
          onClick={() => {
            setRetired(true);
            setCursors([null]);
          }}
        >
          Retired credentials
        </Button>
      </nav>
      {query.isPending ? <p role="status">Loading provider access...</p> : null}
      {query.error ? <SecretError error={query.error} /> : null}
      {data ? (
        <>
          <div className="provider-access-list">
            {data.items.map((credential) => (
              <ProviderCredentialRow
                key={
                  credential.id +
                  ":" +
                  credential.revision +
                  ":" +
                  credential.status
                }
                workspaceId={workspaceId}
                credential={credential}
                storageReady={data.storageReady}
                onEdit={edit}
                onReview={openReview}
                onConnect={onConnect}
              />
            ))}
          </div>
          {!data.items.length ? (
            <div className="empty-state">
              <KeyRound size={28} aria-hidden="true" />
              <h3>
                {retired
                  ? "No retired credentials"
                  : "No UI-managed provider access"}
              </h3>
              <p>
                {retired
                  ? "Retired access retains metadata and audit history, not usable local token ciphertext."
                  : purpose === "repositories"
                    ? "Add a dedicated token with Contents and Pull requests write access, limit its repositories, and select it when preparing a dependency change."
                    : "Add a dedicated provider token, limit its resource scope, and then connect those resources to configuration inventory."}
              </p>
            </div>
          ) : null}
          <SecretPagination
            page={cursors.length}
            previous={
              cursors.length > 1
                ? () => setCursors((items) => items.slice(0, -1))
                : undefined
            }
            next={
              data.nextCursor
                ? () => setCursors((items) => [...items, data.nextCursor])
                : undefined
            }
            busy={query.isFetching}
            label="Provider credential pages"
          />
        </>
      ) : null}
      {deploymentReferences.length ? (
        <details className="hook-signals">
          <summary>Deployment-managed provider access</summary>
          <p>
            These references are configured on the Worker, outside UI-managed
            credential storage. Their values are never returned here.
          </p>
          <div className="secret-list">
            {deploymentReferences.map((reference) => (
              <article key={reference.kind + reference.id}>
                <div>
                  <strong>{reference.name}</strong>
                  <p className="hook-muted">
                    {reference.available
                      ? "Configured"
                      : "Unavailable or expired"}{" "}
                    /{" "}
                    {reference.writable
                      ? "Reviewed writes allowed"
                      : "Read only"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={!reference.available}
                  onClick={() => onConnect(reference.id, reference.kind)}
                >
                  Connect resources
                </Button>
              </article>
            ))}
          </div>
        </details>
      ) : null}
      {purpose === "secrets" && legacy.error ? (
        <SecretError error={legacy.error} />
      ) : null}
      {editing ? (
        <ProviderCredentialEditor
          snapshot={snapshot}
          initial={editing === "new" ? undefined : editing}
          initialKind={
            purpose === "repositories"
              ? PROVIDER_CREDENTIAL_KIND.REPOSITORY
              : SECRET_PROVIDER_KIND.GITHUB
          }
          returnFocus={focus.current}
          onClose={() => setEditing(null)}
          onReview={openReview}
        />
      ) : null}
    </section>
  );
}
