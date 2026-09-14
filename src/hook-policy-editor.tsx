import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  HOOK_LIMITS,
  HOOK_POLICY_LIMITS,
  type HookConfigurationAvailability,
  type HookConnection,
  type HookPolicyReview,
  type HookResult,
} from "../shared/hooks";
import { command } from "./lib/api";
import {
  hookFilterDraft,
  hookPolicyDraft,
  hookPolicyValue,
  toggleHookValue,
  type HookPolicyDraft,
} from "./lib/hook-policy-draft";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
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
import {
  HookError,
  HookTime,
  HOOK_REQUEST_TIMEOUT_MS,
  restoreHookFocus,
} from "./hook-components";
import { HookFilterFields, HookPolicyIdentity } from "./hook-policy-fields";

type Detail = HookResult<"configuration_subscription">;
type Base = { detail: Detail; connectionRevision: number };

export function HookDestinations({
  workspaceId,
  connectionId,
  base,
  selected,
  onChange,
  disabled,
  limit = HOOK_POLICY_LIMITS.DESTINATIONS,
}: {
  workspaceId: string;
  connectionId: string;
  base: Pick<Detail, "authorityId" | "revision">;
  selected: string[];
  onChange: (selected: string[]) => void;
  disabled: boolean;
  limit?: number;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "policy-destinations",
      connectionId,
      base.authorityId,
      base.revision,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<{ result: HookResult<"configuration_sinks"> }>(
        "hooks_policy_destinations",
        {
          workspaceId,
          connectionId,
          authorityId: base.authorityId,
          revision: base.revision,
          cursor,
        },
        signal,
      ),
    staleTime: HOOK_LIMITS.REFRESH_MS,
  });
  const data = query.data?.result;
  return (
    <div className="hook-policy-destinations">
      <p className="hook-muted">
        Choose existing destinations. Their private endpoints and credentials
        are unchanged.
      </p>
      {query.isPending ? (
        <p role="status">Reading available destinations...</p>
      ) : null}
      {query.error ? (
        <>
          <HookError error={query.error} />
          <Button
            type="button"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry destination read
          </Button>
        </>
      ) : null}
      {data ? (
        <>
          <div className="hook-policy-destination-list">
            {data.items.map((item) => (
              <label className="hook-checkbox" key={item.resourceId}>
                <Checkbox
                  checked={selected.includes(item.name)}
                  disabled={
                    disabled ||
                    item.retired ||
                    (!selected.includes(item.name) && selected.length >= limit)
                  }
                  onCheckedChange={(checked) =>
                    onChange(
                      toggleHookValue(selected, item.name, checked === true),
                    )
                  }
                />
                <span>
                  {item.name}
                  <small>
                    {item.type}
                    {item.retired ? " / retired" : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {!data.items.length ? <p>No destinations in this page.</p> : null}
          <nav className="hook-pagination" aria-label="Destination pages">
            <span>Page {cursors.length}</span>
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetching || cursors.length < 2}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Previous destinations
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetching || !data.nextCursor}
                onClick={() => setCursors([...cursors, data.nextCursor])}
              >
                Next destinations
              </Button>
            </div>
          </nav>
        </>
      ) : null}
    </div>
  );
}

export function HookPolicyEditor({
  snapshot,
  connection,
  resourceId,
  open,
  onClose,
  onReview,
  returnFocus,
}: {
  snapshot: Snapshot;
  connection: HookConnection;
  resourceId: string;
  open: boolean;
  onClose: () => void;
  onReview: (planId: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<HookPolicyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const key = [
    "hooks",
    workspaceId,
    "policy-detail",
    connection.id,
    connection.revision,
    resourceId,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<{ result: Detail }>(
        "hooks_policy_subscription",
        { workspaceId, connectionId: connection.id, resourceId },
        signal,
      ),
    enabled: open && connection.enabled && connection.available,
    staleTime: HOOK_LIMITS.REFRESH_MS,
  });
  const availability = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "configuration",
      connection.id,
      connection.revision,
    ],
    queryFn: ({ signal }) =>
      command<HookConfigurationAvailability>(
        "hooks_configuration",
        { workspaceId, connectionId: connection.id },
        signal,
      ),
    enabled: open && connection.enabled && connection.available,
    staleTime: HOOK_LIMITS.REFRESH_MS,
  });
  useEffect(() => {
    if (!base && query.data) {
      setBase({
        detail: query.data.result,
        connectionRevision: connection.revision,
      });
      setDraft(hookPolicyDraft(query.data.result.policy));
    }
  }, [base, query.data, connection.revision]);
  const dirty = Boolean(
    base &&
      draft &&
      JSON.stringify(draft) !==
        JSON.stringify(hookPolicyDraft(base.detail.policy)),
  );
  const guard = useCloseGuard(
    open && (dirty || busy),
    onClose,
    (current, next) => {
      const before = new URLSearchParams(current.search);
      const after = new URLSearchParams(next.search);
      if (!after.has("policyReview")) return false;
      before.delete("policyReview");
      after.delete("policyReview");
      return (
        current.pathname === next.pathname &&
        before.toString() === after.toString()
      );
    },
  );
  const configuration = availability.data?.configuration;
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const changed = Boolean(
    base &&
      (base.connectionRevision !== connection.revision ||
        (query.data &&
          (query.data.result.revision !== base.detail.revision ||
            query.data.result.authorityId !== base.detail.authorityId)) ||
        (configuration &&
          (configuration.revision !== base.detail.revision ||
            configuration.authorityId !== base.detail.authorityId))),
  );
  const canEdit =
    canOperate &&
    configuration?.mode === "active" &&
    configuration.canConfigure &&
    configuration.supported.policy;
  const unavailable = !connection.enabled || !connection.available;
  const blocked =
    busy ||
    changed ||
    unavailable ||
    query.isError ||
    availability.isError ||
    !canEdit;
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const saved = await command<{ result: Detail }>(
        "hooks_policy_subscription",
        { workspaceId, connectionId: connection.id, resourceId },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      setBase({
        detail: saved.result,
        connectionRevision: connection.revision,
      });
      setDraft(hookPolicyDraft(saved.result.policy));
      client.setQueryData(key, saved);
      attempt.current = null;
      void availability.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      setReload(false);
    }
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (!base || !draft || blocked || !dirty) return;
    setError(null);
    try {
      const fields = {
        workspaceId,
        connectionId: connection.id,
        connectionRevision: base.connectionRevision,
        resourceId,
        authorityId: base.detail.authorityId,
        revision: base.detail.revision,
        policy: hookPolicyValue(draft),
      };
      const identity = JSON.stringify(fields);
      if (attempt.current?.key !== identity)
        attempt.current = { key: identity, id: crypto.randomUUID() };
      setBusy(true);
      const result = await command<HookPolicyReview>(
        "hooks_policy_plan",
        { ...fields, reviewId: attempt.current.id },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      client.setQueryData(
        ["hooks", workspaceId, "policy-review", result.id],
        result,
      );
      onReview(result.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="hook-dialog hook-policy-dialog"
          data-policy-editor
          showCloseButton={!busy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!document.querySelector("[data-policy-review]"))
              restoreHookFocus(returnFocus);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {canEdit ? "Edit routing" : "Subscription routing"}
              {base ? ": " + base.detail.name : ""}
            </DialogTitle>
            <DialogDescription>
              Control future events handled by this subscription. Existing
              queued deliveries and the upstream webhook are unchanged.
            </DialogDescription>
          </DialogHeader>
          {query.isPending && !unavailable ? (
            <p role="status">Reading saved routing...</p>
          ) : null}
          {query.error ? <HookError error={query.error} /> : null}
          {availability.error ? <HookError error={availability.error} /> : null}
          {error ? <HookError error={error} /> : null}
          {unavailable ? (
            <p className="permission-notice">
              This HQ connection is unavailable. Your draft is preserved; enable
              or restore the connection before continuing.
            </p>
          ) : null}
          {configuration && !canEdit ? (
            <p className="permission-notice">
              {!canOperate
                ? "Your workspace role can inspect routing. An owner or operator must apply changes."
                : configuration.mode !== "active" ||
                    !configuration.supported.policy
                  ? "This provider has not enabled online routing changes."
                  : "This provider credential does not allow routing changes. The deployment owner must grant configuration access."}
            </p>
          ) : null}
          {changed ? (
            <p className="hook-notice" role="status">
              Saved routing or the connection changed. Your draft is preserved.
              Load saved routing before preparing another review.
            </p>
          ) : null}
          {base && draft ? (
            <form
              className="hook-form hook-policy-form"
              onSubmit={(event) => void review(event)}
            >
              <p className="hook-muted">
                Source: {base.detail.source}. Revision {base.detail.revision}.
                Read <HookTime value={base.detail.observedAt} />.
              </p>
              <HookPolicyIdentity
                resourceId={resourceId}
                authorityId={base.detail.authorityId}
              />
              <fieldset disabled={blocked}>
                <legend>Routing</legend>
                <label className="hook-checkbox">
                  <Checkbox
                    disabled={blocked}
                    checked={draft.enabled}
                    onCheckedChange={(value) =>
                      setDraft({ ...draft, enabled: value === true })
                    }
                  />
                  <span>Enabled for future events</span>
                </label>
                {!draft.enabled ? (
                  <p className="hook-notice">
                    New events will not route through this subscription. Queued
                    deliveries continue.
                  </p>
                ) : null}
              </fieldset>
              <fieldset disabled={busy}>
                <legend>Destinations ({draft.sinks.length} selected)</legend>
                <HookDestinations
                  key={base.detail.authorityId + "/" + base.detail.revision}
                  workspaceId={workspaceId}
                  connectionId={connection.id}
                  base={base.detail}
                  selected={draft.sinks}
                  disabled={blocked}
                  onChange={(sinks) => setDraft({ ...draft, sinks })}
                />
                {!draft.sinks.length ? (
                  <p className="hook-notice">
                    No destinations selected. This subscription will not send
                    notifications.
                  </p>
                ) : null}
              </fieldset>
              <fieldset disabled={blocked}>
                <legend>Subscription filters</legend>
                <HookFilterFields
                  value={draft.filter}
                  disabled={blocked}
                  onChange={(filter) => setDraft({ ...draft, filter })}
                />
              </fieldset>
              {draft.sinks.length ? (
                <fieldset disabled={blocked}>
                  <legend>Selected destinations and their filters</legend>
                  <p className="hook-muted">
                    Destination filters apply in addition to the subscription
                    filters.
                  </p>
                  {draft.sinks.map((name) => (
                    <details
                      className="hook-policy-destination-filter"
                      key={name}
                    >
                      <summary>{name}</summary>
                      <HookFilterFields
                        value={draft.sinkFilters[name] ?? hookFilterDraft()}
                        disabled={blocked}
                        onChange={(filter) =>
                          setDraft({
                            ...draft,
                            sinkFilters: {
                              ...draft.sinkFilters,
                              [name]: filter,
                            },
                          })
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={blocked}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            sinks: draft.sinks.filter(
                              (value) => value !== name,
                            ),
                          })
                        }
                      >
                        Remove {name}
                      </Button>
                    </details>
                  ))}
                </fieldset>
              ) : null}
              <div className="hook-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={guard.requestClose}
                >
                  {dirty ? "Cancel" : "Close"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || unavailable}
                  onClick={() => (dirty ? setReload(true) : void loadSaved())}
                >
                  Load saved routing
                </Button>
                {canOperate ? (
                  <Button type="submit" disabled={blocked || !dirty}>
                    {busy ? "Preparing review..." : "Review changes"}
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <div className="hook-actions">
              <Button variant="outline" onClick={guard.requestClose}>
                Close
              </Button>
              <Button
                variant="outline"
                disabled={query.isFetching || unavailable}
                onClick={() => {
                  void query.refetch();
                  void availability.refetch();
                }}
              >
                Retry read
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent className="hook-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace your draft with saved routing?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your edits will be replaced only after a successful read from
              Hookrelay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void loadSaved();
              }}
            >
              {busy ? "Loading..." : "Load saved routing"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
