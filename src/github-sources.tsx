import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Check, FolderGit2 as Github, Plus, RefreshCw } from "lucide-react";
import { CAPABILITY, idSchema, type Snapshot } from "../shared/domain";
import {
  GITHUB_REFRESH_LIMITS,
  githubRefreshActive,
  githubScheduleNotice,
  type GitHubSource,
  type GitHubRefresh,
} from "../shared/github";
import { GITHUB_CHECK_LABELS } from "../shared/github-evidence";
import { GITHUB_STOP_LABELS } from "../shared/github-diagnostics";
import {
  GITHUB_CHANGE_LABELS,
  GITHUB_OUTCOME_LABELS,
  githubCollectionOutcome,
} from "../shared/github-refresh-summary";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { GitHubEditor } from "./github-editor";
import { GitHubEvidenceList } from "./github-evidence";
import { useSourceTime } from "./date-time";
import { GitHubCoverageView } from "./github-coverage";
import { githubCoverageHref } from "../shared/github-coverage";
import { SOURCE_REQUEST_TIMEOUT_MS } from "./source-editor";
import "./sources.css";
import "./github.css";

function evidenceLabel(source: GitHubSource, snapshot: Snapshot) {
  if (!source.enabled) return "Collection disabled";
  if (!source.credentialConfigured || !source.github.configurationValid)
    return "Not configured";
  const evidence = snapshot.observations.filter(
    (item) =>
      item.sourceId === source.id &&
      source.repositoryIds.includes(item.resourceId),
  );
  if (!evidence.length) return "Awaiting first refresh";
  const fresh = evidence.filter(
    (item) => Date.parse(item.expiresAt) > Date.now(),
  );
  if (!fresh.length) return "Evidence stale";
  if (
    fresh.length < source.repositoryIds.length ||
    fresh.some(
      (item) =>
        !item.details.github ||
        item.details.github.checks.some((check) => check.state !== "observed"),
    )
  )
    return "Incomplete evidence";
  return "Evidence current";
}

function GitHubSourceCard({
  source,
  snapshot,
  edit,
  inspect,
}: {
  source: GitHubSource;
  snapshot: Snapshot;
  edit: () => void;
  inspect: (id?: string, returnFocus?: HTMLElement | null) => void;
}) {
  const displaySourceTime = useSourceTime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ id: string; revision: number } | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const cooldown =
    source.github.retryAt && Date.parse(source.github.retryAt) > Date.now();
  const scheduleNotice = githubScheduleNotice(
    source,
    Date.parse(snapshot.generatedAt),
  );
  const tooSoon =
    source.lastAttemptAt &&
    Date.now() - Date.parse(source.lastAttemptAt) <
      GITHUB_REFRESH_LIMITS.MANUAL_INTERVAL_MS;
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (!request.current || request.current.revision !== source.revision)
      request.current = { id: crypto.randomUUID(), revision: source.revision };
    try {
      const result = await command<GitHubRefresh>(
        "github_refresh",
        {
          workspaceId: snapshot.workspace.id,
          sourceId: source.id,
          revision: request.current.revision,
          refreshId: request.current.id,
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      request.current = null;
      inspect(result.id, historyButton.current);
    } catch (error) {
      if (error instanceof RequestError) {
        request.current = null;
        setError(error.message);
      } else
        setError(
          "The response was interrupted. A refresh may already be queued. Retry will reuse the same request ID.",
        );
    } finally {
      setBusy(false);
      void client.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
      void client.invalidateQueries({
        queryKey: ["github-refreshes", snapshot.workspace.id, source.id],
      });
    }
  }
  return (
    <article className="source-card" aria-label={source.name}>
      <div className="source-card-heading">
        <div>
          <Github size={19} />
          <h2>{source.name}</h2>
        </div>
        <Badge variant="outline">{evidenceLabel(source, snapshot)}</Badge>
      </div>
      <p>
        Read-only GitHub evidence. Freshness and collection success do not mean
        that CI passed or that no findings exist.
      </p>
      <details className="source-scope-summary">
        <summary>{source.repositoryIds.length} repositories in scope</summary>
        <div className="source-scope-links">
          {source.repositoryIds.map((id) => {
            const repository = snapshot.repositories.find(
              (item) => item.id === id,
            );
            return repository ? (
              <Link
                key={id}
                to={
                  "/repositories/" + id + "?workspace=" + snapshot.workspace.id
                }
              >
                {repository.fullName}
              </Link>
            ) : null;
          })}
        </div>
      </details>
      <dl className="source-metadata github-metadata">
        <div>
          <dt>Refresh policy</dt>
          <dd>Every {source.github.refreshIntervalMinutes} minutes</dd>
        </div>
        <div>
          <dt>Stale after</dt>
          <dd>{source.freshnessMinutes} minutes</dd>
        </div>
        <div>
          <dt>Last attempted</dt>
          <dd>{displaySourceTime(source.lastAttemptAt)}</dd>
        </div>
        <div>
          <dt>Last complete collection</dt>
          <dd>{displaySourceTime(source.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt>Next scheduled eligibility</dt>
          <dd>
            {source.enabled && source.credentialConfigured
              ? displaySourceTime(source.github.nextRefreshAt)
              : "Not configured or disabled"}
          </dd>
        </div>
        <div>
          <dt>Latest refresh</dt>
          <dd>{source.github.lastRefreshStatus ?? "Not started"}</dd>
        </div>
      </dl>
      {!source.credentialConfigured ? (
        <p className="permission-notice">
          No workspace-bound GitHub credential is available. An owner can choose
          a provisioned reference in settings.
        </p>
      ) : null}
      {!source.github.configurationValid ? (
        <p className="permission-notice">
          An owner must repair this connection's refresh settings.
        </p>
      ) : null}
      {cooldown ? (
        <p className="permission-notice">
          GitHub requested a cooldown until{" "}
          {displaySourceTime(source.github.retryAt)}. Unread repositories remain
          queued.
        </p>
      ) : null}
      {source.lastError ? (
        <p className="permission-notice">{source.lastError}</p>
      ) : null}
      {scheduleNotice ? (
        <p className="permission-notice">{scheduleNotice}</p>
      ) : null}
      {error ? (
        <p role="alert" className="source-error">
          {error}
        </p>
      ) : null}
      {!canOperate ? (
        <p className="permission-notice">
          Read-only access. Owners and operators can refresh or cancel
          collection.
        </p>
      ) : tooSoon && !source.github.activeRefreshId && !cooldown ? (
        <p className="field-help">
          Manual refresh is available once per minute. Scheduled collection
          continues independently.
        </p>
      ) : null}
      <div className="source-card-footer">
        <code title="Source ID">{source.id}</code>
        <div>
          <Button size="sm" variant="outline" asChild>
            <Link
              to={githubCoverageHref(
                snapshot.workspace.id,
                undefined,
                source.id,
              )}
            >
              View coverage
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canAdmin}
            onClick={edit}
          >
            Edit GitHub settings
          </Button>
          <Button
            ref={historyButton}
            size="sm"
            variant="outline"
            onClick={() => inspect()}
          >
            Refresh history
          </Button>
          <Button
            size="sm"
            disabled={
              busy ||
              !canOperate ||
              !source.enabled ||
              !source.credentialConfigured ||
              !source.github.configurationValid ||
              Boolean(
                source.github.activeRefreshId ||
                  cooldown ||
                  (tooSoon && !request.current),
              )
            }
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            {busy
              ? "Queuing..."
              : source.github.activeRefreshId
                ? "Refresh active"
                : "Refresh GitHub"}
          </Button>
        </div>
      </div>
    </article>
  );
}

export function GitHubRefreshDialog({
  source,
  snapshot,
  initialId,
  onClose,
  returnFocus,
  onSelect,
}: {
  source: Pick<GitHubSource, "id" | "name"> &
    Partial<Pick<GitHubSource, "github">>;
  snapshot: Snapshot;
  initialId?: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  onSelect?: (id: string) => void;
}) {
  const displaySourceTime = useSourceTime();
  const workspaceId = snapshot.workspace.id;
  const [selected, setSelected] = useState(
    initialId ?? source.github?.activeRefreshId ?? undefined,
  );
  const [confirm, setConfirm] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const history = useQuery({
    ...COORDINATED_QUERY_OPTIONS,
    queryKey: ["github-refreshes", workspaceId, source.id],
    staleTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      command<GitHubRefresh[]>(
        "github_refreshes_list",
        { workspaceId, sourceId: source.id },
        signal,
      ),
  });
  const firstId = history.data?.[0]?.id;
  useEffect(() => {
    if (firstId) setSelected((previous) => previous ?? firstId);
  }, [firstId]);
  const refreshId = onSelect ? (initialId ?? selected) : selected;
  const result = useQuery({
    ...COORDINATED_QUERY_OPTIONS,
    queryKey: ["github-refresh", workspaceId, source.id, refreshId],
    enabled: Boolean(refreshId),
    retry: false,
    queryFn: ({ signal }) =>
      command<GitHubRefresh>(
        "github_refresh_get",
        { workspaceId, sourceId: source.id, refreshId },
        signal,
      ),
  });
  const active = result.data && githubRefreshActive(result.data.status);
  const receipts = history.data ?? [];
  const outsideHistory =
    refreshId && !receipts.some((receipt) => receipt.id === refreshId);
  async function cancel() {
    if (!refreshId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await command(
        "github_refresh_cancel",
        { workspaceId, sourceId: source.id, refreshId },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      setConfirm(false);
      void result.refetch();
      void history.refetch();
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Cancellation could not be confirmed. Inspect the refresh before retrying.",
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
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent
          className="source-dialog github-history-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus?.isConnected
              ? returnFocus
              : document.getElementById("github-sources-heading");
            target?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>GitHub refresh history</DialogTitle>
            <DialogDescription>
              {source.name}. Collection receipts show what was read, what
              remains unknown, and what can be retried.
            </DialogDescription>
          </DialogHeader>
          <div className="source-form-scroll">
            {history.isError ? (
              <p role="alert" className="source-error">
                {history.error.message}{" "}
                <Button
                  variant="outline"
                  onClick={() => void history.refetch()}
                >
                  Retry history
                </Button>
              </p>
            ) : null}
            {history.isPending ? (
              <p role="status">Loading refresh history...</p>
            ) : history.data?.length === 0 && !refreshId ? (
              <div className="source-empty">
                <Github size={24} />
                <h3>No refreshes yet</h3>
                <p>
                  Connect a server-side credential, then refresh to collect
                  evidence. Enrollment alone is not verification.
                </p>
              </div>
            ) : null}
            {receipts.length || outsideHistory ? (
              <div className="form-field">
                <label htmlFor="github-refresh-selection">
                  Refresh receipt
                </label>
                <Select
                  value={refreshId}
                  onValueChange={(id) => {
                    if (onSelect) onSelect(id);
                    else setSelected(id);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id="github-refresh-selection">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {outsideHistory ? (
                      <SelectItem value={refreshId}>
                        {result.data
                          ? displaySourceTime(result.data.createdAt) +
                            ": " +
                            result.data.status
                          : result.isError
                            ? "Unavailable receipt"
                            : "Opening selected receipt..."}
                      </SelectItem>
                    ) : null}
                    {receipts.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {displaySourceTime(item.createdAt)}: {item.status} (
                        {item.trigger})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="field-help">
                  History is bounded. The latest receipt is retained; older
                  completed receipts expire after{" "}
                  {GITHUB_REFRESH_LIMITS.RETENTION_DAYS} days.
                </p>
              </div>
            ) : null}
            {result.isError ? (
              <p role="alert" className="source-error">
                {result.error instanceof RequestError &&
                result.error.status === 404
                  ? "This refresh receipt is no longer available. It may have expired or its connection may have been removed. The Activity entry is retained."
                  : result.error.message}{" "}
                <Button variant="outline" onClick={() => void result.refetch()}>
                  Retry receipt
                </Button>
              </p>
            ) : null}
            {refreshId && result.isPending ? (
              <p role="status">Loading repository results...</p>
            ) : null}
            {result.data ? (
              <>
                <div className="github-refresh-summary" role="status">
                  <Badge variant="outline">{result.data.status}</Badge>
                  <strong>
                    {result.data.finished} / {result.data.total} repositories
                    finished
                  </strong>
                  <p>{result.data.summary}</p>
                </div>
                <p className="field-help">
                  Requested by {result.data.actor}. Scope revision{" "}
                  {result.data.sourceRevision}.{" "}
                  {active
                    ? "Closing this view does not cancel the refresh. Queued work is resumed by the hosted collector."
                    : "A successful collection can still contain failed CI or security findings."}
                </p>
                <div className="github-refresh-reference">
                  <label htmlFor="github-refresh-reference">
                    Refresh reference
                  </label>
                  <input
                    id="github-refresh-reference"
                    readOnly
                    value={result.data.id}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(result.data.id);
                        setCopiedId(result.data.id);
                      } catch {
                        setError(
                          "Copy was unavailable. Select the refresh reference and copy it with your keyboard.",
                        );
                      }
                    }}
                  >
                    {copiedId === result.data.id
                      ? "Copied reference"
                      : "Copy reference"}
                  </Button>
                </div>
                <div className="github-results">
                  {result.data.items?.map((item) => (
                    <article
                      key={item.repositoryId}
                      className="github-result"
                      aria-label={item.fullName}
                    >
                      <div className="source-card-heading">
                        <h3>{item.fullName}</h3>
                        <Badge variant="outline">
                          {GITHUB_OUTCOME_LABELS[githubCollectionOutcome(item)]}
                        </Badge>
                      </div>
                      <p className="field-help">
                        {item.changes == null
                          ? "Change comparison was not recorded."
                          : item.changes.length
                            ? "Changed: " +
                              item.changes
                                .map((change) => GITHUB_CHANGE_LABELS[change])
                                .join(", ")
                            : "Evidence unchanged."}
                      </p>
                      <p>{item.summary}</p>
                      <p className="field-help">
                        Observed: {displaySourceTime(item.observedAt)}.
                        Collection attempts: {item.attempts}.
                      </p>
                      {item.diagnostics ? (
                        <details className="github-diagnostics">
                          <summary>
                            Collection diagnostics: {item.diagnostics.requests}{" "}
                            requests, {item.diagnostics.pages} list pages,{" "}
                            {(item.diagnostics.elapsedMs / 1000).toFixed(1)}s
                            elapsed
                          </summary>
                          <p>
                            Elapsed time includes waiting for GitHub; it is not
                            CPU time. These counters describe this collection
                            attempt, not earlier retries.
                          </p>
                          <dl className="github-checks">
                            {item.diagnostics.endpoints.map((endpoint) => (
                              <div key={endpoint.key}>
                                <dt>{GITHUB_CHECK_LABELS[endpoint.key]}</dt>
                                <dd>
                                  {GITHUB_STOP_LABELS[endpoint.reason]}.{" "}
                                  {endpoint.requests} request
                                  {endpoint.requests === 1
                                    ? ""
                                    : "s"} started; {endpoint.pages} list page
                                  {endpoint.pages === 1 ? "" : "s"} read.
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : item.observedAt ? (
                        <p className="field-help">
                          Counters were not recorded for this older receipt.
                        </p>
                      ) : null}
                      {item.evidence ? (
                        <GitHubEvidenceList evidence={item.evidence} />
                      ) : null}
                    </article>
                  ))}
                </div>
              </>
            ) : null}
            {error ? (
              <p role="alert" className="source-error">
                {error}
              </p>
            ) : null}
          </div>
          <div className="source-dialog-actions">
            <Button
              variant="outline"
              disabled={busy || result.isFetching || history.isFetching}
              onClick={() => {
                if (refreshId) void result.refetch();
                void history.refetch();
              }}
            >
              Refresh receipt
            </Button>
            {active ? (
              <Button
                variant="outline"
                disabled={
                  busy || !snapshot.capabilities.includes(CAPABILITY.OPERATE)
                }
                onClick={() => setConfirm(true)}
              >
                Cancel refresh
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this refresh?</AlertDialogTitle>
            <AlertDialogDescription>
              Pending work will stop. Completed repository evidence stays
              available; an in-flight read cannot publish after cancellation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep collecting
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void cancel();
              }}
            >
              {busy ? "Cancelling..." : "Cancel refresh"}
            </AlertDialogAction>
          </AlertDialogFooter>
          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function GitHubSources({ snapshot }: { snapshot: Snapshot }) {
  const [editor, setEditor] = useState<GitHubSource | "new" | null>(null);
  const [params, setParams] = useSearchParams();
  const view =
    params.get("view") === "connections" ? "connections" : "coverage";
  const sourceId = params.get("source");
  const refreshId = params.get("refresh");
  const validReference =
    idSchema.safeParse(sourceId).success &&
    (refreshId === null || idSchema.safeParse(refreshId).success);
  const history = validReference
    ? { sourceId, refreshId: refreshId ?? undefined }
    : null;
  const [notice, setNotice] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const sources = snapshot.connections.filter(
    (source): source is GitHubSource =>
      source.provider === "github" && Boolean(source.github),
  );
  const selected = sources.find((source) => source.id === history?.sourceId);
  function setHistory(next: { sourceId: string; refreshId?: string } | null) {
    setParams((before) => {
      const after = new URLSearchParams(before);
      after.delete("source");
      after.delete("refresh");
      if (next) {
        after.set("source", next.sourceId);
        if (next.refreshId) after.set("refresh", next.refreshId);
      }
      return after;
    });
  }
  function remember() {
    returnFocus.current = document.activeElement as HTMLElement | null;
  }
  return (
    <section
      className="source-settings"
      aria-labelledby="github-sources-heading"
    >
      <div className="source-section-heading">
        <div>
          <h1 id="github-sources-heading" tabIndex={-1}>
            GitHub evidence
          </h1>
        </div>
        <Button
          disabled={!snapshot.capabilities.includes(CAPABILITY.ADMIN)}
          onClick={() => {
            remember();
            setEditor("new");
          }}
        >
          <Plus size={16} />
          Connect GitHub
        </Button>
      </div>
      <nav className="filter-tabs" aria-label="GitHub evidence views">
        {(["coverage", "connections"] as const).map((value) => (
          <Button
            key={value}
            variant="ghost"
            aria-pressed={view === value}
            aria-current={view === value ? "page" : undefined}
            onClick={() =>
              setParams((before) => {
                const after = new URLSearchParams(before);
                if (value === "coverage") after.delete("view");
                else after.set("view", value);
                after.delete("source");
                after.delete("refresh");
                return after;
              })
            }
          >
            {value === "coverage" ? "Coverage" : "Connections"}
          </Button>
        ))}
      </nav>
      {!snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
        <p className="permission-notice">
          Only workspace owners can configure GitHub connections.
        </p>
      ) : view === "connections" && !snapshot.repositories.length ? (
        <p className="permission-notice">
          You can prepare a disabled, empty GitHub source before enrolling or
          transferring repositories.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="save-notice">
          <Check size={16} />
          {notice}
        </p>
      ) : null}
      {(sourceId !== null || refreshId !== null) && !selected ? (
        <div role="alert" className="source-error">
          <p>
            {validReference
              ? "The selected GitHub connection is unavailable in this workspace. It may have been removed or your access may have changed."
              : "This refresh link is incomplete or invalid. Choose a connection's refresh history."}
          </p>
          <Button variant="outline" onClick={() => setHistory(null)}>
            Dismiss refresh link
          </Button>
        </div>
      ) : null}
      {view === "connections" && !sources.length ? (
        <div className="source-empty">
          <Github size={26} />
          <h2>Bring GitHub evidence into view</h2>
          <p>
            Choose the repositories to read and a workspace-bound credential.
            Missing permissions stay visible as unknown, never as a clean bill
            of health.
          </p>
        </div>
      ) : null}
      {view === "coverage" ? (
        <GitHubCoverageView
          snapshot={snapshot}
          edit={(id) => {
            const source = sources.find((item) => item.id === id);
            if (source) {
              remember();
              setEditor(source);
            }
          }}
          inspect={(sourceId, refreshId, target) => {
            returnFocus.current = target;
            setHistory({ sourceId, refreshId });
          }}
        />
      ) : (
        sources.map((source) => (
          <GitHubSourceCard
            key={source.id}
            source={source}
            snapshot={snapshot}
            edit={() => {
              remember();
              setEditor(source);
            }}
            inspect={(refreshId, focusTarget) => {
              if (focusTarget) returnFocus.current = focusTarget;
              else remember();
              setHistory({ sourceId: source.id, refreshId });
            }}
          />
        ))
      )}
      {editor ? (
        <GitHubEditor
          initial={editor === "new" ? undefined : editor}
          snapshot={snapshot}
          onClose={() => setEditor(null)}
          onSaved={(source) =>
            setNotice(source.name + ": GitHub settings saved")
          }
          returnFocus={returnFocus.current}
        />
      ) : null}
      {selected ? (
        <GitHubRefreshDialog
          key={selected.id + ":" + (history?.refreshId ?? "latest")}
          source={selected}
          snapshot={snapshot}
          initialId={history?.refreshId}
          onClose={() => setHistory(null)}
          returnFocus={returnFocus.current}
          onSelect={(id) =>
            setHistory({ sourceId: selected.id, refreshId: id })
          }
        />
      ) : null}
    </section>
  );
}
