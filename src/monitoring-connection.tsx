import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "../shared/domain";
import {
  monitorConnectionFields,
  type MonitorConnection,
  type MonitorConnectionFields,
} from "../shared/monitoring";
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
import { MonitorError } from "./monitoring-components";
import { RESOURCE_REQUEST_TIMEOUT_MS } from "./resource-repositories";

const NO_PROJECT = ":none";
function fields(value?: MonitorConnection): MonitorConnectionFields {
  return value
    ? {
        name: value.name,
        providerRef: value.providerRef,
        enabled: value.enabled,
        projectId: value.projectId,
      }
    : { name: "", providerRef: "", enabled: true, projectId: null };
}
export function MonitoringConnectionEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
}: {
  initial?: MonitorConnection;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (value: MonitorConnection) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() => fields(initial));
  const [connectionId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(fields(base));
  const guard = useCloseGuard(dirty || busy, onClose);
  const providers = useQuery({
    queryKey: ["monitoring", workspaceId, "providers"],
    queryFn: ({ signal }) =>
      command<{ id: string; name: string; available: boolean }[]>(
        "monitoring_providers",
        { workspaceId },
        signal,
      ),
  });
  const missing =
    draft.providerRef &&
    providers.data &&
    !providers.data.some((value) => value.id === draft.providerRef);
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const saved = await command<MonitorConnection[]>(
        "monitoring_connections",
        { workspaceId },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      const value = saved.find((connection) => connection.id === connectionId);
      if (!value)
        throw new Error(
          "This connection is no longer available. Your draft is still here.",
        );
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
    const parsed = monitorConnectionFields.safeParse(draft);
    if (!parsed.success) {
      setError(
        new Error("Enter a name and select an available provider reference."),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await command<MonitorConnection>(
        "monitoring_connection_save",
        {
          workspaceId,
          connectionId,
          revision: base?.revision ?? 0,
          connection: parsed.data,
        },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      void client.invalidateQueries({ queryKey: ["monitoring", workspaceId] });
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      guard.saved();
      onSaved(saved);
    } catch (failure) {
      setError(failure);
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
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initial
                ? "Monitoring connection settings"
                : "Connect Endpoint Monitor"}
            </DialogTitle>
            <DialogDescription>
              Enroll a deployment-approved provider in this workspace.
              Credentials stay on the server. Connecting it does not add targets
              or enable probes.
            </DialogDescription>
          </DialogHeader>
          <form className="hook-form" onSubmit={save}>
            {error || providers.error ? (
              <MonitorError error={error ?? providers.error} />
            ) : null}
            <label htmlFor="monitor-connection-name">
              Connection name
              <Input
                id="monitor-connection-name"
                value={draft.name}
                disabled={busy}
                required
                maxLength={80}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <div className="hook-field">
              <label htmlFor="monitor-provider">Provider reference</label>
              <Select
                value={draft.providerRef}
                disabled={busy || providers.isPending}
                onValueChange={(providerRef) =>
                  setDraft({ ...draft, providerRef })
                }
              >
                <SelectTrigger id="monitor-provider">
                  <SelectValue
                    placeholder={
                      providers.isPending
                        ? "Loading providers..."
                        : "Choose an approved provider"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {missing ? (
                    <SelectItem value={draft.providerRef}>
                      {draft.providerRef} (unavailable)
                    </SelectItem>
                  ) : null}
                  {providers.data?.map((value) => (
                    <SelectItem
                      key={value.id}
                      value={value.id}
                      disabled={!value.available}
                    >
                      {value.name}
                      {value.available ? "" : " (binding unavailable)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {providers.data?.length === 0 ? (
                <p>
                  No approved monitoring references are installed for this
                  workspace. The deployment owner must enroll a scoped
                  credential and private binding.
                </p>
              ) : null}
              {missing ? (
                <p className="permission-notice">
                  The saved reference is unavailable. Keep it for recovery or
                  deliberately select a replacement.
                </p>
              ) : null}
            </div>
            <div className="hook-field">
              <label htmlFor="monitor-project">
                Connection project context
              </label>
              <Select
                value={draft.projectId ?? NO_PROJECT}
                disabled={busy}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    projectId: value === NO_PROJECT ? null : value,
                  })
                }
              >
                <SelectTrigger id="monitor-project">
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
              <p>
                This labels the connection, not its targets. Associate
                individual targets explicitly; repository links remain separate.
              </p>
            </div>
            <label className="hook-checkbox">
              <Checkbox
                checked={draft.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  setDraft({ ...draft, enabled: Boolean(enabled) })
                }
              />
              Enabled in HQ
            </label>
            <p className="hook-muted">
              Disabling this connection stops new HQ reads and actions, not
              Endpoint Monitor's probes or notifications. Original operation
              receipts remain available for recovery.
            </p>
            <div className="hook-actions">
              {initial ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => (dirty ? setReload(true) : void loadSaved())}
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
              Fetch the latest saved connection. Your edits stay intact if the
              read fails.
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
