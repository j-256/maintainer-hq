import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  History,
  KeyRound,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  SECRET_ENTRY_KIND,
  SECRET_MANAGEMENT,
  SECRET_PROVIDER_KIND,
  type SecretConnection,
  type SecretDestination,
  type SecretEntryKind,
  type SecretInventory,
  type SecretReview,
  type SecretScope,
  type SecretProviderKind,
  type SecretInventoryItem,
} from "../shared/secrets";
import type { ManagedConfiguration } from "../shared/managed-configurations";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { SecretConnectionEditor } from "./secret-connection";
import { ProviderAccessView } from "./provider-access";
import { SecretDraftEditor } from "./secret-draft";
import { SecretReviewPanel } from "./secret-review";
import {
  ManagedConfigurationsView,
  ManagedConfigurationReviewPanel,
} from "./managed-configurations";
import {
  ManagedConfigurationEditor,
  type ManagedConfigurationSeed,
} from "./managed-configuration-editor";
import { ResourceProjectEditor } from "./resource-project";
import { RepositoryContext } from "./resource-repositories";
import {
  SecretError,
  SecretPagination,
  SecretTargetPicker,
  SecretTime,
  secretScopeLabel,
  type SecretSelection,
} from "./secret-components";
import "./sources.css";
import "./hooks.css";
import "./secrets.css";

type HistoryResult = {
  items: {
    id: string;
    stage: SecretReview["stage"];
    createdAt: string;
    destinations: {
      name: string;
      resource: { label: string };
      scope: SecretScope;
    }[];
  }[];
  nextCursor: string | null;
};
const STAGE_LABEL = {
  "awaiting-input": "Awaiting supplied value",
  reviewed: "Ready for confirmation",
  accepted: "Intent accepted; inspect receipts",
  cancelled: "Cancelled",
} as const;
function SecretHistory({
  workspaceId,
  repositoryId,
  onReview,
}: {
  workspaceId: string;
  repositoryId?: string;
  onReview: (id: string) => void;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ["secrets", workspaceId, "history", repositoryId ?? null, cursor],
    queryFn: ({ signal }) =>
      command<HistoryResult>(
        "secrets_history",
        {
          workspaceId,
          ...(repositoryId ? { repositoryId } : {}),
          ...(cursor ? { before: cursor } : {}),
        },
        signal,
      ),
    retry: false,
  });
  return (
    <section className="hook-section" aria-label="Secret operation history">
      <div className="hook-section-heading">
        <div>
          <h2>Operations</h2>
          <p>
            Prepared reviews, supplied-value distributions, and retained-input
            recovery.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh operations
        </Button>
      </div>
      {query.error ? <SecretError error={query.error} /> : null}
      {query.isPending ? (
        <p role="status">Loading operation history...</p>
      ) : null}
      {query.data ? (
        <>
          <div className="secret-list">
            {query.data.items.map((item) => (
              <article key={item.id}>
                <div className="secret-target-facts">
                  <strong>
                    {item.destinations
                      .map((target) => target.name)
                      .filter(
                        (value, index, all) => all.indexOf(value) === index,
                      )
                      .join(", ")}
                  </strong>
                  <span>
                    {item.destinations.length}{" "}
                    {item.destinations.length === 1
                      ? "destination"
                      : "destinations"}
                  </span>
                  <span className="hook-muted">
                    <SecretTime value={item.createdAt} />
                  </span>
                  <Badge variant="outline">{STAGE_LABEL[item.stage]}</Badge>
                </div>
                <Button variant="outline" onClick={() => onReview(item.id)}>
                  Open review <ArrowRight size={16} aria-hidden="true" />
                </Button>
              </article>
            ))}
          </div>
          {!query.data.items.length ? (
            <div className="empty-state">
              <History size={28} aria-hidden="true" />
              <h3>No secret operations recorded</h3>
              <p>
                Prepare a distribution to review its destinations and track its
                outcomes here.
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
              query.data.nextCursor
                ? () =>
                    setCursors((items) => [...items, query.data!.nextCursor])
                : undefined
            }
            busy={query.isFetching}
            label="Secret operation pages"
          />
        </>
      ) : null}
    </section>
  );
}
function SecretInventoryView({
  snapshot,
  connections,
  repositoryId,
  onDistribute,
  onMove,
  onSettings,
  onManage,
  onOpenManaged,
}: {
  snapshot: Snapshot;
  connections: SecretConnection[];
  repositoryId?: string;
  onDistribute: (value: SecretDestination) => void;
  onMove: (value: SecretDestination) => void;
  onSettings: (connection: SecretConnection) => void;
  onManage: (seed: ManagedConfigurationSeed) => void;
  onOpenManaged: (configurationId: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const [params] = useSearchParams();
  const [projectLinking, setProjectLinking] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<SecretSelection>(() => {
    const requestedConnection = params.get("connection");
    const requestedResource = params.get("resource");
    const first = requestedConnection
      ? connections.find((item) => item.id === requestedConnection)
      : connections.find(
          (item) =>
            item.available &&
            item.enabled &&
            item.resources.some(
              (resource) =>
                !repositoryId || resource.repositoryIds.includes(repositoryId),
            ),
        );
    const resource = requestedResource
      ? first?.resources.find(
          (item) =>
            item.id === requestedResource &&
            (!repositoryId || item.repositoryIds.includes(repositoryId)),
        )
      : first?.resources.find(
          (item) => !repositoryId || item.repositoryIds.includes(repositoryId),
        );
    return {
      connectionId: requestedConnection ?? first?.id ?? "",
      resourceId: requestedResource ?? resource?.id ?? "",
      scope: {
        kind:
          first?.providerKind === "cloudflare-workers"
            ? "worker"
            : "repository",
      },
      name: "",
    };
  });
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [entryKind, setEntryKind] = useState<SecretEntryKind>(
    SECRET_ENTRY_KIND.SECRET,
  );
  const selected = connections.find(
    (item) => item.id === selection.connectionId,
  );
  const eligible = Boolean(
    selected?.enabled &&
    selected.available &&
    selected.capabilities?.entryKinds.includes(entryKind) &&
    selected.resources.some(
      (item) =>
        item.id === selection.resourceId &&
        (!repositoryId || item.repositoryIds.includes(repositoryId)),
    ),
  );
  const query = useQuery({
    queryKey: [
      "secrets",
      workspaceId,
      "inventory",
      selection.connectionId,
      selected?.revision,
      selection.resourceId,
      selection.scope,
      entryKind,
      page,
    ],
    queryFn: ({ signal }) =>
      command<SecretInventory>(
        "secrets_inventory",
        {
          workspaceId,
          connectionId: selection.connectionId,
          target: { resourceId: selection.resourceId, scope: selection.scope },
          entryKind,
          page,
        },
        signal,
      ),
    enabled: eligible,
    retry: false,
  });
  const secretWritable =
    entryKind === SECRET_ENTRY_KIND.SECRET &&
    snapshot.capabilities.includes(CAPABILITY.SECRETS) &&
    selected?.writable &&
    selected.capabilities?.secretMutationScopeKinds.includes(
      selection.scope.kind,
    ) &&
    eligible;
  const canManage =
    snapshot.capabilities.includes(CAPABILITY.SECRETS) &&
    selected?.providerKind === SECRET_PROVIDER_KIND.GITHUB &&
    ["repository", "environment"].includes(selection.scope.kind) &&
    eligible;
  const entryLabel =
    entryKind === SECRET_ENTRY_KIND.SECRET ? "secret" : "variable";
  const destination = (name: string): SecretDestination => ({
    connectionId: selected!.id,
    connectionRevision: selected!.revision,
    target: { resourceId: selection.resourceId, scope: selection.scope },
    name,
  });
  const manage = (item: SecretInventoryItem) =>
    onManage({
      entryKind: item.kind,
      value: item.value,
      destination: destination(item.name),
    });
  return (
    <section
      className="hook-section"
      aria-label="Provider configuration inventory"
    >
      <div className="secret-panel">
        <div className="secret-kind-picker">
          <span>Inventory kind</span>
          <div
            className="secret-actions"
            role="group"
            aria-label="Inventory kind"
          >
            <Button
              disabled={Boolean(
                selected?.capabilities &&
                  !selected.capabilities.entryKinds.includes(
                    SECRET_ENTRY_KIND.SECRET,
                  ),
              )}
              variant={
                entryKind === SECRET_ENTRY_KIND.SECRET ? "default" : "outline"
              }
              aria-pressed={entryKind === SECRET_ENTRY_KIND.SECRET}
              onClick={() => {
                setEntryKind(SECRET_ENTRY_KIND.SECRET);
                setPage(1);
                setFilter("");
              }}
            >
              Secrets
            </Button>
            <Button
              disabled={Boolean(
                selected?.capabilities &&
                  !selected.capabilities.entryKinds.includes(
                    SECRET_ENTRY_KIND.VARIABLE,
                  ),
              )}
              variant={
                entryKind === SECRET_ENTRY_KIND.VARIABLE
                  ? "default"
                  : "outline"
              }
              aria-pressed={entryKind === SECRET_ENTRY_KIND.VARIABLE}
              onClick={() => {
                setEntryKind(SECRET_ENTRY_KIND.VARIABLE);
                setPage(1);
                setFilter("");
              }}
            >
              Variables
            </Button>
          </div>
        </div>
        <SecretTargetPicker
          workspaceId={workspaceId}
          connections={connections}
          value={selection}
          onChange={(value) => {
            setSelection(value);
            setPage(1);
            setFilter("");
          }}
          includeName={false}
          writable={false}
          repositoryId={repositoryId}
        />
        <div className="secret-actions">
          <Button
            ref={projectButton}
            variant="outline"
            disabled={
              !selected?.resources.some(
                (item) =>
                  item.id === selection.resourceId &&
                  (!repositoryId || item.repositoryIds.includes(repositoryId)),
              )
            }
            onClick={() => setProjectLinking(true)}
          >
            Project association
          </Button>
          <Button
            variant="outline"
            disabled={!eligible || query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh {entryLabel}s
          </Button>
          {selected && snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
            <Button variant="ghost" onClick={() => onSettings(selected)}>
              <Settings2 size={16} aria-hidden="true" /> Connection settings
            </Button>
          ) : null}
        </div>
        {!eligible ? (
          <p className="hook-notice">
            The selected connection and resource are not available for reading.
            Choose an available connection and enrolled resource to inspect
            metadata.
          </p>
        ) : null}
      </div>
      {query.error ? <SecretError error={query.error} /> : null}
      {eligible && query.isPending ? (
        <p role="status">Reading {entryLabel}s from the provider...</p>
      ) : null}
      {eligible && query.data ? (
        <>
          <div className="hook-section-heading">
            <div>
              <h2>
                {secretScopeLabel(query.data.target.scope)} {entryLabel}s
              </h2>
              <p>
                {query.data.resource.label}. Read{" "}
                <SecretTime value={query.data.observedAt} />.
              </p>
            </div>
            {secretWritable ? (
              <Button onClick={() => onDistribute(destination(""))}>
                <Plus size={16} aria-hidden="true" /> Supply a new secret
              </Button>
            ) : null}
          </div>
          {entryKind === SECRET_ENTRY_KIND.VARIABLE ? (
            <p className="hook-notice">
              These values are live provider-declared non-secret configuration.
              HQ-managed variables retain an explicit desired value; unmanaged
              values stay provider-owned. Do not use variables for credentials
              or other sensitive values.
              {query.data.excludedBindings
                ? " Other provider binding kinds are excluded from this inventory."
                : ""}
              {query.data.providerKind === "cloudflare-workers" &&
              query.data.workerDeployment === null
                ? " A gradual deployment is active: this list does not prove that every serving version has the same variable values."
                : ""}
            </p>
          ) : query.data.providerKind === "cloudflare-workers" ? (
            <p className="hook-notice">
              Text secret names are case-sensitive. Cloudflare does not expose
              their values, timestamps or individual secret versions. HQ
              compares serving Worker deployments, not values.
              {query.data.excludedBindings
                ? " Cryptographic key bindings are excluded from this text-secret workspace."
                : ""}
              {query.data.workerDeployment === null
                ? " A gradual deployment is active: this list does not prove that every serving version has the same bindings. Changes require one fully serving version."
                : ""}
            </p>
          ) : null}
          {query.data.target.scope.kind === "organization" ? (
            <p className="hook-notice">
              GitHub reports these organization entries as available to the
              selected repository. This is not a complete organization-wide
              inventory.
            </p>
          ) : null}
          <label className="hook-field">
            Filter this page
            <Input
              value={filter}
              placeholder={
                entryKind === SECRET_ENTRY_KIND.SECRET
                  ? "Secret name"
                  : "Variable name"
              }
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="secret-list">
            {query.data.items
              .filter((item) =>
                item.name.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((item) => (
                <article key={item.name}>
                  <div className="secret-target-facts">
                    <strong className="secret-name">{item.name}</strong>
                    <span className="hook-muted">
                      {item.updatedAt ? (
                        <>
                          Updated <SecretTime value={item.updatedAt} />
                        </>
                      ) : (
                        "Timestamp not provided by the provider"
                      )}
                    </span>
                    {item.value !== null ? (
                      <pre className="secret-variable-value">
                        <code>{item.value}</code>
                      </pre>
                    ) : null}
                  </div>
                  <div className="secret-actions">
                    <Badge variant="outline">
                      {item.kind === SECRET_ENTRY_KIND.SECRET
                        ? "Secret"
                        : item.valueFormat === "json"
                          ? "JSON variable"
                          : "Text variable"}
                    </Badge>
                    <Badge variant="outline">
                      {item.management === SECRET_MANAGEMENT.HQ
                        ? "HQ managed"
                        : "Unmanaged by HQ"}
                    </Badge>
                    {item.management === SECRET_MANAGEMENT.HQ &&
                    item.managedConfigurationId ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          onOpenManaged(item.managedConfigurationId!)
                        }
                      >
                        Open managed definition
                      </Button>
                    ) : canManage ? (
                      <Button variant="outline" onClick={() => manage(item)}>
                        Manage in HQ
                      </Button>
                    ) : null}
                    {secretWritable ? (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => onDistribute(destination(item.name))}
                        >
                          Distribute supplied value
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => onMove(destination(item.name))}
                        >
                          Change scope
                        </Button>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
          </div>
          {!query.data.items.length ? (
            <p className="hook-muted">
              No {entryLabel}s on this provider page.
            </p>
          ) : query.data.items.every(
              (item) => !item.name.toLowerCase().includes(filter.toLowerCase()),
            ) ? (
            <p className="hook-muted">
              No names match on this page. Clear the filter or browse another
              page.
            </p>
          ) : null}
          {entryKind === SECRET_ENTRY_KIND.SECRET ? (
            <p className="hook-muted">
              Names and timestamps are metadata only. HQ cannot read stored
              secret values or confirm whether they work in an application.
              Refresh explicitly after external provider changes.
            </p>
          ) : (
            <p className="hook-muted">
              Unmanaged values are read live and not persisted by HQ. Managed
              variables retain a desired non-secret value for comparison.
              Presence does not confirm that an application uses them.
            </p>
          )}
          {query.data.truncated ? (
            <p className="hook-notice">
              The provider page limit was reached. More names may exist beyond
              this bounded inventory.
            </p>
          ) : null}
          <SecretPagination
            page={page}
            previous={
              page > 1
                ? () => {
                    setPage(page - 1);
                    setFilter("");
                  }
                : undefined
            }
            next={
              query.data.nextPage
                ? () => {
                    setPage(query.data!.nextPage!);
                    setFilter("");
                  }
                : undefined
            }
            busy={query.isFetching}
            label={
              entryKind === SECRET_ENTRY_KIND.SECRET
                ? "Secret name pages"
                : "Variable pages"
            }
          />
        </>
      ) : null}
      {projectLinking && selected ? (
        <ResourceProjectEditor
          key={selected.id + selection.resourceId}
          snapshot={snapshot}
          reference={{
            workspaceId,
            kind: "secret",
            connectionId: selected.id,
            resourceKey: selection.resourceId,
          }}
          suggestedProjectId={params.get("project") ?? undefined}
          returnFocus={projectButton.current}
          onClose={() => setProjectLinking(false)}
          onSaved={() => setProjectLinking(false)}
        />
      ) : null}
    </section>
  );
}
export function SecretsView({
  snapshot,
  repositoryId,
}: {
  snapshot: Snapshot;
  repositoryId?: string;
}) {
  const workspaceId = snapshot.workspace.id;
  const [params, setParams] = useSearchParams();
  const isOwner = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const view =
    params.get("view") === "providers"
      ? "providers"
      : params.get("view") === "operations"
        ? "operations"
        : params.get("view") === "managed"
          ? "managed"
          : "inventory";
  const [editing, setEditing] = useState<SecretConnection | "new" | null>(null);
  const [initialProviderRef, setInitialProviderRef] = useState<
    string | undefined
  >();
  const [initialProviderKind, setInitialProviderKind] = useState<
    SecretProviderKind | undefined
  >();
  const [draft, setDraft] = useState<{
    destinations?: SecretDestination[];
    source?: SecretDestination;
  } | null>(null);
  const [managedEditing, setManagedEditing] = useState<{
    initial?: ManagedConfiguration;
    seed?: ManagedConfigurationSeed;
  } | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const query = useQuery({
    queryKey: ["secrets", workspaceId, "connections"],
    queryFn: ({ signal }) =>
      command<SecretConnection[]>(
        "secrets_connections",
        { workspaceId },
        signal,
      ),
    retry: false,
    enabled: view !== "providers" || isOwner,
  });
  const connections = query.data ?? [];
  const relevant = repositoryId
    ? connections.filter((item) =>
        item.resources.some((resource) =>
          resource.repositoryIds.includes(repositoryId),
        ),
      )
    : connections;
  const canWrite = snapshot.capabilities.includes(CAPABILITY.SECRETS);
  const reviewId = params.get("review");
  const configurationReviewId = params.get("configurationReview");
  const selectedConfigurationId = params.get("configuration");
  const heading = useRef<HTMLHeadingElement>(null);
  const activeReviewId = configurationReviewId ?? reviewId;
  const previousReviewId = useRef(activeReviewId);
  useEffect(() => {
    if (previousReviewId.current && !activeReviewId) heading.current?.focus();
    previousReviewId.current = activeReviewId;
  }, [activeReviewId]);
  function navigate(changes: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  }
  function openReview(id: string) {
    navigate({
      review: id,
      configurationReview: null,
      cleanup: null,
      view: "operations",
    });
  }
  function openConfigurationReview(id: string) {
    navigate({
      configurationReview: id,
      review: null,
      cleanup: null,
      view: "managed",
    });
  }
  function newDraft(value: NonNullable<typeof draft>) {
    focus.current = document.activeElement as HTMLElement;
    setDraft(value);
  }
  function edit(
    value: SecretConnection | "new",
    providerRef?: string,
    providerKind?: SecretProviderKind,
  ) {
    focus.current = document.activeElement as HTMLElement;
    setInitialProviderRef(providerRef);
    setInitialProviderKind(providerKind);
    setEditing(value);
  }
  function editManaged(value: {
    initial?: ManagedConfiguration;
    seed?: ManagedConfigurationSeed;
  }) {
    focus.current = document.activeElement as HTMLElement;
    setManagedEditing(value);
  }
  return (
    <div className="secrets-workspace">
      {!repositoryId ? (
        <RepositoryContext snapshot={snapshot} section="secrets" />
      ) : null}
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {repositoryId ? "REPOSITORY CONTEXT" : "WORKSPACE"}
          </div>
          {repositoryId ? (
            <h2 ref={heading} tabIndex={-1}>
              Secrets
            </h2>
          ) : (
            <h1 ref={heading} tabIndex={-1}>
              Secrets
            </h1>
          )}
          <p>
            Provider inventory, managed desired configuration, and reviewed
            supplied-secret changes.
          </p>
        </div>
        {!reviewId &&
        !configurationReviewId &&
        (view !== "providers" || isOwner) &&
        !(view === "providers" && params.get("credentialReview")) ? (
          <div className="secret-actions">
            {snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
              <Button variant="outline" onClick={() => edit("new")}>
                <Plus size={16} aria-hidden="true" /> Connect provider
              </Button>
            ) : null}
            {canWrite ? (
              <Button
                disabled={
                  !connections.some(
                    (item) => item.available && item.enabled && item.writable,
                  )
                }
                onClick={() => newDraft({})}
              >
                <KeyRound size={16} aria-hidden="true" /> Distribute value
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {configurationReviewId ? (
        <ManagedConfigurationReviewPanel
          key={configurationReviewId}
          snapshot={snapshot}
          planId={configurationReviewId}
          onClose={() => navigate({ configurationReview: null })}
        />
      ) : reviewId ? (
        <SecretReviewPanel
          key={reviewId}
          snapshot={snapshot}
          reviewId={reviewId}
          onClose={() => navigate({ review: null, cleanup: null })}
          onReview={openReview}
          onNewDraft={(destinations, source) =>
            newDraft({ destinations, source })
          }
        />
      ) : (
        <>
          <nav className="hook-views" aria-label="Secrets views">
            <Button
              variant={view === "inventory" ? "secondary" : "ghost"}
              aria-current={view === "inventory" ? "page" : undefined}
              onClick={() => navigate({ view: "inventory" })}
            >
              Inventory
            </Button>
            <Button
              variant={view === "operations" ? "secondary" : "ghost"}
              aria-current={view === "operations" ? "page" : undefined}
              onClick={() => navigate({ view: "operations" })}
            >
              Operations
            </Button>
            <Button
              variant={view === "managed" ? "secondary" : "ghost"}
              aria-current={view === "managed" ? "page" : undefined}
              onClick={() =>
                navigate({
                  view: "managed",
                  review: null,
                  cleanup: null,
                  configurationReview: null,
                })
              }
            >
              Managed
            </Button>
            {isOwner ? (
              <Button
                variant={view === "providers" ? "secondary" : "ghost"}
                aria-current={view === "providers" ? "page" : undefined}
                onClick={() => navigate({ view: "providers" })}
              >
                Provider access
              </Button>
            ) : null}
          </nav>
          {query.error ? (
            <>
              <SecretError error={query.error} />
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry Secrets connections
              </Button>
            </>
          ) : null}
          {view === "providers" && !isOwner ? (
            <section className="empty-state">
              <h2>Provider access requires an Owner</h2>
              <p>
                Only workspace Owners can manage provider credentials. Use
                Inventory to browse the provider configuration available to
                you.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  navigate({ view: "inventory", credentialReview: null })
                }
              >
                Browse Secrets inventory
              </Button>
            </section>
          ) : view === "providers" ? (
            <ProviderAccessView
              snapshot={snapshot}
              onConnect={(reference, kind) => {
                if (kind !== "github-repositories") edit("new", reference, kind);
              }}
            />
          ) : view === "operations" ? (
            <SecretHistory
              workspaceId={workspaceId}
              repositoryId={repositoryId}
              onReview={openReview}
            />
          ) : view === "managed" ? (
            <ManagedConfigurationsView
              snapshot={snapshot}
              connections={relevant}
              repositoryId={repositoryId}
              selectedConfigurationId={selectedConfigurationId}
              onSelect={(configurationId) =>
                navigate({ configuration: configurationId })
              }
              onCreate={() => editManaged({})}
              onEdit={(initial) => editManaged({ initial })}
              onReview={openConfigurationReview}
            />
          ) : query.isPending ? (
            <p role="status">Loading Secrets connections...</p>
          ) : query.data ? (
            relevant.length ? (
              <SecretInventoryView
                key={JSON.stringify([
                  repositoryId,
                  params.get("connection"),
                  params.get("resource"),
                ])}
                snapshot={snapshot}
                connections={relevant}
                repositoryId={repositoryId}
                onDistribute={(value) => newDraft({ destinations: [value] })}
                onMove={(value) =>
                  newDraft({ source: value, destinations: [value] })
                }
                onSettings={edit}
                onManage={(seed) => editManaged({ seed })}
                onOpenManaged={(configurationId) =>
                  navigate({
                    view: "managed",
                    configuration: configurationId,
                  })
                }
              />
            ) : (
              <section className="empty-state">
                <KeyRound size={28} aria-hidden="true" />
                <h2>
                  {repositoryId
                    ? "No Secrets resources linked here"
                    : "Connect your first Secrets provider"}
                </h2>
                <p>
                  {repositoryId
                    ? "Enroll this repository in a Secrets connection to browse its configuration here. Historical operations remain available in Operations."
                    : "Set up provider access to browse secret names and non-secret variables, then distribute secret values you supply."}
                </p>
                {isOwner ? (
                  <Button
                    variant="outline"
                    onClick={() => navigate({ view: "providers" })}
                  >
                    Set up provider access
                  </Button>
                ) : null}
              </section>
            )
          ) : null}
        </>
      )}
      {editing ? (
        <SecretConnectionEditor
          snapshot={snapshot}
          initialProviderRef={initialProviderRef}
          initialProviderKind={initialProviderKind}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void query.refetch();
          }}
          returnFocus={focus.current}
        />
      ) : null}
      {draft ? (
        <SecretDraftEditor
          snapshot={snapshot}
          connections={connections}
          initial={draft.destinations}
          source={draft.source}
          onClose={() => setDraft(null)}
          onPrepared={openReview}
          returnFocus={focus.current}
        />
      ) : null}
      {managedEditing ? (
        <ManagedConfigurationEditor
          snapshot={snapshot}
          connections={connections}
          initial={managedEditing.initial}
          seed={managedEditing.seed}
          onClose={() => setManagedEditing(null)}
          onSaved={(configuration) => {
            setManagedEditing(null);
            navigate({
              view: "managed",
              configuration: configuration.id,
              configurationReview: null,
              review: null,
            });
          }}
          returnFocus={focus.current}
        />
      ) : null}
    </div>
  );
}
