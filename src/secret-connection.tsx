import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Snapshot } from "../shared/domain";
import {
  secretConnectionFields,
  SECRET_PROVIDER_KIND,
  type SecretConnection,
  type SecretProviderReference,
  type SecretProviderKind,
} from "../shared/secrets";
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
import { SecretError, SecretTime } from "./secret-components";

function fields(
  value?: SecretConnection,
  providerRef = "",
  providerKind: SecretProviderKind = SECRET_PROVIDER_KIND.GITHUB,
) {
  return value
    ? {
        name: value.name,
        providerKind: value.providerKind,
        providerRef: value.providerRef,
        resourceIds: [...value.resourceIds],
        enabled: value.enabled,
      }
    : {
        name: "",
        providerKind,
        providerRef,
        resourceIds: [] as string[],
        enabled: true,
      };
}
export function SecretConnectionEditor({
  snapshot,
  initial,
  initialProviderRef,
  initialProviderKind,
  onClose,
  onSaved,
  returnFocus,
}: {
  snapshot: Snapshot;
  initial?: SecretConnection;
  initialProviderRef?: string;
  initialProviderKind?: SecretProviderKind;
  onClose: () => void;
  onSaved: (connection: SecretConnection) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() =>
    fields(initial, initialProviderRef, initialProviderKind),
  );
  const [id] = useState(() => initial?.id ?? crypto.randomUUID());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const guard = useCloseGuard(
    JSON.stringify(draft) !==
      JSON.stringify(fields(base, initialProviderRef, initialProviderKind)) ||
      busy,
    onClose,
  );
  const providers = useQuery({
    queryKey: ["secrets", workspaceId, "providers"],
    queryFn: ({ signal }) =>
      command<SecretProviderReference[]>(
        "secrets_providers",
        { workspaceId },
        signal,
      ),
    retry: false,
  });
  const provider = providers.data?.find(
    (item) => item.id === draft.providerRef && item.kind === draft.providerKind,
  );
  const resources = provider?.resources ?? [];
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = secretConnectionFields.safeParse(draft);
    if (!parsed.success) {
      setError(
        new Error(
          "Enter a connection name, choose an installed provider, and select its resources.",
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await command<SecretConnection>("secrets_connection_save", {
        workspaceId,
        connectionId: id,
        revision: base?.revision ?? 0,
        connection: parsed.data,
      });
      void client.invalidateQueries({ queryKey: ["secrets", workspaceId] });
      guard.saved();
      onSaved(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const values = await command<SecretConnection[]>("secrets_connections", {
        workspaceId,
      });
      const current = values.find((value) => value.id === id);
      if (!current)
        throw new Error(
          "This connection is no longer available. Your draft has been kept.",
        );
      setBase(current);
      setDraft(fields(current));
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
          className="secret-dialog"
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
                ? "Secrets connection settings"
                : "Connect a Secrets provider"}
            </DialogTitle>
            <DialogDescription>
              Choose the credential and resources HQ may use. Saving changes
              access through this connection, not provider permissions or
              configuration values.
            </DialogDescription>
          </DialogHeader>
          <form className="secret-form" onSubmit={save}>
            <label className="hook-field">
              Connection name
              <Input
                value={draft.name}
                maxLength={80}
                required
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <div className="hook-field">
              <label htmlFor="secret-provider">Installed provider</label>
              <Select
                value={
                  draft.providerRef
                    ? draft.providerKind + ":" + draft.providerRef
                    : ""
                }
                disabled={busy || providers.isPending}
                onValueChange={(key) => {
                  const chosen = providers.data?.find(
                    (item) => item.kind + ":" + item.id === key,
                  );
                  if (!chosen) return;
                  setDraft({
                    ...draft,
                    providerKind: chosen.kind,
                    providerRef: chosen.id,
                    resourceIds: [],
                  });
                }}
              >
                <SelectTrigger id="secret-provider">
                  <SelectValue placeholder="Select installed provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.data
                    ?.filter(
                      (item) => !initial || item.kind === initial.providerKind,
                    )
                    .map((item) => (
                      <SelectItem
                        value={item.kind + ":" + item.id}
                        key={item.kind + item.id}
                        disabled={!item.available}
                      >
                        {item.name}
                        {item.writable ? "" : " (read only)"}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {providers.isPending ? (
              <p role="status">Loading approved provider scopes...</p>
            ) : null}
            {providers.error ? (
              <>
                <SecretError error={providers.error} />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void providers.refetch()}
                >
                  Retry provider list
                </Button>
              </>
            ) : null}
            {providers.data && !providers.data.length ? (
              <p className="hook-notice">
                No provider configuration credential is configured. Close this
                form and open Provider access to add a scoped token through
                private input. Do not paste credentials in connection settings
                or reuse the fleet collector token.
              </p>
            ) : null}
            {provider ? (
              <p className="hook-muted">
                Credential expires <SecretTime value={provider.expiresAt} />.{" "}
                {provider.writable
                  ? "Declared writable; provider permissions are checked during each operation."
                  : "Configuration reads only. Secret distribution is unavailable."}
              </p>
            ) : null}
            <fieldset className="secret-destination">
              <legend>Enrolled resources ({draft.resourceIds.length})</legend>
              <Input
                aria-label="Filter approved resources"
                placeholder="Filter approved resources"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <div className="secret-choices">
                {resources
                  .filter((resource) =>
                    resource.label.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((resource) => (
                    <label key={resource.id}>
                      <Checkbox
                        checked={draft.resourceIds.includes(resource.id)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            resourceIds: checked
                              ? [...draft.resourceIds, resource.id]
                              : draft.resourceIds.filter(
                                  (value) => value !== resource.id,
                                ),
                          })
                        }
                      />
                      <span>{resource.label}</span>
                    </label>
                  ))}
              </div>
              {draft.resourceIds.some(
                (resourceId) =>
                  !resources.some((item) => item.id === resourceId),
              ) ? (
                <p role="alert">
                  Some selected resources are outside the installed scope.
                  Reload saved enrollment or choose an available provider before
                  saving.
                </p>
              ) : null}
            </fieldset>
            <label className="secret-checkbox">
              <Checkbox
                checked={draft.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  setDraft({ ...draft, enabled: enabled === true })
                }
              />
              <span>Enable this connection in HQ</span>
            </label>
            <p className="hook-muted">
              Disabling blocks provider reads and new secret changes through
              this connection. It does not revoke the provider credential,
              remove configuration or undo changes already sent to the
              provider.
            </p>
            {error ? <SecretError error={error} /> : null}
            <div className="secret-actions">
              <Button type="submit" disabled={busy || !provider?.available}>
                {busy ? "Saving..." : "Save connection"}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
              {base ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setReload(true)}
                >
                  Reload saved connection
                </Button>
              ) : null}
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace this draft with saved enrollment?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved connection choices will be discarded. Provider
              configuration will not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void loadSaved()}>
              Reload saved
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
