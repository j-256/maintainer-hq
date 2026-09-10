import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  GitBranch,
  KeyRound,
  Monitor,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import {
  assessRepository,
  type Repository,
  type Snapshot,
} from "../shared/domain";
import {
  EXPECTATION_LABELS,
  HEALTH_LABELS,
  REQUIREMENT_LABELS,
  reviewIsDue,
} from "../shared/presentation";
import { GOAL_STATUS_LABELS } from "../shared/goals";
import type { ActivityFeed } from "../shared/activity";
import {
  REPOSITORY_CONTEXT_LIMITS,
  type RepositoryContext,
} from "../shared/repository-context";
import { githubReceiptHref } from "../shared/github-refresh-summary";
import { command } from "./lib/api";
import { StatusBadge, StatusIcon } from "./components/ui/status";
import { HEALTH_TONES } from "./lib/status-tones";
import { Button } from "./components/ui/button";
import { useDateTime } from "./date-time";
import { GitHubEvidenceList } from "./github-evidence";
import { githubCoverageHref } from "../shared/github-coverage";
import { resourceHref } from "./repository-resources";
import { repositoryHref } from "./resource-repositories";
import { withInventoryContext } from "./repository-inventory";
import {
  IMPORTANCE_LABELS,
  PORTFOLIO_LABELS,
  projectHref,
} from "./project-inventory";
import {
  repositoryEvidenceSummary,
  repositoryGitHubContext,
} from "./repository-overview-model";
import "./repository-overview.css";
import {
  RepositoryOperationalChecks,
  useRepositoryCoverage,
} from "./repository-coverage";

const CLOCK_TICK_MS = 1000;

function ReadFailure({
  label,
  retry,
  fetching,
}: {
  label: string;
  retry: () => void;
  fetching: boolean;
}) {
  return (
    <div className="repository-read-error" role="alert">
      <span>
        {label} could not be refreshed. Any preview below is from the last
        successful read.
      </span>
      <Button variant="outline" size="sm" onClick={retry} disabled={fetching}>
        Retry {label.toLowerCase()}
      </Button>
    </div>
  );
}

function PreviewCard({
  title,
  icon,
  total,
  href,
  children,
}: {
  title: string;
  icon: ReactNode;
  total?: number;
  href: string;
  children: ReactNode;
}) {
  return (
    <section
      className="repository-preview-card"
      aria-label={title + " preview"}
    >
      <div className="detail-card-heading">
        <h2>
          {icon}
          {title}
          {total !== undefined ? (
            <span className="repository-link-count">{total} linked</span>
          ) : null}
        </h2>
        <Link
          className="quiet-link"
          to={href}
          aria-label={"View all repository " + title.toLowerCase()}
        >
          <ArrowUpRight size={17} aria-hidden="true" />
        </Link>
      </div>
      {children}
    </section>
  );
}

export function RepositoryOverview({
  repository,
  snapshot,
}: {
  repository: Repository;
  snapshot: Snapshot;
}) {
  const dates = useDateTime();
  const [params] = useSearchParams();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function visibility() {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
      }
    }
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const workspaceId = snapshot.workspace.id;
  const coverage = useRepositoryCoverage(repository, snapshot);
  const input = { workspaceId, repositoryId: repository.id };
  const resourceConnections = snapshot.connections
    .filter(
      (item) =>
        item.provider === "hookrelay" || item.provider === "endpoint-monitor",
    )
    .map((item) => [item.id, item.revision, item.name, item.enabled]);
  const context = useQuery({
    queryKey: [
      "repository-context",
      workspaceId,
      repository.id,
      repository.revision,
      resourceConnections,
    ],
    queryFn: ({ signal }) =>
      command<RepositoryContext>("repository_context", input, signal),
    staleTime: 0,
    retry: false,
  });
  const filters = {
    ...input,
    filter: "all",
    search: "",
    projectId: null,
    limit: REPOSITORY_CONTEXT_LIMITS.ACTIVITY_PREVIEW,
  };
  const activity = useQuery({
    queryKey: ["workspace", workspaceId, "activity-feed", filters, null],
    queryFn: ({ signal }) =>
      command<ActivityFeed>(
        "activity_feed",
        { ...filters, cursor: null },
        signal,
      ),
    staleTime: 0,
    retry: false,
  });
  const sectionHref = (section: string) =>
    withInventoryContext(
      repositoryHref(workspaceId, repository.id, section),
      params,
    );
  const project = snapshot.projects.find(
    (item) => item.id === repository.projectId,
  );
  const assessment = assessRepository(
    repository,
    snapshot.observations.filter(
      (item) =>
        item.details.coverage ||
        snapshot.connections.find(
          (connection) => connection.id === item.sourceId,
        )?.enabled !== false,
    ),
    now,
  );
  const github = repositoryGitHubContext(repository, snapshot);
  const sourceHref = githubCoverageHref(
    workspaceId,
    repository.id,
    github.source?.id,
  );
  return (
    <div className="repository-overview">
      <div
        className="repository-overview-context"
        role="group"
        aria-label="Repository context"
      >
        <StatusBadge
          tone={
            repository.lifecycle === "archived"
              ? "neutral"
              : HEALTH_TONES[assessment.health]
          }
          className={"health-badge health-" + assessment.health}
        >
          {repository.lifecycle === "archived"
            ? "Archived"
            : HEALTH_LABELS[assessment.health]}
        </StatusBadge>
        {project ? (
          <>
            <Link
              className="quiet-link"
              to={projectHref(workspaceId, project.id)}
            >
              {project.name}
            </Link>
            <span>{IMPORTANCE_LABELS[project.importance]} importance</span>
            <span>Portfolio: {PORTFOLIO_LABELS[project.portfolio.status]}</span>
          </>
        ) : (
          <span>Project unavailable</span>
        )}
        <span>
          {repository.lifecycle === "active"
            ? "Active tracking"
            : "Archived in this workspace"}
        </span>
        {github.upstream ? (
          <a
            className="quiet-link repository-upstream"
            href={github.upstream}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <Link className="quiet-link" to={sectionHref("work")}>
        Review open pull requests, checks and issues{" "}
        <ArrowUpRight size={14} aria-hidden="true" />
      </Link>
      <Link className="quiet-link" to={sectionHref("releases")}>
        Review releases, deployments and changes since release{" "}
        <ArrowUpRight size={15} aria-hidden="true" />
      </Link>
      <div className="repository-summary-grid">
        <section
          className="repository-preview-card"
          aria-label="Observed evidence"
        >
          <div className="detail-card-heading">
            <h2>Observed evidence</h2>
            <Link className="quiet-link" to={sourceHref}>
              Sources
            </Link>
          </div>
          <div className="repository-evidence-summary">
            {(["ci", "security"] as const).map((kind) => {
              const evidence = repositoryEvidenceSummary(
                kind,
                github.observation,
                github.source,
                now,
              );
              const Icon = kind === "ci" ? GitBranch : ShieldCheck;
              return (
                <div
                  key={kind}
                  className={"repository-evidence-result " + evidence.tone}
                >
                  <h3>
                    <Icon size={16} aria-hidden="true" />
                    {kind === "ci" ? "CI" : "Security"}
                  </h3>
                  <strong data-tone={evidence.tone}>
                    <StatusIcon tone={evidence.tone} size={18} />
                    {evidence.label}
                  </strong>
                  <p>{evidence.detail}</p>
                  {github.upstream ? (
                    <a
                      className="quiet-link"
                      href={
                        github.upstream +
                        (kind === "ci" ? "/actions" : "/security")
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {kind === "ci" ? "GitHub Actions" : "GitHub security"}
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="repository-evidence-source">
            {github.source?.name ?? "GitHub"}
            {github.source?.enabled === false ? " (disabled)" : ""}
            {github.observation ? (
              <>
                {" "}
                / Observed{" "}
                <time
                  dateTime={github.observation.observedAt}
                  title={dates.tooltip(github.observation.observedAt)}
                >
                  {dates.dateTime(github.observation.observedAt)}
                </time>
              </>
            ) : (
              " / No accepted result"
            )}
          </p>
          <details className="repository-assessment">
            <summary>
              Expectation check
              {assessment.reasons.length
                ? `: ${assessment.reasons.length} item${assessment.reasons.length === 1 ? "" : "s"} to review`
                : ": met by fresh observations"}
            </summary>
            <ul>
              {assessment.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p>
              Requirements describe what you expect; they do not establish
              provider health.
            </p>
          </details>
        </section>
        <section
          className="repository-preview-card"
          aria-label="Expectations summary"
        >
          <div className="detail-card-heading">
            <h2>Expectations</h2>
            <span className="revision-label">
              Revision {repository.revision}
            </span>
          </div>
          <dl className="repository-expectations">
            {(
              Object.keys(
                EXPECTATION_LABELS,
              ) as (keyof typeof EXPECTATION_LABELS)[]
            ).map((key) => (
              <div key={key}>
                <dt>{EXPECTATION_LABELS[key]}</dt>
                <dd>{REQUIREMENT_LABELS[repository.expectations[key]]}</dd>
              </div>
            ))}
            <div>
              <dt>Visibility</dt>
              <dd>
                {repository.expectations.visibility === "any"
                  ? "Public or private"
                  : repository.expectations.visibility}
              </dd>
            </div>
            <div>
              <dt>Review by</dt>
              <dd className={reviewIsDue(repository, now) ? "review-due" : ""}>
                {repository.expectations.reviewDate
                  ? dates.calendarDate(repository.expectations.reviewDate)
                  : "Not scheduled"}
              </dd>
            </div>
          </dl>
          {repository.expectations.note ? (
            <details className="repository-note">
              <summary>Maintainer context</summary>
              <p>{repository.expectations.note}</p>
            </details>
          ) : null}
        </section>
      </div>
      <RepositoryOperationalChecks
        repository={repository}
        workspaceId={workspaceId}
        query={coverage}
        now={now}
      />
      {context.error ? (
        <ReadFailure
          label="Resource links"
          retry={() => void context.refetch()}
          fetching={context.isFetching}
        />
      ) : null}
      <details className="repository-linked-details">
        <summary>
          Linked resources
          {context.data
            ? ` / ${context.data.hooks.total} hooks, ${context.data.monitoring.total} monitors, ${context.data.secrets.total} Secrets resources`
            : ""}
        </summary>
        <div
          className="repository-linked-previews"
          aria-busy={context.isPending}
        >
          {(
            [
              { key: "hooks", title: "Hooks", Icon: Webhook },
              { key: "monitoring", title: "Monitoring", Icon: Monitor },
            ] as const
          ).map(({ key, title, Icon }) => {
            const links = context.data?.[key];
            return (
              <PreviewCard
                key={key}
                title={title}
                icon={<Icon size={17} aria-hidden="true" />}
                total={links?.total}
                href={sectionHref(key)}
              >
                {links?.items.length ? (
                  <ul className="repository-preview-list">
                    {links.items.map((resource) => (
                      <li
                        key={resource.connectionId + ":" + resource.resourceKey}
                      >
                        <Link
                          to={resourceHref(
                            workspaceId,
                            resource,
                            repository.id,
                          )}
                        >
                          {resource.resourceKey}
                        </Link>
                        <span>
                          {resource.connectionName}
                          {resource.connectionEnabled
                            ? ""
                            : " / Connection disabled"}
                          {resource.repositoryCount > 1
                            ? ` / Shared by ${resource.repositoryCount} repos`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {links
                      ? "No resources linked to this repository."
                      : context.isPending
                        ? "Loading links..."
                        : "Links unavailable."}
                  </p>
                )}
                <Link className="quiet-link" to={sectionHref(key)}>
                  {links?.total
                    ? "View status and details"
                    : "Browse and link resources"}
                </Link>
              </PreviewCard>
            );
          })}
          <PreviewCard
            title="Secrets"
            icon={<KeyRound size={17} aria-hidden="true" />}
            total={context.data?.secrets.total}
            href={sectionHref("secrets")}
          >
            {context.data?.secrets.items.length ? (
              <ul className="repository-preview-list">
                {context.data.secrets.items.map((resource) => (
                  <li key={resource.connectionId + ":" + resource.resourceId}>
                    <Link
                      to={
                        "/secrets?" +
                        new URLSearchParams({
                          workspace: workspaceId,
                          connection: resource.connectionId,
                          resource: resource.resourceId,
                          repository: repository.id,
                        })
                      }
                    >
                      {resource.label}
                    </Link>
                    <span>
                      {resource.providerKind === "github-actions"
                        ? "GitHub Actions"
                        : "Cloudflare Workers"}{" "}
                      / {resource.connectionName}
                      {resource.connectionEnabled
                        ? ""
                        : " / Connection disabled"}
                      {!resource.identityMatches
                        ? " / Repository identity changed"
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {context.data
                  ? "No Secrets resources linked to this repository."
                  : context.isPending
                    ? "Loading links..."
                    : "Links unavailable."}
              </p>
            )}
            <Link className="quiet-link" to={sectionHref("secrets")}>
              View inventory and operations
            </Link>
          </PreviewCard>
        </div>
        <p className="repository-preview-note">
          Links describe configuration, not resource health. Open a resource for
          its latest status.
          {context.data ? (
            <> Links read {dates.dateTime(context.data.generatedAt)}.</>
          ) : null}
        </p>
      </details>
      <section
        className="repository-preview-card repository-recent-activity"
        aria-label="Recent repository activity"
      >
        <div className="detail-card-heading">
          <h2>
            <Activity size={17} aria-hidden="true" />
            Recent activity
          </h2>
          <Link className="quiet-link" to={sectionHref("activity")}>
            View journal <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
        {activity.error ? (
          <ReadFailure
            label="Activity"
            retry={() => void activity.refetch()}
            fetching={activity.isFetching}
          />
        ) : null}
        {activity.isPending ? (
          <p role="status">Loading recent activity...</p>
        ) : null}
        {activity.data?.groups.length ? (
          <ol className="repository-preview-list">
            {activity.data.groups.map((group) => {
              const goal = group.kind === "goal" ? group.goal : null;
              const event = group.kind === "event" ? group.event : null;
              const time =
                group.kind === "goal" ? group.latestAt : group.event.createdAt;
              return (
                <li key={goal?.id ?? event!.id}>
                  <div className="repository-preview-event-heading">
                    <strong>
                      {goal
                        ? "Goal / " + GOAL_STATUS_LABELS[goal.status]
                        : event!.title}
                    </strong>
                    <time dateTime={time} title={dates.tooltip(time)}>
                      {dates.dateTime(time)}
                    </time>
                  </div>
                  <p className="repository-preview-description">
                    {goal?.objective ?? event!.summary}
                  </p>
                  {event?.githubSourceId && event.githubRefreshId ? (
                    <Link
                      className="quiet-link"
                      to={githubReceiptHref(
                        workspaceId,
                        event.githubSourceId,
                        event.githubRefreshId,
                      )}
                    >
                      View refresh receipt
                    </Link>
                  ) : (
                    <Link className="quiet-link" to={sectionHref("activity")}>
                      {goal
                        ? `View goal and ${group.kind === "goal" ? group.eventCount : 0} updates`
                        : "View in journal"}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        ) : activity.data ? (
          <p>No activity has been attributed to this repository.</p>
        ) : null}
      </section>
      <details className="repository-preview-card repository-full-evidence">
        <summary>GitHub evidence details</summary>
        {github.observations.length ? (
          github.observations.map((item) => (
            <section key={item.sourceId}>
              <h3>
                {snapshot.connections.find(
                  (source) => source.id === item.sourceId,
                )?.name ?? item.sourceId}
                {snapshot.connections.find(
                  (source) => source.id === item.sourceId,
                )?.enabled === false
                  ? " / Collection disabled"
                  : ""}
              </h3>
              <p>
                {Date.parse(item.expiresAt) > now
                  ? "Within freshness window"
                  : "Stale evidence"}{" "}
                / Observed {dates.dateTime(item.observedAt)}. {item.summary}
              </p>
              {item.details.github ? (
                <GitHubEvidenceList evidence={item.details.github} />
              ) : (
                <p>No per-check details were reported.</p>
              )}
            </section>
          ))
        ) : (
          <p>No GitHub evidence has been collected for this repository.</p>
        )}
      </details>
    </div>
  );
}
