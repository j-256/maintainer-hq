import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  COVERAGE_GUIDANCE,
  COVERAGE_LABELS,
  GITHUB_COVERAGE_LIMITS,
  githubCoverageRepositories,
  isGitHubSource,
  type GitHubCoverage,
  type GitHubCoverageRepository,
  type GitHubCoverageSource,
  type GitHubCoverageState,
} from "../shared/github-coverage";
import {
  GITHUB_CHECK_LABELS,
  type GitHubCheck,
} from "../shared/github-evidence";
import { Button } from "./components/ui/button";
import { StatusBadge, type StatusTone } from "./components/ui/status";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { useDateTime } from "./date-time";
import "./github-coverage.css";

const CLOCK_MS = 60 * 1000;
const COVERAGE_TONES: Record<GitHubCoverageState, StatusTone> = {
  current: "info",
  unavailable: "warning",
  incomplete: "warning",
  error: "danger",
  limited: "warning",
  rate_limited: "warning",
  stale: "warning",
  awaiting: "neutral",
  not_configured: "neutral",
  disabled: "neutral",
  not_collected: "neutral",
};
const NAME_ORDER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const CHECK_LABELS: Record<GitHubCheck["state"], string> = {
  observed: "Read",
  unobserved: "Not read",
  unavailable: "Unavailable",
  error: "Read failed",
  limited: "Limit reached",
  rate_limited: "Rate limited",
};
const NEXT_STEP: Record<GitHubCoverageState, string> = {
  current: "Review CI and findings",
  unavailable: "Review access and features",
  incomplete: "Inspect unread checks",
  error: "Inspect the failed read",
  limited: "Inspect the read limit",
  rate_limited: "Wait for the provider cooldown",
  stale: "Check the schedule and receipt",
  awaiting: "Inspect or start collection",
  not_configured: "Review connection settings",
  disabled: "Enable only if needed",
  not_collected: "Connect only if needed",
};
type Inspect = (
  sourceId: string,
  refreshId: string | undefined,
  returnFocus: HTMLElement,
) => void;

function LatestAttempt({
  source,
  loading,
  failed,
}: {
  source: GitHubCoverageSource | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const dates = useDateTime();
  const attempt = source?.latestRefresh;
  if (loading)
    return <span className="coverage-muted">Loading receipt...</span>;
  if (!attempt)
    return (
      <span className="coverage-muted">
        {failed ? "Receipt unavailable" : "No latest receipt"}
      </span>
    );
  return (
    <>
      <span>
        {!attempt.currentRevision
          ? "Previous settings"
          : !attempt.identityMatches
            ? "Previous repository name"
            : attempt.attempts === 0
              ? attempt.status === "cancelled"
                ? "Cancelled before attempt"
                : attempt.status === "failed"
                  ? "Stopped before attempt"
                  : "Not yet attempted"
              : attempt.status === "succeeded"
                ? "Collected"
                : attempt.status === "partial"
                  ? "Collected with gaps"
                  : attempt.status === "running"
                    ? "Reading"
                    : attempt.status === "queued"
                      ? "Waiting to retry"
                      : attempt.status === "failed"
                        ? "Read failed"
                        : "Cancelled"}
      </span>
      <span className="coverage-muted">
        {attempt.attempts === 0
          ? "Queued " + dates.dateTime(attempt.createdAt)
          : "Updated " + dates.dateTime(attempt.updatedAt)}
      </span>
    </>
  );
}

function CoverageDetails({
  workspaceId,
  row,
  canAdmin,
  loading,
  failed,
  edit,
  inspect,
}: {
  workspaceId: string;
  row: GitHubCoverageRepository;
  canAdmin: boolean;
  loading: boolean;
  failed: boolean;
  edit: (id: string) => void;
  inspect: Inspect;
}) {
  const dates = useDateTime();
  if (!row.sources.length)
    return (
      <div className="coverage-detail-body">
        <p>
          {row.repository.lifecycle === "archived"
            ? "This archived repository is not selected by a GitHub connection."
            : "No GitHub connection selects this repository."}
        </p>
        <p>{COVERAGE_GUIDANCE.not_collected}</p>
        <Link
          className="quiet-link"
          to={
            "/settings/github?" +
            new URLSearchParams({ workspace: workspaceId, view: "connections" })
          }
        >
          Review connections
        </Link>
      </div>
    );
  return (
    <div className="coverage-detail-body">
      {row.sources.map((source) => (
        <section
          className="coverage-source-detail"
          key={source.id}
          aria-label={source.name + " coverage"}
        >
          <div className="coverage-detail-heading">
            <h2>{source.name}</h2>
            <StatusBadge tone={COVERAGE_TONES[source.state]}>
              {COVERAGE_LABELS[source.state]}
            </StatusBadge>
          </div>
          <p>{COVERAGE_GUIDANCE[source.state]}</p>
          <dl className="coverage-timing">
            <div>
              <dt>Latest refresh result</dt>
              <dd className="coverage-latest-result">
                <LatestAttempt
                  source={source}
                  loading={loading}
                  failed={failed}
                />
              </dd>
            </div>
            <div>
              <dt>Latest refresh queued</dt>
              <dd>
                {source.lastRefreshQueuedAt
                  ? dates.dateTime(source.lastRefreshQueuedAt)
                  : "Not started"}
              </dd>
            </div>
            <div>
              <dt>Latest evidence observed</dt>
              <dd>
                {source.evidence
                  ? dates.dateTime(source.evidence.observedAt)
                  : "Not observed"}
              </dd>
            </div>
            <div>
              <dt>Evidence accepted by HQ</dt>
              <dd>
                {source.evidence
                  ? dates.dateTime(source.evidence.receivedAt)
                  : "Not received"}
              </dd>
            </div>
            <div>
              <dt>Evidence expires</dt>
              <dd>
                {source.evidence
                  ? dates.dateTime(source.evidence.expiresAt)
                  : "No evidence"}
              </dd>
            </div>
            <div>
              <dt>Next scheduled eligibility</dt>
              <dd>
                {source.enabled &&
                source.credentialConfigured &&
                source.configurationValid &&
                source.nextRefreshAt
                  ? dates.dateTime(source.nextRefreshAt)
                  : "Not scheduled"}
              </dd>
            </div>
            <div>
              <dt>Provider cooldown</dt>
              <dd>
                {source.retryAt
                  ? dates.dateTime(source.retryAt)
                  : "None reported"}
              </dd>
            </div>
          </dl>
          {source.latestRefresh &&
          (!source.latestRefresh.currentRevision ||
            !source.latestRefresh.identityMatches) ? (
            <p className="permission-notice">
              The latest receipt belongs to earlier source settings or a
              previous repository name. It is history, not an attempt with the
              saved identity and scope.
            </p>
          ) : null}
          {source.evidence?.identityMatches === false ? (
            <p className="permission-notice">
              This evidence was accepted for a previous repository name. A new
              matching observation is needed.
            </p>
          ) : null}
          {source.evidence ? (
            <ul
              className="coverage-checks"
              aria-label="Accepted check coverage"
            >
              {source.evidence.checks.map((check) => (
                <li key={check.key}>
                  <span>{GITHUB_CHECK_LABELS[check.key]}</span>
                  <span data-state={check.state}>
                    {CHECK_LABELS[check.state]}
                    {check.count !== undefined
                      ? " (" + check.count + " returned)"
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="coverage-detail-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={(event) =>
                inspect(
                  source.id,
                  source.latestRefresh?.refreshId,
                  event.currentTarget,
                )
              }
            >
              Open refresh receipt
            </Button>
            <Link
              className="quiet-link"
              to={
                "/settings/github?" +
                new URLSearchParams({
                  workspace: workspaceId,
                  view: "connections",
                })
              }
            >
              View connections
            </Link>
            <Button
              variant="outline"
              size="sm"
              disabled={!canAdmin}
              onClick={() => edit(source.id)}
            >
              Edit connection
            </Button>
            {!canAdmin ? (
              <span className="coverage-muted">
                Only workspace owners can change connection settings.
              </span>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

export function GitHubCoverageView({
  snapshot,
  edit,
  inspect,
}: {
  snapshot: Snapshot;
  edit: (id: string) => void;
  inspect: Inspect;
}) {
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const resultsSummary = useRef<HTMLParagraphElement>(null);
  const dates = useDateTime();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const sources = snapshot.connections.filter(isGitHubSource);
  const selectedSource = params.get("connection") ?? "all";
  const selectedRepository = params.get("repository");
  const missingRepository =
    selectedRepository !== null &&
    !snapshot.repositories.some(
      (repository) => repository.id === selectedRepository,
    );
  const search = params.get("q") ?? "";
  const lifecycle = params.get("lifecycle") === "all" ? "all" : "active";
  const rawState = params.get("coverage") ?? "all";
  const state = Object.hasOwn(COVERAGE_LABELS, rawState)
    ? (rawState as GitHubCoverageState)
    : "all";
  const selection =
    selectedSource === "all"
      ? sources
      : sources.filter((source) => source.id === selectedSource);
  const missingSource = selectedSource !== "all" && !selection.length;
  const rows = githubCoverageRepositories(
    snapshot.repositories,
    selection,
    snapshot.observations,
    now,
  )
    .filter(
      (row) =>
        !missingSource &&
        (!selectedRepository || row.repository.id === selectedRepository) &&
        (lifecycle === "all" || row.repository.lifecycle === "active") &&
        (selectedSource === "all" || row.sources.length > 0) &&
        row.repository.fullName
          .toLowerCase()
          .includes(search.trim().toLowerCase()) &&
        (state === "all" || row.state === state),
    )
    .sort(
      (a, b) =>
        NAME_ORDER.compare(a.repository.fullName, b.repository.fullName) ||
        a.repository.id.localeCompare(b.repository.id),
    );
  const size = GITHUB_COVERAGE_LIMITS.REPOSITORIES;
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const requestedPage = Number(params.get("coveragePage"));
  const page = Math.min(
    pageCount,
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1,
  );
  const visible = rows.slice((page - 1) * size, page * size);
  const repositoryIds = visible.map((row) => row.repository.id);
  const input = {
    workspaceId: snapshot.workspace.id,
    repositoryIds,
    sourceId: selectedSource === "all" ? null : selectedSource,
  };
  const result = useQuery({
    ...COORDINATED_QUERY_OPTIONS,
    queryKey: [
      "github-coverage",
      snapshot.workspace.id,
      input,
      visible.map((row) => [
        row.repository.revision,
        row.sources.map((source) => [source.id, source.revision]),
      ]),
    ],
    enabled: repositoryIds.length > 0,
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) =>
      command<GitHubCoverage>("github_coverage", input, signal),
  });
  const details = new Map(
    result.data?.repositories.map((row) => [row.repository.id, row]),
  );
  function detail(row: GitHubCoverageRepository) {
    const received = details.get(row.repository.id);
    if (received?.repository.revision !== row.repository.revision) return row;
    return {
      ...row,
      sources: row.sources.map((source) => ({
        ...source,
        latestRefresh:
          received.sources.find(
            (item) =>
              item.id === source.id && item.revision === source.revision,
          )?.latestRefresh ?? null,
      })),
    };
  }
  function filter(name: string, value: string) {
    setParams(
      (before) => {
        const after = new URLSearchParams(before);
        after.delete("coveragePage");
        if (
          (value === "all" && name !== "lifecycle") ||
          value === "" ||
          (value === "active" && name === "lifecycle")
        )
          after.delete(name);
        else after.set(name, value);
        return after;
      },
      { replace: name === "q", preventScrollReset: true, flushSync: true },
    );
  }
  function movePage(next: number) {
    setParams(
      (before) => {
        const after = new URLSearchParams(before);
        after.set("coveragePage", String(next));
        return after;
      },
      { preventScrollReset: true, flushSync: true },
    );
    resultsSummary.current?.focus({ preventScroll: true });
    resultsSummary.current?.scrollIntoView({ block: "start" });
  }
  const filtered = Boolean(
    selectedRepository ||
      search ||
      selectedSource !== "all" ||
      state !== "all" ||
      lifecycle !== "active",
  );
  return (
    <section
      className="github-coverage"
      aria-label="Repository evidence coverage"
    >
      <p className="coverage-muted">
        Coverage shows what HQ could read, not whether CI passed or security
        findings are clear.
      </p>
      <div className="coverage-controls">
        <div className="search-input">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="Search evidence coverage"
            placeholder="Search repositories..."
            value={search}
            maxLength={100}
            onChange={(event) => filter("q", event.target.value)}
          />
        </div>
        <Select
          value={selectedSource}
          onValueChange={(value) => filter("connection", value)}
        >
          <SelectTrigger aria-label="Coverage connection">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All connections</SelectItem>
            {missingSource ? (
              <SelectItem value={selectedSource}>
                Unavailable connection
              </SelectItem>
            ) : null}
            {sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={state}
          onValueChange={(value) => filter("coverage", value)}
        >
          <SelectTrigger aria-label="Coverage status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All coverage states</SelectItem>
            {Object.entries(COVERAGE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={lifecycle}
          onValueChange={(value) => filter("lifecycle", value)}
        >
          <SelectTrigger aria-label="Coverage lifecycle">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active repositories</SelectItem>
            <SelectItem value="all">Include archived</SelectItem>
          </SelectContent>
        </Select>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() =>
              setParams(
                (before) => {
                  const after = new URLSearchParams(before);
                  for (const key of [
                    "q",
                    "connection",
                    "repository",
                    "coverage",
                    "lifecycle",
                    "coveragePage",
                  ])
                    after.delete(key);
                  return after;
                },
                { replace: true },
              )
            }
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {missingSource ? (
        <p role="alert">
          This GitHub connection is unavailable in the workspace. Choose another
          connection or clear the filter.
        </p>
      ) : null}
      {missingRepository ? (
        <p role="alert">
          This repository is unavailable in the workspace. Clear the filter to
          review other repositories.
        </p>
      ) : null}
      {result.isError ? (
        <div className="coverage-read-error" role="alert">
          <p>
            Refresh details could not be read. Evidence below is from the
            workspace view; any retained receipt details are from the last
            successful read.
          </p>
          {result.error instanceof RequestError &&
          result.error.code === "capacity" ? (
            <p>
              Choose one connection or narrow the repository search to reduce
              this read.
            </p>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void result.refetch()}
            disabled={result.isFetching}
          >
            Retry coverage details
          </Button>
        </div>
      ) : null}
      <div className="coverage-results">
        <p role="status" ref={resultsSummary} tabIndex={-1}>
          {rows.length
            ? (page - 1) * size +
              1 +
              "-" +
              Math.min(page * size, rows.length) +
              " of " +
              rows.length
            : "0"}{" "}
          repositories{filtered ? " matching filters" : " active"}
        </p>
        {result.isFetching && !result.isPending ? (
          <span>Updating refresh details...</span>
        ) : null}
      </div>
      {visible.length ? (
        <table className="coverage-table" role="table">
          <caption className="sr-only">GitHub repository coverage</caption>
          <thead>
            <tr>
              <th scope="col">Repository / connection</th>
              <th scope="col">Coverage</th>
              <th scope="col">Accepted evidence</th>
              <th scope="col">Latest refresh result</th>
              <th scope="col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((base) => {
              const row = detail(base);
              const source =
                row.sources.length === 1 ? row.sources[0] : undefined;
              const open = expanded === row.repository.id;
              return (
                <Fragment key={row.repository.id}>
                  <tr>
                    <th scope="row">
                      <Link
                        to={
                          "/repositories/" +
                          row.repository.id +
                          "?workspace=" +
                          snapshot.workspace.id
                        }
                      >
                        {row.repository.fullName}
                      </Link>
                      <span className="coverage-muted">
                        {source?.name ??
                          (row.sources.length
                            ? row.sources.length + " connections"
                            : "No GitHub connection")}
                        {row.repository.lifecycle === "archived"
                          ? " / Archived"
                          : ""}
                      </span>
                    </th>
                    <td data-label="Coverage">
                      <StatusBadge
                        tone={COVERAGE_TONES[row.state]}
                        data-coverage={row.state}
                      >
                        {COVERAGE_LABELS[row.state]}
                      </StatusBadge>
                      <span className="coverage-next-step">
                        {NEXT_STEP[row.state]}
                      </span>
                    </td>
                    <td data-label="Accepted evidence">
                      <span>
                        {source?.evidence
                          ? dates.dateTime(source.evidence.observedAt)
                          : row.sources.length > 1
                            ? "See connection details"
                            : "No observation"}
                      </span>
                      {source?.evidence ? (
                        <span className="coverage-muted">
                          {!source.evidence.identityMatches
                            ? "Previous repository name"
                            : "Expires " +
                              dates.dateTime(source.evidence.expiresAt)}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Latest refresh result">
                      {row.sources.length > 1 ? (
                        <span>See connection details</span>
                      ) : (
                        <LatestAttempt
                          source={source}
                          loading={result.isPending && row.sources.length > 0}
                          failed={result.isError}
                        />
                      )}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={
                          (open ? "Close" : "Inspect") +
                          " coverage for " +
                          row.repository.fullName
                        }
                        aria-expanded={open}
                        aria-controls={"coverage-detail-" + row.repository.id}
                        onClick={() =>
                          setExpanded(open ? null : row.repository.id)
                        }
                      >
                        {open ? "Close" : "Inspect"}
                      </Button>
                    </td>
                  </tr>
                  {open ? (
                    <tr className="coverage-expanded">
                      <td
                        colSpan={5}
                        id={"coverage-detail-" + row.repository.id}
                      >
                        <CoverageDetails
                          workspaceId={snapshot.workspace.id}
                          row={row}
                          canAdmin={snapshot.capabilities.includes(
                            CAPABILITY.ADMIN,
                          )}
                          loading={result.isPending}
                          failed={result.isError}
                          edit={edit}
                          inspect={inspect}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="source-empty">
          <h2>No repositories match this view</h2>
          <p>
            Adjust the filters or add repositories before reviewing their
            coverage.
          </p>
        </div>
      )}
      <nav
        className="coverage-pagination"
        aria-label="Evidence coverage pagination"
      >
        <p>
          Page {page} of {pageCount}
        </p>
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => movePage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={page >= pageCount}
          onClick={() => movePage(page + 1)}
        >
          Next
        </Button>
      </nav>
    </section>
  );
}
