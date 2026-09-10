import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Globe, MessageSquare, Save } from "lucide-react";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  DEFAULT_PORTFOLIO,
  createProjectInput,
  projectFields,
  type Project,
  type ProjectFields,
  type RepositoryFields,
  type Snapshot,
} from "../shared/domain";
import {
  CLASSIFICATION_LABELS,
  REQUIREMENT_LABELS,
} from "../shared/presentation";
import { command } from "./lib/api";
import { focusInvalidField } from "./lib/form-focus";
import { Disclosure } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
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
import { IMPORTANCE_LABELS, PORTFOLIO_LABELS } from "./project-inventory";
import type { WorkspaceView } from "../shared/workspace-sync";
import "./projects.css";

const PROJECT_REQUEST_MS = 15000;
function editable(project?: Project): ProjectFields {
  return project
    ? projectFields.strip().parse(project)
    : {
        name: "",
        description: "",
        lifecycle: "active",
        importance: "standard",
        importanceNote: "",
        portfolio: { ...DEFAULT_PORTFOLIO },
      };
}
export function ProjectChoice<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  help,
}: {
  id: string;
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
  disabled?: boolean;
  help?: string;
}) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <Select
        value={value}
        onValueChange={(value) => onChange(value as T)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          aria-describedby={help ? id + "-help" : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries<string>(options).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help ? (
        <p className="field-help" id={id + "-help"}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function ProjectEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
}: {
  initial?: Project;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (project: Project) => void;
  returnFocus: HTMLElement | null;
}) {
  const [base, setBase] = useState(() => editable(initial));
  const [draft, setDraft] = useState(() => editable(initial));
  const [revision, setRevision] = useState(initial?.revision);
  const [includeRepository, setIncludeRepository] = useState(false);
  const [firstRepository, setFirstRepository] = useState<
    Omit<RepositoryFields, "projectId">
  >(() => ({
    fullName: "",
    description: "",
    classification: "maintained",
    lifecycle: "active",
    expectations: structuredClone(DEFAULT_EXPECTATIONS),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const client = useQueryClient();
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(base) || includeRepository;
  const guard = useCloseGuard(dirty || busy, onClose);
  const latest = snapshot.projects.find(
    (project) => project.id === initial?.id,
  );
  const changed = Boolean(
    initial && latest && latest.revision > (revision ?? 0),
  );
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  useEffect(() => {
    if (Object.keys(errors).length) focusInvalidField(form.current);
  }, [errors]);
  function update<K extends keyof ProjectFields>(
    key: K,
    value: ProjectFields[K],
  ) {
    setDraft((draft) => ({ ...draft, [key]: value }));
  }
  function portfolio<K extends keyof ProjectFields["portfolio"]>(
    key: K,
    value: ProjectFields["portfolio"][K],
  ) {
    setDraft((draft) => ({
      ...draft,
      portfolio: { ...draft.portfolio, [key]: value },
    }));
  }
  function invalid(path: string) {
    return {
      "aria-invalid": Boolean(errors[path]),
      "aria-describedby": errors[path] ? "project-error-" + path : undefined,
    };
  }
  function fieldError(path: string) {
    return errors[path] ? (
      <p className="field-error" role="alert" id={"project-error-" + path}>
        {errors[path]}
      </p>
    ) : null;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !canEdit || changed) return;
    const parsed = createProjectInput.safeParse({
      workspaceId: snapshot.workspace.id,
      ...draft,
      firstRepository: includeRepository && !initial ? firstRepository : null,
    });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join(".") || "project",
            issue.message,
          ]),
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const saved = await command<Project>(
        initial ? "project_update" : "project_create",
        initial
          ? {
              workspaceId: snapshot.workspace.id,
              projectId: initial.id,
              revision,
              project: projectFields.parse(draft),
            }
          : parsed.data,
        AbortSignal.timeout(PROJECT_REQUEST_MS),
      );
      client.setQueriesData<WorkspaceView>(
        { queryKey: ["workspace", snapshot.workspace.id, "view"] },
        (prior) =>
          prior?.records.projects
            ? {
                ...prior,
                records: {
                  ...prior.records,
                  projects: [
                    ...prior.records.projects.filter(
                      (project) => project.id !== saved.id,
                    ),
                    saved,
                  ],
                },
              }
            : prior,
      );
      await client.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
      guard.saved();
      onSaved(saved);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure
          : new Error(
              "The project could not be saved. Your draft is preserved.",
            ),
      );
      void client.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
    } finally {
      setBusy(false);
    }
  }
  async function loadSaved() {
    if (!initial || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await command<Project>(
        "project_get",
        { workspaceId: snapshot.workspace.id, projectId: initial.id },
        AbortSignal.timeout(PROJECT_REQUEST_MS),
      );
      setBase(editable(saved));
      setDraft(editable(saved));
      setRevision(saved.revision);
      setErrors({});
      void client.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure
          : new Error(
              "Saved project metadata is unavailable. Your draft is preserved.",
            ),
      );
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
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="dialog-heading">
              <FolderKanban size={20} aria-hidden="true" />
              {initial ? "Edit project" : "Create project"}
            </DialogTitle>
            <DialogDescription>
              {initial
                ? "Update this project's identity and priorities."
                : "Name your project and optionally enroll its first repository."}
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={save} noValidate>
            <div className="project-form-scroll">
              {!canEdit ? (
                <p role="status" className="permission-notice">
                  Your workspace access no longer permits editing. Your draft is
                  preserved.
                </p>
              ) : null}
              {error ? (
                <p className="form-error" role="alert">
                  {error.message}
                </p>
              ) : null}
              {Object.keys(errors).length ? (
                <p className="form-error" role="alert">
                  Check the highlighted fields. {errors.project ?? ""}
                </p>
              ) : null}
              {changed ? (
                <p className="form-error" role="alert">
                  This project changed while you were editing. Your draft has
                  not been replaced.
                </p>
              ) : null}
              {initial && (changed || error) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setReload(true)}
                >
                  Discard draft and load saved project
                </Button>
              ) : null}
              <fieldset disabled={busy || !canEdit} className="project-fields">
                <div className="form-field">
                  <label htmlFor="project-name">Project name</label>
                  <Input
                    id="project-name"
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => update("name", event.target.value)}
                    {...invalid("name")}
                    placeholder="For example, Maintainer HQ"
                  />
                  {fieldError("name")}
                </div>
                <div className="form-field">
                  <label htmlFor="project-description">Description</label>
                  <Textarea
                    id="project-description"
                    value={draft.description}
                    maxLength={300}
                    rows={2}
                    onChange={(event) =>
                      update("description", event.target.value)
                    }
                    {...invalid("description")}
                    placeholder="What is this project for?"
                  />
                  {fieldError("description")}
                </div>
                <div className="project-form-grid">
                  <ProjectChoice
                    id="project-importance"
                    label="Importance"
                    value={draft.importance}
                    options={IMPORTANCE_LABELS}
                    disabled={busy || !canEdit}
                    onChange={(value) => update("importance", value)}
                    help="Sets attention priority."
                  />
                  <ProjectChoice
                    id="project-lifecycle"
                    label="Project status"
                    value={draft.lifecycle}
                    options={{ active: "Active", archived: "Archived" }}
                    disabled={busy || !canEdit}
                    onChange={(value) => update("lifecycle", value)}
                    help="Archiving does not stop repositories or services."
                  />
                </div>
                <Disclosure
                  title="Priority context"
                  description={
                    draft.importanceNote ? "Context added" : "Optional"
                  }
                  icon={MessageSquare}
                >
                  <div className="form-field">
                    <label htmlFor="project-importance-note">
                      Why this importance?
                    </label>
                    <Textarea
                      id="project-importance-note"
                      value={draft.importanceNote}
                      maxLength={1000}
                      rows={2}
                      onChange={(event) =>
                        update("importanceNote", event.target.value)
                      }
                      {...invalid("importanceNote")}
                      placeholder="Public visibility, critical dependencies, or other context"
                    />
                    {fieldError("importanceNote")}
                  </div>
                </Disclosure>
                <Disclosure
                  title="Portfolio inclusion"
                  description={PORTFOLIO_LABELS[draft.portfolio.status]}
                  icon={Globe}
                >
                  <ProjectChoice
                    id="project-portfolio"
                    label="Inclusion decision"
                    value={draft.portfolio.status}
                    options={PORTFOLIO_LABELS}
                    onChange={(value) => portfolio("status", value)}
                    disabled={busy || !canEdit}
                    help="A saved Listed decision does not publish or verify a portfolio page."
                  />
                  <div className="form-field">
                    <label htmlFor="project-portfolio-reason">
                      Reason{" "}
                      {draft.portfolio.status === "excluded"
                        ? "(required)"
                        : "(optional)"}
                    </label>
                    <Textarea
                      id="project-portfolio-reason"
                      value={draft.portfolio.reason}
                      maxLength={1000}
                      rows={2}
                      onChange={(event) =>
                        portfolio("reason", event.target.value)
                      }
                      {...invalid("portfolio.reason")}
                    />
                    {fieldError("portfolio.reason")}
                  </div>
                  <div className="form-field">
                    <label htmlFor="project-portfolio-url">
                      Listing URL (optional)
                    </label>
                    <Input
                      id="project-portfolio-url"
                      type="url"
                      value={draft.portfolio.url ?? ""}
                      maxLength={500}
                      placeholder="https://"
                      onChange={(event) =>
                        portfolio("url", event.target.value || null)
                      }
                      {...invalid("portfolio.url")}
                    />
                    {fieldError("portfolio.url")}
                  </div>
                  <div className="form-field">
                    <label htmlFor="project-review-date">
                      Review date (optional)
                    </label>
                    <Input
                      id="project-review-date"
                      type="date"
                      value={draft.portfolio.reviewDate ?? ""}
                      onChange={(event) =>
                        portfolio("reviewDate", event.target.value || null)
                      }
                      {...invalid("portfolio.reviewDate")}
                    />
                    {fieldError("portfolio.reviewDate")}
                  </div>
                </Disclosure>
                {!initial ? (
                  <fieldset className="project-field-group">
                    <legend>First repository</legend>
                    <label
                      className="project-checkbox"
                      htmlFor="project-first-repository"
                    >
                      <Checkbox
                        id="project-first-repository"
                        checked={includeRepository}
                        disabled={busy || !canEdit}
                        onCheckedChange={(value) =>
                          setIncludeRepository(value === true)
                        }
                      />
                      Enroll a repository with this project
                    </label>
                    {includeRepository ? (
                      <>
                        <p className="field-help">
                          Both records are saved together. This does not create
                          a GitHub repository or connect a provider.
                        </p>
                        <div className="form-field">
                          <label htmlFor="project-repository-name">
                            GitHub repository
                          </label>
                          <Input
                            id="project-repository-name"
                            value={firstRepository.fullName}
                            onChange={(event) =>
                              setFirstRepository({
                                ...firstRepository,
                                fullName: event.target.value,
                              })
                            }
                            placeholder="owner/repository"
                            maxLength={140}
                            {...invalid("firstRepository.fullName")}
                          />
                          {fieldError("firstRepository.fullName")}
                        </div>
                        <ProjectChoice
                          id="project-repository-tracking"
                          label="Repository tracking"
                          value={firstRepository.classification}
                          options={CLASSIFICATION_LABELS}
                          disabled={busy || !canEdit}
                          onChange={(value) =>
                            setFirstRepository({
                              ...firstRepository,
                              classification: value,
                            })
                          }
                          help="Watchlist does not imply GitHub administrator access."
                        />
                        <div className="project-form-grid">
                          {(["ci", "security"] as const).map((key) => (
                            <ProjectChoice
                              key={key}
                              id={"project-repository-" + key}
                              label={
                                key === "ci"
                                  ? "Continuous integration"
                                  : "Security checks"
                              }
                              value={firstRepository.expectations[key]}
                              options={REQUIREMENT_LABELS}
                              disabled={busy || !canEdit}
                              onChange={(value) =>
                                setFirstRepository({
                                  ...firstRepository,
                                  expectations: {
                                    ...firstRepository.expectations,
                                    [key]: value,
                                  },
                                })
                              }
                            />
                          ))}
                        </div>
                        <p className="field-help">
                          Monitoring and hooks start unmanaged.
                          Repository-specific expectations can be adjusted after
                          enrollment.
                        </p>
                      </>
                    ) : null}
                  </fieldset>
                ) : null}
              </fieldset>
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
                disabled={
                  busy || !canEdit || changed || (Boolean(initial) && !dirty)
                }
              >
                <Save size={16} aria-hidden="true" />
                {busy
                  ? "Saving..."
                  : initial
                    ? "Save project"
                    : includeRepository
                      ? "Create project and repository"
                      : "Create project"}
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
              Discard your edits and load the saved project. If loading fails,
              your draft stays intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void loadSaved()}>
              Load saved project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
