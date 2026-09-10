import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Snapshot } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_CUSTODY,
  MANAGED_CONFIGURATION_DESIRED_STATE,
  managedConfigurationFieldsSchema,
  type ManagedConfiguration,
  type ManagedConfigurationDestination,
} from "../shared/managed-configurations";
import {
  SECRET_ENTRY_KIND,
  SECRET_PROVIDER_KIND,
  type SecretConnection,
  type SecretDestination,
  type SecretEntryKind,
} from "../shared/secrets";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import { command } from "./lib/api";
import {
  SecretError,
  SecretTargetPicker,
  secretSelection,
  type SecretSelection,
} from "./secret-components";
import { DiscardDialog, useCloseGuard } from "./source-editor";

export type ManagedConfigurationSeed = {
  entryKind: SecretEntryKind;
  value: string | null;
  destination: SecretDestination;
};
type DraftDestination = {
  id: string;
  selection: SecretSelection;
  desiredState: ManagedConfigurationDestination["desiredState"];
};
type Draft = {
  label: string;
  entryKind: SecretEntryKind;
  desiredValue: string;
  destinations: DraftDestination[];
};

function firstSelection(connections: SecretConnection[]): SecretSelection {
  const connection = connections.find(
    (item) =>
      item.providerKind === SECRET_PROVIDER_KIND.GITHUB &&
      item.enabled &&
      item.available &&
      item.resources.length,
  );
  return {
    connectionId: connection?.id ?? "",
    resourceId: connection?.resources[0]?.id ?? "",
    scope: { kind: "repository" },
    name: "",
  };
}

function editable(
  connections: SecretConnection[],
  initial?: ManagedConfiguration,
  seed?: ManagedConfigurationSeed,
): Draft {
  if (initial)
    return {
      label: initial.label,
      entryKind: initial.entryKind,
      desiredValue: initial.desiredValue ?? "",
      destinations: initial.destinations.map((item) => ({
        id: crypto.randomUUID(),
        selection: secretSelection(item.destination),
        desiredState: item.desiredState,
      })),
    };
  if (seed)
    return {
      label: seed.destination.name,
      entryKind: seed.entryKind,
      desiredValue: seed.value ?? "",
      destinations: [
        {
          id: crypto.randomUUID(),
          selection: secretSelection(seed.destination),
          desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
        },
      ],
    };
  return {
    label: "",
    entryKind: SECRET_ENTRY_KIND.VARIABLE,
    desiredValue: "",
    destinations: [
      {
        id: crypto.randomUUID(),
        selection: firstSelection(connections),
        desiredState: MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
      },
    ],
  };
}

function destination(
  selection: SecretSelection,
  connections: SecretConnection[],
): SecretDestination {
  const connection = connections.find(
    (item) =>
      item.id === selection.connectionId &&
      item.providerKind === SECRET_PROVIDER_KIND.GITHUB &&
      item.available &&
      item.enabled,
  );
  if (
    !connection ||
    !connection.resources.some((item) => item.id === selection.resourceId)
  )
    throw new Error(
      "Select an available GitHub connection and enrolled repository for every destination.",
    );
  return {
    connectionId: connection.id,
    connectionRevision: connection.revision,
    target: {
      resourceId: selection.resourceId,
      scope: selection.scope,
    },
    name: selection.name,
  };
}

export function ManagedConfigurationEditor({
  snapshot,
  connections,
  initial,
  seed,
  onClose,
  onSaved,
  returnFocus,
}: {
  snapshot: Snapshot;
  connections: SecretConnection[];
  initial?: ManagedConfiguration;
  seed?: ManagedConfigurationSeed;
  onClose: () => void;
  onSaved: (configuration: ManagedConfiguration) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const valueId = useId();
  const client = useQueryClient();
  const [base] = useState(() => editable(connections, initial, seed));
  const [draft, setDraft] = useState(base);
  const [configurationId] = useState(
    () => initial?.id ?? crypto.randomUUID(),
  );
  const requestIds = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const guard = useCloseGuard(
    busy || JSON.stringify(draft) !== JSON.stringify(base),
    onClose,
  );
  const eligible = connections.filter(
    (item) =>
      item.providerKind === SECRET_PROVIDER_KIND.GITHUB &&
      item.enabled &&
      item.available &&
      item.resources.length > 0 &&
      item.capabilities?.entryKinds.includes(draft.entryKind),
  );

  function updateDestination(index: number, value: DraftDestination) {
    setDraft({
      ...draft,
      destinations: draft.destinations.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const candidate = {
        label: draft.label,
        entryKind: draft.entryKind,
        custody: MANAGED_CONFIGURATION_CUSTODY.NONE,
        desiredValue:
          draft.entryKind === SECRET_ENTRY_KIND.SECRET
            ? null
            : draft.desiredValue,
        destinations: draft.destinations.map((item) => ({
          destination: destination(item.selection, eligible),
          desiredState: item.desiredState,
        })),
      };
      const parsed = managedConfigurationFieldsSchema.safeParse(candidate);
      if (!parsed.success)
        throw new Error(
          "Enter a label and choose distinct valid GitHub repository or environment destinations.",
        );
      const requestKey = JSON.stringify([
        initial?.revision ?? 0,
        parsed.data,
      ]);
      if (!requestIds.current.has(requestKey))
        requestIds.current.set(requestKey, crypto.randomUUID());
      setBusy(true);
      const saved = await command<ManagedConfiguration>(
        "secrets_configuration_save",
        {
          workspaceId,
          configurationId,
          revision: initial?.revision ?? 0,
          requestId: requestIds.current.get(requestKey),
          configuration: parsed.data,
        },
      );
      void client.invalidateQueries({ queryKey: ["secrets", workspaceId] });
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
              {initial ? "Edit managed configuration" : "Manage configuration"}
            </DialogTitle>
            <DialogDescription>
              HQ stores ownership and desired state. It can store non-secret
              variable values, but it never accepts or stores a secret value in
              this workflow.
            </DialogDescription>
          </DialogHeader>
          <form className="secret-form" onSubmit={save}>
            <label className="hook-field">
              HQ label
              <Input
                value={draft.label}
                maxLength={80}
                required
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, label: event.target.value })
                }
              />
            </label>
            <div className="hook-field">
              <label htmlFor="managed-entry-kind">Configuration kind</label>
              <Select
                value={draft.entryKind}
                disabled={busy || Boolean(initial)}
                onValueChange={(entryKind: SecretEntryKind) =>
                  setDraft({ ...draft, entryKind })
                }
              >
                <SelectTrigger id="managed-entry-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SECRET_ENTRY_KIND.VARIABLE}>
                    Non-secret variable
                  </SelectItem>
                  <SelectItem value={SECRET_ENTRY_KIND.SECRET}>
                    Secret name tracking
                  </SelectItem>
                </SelectContent>
              </Select>
              {initial ? (
                <p>Kind cannot change after this managed identity is created.</p>
              ) : null}
            </div>
            {draft.entryKind === SECRET_ENTRY_KIND.VARIABLE ? (
              <div className="hook-field">
                <label htmlFor={valueId}>Desired non-secret value</label>
                <Textarea
                  id={valueId}
                  aria-describedby={valueId + "-description"}
                  className="secret-value"
                  value={draft.desiredValue}
                  maxLength={64 * 1024}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({ ...draft, desiredValue: event.target.value })
                  }
                />
                <span id={valueId + "-description"}>
                  This value is readable to workspace members and must not
                  contain credentials or other sensitive material.
                </span>
              </div>
            ) : (
              <p className="hook-notice">
                Secret management records ownership and expected presence only.
                Without a vault, HQ cannot store, compare, or restore the value.
              </p>
            )}
            <fieldset className="secret-destination">
              <legend>Desired destinations ({draft.destinations.length})</legend>
              {draft.destinations.map((item, index) => (
                <div className="managed-destination" key={item.id}>
                  <div className="managed-destination-heading">
                    <strong>Destination {index + 1}</strong>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || draft.destinations.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          destinations: draft.destinations.filter(
                            (_value, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" /> Remove
                    </Button>
                  </div>
                  <SecretTargetPicker
                    workspaceId={workspaceId}
                    connections={eligible}
                    value={item.selection}
                    disabled={busy}
                    writable={false}
                    entryKind={draft.entryKind}
                    allowedScopeKinds={["repository", "environment"]}
                    onChange={(selection) =>
                      updateDestination(index, { ...item, selection })
                    }
                  />
                  <div className="hook-field">
                    <label htmlFor={"managed-state-" + index}>
                      Desired state
                    </label>
                    <Select
                      value={item.desiredState}
                      disabled={busy}
                      onValueChange={(
                        desiredState: ManagedConfigurationDestination["desiredState"],
                      ) => updateDestination(index, { ...item, desiredState })}
                    >
                      <SelectTrigger id={"managed-state-" + index}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          value={MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT}
                        >
                          Present
                        </SelectItem>
                        <SelectItem
                          value={MANAGED_CONFIGURATION_DESIRED_STATE.ABSENT}
                        >
                          Absent
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={busy || draft.destinations.length >= 10}
                onClick={() =>
                  setDraft({
                    ...draft,
                    destinations: [
                      ...draft.destinations,
                      {
                        id: crypto.randomUUID(),
                        selection: firstSelection(eligible),
                        desiredState:
                          MANAGED_CONFIGURATION_DESIRED_STATE.PRESENT,
                      },
                    ],
                  })
                }
              >
                <Plus size={16} aria-hidden="true" /> Add destination
              </Button>
            </fieldset>
            {!eligible.length ? (
              <p className="hook-notice">
                No available GitHub Actions connection supports this kind. Add
                or repair provider access before saving this definition.
              </p>
            ) : null}
            {error ? <SecretError error={error} /> : null}
            <div className="secret-actions">
              <Button type="submit" disabled={busy || !eligible.length}>
                {busy ? "Saving..." : "Save managed configuration"}
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
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
