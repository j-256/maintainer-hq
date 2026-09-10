import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import type { Snapshot } from "../shared/domain";
import {
  SECRET_LIMITS,
  secretDraftInput,
  type SecretConnection,
  type SecretDestination,
  type SecretReview,
} from "../shared/secrets";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import {
  SecretError,
  SecretTargetPicker,
  selectedSecret,
  secretSelection,
  type SecretSelection,
} from "./secret-components";

export function SecretDraftEditor({
  snapshot,
  connections,
  initial,
  source,
  onClose,
  onPrepared,
  returnFocus,
}: {
  snapshot: Snapshot;
  connections: SecretConnection[];
  initial?: SecretDestination[];
  source?: SecretDestination;
  onClose: () => void;
  onPrepared: (id: string) => void;
  returnFocus: HTMLElement | null;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [destinations, setDestinations] = useState(() =>
    (initial?.length ? initial : [undefined]).map((item) => ({
      key: crypto.randomUUID(),
      value: secretSelection(item),
    })),
  );
  const [sourceValue, setSourceValue] = useState(() =>
    source ? secretSelection(source) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState(false);
  const attempt = useRef<{ shape: string; id: string } | null>(null);
  const planned = useRef(false);
  const guard = useCloseGuard(changed || busy, onClose);
  function change(key: string, value: SecretSelection) {
    setChanged(true);
    setDestinations((items) =>
      items.map((item) => (item.key === key ? { ...item, value } : item)),
    );
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const selection = {
        workspaceId,
        destinations: destinations.map((item) =>
          selectedSecret(item.value, connections),
        ),
        source: sourceValue ? selectedSecret(sourceValue, connections) : null,
      };
      const shape = JSON.stringify(selection);
      if (attempt.current?.shape !== shape)
        attempt.current = { shape, id: crypto.randomUUID() };
      const parsed = secretDraftInput.safeParse({
        ...selection,
        reviewId: attempt.current.id,
      });
      if (!parsed.success)
        throw new Error(
          "Choose distinct, named destinations. The source cannot also be a destination.",
        );
      setBusy(true);
      const review = await command<SecretReview>("secrets_draft", parsed.data);
      client.setQueryData(
        ["secrets", workspaceId, "review", review.id],
        review,
      );
      void client.invalidateQueries({
        queryKey: ["secrets", workspaceId, "history"],
      });
      planned.current = true;
      guard.saved();
      onPrepared(review.id);
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
            if (planned.current) return;
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {sourceValue
                ? "Plan a supplied-value scope change"
                : "Distribute a supplied value"}
            </DialogTitle>
            <DialogDescription>
              Select exact destinations first. HQ will read their metadata and
              prepare a review before asking for the value. No provider write
              happens here.
            </DialogDescription>
          </DialogHeader>
          <form className="secret-form" onSubmit={prepare}>
            {destinations.some(
              (item) =>
                connections.find(
                  (connection) => connection.id === item.value.connectionId,
                )?.providerKind === "cloudflare-workers",
            ) ||
            (sourceValue &&
              connections.find(
                (connection) => connection.id === sourceValue.connectionId,
              )?.providerKind === "cloudflare-workers") ? (
              <p className="hook-notice">
                Cloudflare changes activate a new Worker version. Choose one
                binding per Worker across this distribution and its source; a
                second change on the same Worker needs a fresh review.
                Same-Worker rename cleanup is not supported. Text secret values
                are limited to 5 KiB of UTF-8.
              </p>
            ) : null}
            {sourceValue ? (
              <fieldset className="secret-destination">
                <legend>Original source</legend>
                <SecretTargetPicker
                  workspaceId={workspaceId}
                  connections={connections}
                  value={sourceValue}
                  disabled={busy}
                  onChange={(value) => {
                    setChanged(true);
                    setSourceValue(value);
                  }}
                />
                <p className="hook-notice">
                  Supply the value yourself. Providers cannot reveal it. The
                  source stays in place until destination writes are accepted
                  and you separately review removal. Scope changes are not
                  atomic.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setChanged(true);
                    setSourceValue(null);
                  }}
                >
                  Keep source; distribute only
                </Button>
              </fieldset>
            ) : null}
            {destinations.map((item, index) => (
              <fieldset key={item.key} className="secret-destination">
                <legend>Destination {index + 1}</legend>
                <SecretTargetPicker
                  workspaceId={workspaceId}
                  connections={connections}
                  value={item.value}
                  onChange={(value) => change(item.key, value)}
                  disabled={busy}
                />
                {destinations.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setChanged(true);
                      setDestinations((items) =>
                        items.filter((value) => value.key !== item.key),
                      );
                    }}
                  >
                    <X size={16} aria-hidden="true" /> Remove destination{" "}
                    {index + 1}
                  </Button>
                ) : null}
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={
                busy || destinations.length >= SECRET_LIMITS.DESTINATIONS
              }
              onClick={() => {
                setChanged(true);
                setDestinations((items) => [
                  ...items,
                  {
                    key: crypto.randomUUID(),
                    value: {
                      ...secretSelection(),
                      name: items[0]?.value.name ?? "",
                    },
                  },
                ]);
              }}
            >
              <Plus size={16} aria-hidden="true" /> Add destination (
              {destinations.length}/{SECRET_LIMITS.DESTINATIONS})
            </Button>
            <p className="hook-muted">
              One supplied value is sent to all selected destinations, with each
              provider's own input and activation requirements. Existing names
              may be overwritten.
            </p>
            {error ? (
              <>
                <SecretError error={error} />
                {attempt.current ? (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      guard.saved();
                      onPrepared(attempt.current!.id);
                    }}
                  >
                    Inspect this preparation attempt
                  </Button>
                ) : null}
              </>
            ) : null}
            <div className="secret-actions">
              <Button type="submit" disabled={busy}>
                {busy ? "Checking destinations..." : "Prepare destinations"}
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
