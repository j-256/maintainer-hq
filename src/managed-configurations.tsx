import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  History,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_ACTION,
  MANAGED_CONFIGURATION_STATUS,
  type ManagedConfiguration,
  type ManagedConfigurationObservation,
  type ManagedConfigurationReview,
  type ManagedConfigurationStatus,
} from "../shared/managed-configurations";
import {
  SECRET_ENTRY_KIND,
  type SecretConnection,
} from "../shared/secrets";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { command } from "./lib/api";
import {
  SecretError,
  SecretTime,
  secretScopeLabel,
  useSecretClock,
} from "./secret-components";

type ManagedHistoryItem = {
  id: string;
  planId: string;
  configurationId: string;
  status: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

const STATUS_LABELS = {
  [MANAGED_CONFIGURATION_STATUS.IN_SYNC]: "In sync",
  [MANAGED_CONFIGURATION_STATUS.MISSING]: "Missing",
  [MANAGED_CONFIGURATION_STATUS.DRIFTED]: "Drifted",
  [MANAGED_CONFIGURATION_STATUS.UNEXPECTED]: "Unexpected",
  [MANAGED_CONFIGURATION_STATUS.UNVERIFIABLE]: "Presence only",
  [MANAGED_CONFIGURATION_STATUS.UNAVAILABLE]: "Unavailable",
} as const;
const ACTION_LABELS = {
  [MANAGED_CONFIGURATION_ACTION.CREATE]: "Create variable",
  [MANAGED_CONFIGURATION_ACTION.UPDATE]: "Update variable",
  [MANAGED_CONFIGURATION_ACTION.DELETE]: "Delete variable",
  [MANAGED_CONFIGURATION_ACTION.NONE]: "No provider change",
} as const;
const RECEIPT_REASON_LABELS = {
  credential_read_only: "The provider credential is read only.",
  rate_limited: "The provider rate limited the request.",
  provider_rejected: "The provider rejected the request.",
  provider_result_uncertain: "Provider acceptance remains uncertain.",
  preflight_changed: "Live provider state changed after review.",
  authority_changed:
    "Workspace or provider authority changed before submission.",
} as const;

function statusVariant(status: ManagedConfigurationObservation["status"]) {
  if (status === MANAGED_CONFIGURATION_STATUS.IN_SYNC) return "secondary";
  if (
    status === MANAGED_CONFIGURATION_STATUS.DRIFTED ||
    status === MANAGED_CONFIGURATION_STATUS.UNEXPECTED
  )
    return "destructive";
  return "outline";
}

function ManagedHistory({
  workspaceId,
  repositoryId,
  onReview,
}: {
  workspaceId: string;
  repositoryId?: string;
  onReview: (planId: string) => void;
}) {
  const query = useQuery({
    queryKey: [
      "secrets",
      workspaceId,
      "managed-history",
      repositoryId ?? null,
    ],
    queryFn: ({ signal }) =>
      command<ManagedHistoryItem[]>(
        "secrets_configuration_history",
        { workspaceId, ...(repositoryId ? { repositoryId } : {}) },
        signal,
      ),
    retry: false,
  });
  return (
    <section className="hook-section" aria-label="Managed operation history">
      <div className="hook-section-heading">
        <div>
          <h2>Managed operation history</h2>
          <p>Retained reviews and receipts for provider variable changes.</p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh history
        </Button>
      </div>
      {query.error ? <SecretError error={query.error} /> : null}
      {query.isPending ? <p role="status">Loading managed history...</p> : null}
      {query.data?.length ? (
        <div className="secret-list">
          {query.data.map((item) => (
            <article key={item.id}>
              <div className="secret-target-facts">
                <strong>{item.summary}</strong>
                <span className="hook-muted">
                  Updated <SecretTime value={item.updatedAt} />
                </span>
                <Badge variant="outline">{item.status}</Badge>
              </div>
              <Button variant="outline" onClick={() => onReview(item.planId)}>
                Open receipt <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </article>
          ))}
        </div>
      ) : query.data ? (
        <div className="empty-state">
          <History size={28} aria-hidden="true" />
          <h3>No managed provider operations</h3>
          <p>Saved definitions appear above before any provider write occurs.</p>
        </div>
      ) : null}
    </section>
  );
}

function ManagedStatusDetails({
  snapshot,
  configuration,
  onBack,
  onEdit,
  onReview,
}: {
  snapshot: Snapshot;
  configuration: ManagedConfiguration;
  onBack: () => void;
  onEdit: (configuration: ManagedConfiguration) => void;
  onReview: (planId: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const canWrite = snapshot.capabilities.includes(CAPABILITY.SECRETS);
  const [planning, setPlanning] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const planIds = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey: [
      "secrets",
      workspaceId,
      "managed-status",
      configuration.id,
      configuration.revision,
    ],
    queryFn: ({ signal }) =>
      command<ManagedConfigurationStatus>(
        "secrets_configuration_status",
        { workspaceId, configurationId: configuration.id },
        signal,
      ),
    retry: false,
  });
  const current = query.data?.configuration ?? configuration;
  async function review(destinationIndex: number) {
    if (planning !== null) return;
    const connectionRevision =
      current.destinations[destinationIndex]?.destination.connectionRevision;
    if (connectionRevision === undefined) return;
    const planKey =
      current.revision + ":" + connectionRevision + ":" + destinationIndex;
    if (!planIds.current.has(planKey))
      planIds.current.set(planKey, crypto.randomUUID());
    setPlanning(destinationIndex);
    setError(null);
    try {
      const result = await command<ManagedConfigurationReview>(
        "secrets_configuration_plan",
        {
          workspaceId,
          configurationId: current.id,
          configurationRevision: current.revision,
          destinationIndex,
          planId: planIds.current.get(planKey),
        },
      );
      onReview(result.id);
    } catch (failure) {
      setError(failure);
      await query.refetch();
    } finally {
      setPlanning(null);
    }
  }
  return (
    <section className="hook-section" aria-labelledby="managed-status-title">
      <div className="hook-section-heading">
        <div>
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" /> All managed configurations
          </Button>
          <h2 id="managed-status-title">{current.label}</h2>
          <p>
            Revision {current.revision}. HQ owns the definition with no secret
            custody.
          </p>
        </div>
        <div className="secret-actions">
          {canWrite ? (
            <Button variant="outline" onClick={() => onEdit(current)}>
              <Settings2 size={16} aria-hidden="true" /> Edit definition
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh live status
          </Button>
        </div>
      </div>
      {query.isPending ? (
        <p role="status">Reading exact provider configuration...</p>
      ) : null}
      {query.error || error ? (
        <>
          <SecretError error={error ?? query.error} />
          <p className="hook-notice">
            Unavailable provider data is not treated as an absent entry. Reload
            the live status before preparing a change.
          </p>
        </>
      ) : null}
      {query.data ? (
        <div className="managed-status-list">
          {query.data.observations.map((observation) => {
            const desired = current.destinations[observation.destinationIndex];
            if (!desired) return null;
            return (
              <article key={observation.destinationIndex}>
                <div className="secret-target-facts">
                  <strong className="secret-name">
                    {desired.destination.name}
                  </strong>
                  <span>
                    {secretScopeLabel(desired.destination.target.scope)} /
                    desired {desired.desiredState}
                  </span>
                  <Badge variant={statusVariant(observation.status)}>
                    {STATUS_LABELS[observation.status]}
                  </Badge>
                  {current.entryKind === SECRET_ENTRY_KIND.VARIABLE ? (
                    <div className="managed-value-comparison">
                      <div>
                        <strong>Desired non-secret value</strong>
                        <pre className="secret-variable-value">
                          <code>{current.desiredValue}</code>
                        </pre>
                      </div>
                      <div>
                        <strong>Live provider value</strong>
                        {observation.item?.value !== null &&
                        observation.item?.value !== undefined ? (
                          <pre className="secret-variable-value">
                            <code>{observation.item.value}</code>
                          </pre>
                        ) : (
                          <p className="hook-muted">
                            {observation.error
                              ? "Value unavailable"
                              : "Entry absent"}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : null}
                  {observation.error ? (
                    <p className="hook-muted">{observation.error.message}</p>
                  ) : observation.observedAt ? (
                    <span className="hook-muted">
                      Read <SecretTime value={observation.observedAt} />
                    </span>
                  ) : null}
                </div>
                <div className="secret-actions">
                  {current.entryKind === SECRET_ENTRY_KIND.SECRET ? (
                    <span className="hook-muted">
                      Presence is trackable; value equality is not.
                    </span>
                  ) : canWrite ? (
                    <Button
                      variant="outline"
                      disabled={planning !== null || observation.error !== null}
                      onClick={() => void review(observation.destinationIndex)}
                    >
                      {planning === observation.destinationIndex
                        ? "Preparing review..."
                        : "Review reconciliation"}
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function ManagedConfigurationsView({
  snapshot,
  connections,
  repositoryId,
  selectedConfigurationId,
  onSelect,
  onCreate,
  onEdit,
  onReview,
}: {
  snapshot: Snapshot;
  connections: SecretConnection[];
  repositoryId?: string;
  selectedConfigurationId: string | null;
  onSelect: (configurationId: string | null) => void;
  onCreate: () => void;
  onEdit: (configuration: ManagedConfiguration) => void;
  onReview: (planId: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const canWrite = snapshot.capabilities.includes(CAPABILITY.SECRETS);
  const [stopping, setStopping] = useState<ManagedConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stopIds = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey: ["secrets", workspaceId, "managed-configurations"],
    queryFn: ({ signal }) =>
      command<ManagedConfiguration[]>(
        "secrets_configurations",
        { workspaceId },
        signal,
      ),
    retry: false,
  });
  const resourceIds = new Set(
    connections.flatMap((connection) =>
      connection.resources
        .filter(
          (resource) =>
            !repositoryId || resource.repositoryIds.includes(repositoryId),
        )
        .map((resource) => connection.id + ":" + resource.id),
    ),
  );
  const configurations = (query.data ?? []).filter(
    (configuration) =>
      !repositoryId ||
      configuration.destinations.some((item) =>
        resourceIds.has(
          item.destination.connectionId + ":" + item.destination.target.resourceId,
        ),
      ),
  );
  const selected = configurations.find(
    (item) => item.id === selectedConfigurationId,
  );
  async function stop() {
    if (!stopping || busy) return;
    const key = stopping.id + ":" + stopping.revision;
    if (!stopIds.current.has(key))
      stopIds.current.set(key, crypto.randomUUID());
    setBusy(true);
    setError(null);
    try {
      await command("secrets_configuration_stop", {
        workspaceId,
        configurationId: stopping.id,
        revision: stopping.revision,
        requestId: stopIds.current.get(key),
      });
      setStopping(null);
      onSelect(null);
      void client.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  if (selected)
    return (
      <ManagedStatusDetails
        snapshot={snapshot}
        configuration={selected}
        onBack={() => onSelect(null)}
        onEdit={onEdit}
        onReview={onReview}
      />
    );
  return (
    <>
      <section className="hook-section" aria-label="Managed configuration">
        <div className="hook-section-heading">
          <div>
            <h2>HQ-managed configuration</h2>
            <p>
              Desired state and ownership without secret custody. Provider
              configuration changes require a separate exact review.
            </p>
          </div>
          <div className="secret-actions">
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={16} aria-hidden="true" /> Refresh definitions
            </Button>
            {canWrite ? (
              <Button onClick={onCreate}>
                <Plus size={16} aria-hidden="true" /> Manage configuration
              </Button>
            ) : null}
          </div>
        </div>
        <p className="hook-notice">
          HQ-managed means HQ owns the desired definition. Custody remains none:
          secret values stay outside HQ, while explicitly non-secret variable
          values may be saved and compared.
        </p>
        {query.error || error ? (
          <SecretError error={error ?? query.error} />
        ) : null}
        {query.isPending ? (
          <p role="status">Loading managed definitions...</p>
        ) : null}
        {configurations.length ? (
          <div className="secret-list">
            {configurations.map((configuration) => (
              <article key={configuration.id}>
                <div className="secret-target-facts">
                  <strong>{configuration.label}</strong>
                  <span className="secret-name">
                    {configuration.destinations
                      .map((item) => item.destination.name)
                      .filter(
                        (value, index, values) => values.indexOf(value) === index,
                      )
                      .join(", ")}
                  </span>
                  <span>
                    {configuration.destinations.length}{" "}
                    {configuration.destinations.length === 1
                      ? "destination"
                      : "destinations"}
                  </span>
                  <div className="secret-actions">
                    <Badge variant="secondary">HQ managed</Badge>
                    <Badge variant="outline">No secret custody</Badge>
                    <Badge variant="outline">
                      {configuration.entryKind === SECRET_ENTRY_KIND.SECRET
                        ? "Secret presence"
                        : "Non-secret variable"}
                    </Badge>
                  </div>
                </div>
                <div className="secret-actions">
                  <Button
                    variant="outline"
                    onClick={() => onSelect(configuration.id)}
                  >
                    <ShieldCheck size={16} aria-hidden="true" /> View live status
                  </Button>
                  {canWrite ? (
                    <>
                      <Button
                        variant="ghost"
                        onClick={() => onEdit(configuration)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setError(null);
                          setStopping(configuration);
                        }}
                      >
                        Stop management
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : query.data ? (
          <div className="empty-state">
            <ShieldCheck size={28} aria-hidden="true" />
            <h3>
              {repositoryId
                ? "No managed configuration linked here"
                : "No HQ-managed configuration yet"}
            </h3>
            <p>
              Adopt a provider entry from Inventory or create a desired
              non-secret variable definition here.
            </p>
            {canWrite ? (
              <Button variant="outline" onClick={onCreate}>
                Manage configuration
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <ManagedHistory
        workspaceId={workspaceId}
        repositoryId={repositoryId}
        onReview={onReview}
      />
      <AlertDialog
        open={Boolean(stopping)}
        onOpenChange={(open) => {
          if (!open && !busy) setStopping(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop HQ management?</AlertDialogTitle>
            <AlertDialogDescription>
              The managed definition and desired non-secret value will be
              removed from active views. Provider entries and values remain
              unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep management</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void stop()}
            >
              {busy ? "Stopping..." : "Stop management only"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ManagedConfigurationReviewPanel({
  snapshot,
  planId,
  onClose,
}: {
  snapshot: Snapshot;
  planId: string;
  onClose: () => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const now = useSecretClock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const key = ["secrets", workspaceId, "managed-review", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<ManagedConfigurationReview>(
        "secrets_configuration_review",
        { workspaceId, planId },
        signal,
      ),
    retry: false,
  });
  const review = query.data;
  useEffect(() => {
    heading.current?.focus();
  }, [planId]);
  const expired = review ? Date.parse(review.expiresAt) <= now : false;
  const canWrite =
    snapshot.capabilities.includes(CAPABILITY.SECRETS) &&
    Boolean(review?.actorMatches);
  function update(value: ManagedConfigurationReview) {
    client.setQueryData(key, value);
    void client.invalidateQueries({ queryKey: ["secrets", workspaceId] });
  }
  async function apply() {
    if (!review || busy) return;
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      update(
        await command<ManagedConfigurationReview>(
          "secrets_configuration_apply",
          {
            workspaceId,
            planId,
            fingerprint: review.fingerprint,
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
  async function reconcile() {
    if (!review || busy) return;
    setBusy(true);
    setError(null);
    try {
      update(
        await command<ManagedConfigurationReview>(
          "secrets_configuration_reconcile",
          { workspaceId, planId },
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
    <section className="hook-section" aria-labelledby="managed-review-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="managed-review-title" ref={heading} tabIndex={-1}>
            Managed configuration review
          </h2>
          <p>Exact desired state, live baseline, actor, and retained receipt.</p>
        </div>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Back to managed configuration
        </Button>
      </div>
      {query.isPending ? <p role="status">Loading managed review...</p> : null}
      {query.error || error ? (
        <>
          <SecretError error={error ?? query.error} />
          <p className="hook-notice">
            An interrupted apply may have reached the provider. Reload this
            exact receipt or reconcile it before preparing another change.
          </p>
          <Button
            variant="outline"
            disabled={query.isFetching || busy}
            onClick={() => void query.refetch()}
          >
            Reload receipt
          </Button>
        </>
      ) : null}
      {review ? (
        <div className="secret-form managed-review">
          <div className="secret-target-facts">
            <strong>{review.configurationLabel}</strong>
            <span className="secret-name">{review.desired.destination.name}</span>
            <span>
              {review.resource.label} / {review.connectionName} /{" "}
              {secretScopeLabel(review.desired.destination.target.scope)}
            </span>
            <div className="secret-actions">
              <Badge variant="secondary">
                {ACTION_LABELS[review.action]}
              </Badge>
              <Badge variant="outline">HQ managed</Badge>
              <Badge variant="outline">No secret custody</Badge>
            </div>
          </div>
          <dl className="managed-review-facts">
            <div>
              <dt>Desired state</dt>
              <dd>{review.desired.desiredState}</dd>
            </div>
            <div>
              <dt>Live state at review</dt>
              <dd>{review.before.item ? "Present" : "Absent"}</dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>
                <SecretTime value={review.expiresAt} />
              </dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd>
                <code>{review.fingerprint}</code>
              </dd>
            </div>
          </dl>
          {review.desiredValue !== null ? (
            <div className="managed-value-comparison">
              <div>
                <strong>Desired non-secret value</strong>
                <pre className="secret-variable-value">
                  <code>{review.desiredValue}</code>
                </pre>
              </div>
              <div>
                <strong>Value at review</strong>
                {review.before.item?.value !== undefined &&
                review.before.item?.value !== null ? (
                  <pre className="secret-variable-value">
                    <code>{review.before.item.value}</code>
                  </pre>
                ) : (
                  <p className="hook-muted">Entry absent</p>
                )}
              </div>
            </div>
          ) : null}
          {!review.actorMatches ? (
            <p className="hook-notice">
              This review belongs to another actor or credential. It remains
              readable, but only the original actor can apply it.
            </p>
          ) : null}
          {!review.writable ? (
            <p className="hook-notice">
              This provider credential is read only. Applying records a
              rejected receipt and does not change provider configuration.
            </p>
          ) : null}
          {expired && !review.operation ? (
            <p className="hook-notice">
              This review expired. Refresh live status and prepare a new review.
            </p>
          ) : null}
          {review.operation ? (
            <div className="secret-outcome">
              <div className="secret-actions">
                <Badge
                  variant={
                    review.operation.status === "succeeded"
                      ? "secondary"
                      : review.operation.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {review.operation.status}
                </Badge>
                <Badge variant="outline">
                  {review.operation.receipt.writeStatus}
                </Badge>
                <Badge
                  variant={statusVariant(
                    review.operation.receipt.observationStatus,
                  )}
                >
                  {STATUS_LABELS[review.operation.receipt.observationStatus]}
                </Badge>
              </div>
              <p>{review.operation.summary}</p>
              {review.operation.receipt.reason ? (
                <p className="hook-muted">
                  {RECEIPT_REASON_LABELS[review.operation.receipt.reason]}
                </p>
              ) : null}
              {review.operation.receipt.observedAt ? (
                <p className="hook-muted">
                  Provider state read{" "}
                  <SecretTime value={review.operation.receipt.observedAt} />.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="secret-actions">
            {!review.operation ? (
              <Button
                variant={
                  review.action === MANAGED_CONFIGURATION_ACTION.DELETE
                    ? "destructive"
                    : "default"
                }
                disabled={busy || !canWrite || expired}
                onClick={() => setConfirming(true)}
              >
                {ACTION_LABELS[review.action]}
              </Button>
            ) : ["pending", "running", "partial", "indeterminate"].includes(
                review.operation.status,
              ) ? (
              <Button
                variant="outline"
                disabled={busy || !snapshot.capabilities.includes(CAPABILITY.SECRETS)}
                onClick={() => void reconcile()}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {busy ? "Reconciling..." : "Reconcile from live state"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apply this exact {review?.action}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              HQ will persist operation intent, check the reviewed live
              baseline again, and submit at most one provider request. An
              interrupted request is never automatically replayed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review ? (
            <div className="secret-target-facts">
              <strong className="secret-name">
                {review.desired.destination.name}
              </strong>
              <span>
                Desired {review.desired.desiredState} at{" "}
                {secretScopeLabel(review.desired.destination.target.scope)}
              </span>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep reviewing</AlertDialogCancel>
            <Button
              variant={
                review?.action === MANAGED_CONFIGURATION_ACTION.DELETE
                  ? "destructive"
                  : "default"
              }
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? "Applying..." : "Confirm reviewed operation"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
