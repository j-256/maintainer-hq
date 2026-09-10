import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  SecretConnection,
  SecretDestination,
  SecretScope,
  SecretScopes,
  SecretReviewedDestination,
  SecretReceipt,
  SecretEntryKind,
} from "../shared/secrets";
import { SECRET_ENTRY_KIND } from "../shared/secrets";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
export {
  HookError as SecretError,
  HookTime as SecretTime,
} from "./hook-components";
import { HookError, HookTime } from "./hook-components";

const SECRET_CLOCK_TICK_MS = 1000;
export function useSecretClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function visibility() {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), SECRET_CLOCK_TICK_MS);
      }
    }
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return now;
}

const WRITE_LABELS = {
  "not-sent": "Not sent",
  accepted: "Provider accepted",
  rejected: "Provider rejected",
  indeterminate: "Acceptance uncertain",
} as const;
const OBSERVATION_LABELS = {
  unknown: "Not checked",
  present: "Name observed present",
  absent: "Name observed absent",
  unavailable: "Metadata unavailable",
} as const;
const REASON_LABELS: Record<NonNullable<SecretReceipt["reason"]>, string> = {
  credential_read_only: "The provider credential does not allow writes.",
  rate_limited: "The provider rate limit prevented this request.",
  provider_rejected: "The provider rejected this request.",
  provider_result_uncertain: "A definitive provider receipt was not received.",
  preflight_changed: "The reviewed provider state changed before submission.",
  authority_changed: "The reviewed permissions or connection changed.",
  input_expired: "The retained input expired before submission.",
  execution_interrupted:
    "Execution was interrupted; inspect the receipt before continuing.",
};
export function SecretReceiptFacts({
  receipt,
}: {
  receipt: Pick<
    SecretReceipt,
    "phase" | "writeStatus" | "observationStatus" | "observedAt" | "reason"
  >;
}) {
  return (
    <div className="secret-outcome">
      <div className="secret-actions">
        <Badge variant="outline">
          {receipt.phase === "preparing"
            ? "Checking before submission"
            : receipt.phase === "submitted"
              ? "Awaiting provider receipt"
              : receipt.phase === "pending"
                ? "Pending"
                : WRITE_LABELS[receipt.writeStatus]}
        </Badge>
        <Badge variant="secondary">
          {OBSERVATION_LABELS[receipt.observationStatus]}
        </Badge>
      </div>
      {receipt.reason ? (
        <p className="hook-muted">{REASON_LABELS[receipt.reason]}</p>
      ) : null}
      {receipt.observedAt ? (
        <p className="hook-muted">
          Metadata read <HookTime value={receipt.observedAt} />.
        </p>
      ) : null}
    </div>
  );
}

export function secretScopeLabel(scope: SecretScope) {
  return scope.kind === "organization"
    ? "Organization: " + scope.name
    : scope.kind === "environment"
      ? "Environment: " + scope.name
      : scope.kind === "worker"
        ? "Worker bindings"
        : "Repository";
}
export function SecretTargetFacts({
  value,
}: {
  value: SecretReviewedDestination;
}) {
  return (
    <div className="secret-target-facts">
      <strong className="secret-name">{value.destination.name}</strong>
      <span>
        {value.resource.label} /{" "}
        {secretScopeLabel(value.destination.target.scope)}
      </span>
      <span className="hook-muted">
        {value.connectionName} /{" "}
        {value.providerKind === "github-actions"
          ? "GitHub Actions"
          : "Cloudflare Workers"}
      </span>
      <span className="hook-muted">
        {value.snapshot.before?.updatedAt ? (
          <>
            Existing name, updated{" "}
            <HookTime value={value.snapshot.before.updatedAt} />
          </>
        ) : value.snapshot.before ? (
          "Existing name; the provider does not expose timestamps"
        ) : (
          "Name not present at review"
        )}
      </span>
      {value.snapshot.workerDeployment ? (
        <details className="secret-deployment-facts">
          <summary>Worker deployment affected</summary>
          <dl>
            <div>
              <dt>Account</dt>
              <dd>
                <code>{value.snapshot.workerDeployment.accountId}</code>
              </dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{value.snapshot.workerDeployment.workerName}</dd>
            </div>
            <div>
              <dt>Serving deployment</dt>
              <dd>
                <code>{value.snapshot.workerDeployment.deploymentId}</code>
              </dd>
            </div>
            <div>
              <dt>Serving version</dt>
              <dd>
                <code>{value.snapshot.workerDeployment.versionId}</code>
              </dd>
            </div>
          </dl>
          <p className="hook-muted">
            A write or removal creates and deploys a new version. The comparison
            token covers the entire Worker deployment, not this secret's value.
          </p>
        </details>
      ) : null}
    </div>
  );
}
export function SecretPagination({
  page,
  previous,
  next,
  busy = false,
  label = "Secrets pages",
}: {
  page: number;
  previous?: () => void;
  next?: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <nav className="hook-pagination" aria-label={label}>
      <span>Page {page}</span>
      <div>
        <Button
          variant="outline"
          disabled={!previous || busy}
          onClick={previous}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Previous
        </Button>
        <Button variant="outline" disabled={!next || busy} onClick={next}>
          Next <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
export type SecretSelection = {
  connectionId: string;
  resourceId: string;
  scope: SecretScope;
  name: string;
};
export function secretSelection(value?: SecretDestination): SecretSelection {
  return value
    ? {
        connectionId: value.connectionId,
        resourceId: value.target.resourceId,
        scope: value.target.scope,
        name: value.name,
      }
    : {
        connectionId: "",
        resourceId: "",
        scope: { kind: "repository" },
        name: "",
      };
}
export function selectedSecret(
  value: SecretSelection,
  connections: SecretConnection[],
): SecretDestination {
  const connection = connections.find((item) => item.id === value.connectionId);
  if (
    !connection?.available ||
    !connection.enabled ||
    !connection.writable ||
    !connection.resources.some((item) => item.id === value.resourceId)
  )
    throw new Error(
      "Select an available writable connection and resource. Your draft has been kept.",
    );
  return {
    connectionId: connection.id,
    connectionRevision: connection.revision,
    target: { resourceId: value.resourceId, scope: value.scope },
    name: value.name,
  };
}
function ScopePicker({
  workspaceId,
  connection,
  resourceId,
  value,
  onChange,
  disabled,
  writable,
  entryKind,
  allowedScopeKinds,
  id,
}: {
  workspaceId: string;
  connection: SecretConnection;
  resourceId: string;
  value: SecretScope;
  onChange: (value: SecretScope) => void;
  disabled: boolean;
  writable: boolean;
  entryKind: SecretEntryKind;
  allowedScopeKinds?: SecretScope["kind"][];
  id: string;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [
      "secrets",
      workspaceId,
      "scopes",
      connection.id,
      connection.revision,
      resourceId,
      page,
    ],
    queryFn: ({ signal }) =>
      command<SecretScopes>(
        "secrets_scopes",
        { workspaceId, connectionId: connection.id, resourceId, page },
        signal,
      ),
    retry: false,
  });
  const choices: SecretScope[] = [
    query.data?.defaultScope ??
      (connection.providerKind === "cloudflare-workers"
        ? { kind: "worker" }
        : { kind: "repository" }),
    ...(query.data?.fixedScopes?.map((item) => item.scope) ?? []),
    ...(query.data?.items.map((item) => item.scope) ?? []),
  ].filter(
    (scope) =>
      (!allowedScopeKinds || allowedScopeKinds.includes(scope.kind)) &&
      (!writable ||
        (entryKind === SECRET_ENTRY_KIND.SECRET
          ? connection.capabilities?.secretMutationScopeKinds
          : connection.capabilities?.variableMutationScopeKinds
        )?.includes(scope.kind)),
  );
  if (
    (!allowedScopeKinds || allowedScopeKinds.includes(value.kind)) &&
    (!writable ||
      (entryKind === SECRET_ENTRY_KIND.SECRET
        ? connection.capabilities?.secretMutationScopeKinds
        : connection.capabilities?.variableMutationScopeKinds
      )?.includes(value.kind)) &&
    !choices.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    choices.push(value);
  return (
    <div className="hook-field">
      <label htmlFor={id}>Scope</label>
      <Select
        value={JSON.stringify(value)}
        onValueChange={(next) => onChange(JSON.parse(next) as SecretScope)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((scope) => (
            <SelectItem
              key={JSON.stringify(scope)}
              value={JSON.stringify(scope)}
            >
              {secretScopeLabel(scope)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {query.isPending ? <p role="status">Loading scopes...</p> : null}
      {query.error ? (
        <>
          <HookError error={query.error} />
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry scopes
          </Button>
        </>
      ) : null}
      {page > 1 || query.data?.nextPage ? (
        <SecretPagination
          page={page}
          previous={page > 1 ? () => setPage(page - 1) : undefined}
          next={
            query.data?.nextPage
              ? () => setPage(query.data!.nextPage!)
              : undefined
          }
          busy={disabled || query.isFetching}
          label="Scope pages"
        />
      ) : null}
      {query.data?.truncated ? (
        <p className="hook-notice">
          The scope page limit was reached. This is not the full scope
          inventory.
        </p>
      ) : null}
    </div>
  );
}
export function SecretTargetPicker({
  workspaceId,
  connections,
  value,
  onChange,
  disabled = false,
  includeName = true,
  writable = true,
  entryKind = SECRET_ENTRY_KIND.SECRET,
  allowedScopeKinds,
  repositoryId,
}: {
  workspaceId: string;
  connections: SecretConnection[];
  value: SecretSelection;
  onChange: (value: SecretSelection) => void;
  disabled?: boolean;
  includeName?: boolean;
  writable?: boolean;
  entryKind?: SecretEntryKind;
  allowedScopeKinds?: SecretScope["kind"][];
  repositoryId?: string;
}) {
  const id = useId();
  const selected = connections.find((item) => item.id === value.connectionId);
  const resources =
    selected?.resources.filter(
      (resource) =>
        !repositoryId || resource.repositoryIds.includes(repositoryId),
    ) ?? [];
  return (
    <div className="secret-target-picker">
      <div className="hook-field">
        <label htmlFor={id + "connection"}>Connection</label>
        <Select
          value={value.connectionId}
          disabled={disabled}
          onValueChange={(connectionId) => {
            const next = connections.find((item) => item.id === connectionId);
            if (!next) return;
            const available = next.resources.filter(
              (resource) =>
                !repositoryId || resource.repositoryIds.includes(repositoryId),
            );
            onChange({
              ...value,
              connectionId,
              resourceId: available.length === 1 ? available[0]!.id : "",
              scope: {
                kind:
                  next.providerKind === "cloudflare-workers"
                    ? "worker"
                    : "repository",
              },
            });
          }}
        >
          <SelectTrigger id={id + "connection"}>
            <SelectValue placeholder="Select connection" />
          </SelectTrigger>
          <SelectContent>
            {connections.map((item) => (
              <SelectItem
                key={item.id}
                value={item.id}
                disabled={
                  !item.available ||
                  !item.enabled ||
                  (writable && !item.writable)
                }
              >
                {item.name}
                {!item.available || !item.enabled
                  ? " (unavailable)"
                  : !item.writable
                    ? " (read only)"
                    : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="hook-field">
        <label htmlFor={id + "resource"}>Resource</label>
        <Select
          value={value.resourceId}
          disabled={disabled || !selected}
          onValueChange={(resourceId) => {
            if (!resources.some((item) => item.id === resourceId)) return;
            onChange({
              ...value,
              resourceId,
              scope: {
                kind:
                  selected?.providerKind === "cloudflare-workers"
                    ? "worker"
                    : "repository",
              },
            });
          }}
        >
          <SelectTrigger id={id + "resource"}>
            <SelectValue placeholder="Select resource" />
          </SelectTrigger>
          <SelectContent>
            {resources.map((resource) => (
              <SelectItem key={resource.id} value={resource.id}>
                {resource.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value.resourceId &&
        !resources.some((item) => item.id === value.resourceId) ? (
          <p role="alert">
            The selected resource is no longer enrolled here. Select a resource
            to continue.
          </p>
        ) : null}
      </div>
      {selected?.available &&
      selected.enabled &&
      resources.some((item) => item.id === value.resourceId) ? (
        <ScopePicker
          key={selected.id + selected.revision + value.resourceId}
          workspaceId={workspaceId}
          connection={selected}
          resourceId={value.resourceId}
          value={value.scope}
          onChange={(scope) => onChange({ ...value, scope })}
          disabled={disabled}
          writable={writable}
          entryKind={entryKind}
          allowedScopeKinds={allowedScopeKinds}
          id={id + "scope"}
        />
      ) : null}
      {includeName ? (
        <div className="hook-field">
          <label htmlFor={id + "name"}>
            {entryKind === SECRET_ENTRY_KIND.SECRET
              ? "Secret name"
              : "Variable name"}
          </label>
          <Input
            id={id + "name"}
            value={value.name}
            disabled={disabled}
            maxLength={255}
            required
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
          />
          {selected?.capabilities?.nameRule === "github-actions" ? (
            <p>
              Letters, numbers and underscores. GitHub uses uppercase names;
              GITHUB_ is reserved.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
