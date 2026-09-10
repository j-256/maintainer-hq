import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  RefreshCw,
  Search,
} from "lucide-react";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import {
  DependencyChangeEditor,
  DependencyReviewPanel,
} from "./dependency-changes";
import { DependencyHistory } from "./dependency-operations";
import {
  DEPENDENCIES_LIMITS as LIMITS,
  DEPENDENCY_LABELS,
  dependenciesPageSchema,
  dependencyResultSchema,
  dependencyStatus,
  type DependenciesPage,
  type DependencyResult,
} from "../shared/dependencies";
import { type DependencyFinding } from "../shared/dependency-policy";
import { githubCoverageHref, isGitHubSource } from "../shared/github-coverage";
import { githubRepositoryUrl } from "../shared/github-context";
import { GITHUB_STOP_LABELS } from "../shared/github-diagnostics";
import { documentationForRoute } from "../shared/documentation";
import { StatusBadge, type StatusTone } from "./components/ui/status";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { useDateTime } from "./date-time";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import "./dependencies.css";
const DependencyAccess = lazy(() =>
  import("./dependency-access").then((module) => ({
    default: module.DependencyAccess,
  })),
);

const SUMMARY_LABELS = Object.freeze({
  unread: "Not inspected",
  unavailable: "Evidence unavailable",
  untracked: "No override policy",
  attention: "Needs attention",
  tracked: "Policy checked",
});
const DEPENDENCY_TONES: Record<keyof typeof DEPENDENCY_LABELS, StatusTone> = {
  mitigated: "success",
  vulnerable: "danger",
  review_due: "warning",
  unused: "info",
  invalid: "danger",
  resolved: "success",
};
function useDependencyClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), LIMITS.CLOCK_MS);
      }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}
function errorMessage(error: unknown) {
  return error instanceof RequestError
    ? error.message
    : "Dependency evidence could not be verified. Retry the read.";
}
function denied(error: unknown) {
  return (
    error instanceof RequestError && [401, 403, 404, 409].includes(error.status)
  );
}
function DependencyTime({ value }: { value: string }) {
  const dates = useDateTime();
  return (
    <time dateTime={value} title={dates.tooltip(value)}>
      {dates.dateTime(value)}
    </time>
  );
}
export function DependenciesView({
  snapshot,
  projectId,
}: {
  snapshot: Snapshot;
  projectId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const now = useDependencyClock();
  const search = params.get("dependencySearch") ?? "";
  const requestedPage = Number(params.get("dependencyPage") ?? 1);
  const page = Number.isSafeInteger(requestedPage)
    ? Math.min(1000, Math.max(1, requestedPage))
    : 1;
  const workspaceId = snapshot.workspace.id;
  const access = !projectId && params.get("view") === "access";
  const Heading = projectId ? "h2" : "h1";
  const query = useQuery({
    queryKey: ["dependencies", workspaceId, projectId ?? null, search, page],
    queryFn: async ({ signal }) =>
      dependenciesPageSchema.parse(
        await command<DependenciesPage>(
          "dependencies_list",
          { workspaceId, ...(projectId ? { projectId } : {}), search, page },
          signal,
        ),
      ),
    retry: false,
    enabled: !access,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const data = denied(query.error) ? undefined : query.data;
  const pages = data
    ? Math.max(1, Math.ceil(data.total / LIMITS.PAGE_SIZE))
    : page;
  function change(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    if (name !== "dependencyPage") next.delete("dependencyPage");
    setParams(next, { preventScrollReset: true });
  }
  if (access)
    return (
      <section className="dependencies-view">
        <header className="dependency-toolbar">
          <h1>Dependencies</h1>
          <Button
            variant="outline"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("view");
              next.delete("credentialReview");
              setParams(next);
            }}
          >
            Back to dependencies
          </Button>
        </header>
        {snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
          <Suspense
            fallback={<p role="status">Loading repository write access...</p>}
          >
            <DependencyAccess
              snapshot={snapshot}
              onClose={() => {
                const next = new URLSearchParams(params);
                next.delete("view");
                next.delete("credentialReview");
                setParams(next);
              }}
            />
          </Suspense>
        ) : (
          <p role="status">
            Only a workspace owner can manage repository write access.
          </p>
        )}
      </section>
    );
  return (
    <section className="dependencies-view" aria-label="Dependency maintenance">
      <header className="dependency-toolbar">
        <div>
          <Heading>Dependencies</Heading>
          <p>Temporary overrides, upstream fixes, and review deadlines.</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh list
        </Button>
        {!projectId && snapshot.capabilities.includes(CAPABILITY.ADMIN) ? (
          <Button variant="outline" onClick={() => change("view", "access")}>
            Manage write access
          </Button>
        ) : null}
      </header>
      <form
        className="dependency-search"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          change("dependencySearch", String(form.get("search") ?? ""));
        }}
      >
        <label htmlFor="dependency-search">Find a repository</label>
        <div>
          <Input
            id="dependency-search"
            name="search"
            key={search}
            defaultValue={search}
            placeholder="Owner or repository name"
            maxLength={160}
          />
          <Button type="submit" variant="outline">
            <Search size={16} aria-hidden="true" />
            Search
          </Button>
        </div>
      </form>
      {query.error ? (
        <div role="alert" className="dependency-notice">
          <p>{errorMessage(query.error)}</p>
          {data ? <p>The list below belongs to the previous read.</p> : null}
        </div>
      ) : null}
      {query.isPending ? (
        <p role="status">Reading saved dependency evidence...</p>
      ) : null}
      {data ? (
        <>
          <p className="dependency-meta">
            {data.total} {data.total === 1 ? "repository" : "repositories"}
            {projectId ? " in this project" : " in this workspace"}. Open one to
            inspect its committed policy. Refreshing this list does not call
            providers.
          </p>
          <ul className="dependency-inventory">
            {data.rows.map(({ repository, source, summary }) => {
              const state =
                summary.state === "tracked" &&
                summary.reviewBy &&
                Date.parse(summary.reviewBy) <= now
                  ? "attention"
                  : summary.state;
              const stale =
                summary.stale ||
                Boolean(
                  summary.observedAt &&
                    now >= Date.parse(summary.observedAt) + LIMITS.CACHE_MS,
                );
              return (
                <li key={repository.id}>
                  <div className="dependency-repository">
                    <Link
                      to={
                        "/repositories/" +
                        repository.id +
                        "?" +
                        new URLSearchParams({
                          workspace: workspaceId,
                          section: "dependencies",
                          ...(source ? { dependencySource: source.id } : {}),
                        })
                      }
                    >
                      {repository.fullName}
                    </Link>
                    <span>{source?.name ?? "No GitHub source connected"}</span>
                  </div>
                  <div className="dependency-row-status">
                    <StatusBadge
                      tone={
                        stale
                          ? "warning"
                          : state === "attention"
                            ? "warning"
                            : state === "tracked"
                              ? "success"
                              : "neutral"
                      }
                    >
                      {SUMMARY_LABELS[state]}
                    </StatusBadge>
                    {summary.active ? (
                      <span>
                        {summary.active} active{" "}
                        {summary.active === 1 ? "override" : "overrides"}
                      </span>
                    ) : null}
                    {stale ? <span>Inspection needs refresh</span> : null}
                  </div>
                  <div className="dependency-meta">
                    {summary.reviewBy ? (
                      <span>
                        Review by <DependencyTime value={summary.reviewBy} />
                      </span>
                    ) : null}
                    {summary.observedAt ? (
                      <span>
                        Inspected <DependencyTime value={summary.observedAt} />
                      </span>
                    ) : (
                      <span>No accepted inspection</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {!data.rows.length ? (
            <div className="dependency-empty">
              <PackageCheck size={28} aria-hidden="true" />
              <h3>
                {data.total
                  ? "No repositories on this page"
                  : "No matching repositories"}
              </h3>
              <p>
                {data.total
                  ? "Return to an earlier page to see your repositories."
                  : "Try another search or add repositories to this workspace."}
              </p>
            </div>
          ) : null}
          <nav className="dependency-pagination" aria-label="Dependency pages">
            <Button
              variant="outline"
              disabled={page <= 1 || query.isFetching}
              onClick={() => change("dependencyPage", String(page - 1))}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Previous
            </Button>
            <span>
              Page {page} of {pages}
            </span>
            <Button
              variant="outline"
              disabled={page >= pages || query.isFetching}
              onClick={() => change("dependencyPage", String(page + 1))}
            >
              Next
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
function Finding({
  finding,
  now,
  stale,
  canReview,
  onReview,
}: {
  finding: DependencyFinding;
  now: number;
  stale: boolean;
  canReview: boolean;
  onReview: (anchor: HTMLElement) => void;
}) {
  const status = dependencyStatus(finding, now);
  const { rule, upstream } = finding;
  const scopes = [...new Set(finding.matches.map((match) => match.scope))];
  return (
    <article className="dependency-finding">
      <div className="dependency-finding-heading">
        <div>
          <h3>
            {rule.package} <span>{rule.replacement}</span>
          </h3>
          <p>
            Through {rule.parent}{" "}
            <code>
              {rule.package}@{rule.requested}
            </code>
          </p>
        </div>
        <StatusBadge tone={stale ? "neutral" : DEPENDENCY_TONES[status]}>
          {DEPENDENCY_LABELS[status]}
        </StatusBadge>
      </div>
      <p>{rule.reason}</p>
      <dl className="dependency-facts">
        <div>
          <dt>Scope</dt>
          <dd>
            {scopes.length
              ? scopes
                  .map((scope) =>
                    scope === "development" ? "Development" : "Runtime",
                  )
                  .join(" and ")
              : "No matching parent dependency"}
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{rule.owner}</dd>
        </div>
        <div>
          <dt>Review by</dt>
          <dd>
            <DependencyTime value={rule.reviewBy} />
          </dd>
        </div>
        <div>
          <dt>Manifest</dt>
          <dd>
            <code>{finding.manifestPath}</code>
          </dd>
        </div>
      </dl>
      <div className="dependency-upstream">
        <strong>Upstream</strong>
        <p>
          {upstream.state === "not_checked"
            ? "Not checked. Include upstream releases in the next inspection to compare public npm metadata."
            : upstream.state === "fix_available"
              ? "A release excludes the recorded affected range. This repository still needs its own adoption and cleanup checks."
              : upstream.state === "not_fixed"
                ? "The latest parent release still allows the recorded affected range."
                : "An upstream fix could not be verified. Do not assume the override can be removed."}
        </p>
        {upstream.parentVersion ? (
          <span>
            {rule.parent} {upstream.parentVersion}
            {upstream.requested
              ? " requests " + rule.package + " " + upstream.requested
              : ""}
          </span>
        ) : null}
        {upstream.checkedAt ? (
          <span>
            Checked <DependencyTime value={upstream.checkedAt} />
          </span>
        ) : null}
      </div>
      <details>
        <summary>Removal condition and dependency paths</summary>
        <p>{rule.removeWhen}</p>
        <ul className="dependency-matches">
          {finding.matches.map((match, index) => (
            <li key={index}>
              <code>
                {rule.parent}@{match.parentVersion}
              </code>
              <span>requests {match.requested}</span>
              <span>resolves {match.resolved ?? "unknown"}</span>
              <span>
                {match.overridden
                  ? "Override applies"
                  : "Override does not apply"}
              </span>
            </li>
          ))}
        </ul>
        <a
          className="quiet-link"
          href={"https://github.com/advisories/" + rule.advisory}
          target="_blank"
          rel="noreferrer"
        >
          {rule.advisory}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </details>
      {canReview && ["mitigated", "review_due", "unused"].includes(status) ? (
        <div>
          <Button
            variant="outline"
            onClick={(event) => onReview(event.currentTarget)}
          >
            {status === "unused" ? "Review cleanup" : "Review renewal"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
export function RepositoryDependencies({
  snapshot,
  repository,
}: {
  snapshot: Snapshot;
  repository: Repository;
}) {
  const [params, setParams] = useSearchParams();
  const cache = useQueryClient();
  const now = useDependencyClock();
  const [checkUpstream, setCheckUpstream] = useState(false);
  const requestedPull = Number(params.get("dependencyPull"));
  const pullNumber =
    Number.isSafeInteger(requestedPull) &&
    requestedPull > 0 &&
    requestedPull <= 2147483647
      ? requestedPull
      : undefined;
  const [editing, setEditing] = useState<{
    finding: DependencyFinding;
    anchor: HTMLElement;
  } | null>(null);
  const workspaceId = snapshot.workspace.id;
  const sources = snapshot.connections
    .filter(isGitHubSource)
    .filter((item) => item.repositoryIds.includes(repository.id));
  const source =
    sources.find((item) => item.id === params.get("dependencySource")) ??
    sources[0];
  const key = [
    "repository-dependencies",
    workspaceId,
    repository.id,
    repository.revision,
    source?.id,
    source?.revision,
    source?.credentialConfigured,
    pullNumber ?? null,
  ];
  const scope = {
    workspaceId,
    repositoryId: repository.id,
    sourceId: source?.id,
    ...(pullNumber ? { pullNumber } : {}),
  };
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      dependencyResultSchema.parse(
        await command<DependencyResult>(
          "repository_dependencies",
          scope,
          signal,
        ),
      ),
    enabled: Boolean(source),
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const refresh = useMutation({
    mutationFn: async () => ({
      data: dependencyResultSchema.parse(
        await command<DependencyResult>("repository_dependencies", {
          ...scope,
          refresh: true,
          checkUpstream,
        }),
      ),
      key,
    }),
    onSuccess: ({ data, key: capturedKey }) => {
      cache.setQueryData(capturedKey, data);
      void cache.invalidateQueries({ queryKey: ["dependencies", workspaceId] });
    },
  });
  const error = refresh.error ?? query.error;
  const result = denied(error) ? undefined : query.data;
  const evidence = result?.evidence;
  const waiting = Boolean(
    result?.nextReadAt && now < Date.parse(result.nextReadAt),
  );
  const busy = query.isFetching || refresh.isPending;
  const configure = (
    <Link
      className="quiet-link"
      to={githubCoverageHref(workspaceId, repository.id, source?.id)}
    >
      Review GitHub source
    </Link>
  );
  const reviewId = params.get("dependencyReview");
  if (reviewId)
    return (
      <DependencyReviewPanel
        key={reviewId}
        workspaceId={workspaceId}
        repositoryId={repository.id}
        repositoryName={repository.fullName}
        planId={reviewId}
        now={now}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete("dependencyReview");
          setParams(next);
        }}
      />
    );
  return (
    <section className="dependencies-view" aria-label="Repository dependencies">
      <header className="dependency-toolbar">
        <div>
          <h2>Dependencies</h2>
          <p>
            Review temporary overrides against this repository's committed
            lockfiles.
          </p>
        </div>
        {source ? (
          <Button disabled={busy || waiting} onClick={() => refresh.mutate()}>
            <RefreshCw size={16} aria-hidden="true" />
            {refresh.isPending ? "Inspecting..." : "Inspect repository"}
          </Button>
        ) : null}
      </header>
      {source ? (
        <form
          className="dependency-search"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(
              new FormData(event.currentTarget).get("pullNumber") ?? "",
            );
            const next = new URLSearchParams(params);
            if (value) next.set("dependencyPull", value);
            else next.delete("dependencyPull");
            refresh.reset();
            setParams(next, { preventScrollReset: true });
          }}
        >
          <label htmlFor="dependency-pull">Inspection target</label>
          <div>
            <Input
              id="dependency-pull"
              name="pullNumber"
              type="number"
              min={1}
              max={2147483647}
              key={pullNumber ?? "default"}
              defaultValue={pullNumber ?? ""}
              placeholder="PR number (optional)"
              aria-describedby="dependency-target-help"
              disabled={busy}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              Select target
            </Button>
            {pullNumber ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("dependencyPull");
                  refresh.reset();
                  setParams(next, { preventScrollReset: true });
                }}
              >
                Use default branch
              </Button>
            ) : null}
          </div>
          <p id="dependency-target-help" className="dependency-meta">
            {pullNumber
              ? "PR #" +
                pullNumber +
                ": inspect an open, same-repository PR. Cleanup will target that PR's branch, not the default branch. Fork PRs are not supported."
              : "Default branch. Select an upstream-update PR to check cleanup before that update is merged."}
          </p>
        </form>
      ) : null}
      {source ? (
        <div className="dependency-inspection-options">
          <label>
            <input
              type="checkbox"
              checked={checkUpstream}
              onChange={(event) => setCheckUpstream(event.target.checked)}
              disabled={busy}
            />
            Include upstream releases from public npm
          </label>
          <span>
            Shares up to {LIMITS.UPSTREAM_PACKAGES} parent package names with
            npm. No credentials are sent.
          </span>
        </div>
      ) : null}
      {sources.length > 1 ? (
        <label className="dependency-source">
          GitHub source
          <Select
            value={source?.id}
            disabled={busy}
            onValueChange={(value) => {
              refresh.reset();
              const next = new URLSearchParams(params);
              next.set("dependencySource", value);
              setParams(next);
            }}
          >
            <SelectTrigger aria-label="Dependency source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {!source ? (
        <div className="dependency-empty">
          <h3>Connect a GitHub source</h3>
          <p>
            Dependency inspection needs read access to this repository's
            contents.
          </p>
          {configure}
        </div>
      ) : null}
      {source && query.isPending ? (
        <p role="status">Reading saved dependency evidence...</p>
      ) : null}
      {error ? (
        <div className="dependency-notice" role="alert">
          <p>{errorMessage(error)}</p>
          {evidence ? (
            <p>Evidence below belongs to the previous inspection.</p>
          ) : null}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              refresh.reset();
              void query.refetch();
            }}
          >
            Reload saved evidence
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="dependency-meta dependency-provenance">
          <span>{result.source.name}</span>
          {evidence ? (
            <span>
              Inspected <DependencyTime value={evidence.observedAt} />
            </span>
          ) : null}
          {evidence &&
          now >= Date.parse(evidence.observedAt) + LIMITS.CACHE_MS ? (
            <StatusBadge tone="warning">Inspection needs refresh</StatusBadge>
          ) : null}
          {result.nextReadAt && waiting ? (
            <span>
              Next inspection after <DependencyTime value={result.nextReadAt} />
            </span>
          ) : null}
          {evidence?.headSha ? (
            <a
              className="quiet-link"
              href={
                githubRepositoryUrl(repository.fullName) +
                "/commit/" +
                evidence.headSha
              }
              target="_blank"
              rel="noreferrer"
              title={evidence.headSha}
            >
              Commit {evidence.headSha.slice(0, 7)}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ) : null}
          {configure}
        </div>
      ) : null}
      {result && !evidence ? (
        <div className="dependency-empty">
          <h3>
            {result.state === "not_configured" || result.state === "disabled"
              ? "Source unavailable"
              : "No saved inspection"}
          </h3>
          <p>
            {result.state === "disabled"
              ? "Enable this GitHub source to inspect dependency policy."
              : result.state === "not_configured"
                ? "Ask a workspace owner to review the read-only credential and source settings."
                : result.state === "collecting" || waiting
                  ? "Another inspection or the read budget is active. Wait until the time above, then retry."
                  : "Inspect this repository to read its committed override policy. No package scripts or provider writes will run."}
          </p>
        </div>
      ) : null}
      {evidence && evidence.read.state !== "observed" ? (
        <div className="dependency-notice" role="alert">
          <h3>Inspection incomplete</h3>
          <p>
            {GITHUB_STOP_LABELS[evidence.read.reason]}. No complete dependency
            result was accepted.
          </p>
          <p>
            Review Contents read permission, the committed policy, and the
            documented hosted size limits.
            {pullNumber
              ? " PR inspection also requires Pull requests read permission and an open same-repository PR."
              : ""}
          </p>
        </div>
      ) : null}
      {evidence?.read.state === "observed" && evidence.policy === "absent" ? (
        <div className="dependency-empty">
          <h3>No override policy committed</h3>
          <p>
            This commit has no Maintainer HQ dependency policy. That does not
            establish whether dependencies are safe or whether other overrides
            exist.
          </p>
          <a
            className="quiet-link"
            href={documentationForRoute("/dependencies", "").href}
            target="_blank"
            rel="noreferrer"
          >
            Set up dependency maintenance
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {evidence?.report ? (
        <>
          {evidence.report.analysis.issues.length ? (
            <div className="dependency-notice" role="status">
              <h3>Policy checks need attention</h3>
              <ul>
                {evidence.report.analysis.issues.map((issue, index) => (
                  <li key={index}>
                    <code>{issue.manifestPath}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="dependency-meta">
              Recorded override checks passed at this commit. Package execution,
              a full vulnerability audit, and CI success are separate checks.
            </p>
          )}
          {evidence.report.analysis.findings.map((finding) => (
            <Finding
              key={finding.rule.id}
              finding={finding}
              now={now}
              stale={now >= Date.parse(evidence.observedAt) + LIMITS.CACHE_MS}
              canReview={
                snapshot.capabilities.includes(CAPABILITY.OPERATE) &&
                now < Date.parse(evidence.observedAt) + LIMITS.CACHE_MS &&
                !busy
              }
              onReview={(anchor) => setEditing({ finding, anchor })}
            />
          ))}
          {!evidence.report.analysis.findings.length ? (
            <div className="dependency-empty">
              <h3>No tracked overrides</h3>
              <p>The declared manifests have no temporary override records.</p>
            </div>
          ) : null}
          {!snapshot.capabilities.includes(CAPABILITY.OPERATE) ? (
            <p className="dependency-meta">
              Your access is read-only for provider operations. A workspace
              operator can prepare dependency changes.
            </p>
          ) : now >= Date.parse(evidence.observedAt) + LIMITS.CACHE_MS ? (
            <p className="dependency-meta">
              Inspect the repository again before preparing a renewal or
              cleanup.
            </p>
          ) : null}
        </>
      ) : null}
      {evidence ? (
        <details className="dependency-inspection-details">
          <summary>Inspection details</summary>
          <dl className="dependency-facts">
            <div>
              <dt>Reference</dt>
              <dd>
                <code>{evidence.inspectionId}</code>
              </dd>
            </div>
            <div>
              <dt>Provider requests</dt>
              <dd>
                {evidence.requests} GitHub, {evidence.upstreamRequests} npm
              </dd>
            </div>
            <div>
              <dt>Elapsed time</dt>
              <dd>{evidence.elapsedMs} ms, including network waits</dd>
            </div>
          </dl>
        </details>
      ) : null}
      {editing && result ? (
        <DependencyChangeEditor
          workspaceId={workspaceId}
          result={result}
          finding={editing.finding}
          returnFocus={editing.anchor}
          onClose={() => setEditing(null)}
          onPrepared={(review) => {
            setEditing(null);
            const next = new URLSearchParams(params);
            next.set("dependencyReview", review.planId);
            setParams(next);
          }}
        />
      ) : null}
      {snapshot.capabilities.includes(CAPABILITY.OPERATE) ? (
        <DependencyHistory
          workspaceId={workspaceId}
          repositoryId={repository.id}
        />
      ) : null}
    </section>
  );
}
