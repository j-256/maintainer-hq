import { useFlowBlocker as useBlocker } from "./lib/flow-blocker";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBeforeUnload, type Location } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { type Connection, type Snapshot } from "../shared/domain";
import {
  SOURCE_LIMITS,
  sourceFields,
  type SourceFields,
} from "../shared/sources";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
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

export const SOURCE_REQUEST_TIMEOUT_MS = 15000;

export function useCloseGuard(
  dirty: boolean,
  onClose: () => void,
  allowNavigation?: (current: Location, next: Location) => boolean,
) {
  const [confirming, setConfirming] = useState(false);
  const allow = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !allow.current &&
      !allowNavigation?.(currentLocation, nextLocation) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useBeforeUnload(
    useCallback(
      (event) => {
        if (dirty && !allow.current) {
          event.preventDefault();
          event.returnValue = "";
        }
      },
      [dirty],
    ),
  );
  return {
    open: confirming || blocker.state === "blocked",
    requestClose: () => (dirty ? setConfirming(true) : onClose()),
    keep: () => {
      setConfirming(false);
      if (blocker.state === "blocked") blocker.reset();
    },
    discard: () => {
      allow.current = true;
      if (blocker.state === "blocked") blocker.proceed();
      else onClose();
    },
    permitNavigation: () => {
      allow.current = true;
    },
    saved: () => {
      allow.current = true;
      onClose();
    },
  };
}

export function DiscardDialog({
  guard,
  busy,
  credential = false,
  uncertain = false,
  recoveryHref,
}: {
  guard: ReturnType<typeof useCloseGuard>;
  busy: boolean;
  credential?: boolean;
  uncertain?: boolean;
  recoveryHref?: string;
}) {
  return (
    <AlertDialog
      open={guard.open}
      onOpenChange={(open) => {
        if (!open) guard.keep();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {uncertain
              ? "Close without confirming the outcome?"
              : credential
                ? "Have you saved the credential?"
                : "Discard unsaved changes?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {uncertain
              ? "Apply may still finish. Save this review URL to check the original receipt before starting another batch. Closing does not cancel Apply."
              : credential
                ? "The value cannot be retrieved after closing. If it is lost, revoke this credential and create a replacement."
                : "Your changes have not been saved. Keep editing to preserve this draft."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {uncertain && recoveryHref ? (
          <label className="grid min-w-0 gap-2 text-sm">
            Saved review URL
            <Input
              readOnly
              value={recoveryHref}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={guard.keep}>
            {uncertain
              ? "Keep review open"
              : credential
                ? "Keep credential open"
                : "Keep editing"}
          </AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={guard.discard}>
            {uncertain
              ? "Close editor"
              : credential
                ? "Close credential"
                : "Discard changes"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function editable(source?: Connection, hasRepositories = true): SourceFields {
  return source
    ? {
        name: source.name,
        enabled: source.enabled,
        freshnessMinutes: source.freshnessMinutes,
        repositoryIds: [...source.repositoryIds],
      }
    : {
        name: "",
        enabled: hasRepositories,
        freshnessMinutes: SOURCE_LIMITS.DEFAULT_FRESHNESS_MINUTES,
        repositoryIds: [],
      };
}

export function SourceEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
}: {
  initial?: Connection;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (source: Connection) => void;
  returnFocus: HTMLElement | null;
}) {
  const [base, setBase] = useState(() =>
    editable(initial, Boolean(snapshot.repositories.length)),
  );
  const [draft, setDraft] = useState(() =>
    editable(initial, Boolean(snapshot.repositories.length)),
  );
  const [sourceId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [revision, setRevision] = useState(initial?.revision);
  const [query, setQuery] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const guard = useCloseGuard(dirty || busy, onClose);
  const latest = snapshot.connections.find((source) => source.id === sourceId);
  useEffect(() => {
    if (Object.keys(errors).length)
      form.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [errors]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = sourceFields.safeParse(draft);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.path[0] === "repositoryIds"
              ? draft.repositoryIds.length
                ? "Select up to " + SOURCE_LIMITS.REPOSITORIES + " repositories"
                : "Select a repository or turn off Allow publishing to prepare an empty source"
              : issue.path[0] === "name"
                ? "Enter a name for this publisher"
                : "Choose a freshness window between 5 and 1440 minutes",
          ]),
        ),
      );
      return;
    }
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const source = await command<Connection>(
        initial ? "source_update" : "source_enroll",
        {
          workspaceId: snapshot.workspace.id,
          sourceId,
          source: parsed.data,
          ...(initial ? { revision } : {}),
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      void queryClient.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
      onSaved(source);
      guard.saved();
    } catch (error) {
      setError(
        error instanceof Error
          ? error
          : new Error("Settings could not be saved. Your draft is preserved."),
      );
      void queryClient.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
    } finally {
      setBusy(false);
    }
  }
  const available = snapshot.repositories.filter((repository) =>
    repository.fullName.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="source-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initial ? "Edit publisher settings" : "Enroll a publisher"}
            </DialogTitle>
            <DialogDescription>
              A publisher sends local checkout updates to HQ. It cannot read
              workspace data, change expectations, or execute commands.
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={save} noValidate>
            <div className="source-form-scroll">
              {error ? (
                <div role="alert" className="source-error">
                  <TriangleAlert size={16} />
                  <div>
                    {error.message}
                    {error instanceof RequestError &&
                    error.code === "revision_conflict" &&
                    latest ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setReload(true)}
                      >
                        Discard draft and load latest
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="source-name">Publisher name</label>
                <Input
                  id="source-name"
                  value={draft.name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={
                    errors.name ? "source-name-error" : undefined
                  }
                  placeholder="For example, my development laptop"
                />
                {errors.name ? (
                  <p
                    className="field-error"
                    id="source-name-error"
                    role="alert"
                  >
                    {errors.name}
                  </p>
                ) : null}
              </div>
              <div className="form-field">
                <label htmlFor="source-freshness">
                  Consider reports stale after
                </label>
                <div className="source-number">
                  <Input
                    id="source-freshness"
                    type="number"
                    min={5}
                    max={1440}
                    value={draft.freshnessMinutes || ""}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        freshnessMinutes: Number(event.target.value),
                      })
                    }
                    aria-invalid={Boolean(errors.freshnessMinutes)}
                    aria-describedby="source-freshness-help"
                  />
                  <span>minutes</span>
                </div>
                <p className="field-help" id="source-freshness-help">
                  Measured from when the checkout was observed, not when the
                  dashboard refreshed. Extending this window will not revive
                  expired evidence.
                </p>
                {errors.freshnessMinutes ? (
                  <p role="alert" className="field-error">
                    {errors.freshnessMinutes}
                  </p>
                ) : null}
              </div>
              <fieldset className="source-repository-picker">
                <legend>
                  Allowed repositories{" "}
                  <span>{draft.repositoryIds.length} selected</span>
                </legend>
                <p className="field-help">
                  Reports outside this list are rejected. Changes apply to every
                  credential for this source. A disabled source can stay empty
                  while preparing a project transfer.
                </p>
                <Input
                  aria-label="Find repositories to allow"
                  placeholder="Find a repository..."
                  value={query}
                  disabled={busy}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-invalid={Boolean(errors.repositoryIds)}
                  aria-describedby={
                    errors.repositoryIds
                      ? "source-repositories-error"
                      : undefined
                  }
                />
                {errors.repositoryIds ? (
                  <p
                    id="source-repositories-error"
                    role="alert"
                    className="field-error"
                  >
                    {errors.repositoryIds}
                  </p>
                ) : null}
                <div className="source-repository-options">
                  {available.length ? (
                    available.map((repository) => (
                      <label key={repository.id}>
                        <Checkbox
                          checked={draft.repositoryIds.includes(repository.id)}
                          disabled={busy}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              repositoryIds: checked
                                ? [...draft.repositoryIds, repository.id].sort()
                                : draft.repositoryIds.filter(
                                    (id) => id !== repository.id,
                                  ),
                            })
                          }
                        />
                        <span>{repository.fullName}</span>
                      </label>
                    ))
                  ) : (
                    <p className="field-help">
                      {snapshot.repositories.length
                        ? "No repositories match this search."
                        : "No repositories are enrolled here. Keep publishing disabled to prepare this source."}
                    </p>
                  )}
                </div>
              </fieldset>
              <label className="source-enabled">
                <Checkbox
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, enabled: Boolean(checked) })
                  }
                />
                <span>
                  <strong>Allow publishing</strong>
                  <small>
                    Disabling stops every credential and expires this source's
                    existing evidence.
                  </small>
                </span>
              </label>
            </div>
            <div className="source-dialog-actions">
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
                disabled={busy || Boolean(initial && !dirty)}
              >
                {busy
                  ? "Saving..."
                  : initial
                    ? "Save changes"
                    : "Enroll publisher"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace this draft with saved settings?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved changes will be discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (latest) {
                  const next = editable(latest);
                  setBase(next);
                  setDraft(next);
                  setRevision(latest.revision);
                  setError(null);
                  setErrors({});
                }
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
