import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ResourceProjectEditor } from "./resource-project";
import type { Snapshot } from "../shared/domain";
import {
  hookConnectionFields,
  type HookAssociation,
  type HookConnection,
  type HookConnectionFields,
} from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
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
import {
  HookError,
  HOOK_REQUEST_TIMEOUT_MS,
  restoreHookFocus,
} from "./hook-components";

const NO_PROJECT = ":none";
function fields(value?: HookConnection): HookConnectionFields {
  return value
    ? {
        name: value.name,
        providerRef: value.providerRef,
        enabled: value.enabled,
        projectId: value.projectId,
      }
    : { name: "", providerRef: "", enabled: true, projectId: null };
}
function ProjectSelect({
  value,
  onChange,
  snapshot,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  snapshot: Snapshot;
  disabled: boolean;
}) {
  return (
    <Select
      value={value ?? NO_PROJECT}
      onValueChange={(next) => onChange(next === NO_PROJECT ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id="hook-project" aria-label="Project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_PROJECT}>No project context</SelectItem>
        {snapshot.projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function HookConnectionEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
}: {
  initial?: HookConnection;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (connection: HookConnection) => void;
  returnFocus: HTMLElement | null;
}) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() => fields(initial));
  const [connectionId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const dirty = JSON.stringify(draft) !== JSON.stringify(fields(base));
  const guard = useCloseGuard(dirty || busy, onClose);
  const references = useQuery({
    queryKey: ["hooks", workspaceId, "providers"],
    queryFn: ({ signal }) =>
      command<{ id: string; name: string; available: boolean }[]>(
        "hooks_providers",
        { workspaceId },
        signal,
      ),
  });
  const missing = Boolean(
    draft.providerRef &&
    references.data &&
    !references.data.some((value) => value.id === draft.providerRef),
  );
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const saved = await command<HookConnection[]>(
        "hooks_connections",
        { workspaceId },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      const value = saved.find((connection) => connection.id === connectionId);
      if (!value)
        throw new Error(
          "The saved connection is no longer available. Your draft has been kept.",
        );
      client.setQueryData(["hooks", workspaceId, "connections"], saved);
      setBase(value);
      setDraft(fields(value));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = hookConnectionFields.safeParse(draft);
    if (!parsed.success) {
      setError(
        new Error("Enter a connection name and select a configured provider."),
      );
      form.current
        ?.querySelector<HTMLElement>(
          draft.name.trim() ? '[role="combobox"]' : "input",
        )
        ?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await command<HookConnection>(
        "hooks_connection_save",
        {
          workspaceId,
          connectionId,
          revision: base?.revision ?? 0,
          connection: parsed.data,
        },
        AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
      );
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId] });
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      onSaved(saved);
      guard.saved();
    } catch (failure) {
      setError(failure);
      void client.invalidateQueries({
        queryKey: ["hooks", workspaceId, "connections"],
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="hook-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreHookFocus(returnFocus);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initial ? "Edit Hookrelay connection" : "Connect Hookrelay"}
            </DialogTitle>
            <DialogDescription>
              Manage how this workspace reaches Hookrelay. Routes, sinks, and
              notification delivery remain provider-owned.
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={save} className="hook-form">
            {error ? <HookError error={error} /> : null}
            {references.error ? <HookError error={references.error} /> : null}
            <label htmlFor="hook-connection-name">
              Connection name
              <Input
                id="hook-connection-name"
                required
                maxLength={80}
                value={draft.name}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="Production hooks"
              />
            </label>
            <div className="hook-field">
              <label htmlFor="hook-provider">Provider</label>
              <Select
                value={draft.providerRef}
                onValueChange={(providerRef) =>
                  setDraft({ ...draft, providerRef })
                }
                disabled={busy || references.isPending}
              >
                <SelectTrigger
                  id="hook-provider"
                  aria-label="Hookrelay provider"
                >
                  <SelectValue
                    placeholder={
                      references.isPending
                        ? "Loading providers..."
                        : "Select a configured provider"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {missing ? (
                    <SelectItem value={draft.providerRef}>
                      Saved provider unavailable
                    </SelectItem>
                  ) : null}
                  {references.data?.map((provider) => (
                    <SelectItem
                      key={provider.id}
                      value={provider.id}
                      disabled={!provider.available}
                    >
                      {provider.name}
                      {provider.available ? "" : " (binding unavailable)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p>
                Only deployment-approved, workspace-scoped providers appear.
                Credential values never enter this form.
              </p>
            </div>
            {references.data?.length === 0 ? (
              <p className="hook-notice">
                No provider is provisioned for this workspace. The deployment
                owner must add a scoped credential and private service binding
                before enrollment.
              </p>
            ) : null}
            <div className="hook-field">
              <label htmlFor="hook-project">Connection project context</label>
              <ProjectSelect
                value={draft.projectId}
                onChange={(projectId) => setDraft({ ...draft, projectId })}
                snapshot={snapshot}
                disabled={busy}
              />
              <p>
                Group this connection without requiring a repository. This does
                not associate its subscriptions; link each resource explicitly.
              </p>
            </div>
            <label className="hook-checkbox">
              <Checkbox
                checked={draft.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  setDraft({ ...draft, enabled: enabled === true })
                }
              />{" "}
              Enable this HQ connection
            </label>
            <p className="hook-muted">
              Disabling this connection stops HQ reads and new operations
              through it. It does not pause Hookrelay or its notifications.
              Existing receipts can still be reconciled.
            </p>
            {initial && base && initial.revision > base.revision ? (
              <p className="hook-notice" role="status">
                Settings changed elsewhere. Your draft is preserved; load the
                saved version before saving again.
              </p>
            ) : null}
            <div className="hook-actions">
              {initial ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setReload(true)}
                >
                  Load saved settings
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || (!dirty && Boolean(initial))}
              >
                {busy ? "Saving..." : "Save connection"}
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
              Fetch the latest saved connection and replace your unsaved edits
              only if that read succeeds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void loadSaved()}>
              Load saved settings
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function HookAssociationEditor({
  snapshot,
  connectionId,
  initial,
  onClose,
  onSaved,
  returnFocus,
}: {
  snapshot: Snapshot;
  connectionId: string;
  initial: HookAssociation;
  onClose: () => void;
  onSaved: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [params] = useSearchParams();
  return (
    <ResourceProjectEditor
      snapshot={snapshot}
      reference={{
        workspaceId: snapshot.workspace.id,
        kind: "hook",
        connectionId,
        resourceKey: initial.subscription,
      }}
      suggestedProjectId={params.get("project") ?? undefined}
      onClose={onClose}
      onSaved={onSaved}
      returnFocus={returnFocus}
    />
  );
}
