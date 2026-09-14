import { useFlowBlocker as useBlocker } from "./lib/flow-blocker";
import { sameExpectationFlow } from "../shared/expectation-resolution";
import { HookExpectationAction, HookResolution } from "./hook-resolution";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useBeforeUnload, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CalendarClock,
  CircleHelp,
  ClipboardCheck,
  FolderGit2,
  Save,
  ShieldCheck,
  TriangleAlert,
  Webhook,
  Workflow,
} from "lucide-react";
import {
  DEFAULT_EXPECTATIONS,
  repositoryFields,
  type Expectations,
  type Repository,
  type RepositoryFields,
  type Snapshot,
} from "../shared/domain";
import {
  CLASSIFICATION_LABELS,
  EXPECTATION_HELP,
  EXPECTATION_LABELS,
  REQUIREMENT_LABELS,
} from "../shared/presentation";
import { command, RequestError } from "./lib/api";
import { focusInvalidField } from "./lib/form-focus";
import { Disclosure } from "./components/ui/disclosure";
import { Button } from "./components/ui/button";
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

const INITIAL_REPOSITORY: RepositoryFields = {
  fullName: "",
  description: "",
  projectId: "",
  classification: "maintained",
  lifecycle: "active",
  expectations: DEFAULT_EXPECTATIONS,
};
const EXPECTATION_ICONS = {
  ci: Workflow,
  security: ShieldCheck,
  hooks: Webhook,
  monitoring: Activity,
} as const;

function editableFields(repository?: Repository): RepositoryFields {
  if (!repository) return structuredClone(INITIAL_REPOSITORY);
  const {
    fullName,
    description,
    projectId,
    classification,
    lifecycle,
    expectations,
  } = repository;
  return structuredClone({
    fullName,
    description,
    projectId,
    classification,
    lifecycle,
    expectations,
  });
}

function FormField({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help ? (
        <p id={id + "-help"} className="field-help">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={id + "-error"} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Choice<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value: T;
  options: Record<T, string>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => onChange(value as T)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries<string>(options).map(([key, text]) => (
          <SelectItem key={key} value={key}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RepositoryEditor({
  initial,
  snapshot,
  onClose,
  onSaved,
  returnFocus,
  defaultProjectId,
  suggestedProjectId,
}: {
  initial?: Repository;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (repository: Repository) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  defaultProjectId?: string;
  suggestedProjectId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const resolving = Boolean(initial && params.get("resolve") === "hooks");
  function resolveHooks(open: boolean) {
    const next = new URLSearchParams(params);
    next.set("dialog", "expectations");
    if (open) next.set("resolve", "hooks");
    else
      for (const key of [
        "resolve",
        "connection",
        "policy",
        "policyReview",
        "setup",
        "setupReview",
        "resume",
        "verify",
      ])
        next.delete(key);
    setParams(next);
  }
  const initialProjectId =
    defaultProjectId ??
    (snapshot.projects.length === 1 ? snapshot.projects[0]!.id : undefined);
  const [base, setBase] = useState(() => ({
    ...editableFields(initial),
    ...(!initial && initialProjectId ? { projectId: initialProjectId } : {}),
  }));
  const [draft, setDraft] = useState(() => ({
    ...editableFields(initial),
    ...(!initial && initialProjectId ? { projectId: initialProjectId } : {}),
    ...(initial && suggestedProjectId ? { projectId: suggestedProjectId } : {}),
  }));
  const [revision, setRevision] = useState(initial?.revision);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState<"close" | "reload" | null>(null);
  const allowNavigation = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (Object.keys(errors).length) focusInvalidField(form.current);
  }, [errors]);
  const queryClient = useQueryClient();
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const latest = snapshot.repositories.find(
    (repository) => repository.id === initial?.id,
  );
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !sameExpectationFlow(currentLocation, nextLocation) &&
      !allowNavigation.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useBeforeUnload(
    useCallback(
      (event) => {
        if (dirty && !allowNavigation.current) {
          event.preventDefault();
          event.returnValue = "";
        }
      },
      [dirty],
    ),
  );
  const save = useMutation({
    mutationFn: async (repository: RepositoryFields) =>
      initial
        ? command<Repository>("repository_update", {
            workspaceId: snapshot.workspace.id,
            repositoryId: initial.id,
            revision,
            repository,
          })
        : command<Repository>("repository_create", {
            workspaceId: snapshot.workspace.id,
            repository,
          }),
    onSuccess: async (repository) => {
      allowNavigation.current = true;
      queryClient.setQueryData<Snapshot>(
        ["workspace", snapshot.workspace.id],
        (previous) =>
          previous
            ? {
                ...previous,
                repositories: [
                  ...previous.repositories.filter(
                    (item) => item.id !== repository.id,
                  ),
                  repository,
                ],
              }
            : previous,
      );
      void queryClient.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
      onSaved(repository);
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
    },
  });
  function update<K extends keyof RepositoryFields>(
    key: K,
    value: RepositoryFields[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }
  function expectation<K extends keyof Expectations>(
    key: K,
    value: Expectations[K],
  ) {
    setDraft((previous) => ({
      ...previous,
      expectations: { ...previous.expectations, [key]: value },
    }));
  }
  function close() {
    if (save.isPending) return;
    if (dirty) setDiscard("close");
    else onClose();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = repositoryFields.safeParse(draft);
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues)
        fields[issue.path.join(".")] =
          issue.path[0] === "fullName"
            ? "Enter a repository as owner/name, without a URL or spaces."
            : issue.path[0] === "projectId"
              ? "Choose the project that owns this repository."
              : issue.path.includes("reviewDate")
                ? "Choose a valid calendar date."
                : "Check this field and its length.";
      setErrors(fields);
      return;
    }
    setErrors({});
    save.mutate(result.data);
  }
  function discardChanges() {
    if (blocker.state === "blocked") {
      allowNavigation.current = true;
      blocker.proceed();
    } else if (discard === "reload" && latest) {
      const fresh = editableFields(latest);
      setBase(fresh);
      setDraft(structuredClone(fresh));
      setRevision(latest.revision);
      save.reset();
      setErrors({});
    } else {
      allowNavigation.current = true;
      onClose();
    }
    setDiscard(null);
  }
  const conflict =
    save.error instanceof RequestError &&
    save.error.code === "revision_conflict" &&
    Boolean(initial);
  return (
    <>
      <Dialog
        open={!resolving}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="repository-editor"
          showCloseButton={!save.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="dialog-heading">
              <FolderGit2 size={20} aria-hidden="true" />
              {initial ? "Edit repository" : "Enroll a repository"}
            </DialogTitle>
            <DialogDescription>
              {initial
                ? "Set expectations and use the coverage actions to satisfy them."
                : "Track a repository in this workspace. Enrollment does not grant GitHub access or change provider settings."}
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={submit} noValidate>
            <div className="repository-form-scroll">
              <fieldset disabled={save.isPending}>
                <legend className="sr-only">
                  Repository details and expectations
                </legend>
                <section className="editor-section">
                  <h2>
                    <FolderGit2 size={18} aria-hidden="true" />
                    Repository
                  </h2>
                  <div className="form-grid">
                    <FormField
                      id="repository-name"
                      label="Repository name"
                      error={errors.fullName}
                      help="Use owner/repository."
                    >
                      <Input
                        id="repository-name"
                        value={draft.fullName}
                        onChange={(event) =>
                          update("fullName", event.target.value)
                        }
                        maxLength={140}
                        placeholder="owner/repository"
                        autoComplete="off"
                        aria-invalid={Boolean(errors.fullName)}
                        aria-describedby={
                          errors.fullName
                            ? "repository-name-error"
                            : "repository-name-help"
                        }
                        required
                      />
                    </FormField>
                    <FormField
                      id="repository-classification"
                      label="Relationship"
                    >
                      <Choice
                        id="repository-classification"
                        label="Relationship"
                        value={draft.classification}
                        options={CLASSIFICATION_LABELS}
                        onChange={(value) => update("classification", value)}
                      />
                    </FormField>
                    <FormField
                      id="repository-project"
                      label="Owning project"
                      error={errors.projectId}
                      help="Every repository belongs to one project in this workspace."
                    >
                      <Select
                        value={draft.projectId}
                        onValueChange={(value) => update("projectId", value)}
                      >
                        <SelectTrigger
                          id="repository-project"
                          aria-invalid={Boolean(errors.projectId)}
                          aria-describedby={
                            errors.projectId
                              ? "repository-project-error"
                              : "repository-project-help"
                          }
                        >
                          <SelectValue placeholder="Choose a project" />
                        </SelectTrigger>
                        <SelectContent>
                          {snapshot.projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField id="repository-lifecycle" label="Tracking">
                      <Choice
                        id="repository-lifecycle"
                        label="Tracking"
                        value={draft.lifecycle}
                        options={{
                          active: "Active",
                          archived: "Archived in this workspace",
                        }}
                        onChange={(value) => update("lifecycle", value)}
                      />
                    </FormField>
                  </div>
                  <FormField
                    id="repository-description"
                    label="Description"
                    error={errors.description}
                  >
                    <Textarea
                      id="repository-description"
                      value={draft.description}
                      onChange={(event) =>
                        update("description", event.target.value)
                      }
                      placeholder="What does this repository do?"
                      rows={2}
                      maxLength={500}
                    />
                  </FormField>
                </section>
                <section className="editor-section">
                  <h2>
                    <ClipboardCheck size={18} aria-hidden="true" />
                    Expectations
                  </h2>
                  <p className="section-description">
                    Required checks need fresh evidence to pass assessment.
                  </p>
                  <div className="expectation-fields">
                    {(
                      Object.keys(
                        EXPECTATION_LABELS,
                      ) as (keyof typeof EXPECTATION_LABELS)[]
                    ).map((key) => {
                      const Icon = EXPECTATION_ICONS[key];
                      return (
                        <div className="expectation-row" key={key}>
                          <div>
                            <label htmlFor={"expectation-" + key}>
                              <Icon size={16} aria-hidden="true" />
                              {EXPECTATION_LABELS[key]}
                            </label>
                          </div>
                          <Choice
                            id={"expectation-" + key}
                            label={EXPECTATION_LABELS[key]}
                            value={draft.expectations[key]}
                            options={REQUIREMENT_LABELS}
                            onChange={(value) => expectation(key, value)}
                          />
                          {key === "hooks" && initial ? (
                            <HookExpectationAction
                              repository={initial}
                              snapshot={snapshot}
                              onOpen={() => resolveHooks(true)}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  <FormField
                    id="repository-visibility"
                    label="Expected visibility"
                  >
                    <Choice
                      id="repository-visibility"
                      label="Expected visibility"
                      value={draft.expectations.visibility}
                      options={{
                        any: "Either public or private",
                        public: "Public",
                        private: "Private",
                      }}
                      onChange={(value) => expectation("visibility", value)}
                    />
                  </FormField>
                  <Disclosure
                    title="About expectations"
                    icon={CircleHelp}
                    className="expectation-guide"
                  >
                    <p>
                      Optional checks are informative. Unmanaged checks do not
                      affect expected coverage.
                    </p>
                    <dl className="expectation-help">
                      {Object.entries(EXPECTATION_HELP).map(([key, help]) => (
                        <div key={key}>
                          <dt>
                            {
                              EXPECTATION_LABELS[
                                key as keyof typeof EXPECTATION_LABELS
                              ]
                            }
                          </dt>
                          <dd>{help}</dd>
                        </div>
                      ))}
                    </dl>
                  </Disclosure>
                </section>
                <section className="editor-section">
                  <Disclosure
                    title="Review and maintainer context"
                    description={[
                      draft.expectations.reviewDate
                        ? "Review date set"
                        : "No review scheduled",
                      draft.expectations.note
                        ? "Context added"
                        : "Optional context",
                    ].join(" / ")}
                    icon={CalendarClock}
                  >
                    <FormField
                      id="repository-review"
                      label="Review by (UTC date)"
                      help="Optional. Marks the review as due in Overview; it does not send a notification."
                      error={errors["expectations.reviewDate"]}
                    >
                      <Input
                        id="repository-review"
                        type="date"
                        value={draft.expectations.reviewDate ?? ""}
                        onChange={(event) =>
                          expectation("reviewDate", event.target.value || null)
                        }
                        aria-invalid={Boolean(
                          errors["expectations.reviewDate"],
                        )}
                      />
                    </FormField>
                    <FormField
                      id="repository-note"
                      label="Maintainer context"
                      help="Explain an exception or decision. Do not put credentials or secret values here."
                      error={errors["expectations.note"]}
                    >
                      <Textarea
                        id="repository-note"
                        value={draft.expectations.note}
                        onChange={(event) =>
                          expectation("note", event.target.value)
                        }
                        rows={2}
                        maxLength={1500}
                        aria-invalid={Boolean(errors["expectations.note"])}
                        aria-describedby={
                          errors["expectations.note"]
                            ? "repository-note-error"
                            : "repository-note-help"
                        }
                        placeholder="Anything a future maintainer should know..."
                      />
                    </FormField>
                  </Disclosure>
                </section>
              </fieldset>
              {save.error ? (
                <div className="save-error" role="alert">
                  <TriangleAlert size={17} />
                  <div>
                    <strong>
                      {conflict
                        ? "This repository changed while you were editing"
                        : "Your changes were not confirmed"}
                    </strong>
                    <p>{save.error.message}</p>
                    {conflict && latest && latest.revision !== revision ? (
                      <>
                        <p>
                          Saved version {latest.revision} is available. Your
                          draft is still in the form above.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setDiscard("reload")}
                        >
                          Discard draft and load latest
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="editor-footer">
              <span>
                <CircleHelp size={13} />
                {dirty
                  ? "Unsaved changes"
                  : initial
                    ? "No unsaved changes"
                    : "Saved to this workspace only"}
              </span>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  disabled={save.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={save.isPending || (Boolean(initial) && !dirty)}
                >
                  <Save size={16} aria-hidden="true" />
                  {save.isPending
                    ? "Saving..."
                    : initial
                      ? "Save changes"
                      : "Enroll repository"}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {resolving && initial ? (
        <HookResolution
          repository={initial}
          snapshot={snapshot}
          onBack={() => resolveHooks(false)}
        />
      ) : null}
      <AlertDialog
        open={discard !== null || blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) {
            setDiscard(null);
            if (blocker.state === "blocked") blocker.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {discard === "reload"
                ? "Your draft will be replaced with the latest saved version. No repository settings will be changed."
                : "Your changes have not been saved. Keep editing to finish them, or discard the draft to leave."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={discardChanges}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
