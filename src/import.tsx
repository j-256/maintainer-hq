import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileInput, RefreshCw } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  IMPORT_LIMITS,
  importManifest,
  type ImportManifest,
  type ImportPlan,
  type ImportReceipt,
  type ImportStatus,
} from "../shared/import";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { useDateTime } from "./date-time";
import "./membership.css";
import "./import.css";

const timeout = () => AbortSignal.timeout(IMPORT_LIMITS.REQUEST_TIMEOUT_MS);

export function ImportSettings({ snapshot }: { snapshot: Snapshot }) {
  const { dateTime: time } = useDateTime();
  const workspaceId = snapshot.workspace.id;
  const allowed = [CAPABILITY.READ, CAPABILITY.EDIT, CAPABILITY.ADMIN].every(
    (capability) => snapshot.capabilities.includes(capability),
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["metadata-import", workspaceId],
    queryFn: ({ signal }) =>
      command<ImportStatus>("metadata_import_status", { workspaceId }, signal),
    enabled: allowed,
    retry: false,
  });
  function refresh() {
    void query.refetch();
    void cache.invalidateQueries({ queryKey: ["workspace", workspaceId] });
  }
  return (
    <section
      className="access-card import-card"
      aria-labelledby="import-heading"
    >
      <div className="access-heading">
        <div>
          <h1 id="import-heading" tabIndex={-1}>
            Bring your project metadata
          </h1>
          <p>
            A one-time starting point for an empty workspace. Review the exact
            intent before importing.
          </p>
        </div>
        <FileInput size={20} aria-hidden="true" />
      </div>
      <p>
        Projects plus their repository names, descriptions, classifications,
        and expectations only. No credentials, members, connected sources, or
        health evidence. This does not change GitHub or any other provider.
      </p>
      {!allowed ? (
        <p className="import-notice">
          A workspace owner with metadata access can prepare an import.
        </p>
      ) : (
        <>
          {query.isPending ? (
            <p role="status">Checking import eligibility...</p>
          ) : null}
          {query.error ? (
            <p role="alert" className="field-error">
              Import status could not be loaded. Refresh to try again.
            </p>
          ) : null}
          {query.data?.receipt ? (
            <div className="import-notice" role="status">
              <Badge variant="secondary">
                <Check size={12} /> Import complete
              </Badge>
              <p>
                {query.data.receipt.projectCount} projects and{" "}
                {query.data.receipt.repositoryCount} repositories from{" "}
                {query.data.receipt.sourceLabel}. Applied{" "}
                {time(query.data.receipt.appliedAt)}.
              </p>
              <p>Live health still depends on separately connected sources.</p>
            </div>
          ) : query.data &&
            (query.data.projectCount > 0 || query.data.repositoryCount > 0) ? (
            <p className="import-notice">
              This workspace already has projects or repositories. Import is
              available only in an empty workspace and never merges or
              overwrites existing records.
            </p>
          ) : null}
          <div className="access-actions import-actions">
            {query.data &&
            !query.data.receipt &&
            query.data.projectCount === 0 &&
            query.data.repositoryCount === 0 ? (
              <Button ref={trigger} onClick={() => setOpen(true)}>
                <FileInput size={15} /> Review metadata file
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw size={14} /> Refresh import status
            </Button>
          </div>
        </>
      )}
      {open ? (
        <ImportDialog
          snapshot={snapshot}
          onClose={() => setOpen(false)}
          onChanged={refresh}
          returnFocus={trigger.current}
        />
      ) : null}
    </section>
  );
}

function ImportDialog({
  snapshot,
  onClose,
  onChanged,
  returnFocus,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  onChanged: () => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const [manifest, setManifest] = useState<ImportManifest | null>(null);
  const { dateTime: time, calendarDate } = useDateTime();
  const [filename, setFilename] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now);
  const guard = useCloseGuard(!receipt && Boolean(manifest || busy), onClose);
  useEffect(() => {
    if (!plan || receipt) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(plan.expiresAt) - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [plan, receipt]);
  async function selectFile(file?: File) {
    if (busy) return;
    setManifest(null);
    setPlan(null);
    setError("");
    setFilename(file?.name ?? "");
    if (!file) return;
    if (file.size > IMPORT_LIMITS.MANIFEST_BYTES) {
      setError(
        "Choose a metadata file smaller than 60 KiB. Full database and credential exports are not accepted.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = importManifest.safeParse(JSON.parse(await file.text()));
      if (!result.success) {
        const issue = result.error.issues[0];
        setError(
          "This is not a supported project metadata file. " +
            (issue.path.length ? "Check " + issue.path.join(".") + ". " : "") +
            "Use a prepared metadata-only export; full legacy documents and credential fields are not accepted.",
        );
        return;
      }
      setManifest(result.data);
    } catch {
      setError(
        "The file could not be read as metadata. Choose a valid JSON metadata file; do not upload a database or secrets export.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    if (!manifest || busy) return;
    setBusy(true);
    setError("");
    try {
      setPlan(
        await command<ImportPlan>(
          "metadata_import_plan",
          { workspaceId: snapshot.workspace.id, manifest },
          timeout(),
        ),
      );
      setNow(Date.now());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The review could not be prepared. Your file is still selected.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan || busy) return;
    setBusy(true);
    setError("");
    try {
      setReceipt(
        await command<ImportReceipt>(
          "metadata_import_apply",
          {
            workspaceId: plan.workspaceId,
            planId: plan.planId,
            fingerprint: plan.fingerprint,
          },
          timeout(),
        ),
      );
      setUncertain(false);
    } catch (error) {
      const rejected = error instanceof RequestError && error.status === 409;
      setUncertain(!rejected);
      setError(
        (error instanceof Error
          ? error.message
          : "The import response was interrupted.") +
          (rejected
            ? " No new review has been started."
            : " Retry this same review to recover its receipt without importing twice."),
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  const expired = Boolean(plan && Date.parse(plan.expiresAt) <= now);
  const projectNames = new Map(
    plan?.manifest.projects.map((project) => [project.key, project.name]) ?? [],
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
          className="access-dialog import-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus?.isConnected) returnFocus.focus();
            else document.getElementById("import-heading")?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {receipt
                ? "Metadata imported"
                : plan
                  ? "Review project import"
                  : "Choose project metadata"}
            </DialogTitle>
            <DialogDescription>
              {receipt
                ? "The receipt is saved in workspace settings. Health observations and access were not imported."
                : "Only the listed projects and repository metadata will be added. Nothing will be overwritten or changed at a provider."}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}
          {receipt ? (
            <div className="import-review">
              <Badge variant="secondary">
                <Check size={12} /> Import complete
              </Badge>
              <p>
                {receipt.projectCount}{" "}
                {receipt.projectCount === 1 ? "project" : "projects"} and{" "}
                {receipt.repositoryCount}{" "}
                {receipt.repositoryCount === 1 ? "repository" : "repositories"}{" "}
                added to {plan?.workspaceName} from {receipt.sourceLabel}.
              </p>
              <dl>
                <dt>Applied</dt>
                <dd>{time(receipt.appliedAt)}</dd>
                <dt>Receipt</dt>
                <dd className="import-fingerprint">{receipt.planId}</dd>
              </dl>
              <p>
                Review them in Repositories. Connect sources separately to
                collect fresh health evidence.
              </p>
              <Button onClick={guard.saved}>Done</Button>
            </div>
          ) : plan ? (
            <div className="import-review">
              <dl>
                <dt>Target workspace</dt>
                <dd>
                  {plan.workspaceName} <code>({plan.workspaceId})</code>
                </dd>
                <dt>Reviewing as</dt>
                <dd>{plan.actor}</dd>
                <dt>Source label</dt>
                <dd>{plan.manifest.sourceLabel}</dd>
                <dt>Project records</dt>
                <dd>{plan.manifest.projects.length}</dd>
                <dt>Repository records</dt>
                <dd>{plan.manifest.repositories.length}</dd>
                <dt>Review expires</dt>
                <dd>{time(plan.expiresAt)}</dd>
                <dt>Review fingerprint</dt>
                <dd className="import-fingerprint">{plan.fingerprint}</dd>
              </dl>
              <p>
                No members, credentials, connections, goals, or health
                observations are included. Every repository belongs to one of
                the projects shown in this review.
              </p>
              <ol
                className="import-repositories"
                aria-label="Exact project metadata"
              >
                {plan.manifest.projects.map((project) => (
                  <li key={project.key}>
                    <h3>{project.name}</h3>
                    <p>{project.description || "No description"}</p>
                    <dl>
                      <dt>Import key</dt>
                      <dd>{project.key}</dd>
                      <dt>Lifecycle</dt>
                      <dd>{project.lifecycle}</dd>
                      <dt>Importance</dt>
                      <dd>{project.importance}</dd>
                      <dt>Portfolio</dt>
                      <dd>{project.portfolio.status}</dd>
                    </dl>
                  </li>
                ))}
              </ol>
              <ol
                className="import-repositories"
                aria-label="Exact repository metadata"
              >
                {plan.manifest.repositories.map((repository) => (
                  <li key={repository.fullName}>
                    <h3>{repository.fullName}</h3>
                    <p>{repository.description || "No description"}</p>
                    <dl>
                      <dt>Classification</dt>
                      <dd>{repository.classification}</dd>
                      <dt>Project</dt>
                      <dd>
                        {projectNames.get(repository.projectKey) ??
                          repository.projectKey}
                      </dd>
                      <dt>Lifecycle</dt>
                      <dd>{repository.lifecycle}</dd>
                      <dt>CI</dt>
                      <dd>{repository.expectations.ci}</dd>
                      <dt>Security</dt>
                      <dd>{repository.expectations.security}</dd>
                      <dt>Monitoring</dt>
                      <dd>{repository.expectations.monitoring}</dd>
                      <dt>Hooks</dt>
                      <dd>{repository.expectations.hooks}</dd>
                      <dt>Visibility</dt>
                      <dd>{repository.expectations.visibility}</dd>
                      <dt>Review date</dt>
                      <dd>{calendarDate(repository.expectations.reviewDate)}</dd>
                      <dt>Note</dt>
                      <dd className="import-note">
                        {repository.expectations.note || "No note"}
                      </dd>
                    </dl>
                  </li>
                ))}
              </ol>
              {expired && !uncertain ? (
                <p role="status">
                  This review expired. Go back and prepare a fresh review.
                </p>
              ) : null}
              <div className="access-actions">
                <Button
                  variant="outline"
                  disabled={busy || uncertain}
                  onClick={() => {
                    setPlan(null);
                    setError("");
                  }}
                >
                  Back to file
                </Button>
                <Button
                  disabled={busy || (expired && !uncertain)}
                  onClick={apply}
                >
                  {busy
                    ? "Confirming import..."
                    : uncertain
                      ? "Retry same import"
                      : "Import reviewed metadata"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="import-review">
              <div className="form-field">
                <label htmlFor="import-file">Project metadata file</label>
                <Input
                  id="import-file"
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(event) => {
                    void selectFile(event.target.files?.[0]);
                  }}
                />
                <p className="field-help">
                  A reviewed, metadata-only JSON file, up to 60 KiB. The file is
                  validated locally before a review is sent to this workspace.
                  It is not stored in browser storage.
                </p>
              </div>
              {manifest ? (
                <p role="status">
                  {filename}: {manifest.projects.length} project records and{" "}
                  {manifest.repositories.length} repository records from{" "}
                  {manifest.sourceLabel}. Ready to review.
                </p>
              ) : null}
              <Button disabled={!manifest || busy} onClick={review}>
                {busy ? "Preparing review..." : "Review exact import"}
              </Button>
            </div>
          )}
          {!receipt ? (
            <div className="access-dialog-actions">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
