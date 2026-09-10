import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, FolderGit2, Search } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  RESOURCE_LINK_LIMITS,
  type ResourceLinks,
  type ResourceReference,
} from "../shared/resource-links";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
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
import { HookError } from "./hook-components";
import { projectHref } from "./project-inventory";
import "./repository-workspace.css";

export const RESOURCE_REQUEST_TIMEOUT_MS = 30000;
export function repositoryHref(
  workspaceId: string,
  repositoryId: string,
  section = "overview",
) {
  return (
    "/repositories/" +
    encodeURIComponent(repositoryId) +
    "?" +
    new URLSearchParams({ workspace: workspaceId, section })
  );
}

export function RepositoryContext({
  snapshot,
  section,
}: {
  snapshot: Snapshot;
  section: string;
}) {
  const [params] = useSearchParams();
  const repository = snapshot.repositories.find(
    (value) => value.id === params.get("repository"),
  );
  const project = snapshot.projects.find(
    (value) => value.id === params.get("project"),
  );
  return (
    <>
      {project ? (
        <div className="repository-context">
          <Link
            className="back-link"
            to={projectHref(snapshot.workspace.id, project.id, section, params)}
          >
            <ArrowLeft size={16} aria-hidden="true" /> {project.name}
          </Link>
          <span>
            Project context. Provider controls can affect resources outside this
            project.
          </span>
        </div>
      ) : null}
      {repository ? (
        <div className="repository-context">
          <Link
            className="back-link"
            to={repositoryHref(snapshot.workspace.id, repository.id, section)}
          >
            <ArrowLeft size={16} aria-hidden="true" /> {repository.fullName}
          </Link>
          <span>
            Repository context. Provider controls may affect other linked
            repositories.
          </span>
        </div>
      ) : null}
    </>
  );
}

export function RelatedRepositoryLinks({
  snapshot,
  ids,
}: {
  snapshot: Snapshot;
  ids: string[];
}) {
  return ids.length ? (
    <div className="related-repository-links" role="group" aria-label="Related repositories">
      {ids.map((id) => {
        const repository = snapshot.repositories.find(
          (value) => value.id === id,
        );
        return repository ? (
          <Link
            key={id}
            className="repo-tag"
            to={repositoryHref(snapshot.workspace.id, id)}
          >
            <FolderGit2 size={14} aria-hidden="true" /> {repository.fullName}
          </Link>
        ) : (
          <span key={id} className="hook-muted">
            Repository no longer in this snapshot
          </span>
        );
      })}
    </div>
  ) : (
    <p className="hook-muted">Standalone resource. No repositories linked.</p>
  );
}

function LinksForm({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
  suggestedRepositoryId,
}: {
  initial: ResourceLinks;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: () => void;
  returnFocus: HTMLElement | null;
  suggestedRepositoryId?: string;
}) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(() =>
    initial.repositoryIds.length ||
    !suggestedRepositoryId ||
    !snapshot.capabilities.includes(CAPABILITY.EDIT)
      ? initial.repositoryIds
      : [suggestedRepositoryId],
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const client = useQueryClient();
  const dirty =
    JSON.stringify([...draft].sort()) !==
    JSON.stringify([...base.repositoryIds].sort());
  const guard = useCloseGuard(dirty || busy, onClose);
  const reference: ResourceReference = {
    workspaceId: initial.workspaceId,
    kind: initial.kind,
    connectionId: initial.connectionId,
    resourceKey: initial.resourceKey,
  };
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const visible = snapshot.repositories.filter((value) =>
    value.fullName.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  async function loadSaved() {
    setBusy(true);
    setError(null);
    try {
      const saved = await command<ResourceLinks>(
        "resource_repositories",
        reference,
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      setBase(saved);
      setDraft(saved.repositoryIds);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      await command(
        "resource_repositories_save",
        {
          ...reference,
          revision: base.revision,
          connectionRevision: base.connectionRevision,
          repositoryIds: draft,
        },
        AbortSignal.timeout(RESOURCE_REQUEST_TIMEOUT_MS),
      );
      for (const key of [
        "repository-resources",
        "resource-repositories",
        "hooks",
        "monitoring",
        "workspace",
      ]) {
        void client.invalidateQueries({
          queryKey: [key, snapshot.workspace.id],
        });
      }
      onSaved();
      guard.saved();
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
          className="resource-dialog"
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
            <DialogTitle>Related repositories</DialogTitle>
            <DialogDescription>
              Choose where {initial.resourceKey} appears in HQ. Shared resources
              can belong to several repositories. Provider configuration and
              project grouping are unchanged.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="resource-form">
            {error ? <HookError error={error} /> : null}
            {!canEdit ? (
              <p className="permission-notice">
                Your role can view these links. An owner or operator can change
                them.
              </p>
            ) : null}
            <div className="search-input">
              <Search size={16} aria-hidden="true" />
              <Input
                aria-label="Find repositories to link"
                placeholder="Find repositories..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <p className="hook-muted" role="status">
              {draft.length} selected. Leave all unselected to keep this
              resource standalone.
            </p>
            <div
              className="repository-picker"
              role="group"
              aria-label="Repository links"
            >
              {visible.map((repository) => (
                <label key={repository.id} className="repository-picker-item">
                  <Checkbox
                    checked={draft.includes(repository.id)}
                    disabled={
                      busy ||
                      !canEdit ||
                      (!draft.includes(repository.id) &&
                        draft.length >= RESOURCE_LINK_LIMITS.REPOSITORIES)
                    }
                    onCheckedChange={(checked) => {
                      setDraft((prior) =>
                        checked
                          ? [...prior, repository.id]
                          : prior.filter((id) => id !== repository.id),
                      );
                    }}
                  />
                  <span>
                    <strong>{repository.fullName}</strong>
                    <small>
                      {repository.lifecycle === "archived"
                        ? "Archived in HQ"
                        : repository.description || "Active repository"}
                    </small>
                  </span>
                </label>
              ))}
              {!visible.length ? (
                <p className="hook-muted">
                  {snapshot.repositories.length
                    ? "No repositories match this search."
                    : "Enroll a repository in this workspace before linking it."}
                </p>
              ) : null}
            </div>
            <div className="form-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => (dirty ? setReload(true) : void loadSaved())}
              >
                Load saved links
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={guard.requestClose}
              >
                {canEdit ? "Cancel" : "Close"}
              </Button>
              {canEdit ? (
                <Button type="submit" disabled={busy || !dirty}>
                  {busy ? "Saving..." : "Save links"}
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
            <AlertDialogTitle>Replace this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Load the latest saved repository links. Your draft stays intact if
              the read fails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void loadSaved()}>
              Load saved links
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ResourceRepositoriesEditor({
  reference,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
  suggestedRepositoryId,
}: {
  reference: ResourceReference;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: () => void;
  returnFocus: HTMLElement | null;
  suggestedRepositoryId?: string;
}) {
  const query = useQuery({
    queryKey: [
      "resource-repositories",
      reference.workspaceId,
      reference.kind,
      reference.connectionId,
      reference.resourceKey,
    ],
    queryFn: ({ signal }) =>
      command<ResourceLinks>("resource_repositories", reference, signal),
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data ? (
    <LinksForm
      initial={query.data}
      snapshot={snapshot}
      onClose={onClose}
      onSaved={onSaved}
      returnFocus={returnFocus}
      suggestedRepositoryId={suggestedRepositoryId}
    />
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="resource-dialog">
        <DialogHeader>
          <DialogTitle>Related repositories</DialogTitle>
          <DialogDescription>
            Reading the saved links for {reference.resourceKey}.
          </DialogDescription>
        </DialogHeader>
        {query.error ? (
          <>
            <HookError error={query.error} />
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry loading links
            </Button>
          </>
        ) : (
          <p role="status">Loading repository links...</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
