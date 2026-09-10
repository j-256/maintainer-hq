import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import type { Repository, Snapshot } from "../shared/domain";
import { githubCoverageHref, isGitHubSource } from "../shared/github-coverage";
import {
  CONTEXT_READ_LABELS,
  githubRepositoryUrl,
  type ContextRead,
} from "../shared/github-context";
import { GITHUB_STOP_LABELS } from "../shared/github-diagnostics";
import {
  CHECK_LABELS,
  REVIEW_LABELS,
  WORK_FILTERS,
  WORK_LIMITS,
  filterWork,
  failingWorkChecks,
  workAgeDays,
  workItemUrl,
  workResultSchema,
  type PullWork,
  type WorkFilter,
  type WorkItem,
  type WorkResult,
} from "../shared/repository-work";
import { Badge } from "./components/ui/badge";
import {
  StatusBadge,
  StatusIcon,
  type StatusTone,
} from "./components/ui/status";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
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
import "./repository-work.css";

const CLOCK_MS = 30 * 1000;
const REVIEW_TONES: Record<keyof typeof REVIEW_LABELS, StatusTone> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "warning",
  REVIEW_REQUIRED: "warning",
};
const CHECK_TONES: Record<keyof typeof CHECK_LABELS, StatusTone> = {
  ERROR: "danger",
  EXPECTED: "info",
  FAILURE: "danger",
  PENDING: "info",
  SUCCESS: "success",
};
function useWorkClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
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
function ProviderLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="quiet-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  );
}
function EvidenceTime({ value }: { value: string }) {
  const dates = useDateTime();
  return (
    <time dateTime={value} title={dates.tooltip(value)}>
      {dates.dateTime(value)}
    </time>
  );
}
function ReadGap({
  read,
  area,
}: {
  read: ContextRead;
  area: "pull requests" | "issues";
}) {
  return (
    <div className="work-notice">
      <strong>{CONTEXT_READ_LABELS[read.state]}</strong>
      <p>
        {read.reason === "permission"
          ? `Review repository access and ${area === "issues" ? "Issues" : "Pull requests"} read permission. GitHub did not identify which access or feature is missing.`
          : GITHUB_STOP_LABELS[read.reason] +
            ". No complete " +
            area +
            " inventory was accepted."}
      </p>
    </div>
  );
}
function ItemAge({ item, now }: { item: WorkItem; now: number }) {
  const dates = useDateTime();
  const age = workAgeDays(item.createdAt, now);
  return (
    <div className="work-item-meta">
      <time dateTime={item.createdAt} title={dates.tooltip(item.createdAt)}>
        Opened {dates.date(item.createdAt)}
      </time>
      {age >= WORK_LIMITS.AGING_DAYS ? (
        <Badge variant="outline">{age} days open</Badge>
      ) : (
        <span>
          {age === 0
            ? "Less than a day old"
            : age + (age === 1 ? " day old" : " days old")}
        </span>
      )}
      <time dateTime={item.updatedAt} title={dates.tooltip(item.updatedAt)}>
        Updated {dates.date(item.updatedAt)}
      </time>
    </div>
  );
}
function PullRow({
  item,
  repository,
  now,
  stale,
}: {
  item: PullWork;
  repository: Repository;
  now: number;
  stale: boolean;
}) {
  const href = workItemUrl(repository.fullName, "pull", item.number);
  return (
    <li className="work-pull-row">
      <div className="work-item-heading">
        <ProviderLink href={href}>
          <span>
            #{item.number} {item.title}
          </span>
        </ProviderLink>
        {item.draft ? <Badge variant="secondary">Draft</Badge> : null}
        {item.dependencyBot ? (
          <Badge variant="outline">
            {item.dependencyBot === "dependabot" ? "Dependabot" : "Renovate"}
          </Badge>
        ) : null}
      </div>
      <ItemAge item={item} now={now} />
      <div className="work-signals">
        <StatusBadge
          tone={
            !stale && item.review.state === "observed" && item.review.decision
              ? REVIEW_TONES[item.review.decision]
              : "neutral"
          }
        >
          {item.review.state === "observed"
            ? item.review.decision
              ? REVIEW_LABELS[item.review.decision]
              : "No review decision reported"
            : "Review: " + CONTEXT_READ_LABELS[item.review.state].toLowerCase()}
        </StatusBadge>
        {item.review.state === "observed" ? (
          <span>
            {item.review.requested === null
              ? "Requested reviewers not reported"
              : item.review.requested === 0
                ? "No outstanding review requests"
                : item.review.requested +
                  " outstanding review request" +
                  (item.review.requested === 1 ? "" : "s")}
          </span>
        ) : (
          <span>{GITHUB_STOP_LABELS[item.review.reason]}</span>
        )}
        <a
          className={
            failingWorkChecks(item) ? "quiet-link work-failing" : "quiet-link"
          }
          href={href + "/checks"}
          target="_blank"
          rel="noreferrer"
        >
          <StatusIcon
            tone={
              !stale && item.checks.state === "observed" && item.checks.status
                ? CHECK_TONES[item.checks.status]
                : "neutral"
            }
          />
          {item.checks.state === "observed"
            ? item.checks.status
              ? CHECK_LABELS[item.checks.status]
              : "No check rollup reported"
            : "Checks: " + CONTEXT_READ_LABELS[item.checks.state].toLowerCase()}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        {item.checks.state !== "observed" ? (
          <span>{GITHUB_STOP_LABELS[item.checks.reason]}</span>
        ) : null}
        <a
          className="quiet-link work-head"
          href={
            githubRepositoryUrl(repository.fullName) + "/commit/" + item.headSha
          }
          target="_blank"
          rel="noreferrer"
          title={item.headSha}
        >
          Head {item.headSha.slice(0, 7)}
        </a>
        {item.author ? (
          <span>
            By {item.author.login}
            {item.author.bot ? " (bot)" : ""}
          </span>
        ) : (
          <span>Author unavailable</span>
        )}
      </div>
    </li>
  );
}
export function RepositoryWork({
  snapshot,
  repository,
}: {
  snapshot: Snapshot;
  repository: Repository;
}) {
  const [params, setParams] = useSearchParams();
  const dates = useDateTime();
  const now = useWorkClock();
  const sources = snapshot.connections
    .filter(isGitHubSource)
    .filter((item) => item.repositoryIds.includes(repository.id));
  const source =
    sources.find((item) => item.id === params.get("workSource")) ?? sources[0];
  const workspaceId = snapshot.workspace.id;
  const query = useQuery({
    queryKey: [
      "repository-work",
      workspaceId,
      repository.id,
      repository.revision,
      source?.id,
      source?.revision,
      source?.credentialConfigured,
    ],
    queryFn: async ({ signal }) =>
      workResultSchema.parse(
        await command<WorkResult>(
          "repository_work",
          { workspaceId, repositoryId: repository.id, sourceId: source!.id },
          signal,
        ),
      ),
    enabled: Boolean(source),
    staleTime: 0,
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const accessChanged =
    query.error instanceof RequestError &&
    [401, 403, 404, 409].includes(query.error.status);
  const result = accessChanged ? undefined : query.data;
  const evidence = result?.evidence;
  const base = githubRepositoryUrl(repository.fullName);
  const waiting = Boolean(
    result?.nextReadAt && now < Date.parse(result.nextReadAt),
  );
  const stale = Boolean(
    evidence && now >= Date.parse(evidence.observedAt) + WORK_LIMITS.CACHE_MS,
  );
  const rawFilter = params.get("workFilter") ?? "all";
  const filter = (
    Object.hasOwn(WORK_FILTERS, rawFilter) ? rawFilter : "all"
  ) as WorkFilter;
  const filtered = filterWork(evidence?.pulls.records ?? [], filter, now);
  const pages = Math.max(1, Math.ceil(filtered.length / WORK_LIMITS.PAGE_SIZE));
  const requestedPage = Number(params.get("workPage") ?? 1);
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(1, Math.min(pages, requestedPage))
    : 1;
  const configure = (
    <Link
      className="quiet-link"
      to={githubCoverageHref(workspaceId, repository.id, source?.id)}
    >
      Review GitHub connection
    </Link>
  );
  function setWorkParam(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    if (name !== "workPage") next.delete("workPage");
    setParams(next, { preventScrollReset: true });
  }
  return (
    <section className="repository-work" aria-label="Pull requests and issues">
      <div className="work-toolbar">
        <div>
          <h2>Pull requests and issues</h2>
          <p>
            Recent changes and aging open work, with review and head-check
            evidence.
          </p>
        </div>
        {source ? (
          <Button
            variant="outline"
            disabled={query.isFetching || waiting}
            onClick={() => void query.refetch()}
            title={
              waiting && result?.nextReadAt
                ? "Next provider read after " +
                  dates.dateTime(result.nextReadAt)
                : undefined
            }
          >
            <RefreshCw size={16} aria-hidden="true" />
            {query.isFetching ? "Reading work..." : "Refresh work"}
          </Button>
        ) : null}
      </div>
      {sources.length > 1 ? (
        <label className="work-selector">
          GitHub source
          <Select
            value={source?.id}
            onValueChange={(value) => setWorkParam("workSource", value)}
          >
            <SelectTrigger aria-label="GitHub work source">
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
        <Card>
          <CardContent className="work-empty">
            <h3>No GitHub source for this repository</h3>
            <p>
              Connect a read-only source to inspect open pull requests and
              issues.
            </p>
            {configure}
          </CardContent>
        </Card>
      ) : null}
      {source && query.isPending ? (
        <p role="status">Reading pull requests and issues...</p>
      ) : null}
      {query.error ? (
        <div className="work-notice" role="alert">
          <p>
            {query.error instanceof RequestError
              ? query.error.message
              : "Work evidence could not be verified. Retry the read."}
          </p>
          {evidence ? (
            <p>Any evidence below belongs to the previous read.</p>
          ) : null}
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry work read
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="work-provenance">
          <span>{result.source.name}</span>
          {evidence ? (
            <span>
              Observed <EvidenceTime value={evidence.observedAt} />
            </span>
          ) : (
            <span>No accepted evidence</span>
          )}
          {stale ? (
            <StatusBadge tone="warning">Evidence needs refresh</StatusBadge>
          ) : null}
          {result.nextReadAt ? (
            <span>
              Next provider read after{" "}
              <EvidenceTime value={result.nextReadAt} />
            </span>
          ) : null}
          {configure}
        </div>
      ) : null}
      {result && result.state !== "ready" ? (
        <div className="work-notice" role="status">
          <p>
            {result.state === "disabled"
              ? "This GitHub source is disabled. Enable it only if this repository should be collected."
              : result.state === "not_configured"
                ? "A workspace owner needs to review this source's read-only credential and settings."
                : result.state === "collecting"
                  ? "Another window is reading this repository. Its result will arrive through live updates."
                  : "The bounded read budget or provider cooldown is active. Retry after the time above."}
          </p>
        </div>
      ) : null}
      {evidence ? (
        <>
          <Card>
            <CardHeader>
              <div className="work-heading">
                <CardTitle>
                  <GitPullRequest size={18} aria-hidden="true" />
                  Open pull requests
                  {evidence.pulls.total !== null ? (
                    <span className="work-total">{evidence.pulls.total}</span>
                  ) : null}
                </CardTitle>
                <ProviderLink href={base + "/pulls"}>
                  All pull requests on GitHub
                </ProviderLink>
              </div>
            </CardHeader>
            <CardContent>
              {evidence.pulls.state !== "observed" ? (
                <ReadGap read={evidence.pulls} area="pull requests" />
              ) : evidence.pulls.total === 0 ? (
                <p>No open pull requests were reported at this read.</p>
              ) : (
                <>
                  <p className="work-coverage">
                    {evidence.pulls.hasMore
                      ? `Showing ${evidence.pulls.records.length} of ${evidence.pulls.total} open PRs: up to ${WORK_LIMITS.RECENT_PULLS} recently updated and ${WORK_LIMITS.OLDEST_PULLS} oldest, with duplicates combined.`
                      : `All ${evidence.pulls.total} open PRs are in this sample.`}{" "}
                    Filters apply only to this sample.
                  </p>
                  <div className="work-filter-bar">
                    <label className="work-selector">
                      Show
                      <Select
                        value={filter}
                        onValueChange={(value) =>
                          setWorkParam("workFilter", value)
                        }
                      >
                        <SelectTrigger aria-label="Filter sampled pull requests">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(WORK_FILTERS).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </label>
                    <span role="status">
                      {filtered.length} matching sampled PR
                      {filtered.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {filter === "aging" ? (
                    <p>
                      Aging means open for at least {WORK_LIMITS.AGING_DAYS}{" "}
                      days, not necessarily inactive or overdue.
                    </p>
                  ) : null}
                  {filtered.length ? (
                    <ul
                      className="work-items"
                      aria-label="Sampled pull requests"
                    >
                      {filtered
                        .slice(
                          (page - 1) * WORK_LIMITS.PAGE_SIZE,
                          page * WORK_LIMITS.PAGE_SIZE,
                        )
                        .map((item) => (
                          <PullRow
                            key={item.number}
                            item={item}
                            repository={repository}
                            now={now}
                            stale={stale}
                          />
                        ))}
                    </ul>
                  ) : (
                    <p className="work-empty">
                      No sampled PRs match this filter. Unread signals and PRs
                      outside the sample are not proof that nothing needs
                      attention.
                    </p>
                  )}
                  {pages > 1 ? (
                    <nav
                      className="work-pagination"
                      aria-label="Sampled pull request pages"
                    >
                      <Button
                        variant="outline"
                        disabled={page === 1}
                        onClick={() =>
                          setWorkParam("workPage", String(page - 1))
                        }
                      >
                        <ChevronLeft size={16} aria-hidden="true" />
                        Previous
                      </Button>
                      <span>
                        Page {page} of {pages}
                      </span>
                      <Button
                        variant="outline"
                        disabled={page === pages}
                        onClick={() =>
                          setWorkParam("workPage", String(page + 1))
                        }
                      >
                        Next
                        <ChevronRight size={16} aria-hidden="true" />
                      </Button>
                    </nav>
                  ) : null}
                  <p className="work-footnote">
                    Review decisions, requested reviewers and head-check rollups
                    are separate signals. A passing rollup is not proof of merge
                    readiness or merge-commit checks. Dependency badges identify
                    GitHub-reported Dependabot or Renovate bots, not every
                    dependency update.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div className="work-heading">
                <CardTitle>
                  <CircleDot size={18} aria-hidden="true" />
                  Open issues
                  {evidence.issues.total !== null ? (
                    <span className="work-total">{evidence.issues.total}</span>
                  ) : null}
                </CardTitle>
                <ProviderLink href={base + "/issues"}>
                  All issues on GitHub
                </ProviderLink>
              </div>
            </CardHeader>
            <CardContent>
              {evidence.issues.state !== "observed" ? (
                <ReadGap read={evidence.issues} area="issues" />
              ) : (
                <>
                  {evidence.issues.enabled === false ? (
                    <p>GitHub Issues is disabled for this repository.</p>
                  ) : null}
                  {evidence.issues.total === 0 && evidence.issues.enabled ? (
                    <p>No open issues were reported at this read.</p>
                  ) : null}
                  {evidence.issues.records.length ? (
                    <>
                      <p>
                        {evidence.issues.hasMore
                          ? `Showing the ${evidence.issues.records.length} oldest of ${evidence.issues.total} open issues.`
                          : `All ${evidence.issues.total} open issues are shown.`}{" "}
                        Issue totals exclude pull requests.
                      </p>
                      <ul className="work-items" aria-label="Sampled issues">
                        {evidence.issues.records.map((item) => (
                          <li key={item.number}>
                            <div className="work-item-heading">
                              <ProviderLink
                                href={workItemUrl(
                                  repository.fullName,
                                  "issues",
                                  item.number,
                                )}
                              >
                                #{item.number} {item.title}
                              </ProviderLink>
                            </div>
                            <ItemAge item={item} now={now} />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}
