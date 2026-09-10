import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Snapshot } from "../shared/domain";
import {
  MONITOR_DEFAULTS,
  MONITOR_LIMITS,
  monitorDefaultsSchema,
  monitorTargetSchema,
  type JsonValue,
  type MonitorChange,
  type MonitorConnection,
  type MonitorDefaults,
  type MonitorResult,
  type MonitorReview,
  type MonitorTarget,
} from "../shared/monitoring";
import { jsonFields, jsonFieldsValue } from "../shared/monitoring-editor";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
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
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { JsonFieldsEditor, MonitorError } from "./monitoring-components";
import { MonitoringReview } from "./monitoring-review";
import { RESOURCE_REQUEST_TIMEOUT_MS } from "./resource-repositories";

type ConfigurationResponse = {
  result: MonitorResult<"configuration">;
  capabilities: string[];
};
type EditorProps = {
  snapshot: Snapshot;
  connection: MonitorConnection;
  targetId?: string;
  defaults?: boolean;
  onClose: () => void;
  onReceipt: (id: string) => void;
  returnFocus: HTMLElement | null;
};
function newTarget(defaults: MonitorDefaults): MonitorTarget {
  return {
    id: "",
    url: "",
    method: defaults.method,
    failureThreshold: defaults.failureThreshold,
    recoveryThreshold: defaults.recoveryThreshold,
    timeoutMilliseconds: defaults.timeoutMilliseconds,
  };
}
function draftFields(data: ConfigurationResponse, targetId?: string) {
  const defaults = data.result.configuration?.configuration.defaults ?? {
    ...MONITOR_DEFAULTS,
  };
  const target =
    data.result.configuration?.configuration.targets.find(
      (target) => target.id === targetId,
    ) ?? newTarget(defaults);
  return {
    target,
    defaults,
    statuses: target.expectedStatuses?.join(", ") ?? "",
    bodyEnabled: Boolean(target.expect?.bodyIncludes),
    body: target.expect?.bodyIncludes ?? "",
    typeEnabled: Boolean(target.expect?.contentType),
    contentType: target.expect?.contentType ?? "",
    locationEnabled: Boolean(target.expect?.location),
    location: target.expect?.location?.url ?? "",
    ignoreQuery: target.expect?.location?.ignoreQuery ?? false,
    jsonEnabled: Boolean(target.expect?.jsonSubset),
    json: jsonFields(target.expect?.jsonSubset ?? {}),
  };
}
function DefaultsFields({
  value,
  onChange,
  disabled,
  interval = false,
}: {
  value: MonitorDefaults;
  onChange: (value: MonitorDefaults) => void;
  disabled: boolean;
  interval?: boolean;
}) {
  return (
    <div className="monitor-form-grid">
      {interval ? (
        <label htmlFor="monitor-interval">
          Probe interval (minutes)
          <Input
            id="monitor-interval"
            type="number"
            min={1}
            max={60}
            required
            value={
              Number.isNaN(value.probeIntervalMinutes)
                ? ""
                : value.probeIntervalMinutes
            }
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                probeIntervalMinutes: event.target.valueAsNumber,
              })
            }
          />
        </label>
      ) : null}
      <div className="hook-field">
        <label htmlFor="monitor-method">Method</label>
        <Select
          value={value.method}
          disabled={disabled}
          onValueChange={(method) =>
            onChange({ ...value, method: method as "GET" | "HEAD" })
          }
        >
          <SelectTrigger id="monitor-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="HEAD">HEAD</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label htmlFor="monitor-failures">
        Failure threshold
        <Input
          id="monitor-failures"
          type="number"
          min={1}
          max={10}
          required
          value={
            Number.isNaN(value.failureThreshold) ? "" : value.failureThreshold
          }
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, failureThreshold: event.target.valueAsNumber })
          }
        />
      </label>
      <label htmlFor="monitor-recoveries">
        Recovery threshold
        <Input
          id="monitor-recoveries"
          type="number"
          min={1}
          max={10}
          required
          value={
            Number.isNaN(value.recoveryThreshold) ? "" : value.recoveryThreshold
          }
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              recoveryThreshold: event.target.valueAsNumber,
            })
          }
        />
      </label>
      <label htmlFor="monitor-timeout">
        Timeout (milliseconds)
        <Input
          id="monitor-timeout"
          type="number"
          min={100}
          max={30000}
          required
          value={
            Number.isNaN(value.timeoutMilliseconds)
              ? ""
              : value.timeoutMilliseconds
          }
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              timeoutMilliseconds: event.target.valueAsNumber,
            })
          }
        />
      </label>
    </div>
  );
}
function ConfigurationForm({
  initial,
  ...props
}: EditorProps & { initial: ConfigurationResponse }) {
  const {
    snapshot,
    connection,
    targetId,
    defaults,
    onClose,
    onReceipt,
    returnFocus,
  } = props;
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() => draftFields(initial, targetId));
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const attempt = useRef<{ id: string; serialized: string } | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const dirty = JSON.stringify(draft) !== baseline;
  const guard = useCloseGuard(dirty || busy, onClose);
  const allowed = base.capabilities.includes("configure");
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const current = await command<ConfigurationResponse>(
        "monitoring_configuration",
        { workspaceId: snapshot.workspace.id, connectionId: connection.id },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      if (
        targetId &&
        !current.result.configuration?.configuration.targets.some(
          (target) => target.id === targetId,
        )
      )
        throw new Error(
          "This target is no longer configured. Your draft has been kept; close it before deliberately creating a new target.",
        );
      const next = draftFields(current, targetId);
      setBase(current);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      attempt.current = null;
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (busy || !allowed) return;
    setError(null);
    let change: MonitorChange;
    try {
      if (defaults)
        change = {
          kind: "defaults",
          defaults: monitorDefaultsSchema.parse(draft.defaults),
        };
      else {
        const assertion = {
          ...(draft.bodyEnabled ? { bodyIncludes: draft.body } : {}),
          ...(draft.typeEnabled ? { contentType: draft.contentType } : {}),
          ...(draft.locationEnabled
            ? {
                location: {
                  url: draft.location,
                  ignoreQuery: draft.ignoreQuery,
                },
              }
            : {}),
          ...(draft.jsonEnabled
            ? {
                jsonSubset: jsonFieldsValue(draft.json) as Record<
                  string,
                  JsonValue
                >,
              }
            : {}),
        };
        const {
          expect: _priorExpect,
          expectedStatuses: _priorStatuses,
          ...fields
        } = draft.target;
        const target = monitorTargetSchema.safeParse({
          ...fields,
          ...(draft.statuses.trim()
            ? {
                expectedStatuses: draft.statuses
                  .split(",")
                  .map((value) => Number(value.trim())),
              }
            : {}),
          ...(Object.keys(assertion).length ? { expect: assertion } : {}),
        });
        if (!target.success)
          throw new Error(
            target.error.issues
              .map((issue) => issue.path.join(" / ") + ": " + issue.message)
              .join(". "),
          );
        change = {
          kind: "target",
          action: targetId ? "update" : "create",
          targetId: target.data.id,
          target: target.data,
        };
      }
    } catch (failure) {
      setError(failure);
      return;
    }
    const input = {
      workspaceId: snapshot.workspace.id,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      configurationRevision: base.result.configuration?.revision ?? 0,
      change,
    };
    const serialized = JSON.stringify(input);
    if (attempt.current?.serialized !== serialized)
      attempt.current = { id: crypto.randomUUID(), serialized };
    setBusy(true);
    try {
      const prepared = await command<MonitorReview>(
        "monitoring_configuration_plan",
        { ...input, reviewId: attempt.current.id },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      setReviewId(prepared.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !allowed;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="monitor-editor-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {defaults
                ? "Probe schedule and defaults"
                : targetId
                  ? "Edit monitor target"
                  : "Add monitor target"}
            </DialogTitle>
            <DialogDescription>
              Changes are reviewed before they affect Endpoint Monitor. Saved
              configuration is authoritative across HQ and the provider CLI. Do
              not include credentials in URLs or expectations.
            </DialogDescription>
          </DialogHeader>
          <form className="hook-form" onSubmit={review}>
            {error ? <MonitorError error={error} /> : null}
            {!allowed ? (
              <p className="permission-notice">
                This provider credential allows reads but not configuration
                changes. The deployment owner must grant configure access.
              </p>
            ) : null}
            <p className="hook-muted">
              Editing configuration revision{" "}
              {base.result.configuration?.revision ?? 0}. Unrelated target
              definitions are preserved.
            </p>
            {defaults ? (
              <>
                <DefaultsFields
                  value={draft.defaults}
                  disabled={disabled}
                  interval
                  onChange={(value) => setDraft({ ...draft, defaults: value })}
                />
                <p className="hook-notice">
                  The interval changes the schedule for every configured target.
                  The provider validates its per-invocation probe capacity.
                  Other defaults supply settings for new targets, not overrides
                  of existing explicit settings.
                </p>
              </>
            ) : (
              <>
                <div className="monitor-form-grid">
                  <label htmlFor="monitor-id">
                    Target ID
                    <Input
                      id="monitor-id"
                      required
                      maxLength={64}
                      value={draft.target.id}
                      disabled={disabled || Boolean(targetId)}
                      pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                      placeholder="service-health"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          target: { ...draft.target, id: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label htmlFor="monitor-url">
                    Endpoint URL
                    <Input
                      id="monitor-url"
                      type="url"
                      required
                      maxLength={MONITOR_LIMITS.URL_BYTES}
                      autoComplete="off"
                      value={draft.target.url}
                      disabled={disabled}
                      placeholder="https://example.com/health"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          target: { ...draft.target, url: event.target.value },
                        })
                      }
                    />
                  </label>
                </div>
                <DefaultsFields
                  value={{ ...draft.defaults, ...draft.target }}
                  disabled={disabled}
                  onChange={({
                    method,
                    failureThreshold,
                    recoveryThreshold,
                    timeoutMilliseconds,
                  }) =>
                    setDraft({
                      ...draft,
                      target: {
                        ...draft.target,
                        method,
                        failureThreshold,
                        recoveryThreshold,
                        timeoutMilliseconds,
                      },
                    })
                  }
                />
                <label htmlFor="monitor-statuses">
                  Expected HTTP statuses (optional)
                  <Input
                    id="monitor-statuses"
                    value={draft.statuses}
                    maxLength={2000}
                    disabled={disabled}
                    placeholder="200, 204"
                    onChange={(event) =>
                      setDraft({ ...draft, statuses: event.target.value })
                    }
                  />
                  <span className="hook-muted">
                    Comma-separated statuses. Leave empty to check reachability
                    (responses below 500). Selected Cloudflare error statuses
                    open incidents immediately.
                  </span>
                </label>
                <fieldset className="monitor-assertions">
                  <legend>Response checks</legend>
                  <p className="hook-muted">
                    Optional assertions add an application contract. Body checks
                    require GET; redirect checks require explicit 3xx statuses.
                  </p>
                  <label className="hook-checkbox">
                    <Checkbox
                      checked={draft.typeEnabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, typeEnabled: Boolean(checked) })
                      }
                    />
                    Require a content type
                  </label>
                  {draft.typeEnabled ? (
                    <Input
                      aria-label="Expected content type"
                      placeholder="application/json"
                      value={draft.contentType}
                      maxLength={256}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, contentType: event.target.value })
                      }
                    />
                  ) : null}
                  <label className="hook-checkbox">
                    <Checkbox
                      checked={draft.bodyEnabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, bodyEnabled: Boolean(checked) })
                      }
                    />
                    Require text in the response body
                  </label>
                  {draft.bodyEnabled ? (
                    <Textarea
                      aria-label="Required response text"
                      placeholder="Expected text marker"
                      value={draft.body}
                      maxLength={1024}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, body: event.target.value })
                      }
                    />
                  ) : null}
                  <label className="hook-checkbox">
                    <Checkbox
                      checked={draft.locationEnabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        setDraft({
                          ...draft,
                          locationEnabled: Boolean(checked),
                        })
                      }
                    />
                    Require a redirect destination
                  </label>
                  {draft.locationEnabled ? (
                    <>
                      <Input
                        aria-label="Expected redirect URL"
                        type="url"
                        value={draft.location}
                        maxLength={MONITOR_LIMITS.URL_BYTES}
                        disabled={disabled}
                        placeholder="https://example.com/destination"
                        onChange={(event) =>
                          setDraft({ ...draft, location: event.target.value })
                        }
                      />
                      <label className="hook-checkbox">
                        <Checkbox
                          checked={draft.ignoreQuery}
                          disabled={disabled}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              ignoreQuery: Boolean(checked),
                            })
                          }
                        />
                        Ignore the redirect's query string
                      </label>
                    </>
                  ) : null}
                  <label className="hook-checkbox">
                    <Checkbox
                      checked={draft.jsonEnabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        setDraft({ ...draft, jsonEnabled: Boolean(checked) })
                      }
                    />
                    Require JSON fields
                  </label>
                  {draft.jsonEnabled ? (
                    <>
                      <p className="hook-muted">
                        Match a subset of the response object. Add nested
                        objects or arrays without editing a JSON document. Extra
                        response properties are allowed.
                      </p>
                      <JsonFieldsEditor
                        fields={draft.json}
                        disabled={disabled}
                        onChange={(json) => setDraft({ ...draft, json })}
                      />
                    </>
                  ) : null}
                </fieldset>
              </>
            )}
            <div className="hook-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => (dirty ? setReload(true) : void loadSaved())}
              >
                Load saved configuration
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
              <Button
                ref={reviewButton}
                type="submit"
                disabled={
                  disabled || (!dirty && (Boolean(targetId) || defaults))
                }
              >
                {busy ? "Preparing review..." : "Review changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Fetch the saved provider configuration and replace this draft only
              if that read succeeds. Unsubmitted reviews will not be applied.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void loadSaved()}>
              Load saved configuration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {reviewId ? (
        <MonitoringReview
          snapshot={snapshot}
          planId={reviewId}
          returnFocus={reviewButton.current}
          onClose={() => {
            setReviewId(null);
            attempt.current = null;
          }}
          onOperation={(id) => {
            guard.saved();
            onReceipt(id);
          }}
        />
      ) : null}
    </>
  );
}
export function MonitoringConfigurationEditor(props: EditorProps) {
  const { snapshot, connection, targetId, onClose } = props;
  const query = useQuery({
    queryKey: [
      "monitoring",
      snapshot.workspace.id,
      "configuration",
      connection.id,
      connection.revision,
    ],
    queryFn: ({ signal }) =>
      command<ConfigurationResponse>(
        "monitoring_configuration",
        { workspaceId: snapshot.workspace.id, connectionId: connection.id },
        signal,
      ),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const missing =
    targetId &&
    query.data &&
    !query.data.result.configuration?.configuration.targets.some(
      (target) => target.id === targetId,
    );
  return query.data && !missing ? (
    <ConfigurationForm {...props} initial={query.data} />
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="hook-dialog">
        <DialogHeader>
          <DialogTitle>Load monitor configuration</DialogTitle>
          <DialogDescription>
            Reading the provider's saved configuration before editing.
          </DialogDescription>
        </DialogHeader>
        {query.error ? (
          <MonitorError error={query.error} />
        ) : missing ? (
          <p>
            This target is no longer configured. Its links and historical
            activity remain available.
          </p>
        ) : (
          <p role="status">Loading configuration...</p>
        )}
        <Button
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          Retry loading configuration
        </Button>
      </DialogContent>
    </Dialog>
  );
}
