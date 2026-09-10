import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Project, type Snapshot } from "../shared/domain";
import type {
  ResourceProject,
  ResourceProjectReference,
} from "../shared/project-resources";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { HookError } from "./hook-components";
import "./projects.css";

const REQUEST_TIMEOUT_MS = 15000;
type LoadedAssociation = {
  association: ResourceProject;
  project: Project | null;
};
type EditorProps = {
  reference: ResourceProjectReference;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: () => void;
  returnFocus: HTMLElement | null;
  suggestedProjectId?: string;
};
async function loadAssociation(
  reference: ResourceProjectReference,
  signal: AbortSignal,
): Promise<LoadedAssociation> {
  const association = await command<ResourceProject>(
    "resource_project",
    reference,
    signal,
  );
  const project = association.projectId
    ? await command<Project>(
        "project_get",
        {
          workspaceId: reference.workspaceId,
          projectId: association.projectId,
        },
        signal,
      )
    : null;
  return { association, project };
}
function restoreFocus(target: HTMLElement | null) {
  (target?.isConnected
    ? target
    : document.querySelector<HTMLElement>("#main-content")
  )?.focus();
}
function AssociationForm({
  initial,
  reference,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
  suggestedProjectId,
}: EditorProps & { initial: LoadedAssociation }) {
  const [base, setBase] = useState(initial.association);
  const [project, setProject] = useState(
    () =>
      initial.project ??
      (snapshot.capabilities.includes(CAPABILITY.EDIT)
        ? snapshot.projects.find((value) => value.id === suggestedProjectId)
        : null) ??
      null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(false);
  const client = useQueryClient();
  const dirty = (project?.id ?? null) !== base.projectId;
  const guard = useCloseGuard(dirty || busy, onClose);
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const latest = project
    ? snapshot.projects.find((value) => value.id === project.id)
    : undefined;
  const changed = Boolean(
    project && latest && latest.revision > project.revision,
  );
  async function loadSaved() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await loadAssociation(
        reference,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      setBase(saved.association);
      setProject(saved.project);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit || changed || !dirty || !project) return;
    setBusy(true);
    setError(null);
    try {
      await command<ResourceProject>(
        "resource_project_save",
        {
          ...reference,
          revision: base.revision,
          connectionRevision: base.connectionRevision,
          projectId: project.id,
          projectRevision: project.revision,
        },
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      guard.saved();
      for (const key of ["project-resources", "resource-project"])
        void client.invalidateQueries({
          queryKey: [key, snapshot.workspace.id],
        });
      if (reference.kind === "hook")
        void client.invalidateQueries({
          queryKey: ["hooks", snapshot.workspace.id, "subscriptions"],
        });
      onSaved();
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
          className="project-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus(returnFocus);
          }}
        >
          <DialogHeader>
            <DialogTitle>Project association</DialogTitle>
            <DialogDescription>
              Choose a primary project for {reference.resourceKey}. Repository
              links can make this resource relevant to other projects too.
              Provider configuration, credentials, and permissions are
              unchanged.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <div className="project-form-scroll">
              {error ? <HookError error={error} /> : null}
              {!canEdit ? (
                <p className="permission-notice">
                  Read-only access. Your draft is preserved.
                </p>
              ) : null}
              {changed && latest ? (
                <div className="form-error" role="alert">
                  <p>
                    The selected project changed. Your draft is preserved. Its
                    saved name is {latest.name} and its status is{" "}
                    {latest.lifecycle}.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setProject(latest)}
                  >
                    Use this project revision
                  </Button>
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="resource-project">Primary project</label>
                <Select
                  value={project?.id ?? ""}
                  disabled={busy || !canEdit}
                  onValueChange={(id) =>
                    setProject(
                      snapshot.projects.find((value) => value.id === id) ??
                        null,
                    )
                  }
                >
                  <SelectTrigger id="resource-project">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.projects.map((value) => (
                      <SelectItem key={value.id} value={value.id}>
                        {value.name}
                        {value.lifecycle === "archived" ? " (archived)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="field-help">
                  Every enrolled resource has one primary project. Repository
                  links can add relevance to other projects. A connection's
                  project context is not inherited by its resources.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setReload(true)}
              >
                Load saved association
              </Button>
            </div>
            <div className="project-dialog-actions">
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
                disabled={busy || !canEdit || changed || !dirty || !project}
              >
                {busy ? "Saving..." : "Save association"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this association draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Discard your selection and load the saved association. Your draft
              stays intact if the read fails.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void loadSaved()}>
              Load saved association
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
export function ResourceProjectEditor(props: EditorProps) {
  const { reference, onClose, returnFocus } = props;
  const query = useQuery({
    queryKey: [
      "resource-project",
      reference.workspaceId,
      reference.kind,
      reference.connectionId,
      reference.resourceKey,
    ],
    queryFn: ({ signal }) => loadAssociation(reference, signal),
    retry: false,
    staleTime: 0,
  });
  if (query.data) return <AssociationForm {...props} initial={query.data} />;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus(returnFocus);
        }}
      >
        <DialogHeader>
          <DialogTitle>Project association</DialogTitle>
          <DialogDescription>
            Reading the saved association and project revision.
          </DialogDescription>
        </DialogHeader>
        {query.error ? (
          <>
            <HookError error={query.error} />
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </>
        ) : (
          <p role="status">Loading association...</p>
        )}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
