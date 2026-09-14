import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import type { Snapshot } from "../shared/domain";
import {
  GITHUB_REFRESH_LIMITS as LIMITS,
  githubSourceFields,
  type GitHubSource,
  type GitHubSourceFields,
  type GitHubCredentialReference,
} from "../shared/github";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
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
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./components/ui/alert-dialog";
import {
  DiscardDialog,
  useCloseGuard,
  SOURCE_REQUEST_TIMEOUT_MS,
} from "./source-editor";

const NO_CREDENTIAL = ":none";
function editable(
  source?: GitHubSource,
  hasRepositories = true,
): GitHubSourceFields {
  return source
    ? {
        name: source.name,
        enabled: source.enabled,
        freshnessMinutes: source.freshnessMinutes,
        repositoryIds: [...source.repositoryIds],
        credentialRef: source.github.credentialRef,
        refreshIntervalMinutes: source.github.refreshIntervalMinutes,
      }
    : {
        name: "",
        enabled: hasRepositories,
        freshnessMinutes: LIMITS.DEFAULT_FRESHNESS_MINUTES,
        repositoryIds: [],
        credentialRef: null,
        refreshIntervalMinutes: LIMITS.DEFAULT_INTERVAL_MINUTES,
      };
}
export function GitHubEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
  includeRepositoryId,
}: {
  initial?: GitHubSource;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (source: GitHubSource) => void;
  returnFocus: HTMLElement | null;
  includeRepositoryId?: string;
}) {
  const [base, setBase] = useState(() =>
    editable(initial, Boolean(snapshot.repositories.length)),
  );
  const [draft, setDraft] = useState(() => {
    const fields = editable(initial, Boolean(snapshot.repositories.length));
    if (
      includeRepositoryId &&
      !fields.repositoryIds.includes(includeRepositoryId)
    )
      fields.repositoryIds.push(includeRepositoryId);
    return fields;
  });
  const [sourceId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [revision, setRevision] = useState(initial?.revision);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const guard = useCloseGuard(dirty || busy, onClose);
  const latest = snapshot.connections.find(
    (source): source is GitHubSource =>
      source.id === sourceId &&
      source.provider === "github" &&
      Boolean(source.github),
  );
  const references = useQuery({
    queryKey: ["github-credentials", workspaceId],
    queryFn: ({ signal }) =>
      command<GitHubCredentialReference[]>(
        "github_credentials_list",
        { workspaceId },
        signal,
      ),
  });
  const available = snapshot.repositories.filter((repository) =>
    repository.fullName.toLowerCase().includes(search.toLowerCase()),
  );
  const missingRef =
    draft.credentialRef &&
    references.data &&
    !references.data.some((item) => item.id === draft.credentialRef);
  useEffect(() => {
    if (Object.keys(errors).length)
      form.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [errors]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = githubSourceFields.safeParse(draft);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.path[0] === "name"
              ? "Enter a name for this GitHub source"
              : issue.path[0] === "repositoryIds"
                ? draft.repositoryIds.length
                  ? "Select up to " + LIMITS.REPOSITORIES + " repositories"
                  : "Select a repository or turn off collection to prepare an empty source"
                : issue.message,
          ]),
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const source = await command<GitHubSource>(
        initial ? "github_source_update" : "github_source_enroll",
        {
          workspaceId,
          sourceId,
          source: parsed.data,
          ...(initial ? { revision } : {}),
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      guard.saved();
      onSaved(source);
    } catch (error) {
      setError(
        error instanceof Error
          ? error
          : new Error("Settings could not be saved. Your draft is preserved."),
      );
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
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
          className="source-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initial ? "Edit GitHub settings" : "Connect GitHub"}
            </DialogTitle>
            <DialogDescription>
              HQ reads selected repositories online. It never writes to GitHub
              or runs commands on a machine.
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
                <label htmlFor="github-name">Connection name</label>
                <Input
                  id="github-name"
                  value={draft.name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="For example, personal repositories"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={
                    errors.name ? "github-name-error" : undefined
                  }
                />
                {errors.name ? (
                  <p
                    id="github-name-error"
                    role="alert"
                    className="field-error"
                  >
                    {errors.name}
                  </p>
                ) : null}
              </div>
              <div className="form-field">
                <label htmlFor="github-credential">
                  Server-side credential
                </label>
                <Select
                  value={draft.credentialRef ?? NO_CREDENTIAL}
                  disabled={busy || references.isPending || references.isError}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      credentialRef: value === NO_CREDENTIAL ? null : value,
                    })
                  }
                >
                  <SelectTrigger
                    id="github-credential"
                    aria-describedby="github-credential-help"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CREDENTIAL}>
                      Configure later
                    </SelectItem>
                    {missingRef ? (
                      <SelectItem value={draft.credentialRef!}>
                        {draft.credentialRef} (unavailable)
                      </SelectItem>
                    ) : null}
                    {references.data?.map((reference) => (
                      <SelectItem key={reference.id} value={reference.id}>
                        {reference.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="github-credential-help" className="field-help">
                  Only workspace-bound references appear here. Token values stay
                  in the server's secret binding, never in this form.
                </p>
                {references.isPending ? (
                  <p className="field-help" role="status">
                    Loading available references...
                  </p>
                ) : null}
                {references.isError ? (
                  <p role="alert" className="field-error">
                    Credential references could not be loaded.{" "}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void references.refetch()}
                    >
                      Retry references
                    </Button>
                  </p>
                ) : references.data?.length === 0 || missingRef ? (
                  <p className="permission-notice">
                    A server administrator must provision a read-only GitHub
                    credential for this workspace. You can save settings without
                    one; evidence will remain unobserved.
                  </p>
                ) : null}
              </div>
              <div className="github-policy-fields">
                {(["refreshIntervalMinutes", "freshnessMinutes"] as const).map(
                  (key) => (
                    <div className="form-field" key={key}>
                      <label htmlFor={"github-" + key}>
                        {key === "refreshIntervalMinutes"
                          ? "Refresh every"
                          : "Consider evidence stale after"}
                      </label>
                      <div className="source-number">
                        <Input
                          id={"github-" + key}
                          type="number"
                          min={5}
                          max={
                            key === "refreshIntervalMinutes"
                              ? LIMITS.MAX_INTERVAL_MINUTES
                              : 1440
                          }
                          disabled={busy}
                          value={draft[key] || ""}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [key]: Number(event.target.value),
                            })
                          }
                          aria-invalid={Boolean(errors[key])}
                          aria-describedby={
                            errors[key]
                              ? "github-error-" + key
                              : "github-policy-help"
                          }
                        />
                        <span>minutes</span>
                      </div>
                      {errors[key] ? (
                        <p
                          id={"github-error-" + key}
                          role="alert"
                          className="field-error"
                        >
                          {errors[key]}
                        </p>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
              <p id="github-policy-help" className="field-help">
                Allow at least two refresh intervals. Freshness is measured from
                the GitHub read, not from viewing the dashboard. A longer window
                does not revive old evidence.
              </p>
              <fieldset className="source-repository-picker">
                <legend>
                  Repositories to read{" "}
                  <span>
                    {draft.repositoryIds.length} / {LIMITS.REPOSITORIES}{" "}
                    selected
                  </span>
                </legend>
                <p className="field-help">
                  A disabled source can stay empty while preparing a project
                  transfer. Saving it does not grant provider access.
                </p>
                <Input
                  aria-label="Find GitHub repositories"
                  placeholder="Find a repository..."
                  value={search}
                  disabled={busy}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-invalid={Boolean(errors.repositoryIds)}
                  aria-describedby={
                    errors.repositoryIds
                      ? "github-repositories-error"
                      : undefined
                  }
                />
                {errors.repositoryIds ? (
                  <p
                    id="github-repositories-error"
                    role="alert"
                    className="field-error"
                  >
                    {errors.repositoryIds}
                  </p>
                ) : null}
                <div className="source-repository-options">
                  {available.map((repository) => (
                    <label key={repository.id}>
                      <Checkbox
                        checked={draft.repositoryIds.includes(repository.id)}
                        disabled={
                          busy ||
                          (!draft.repositoryIds.includes(repository.id) &&
                            draft.repositoryIds.length >= LIMITS.REPOSITORIES)
                        }
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
                  ))}
                  {!available.length ? (
                    <p className="field-help">
                      {snapshot.repositories.length
                        ? "No repositories match this search."
                        : "No repositories are enrolled here. Keep collection disabled to prepare this source."}
                    </p>
                  ) : null}
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
                  <strong>Enable read-only collection</strong>
                  <small>
                    Disabling cancels pending work and expires this source's
                    evidence. Saving any settings cancels an in-flight refresh.
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
                    : "Save connection"}
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
