import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  GitBranch,
  Info,
  KeyRound,
  Monitor,
  ShieldCheck,
  SlidersHorizontal,
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
import { Disclosure } from "./components/ui/disclosure";
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
        {label} could not be refreshed. The preview is from the last successful
        read.
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
        {reviewIsDue(repository, now) ? (
          <StatusBadge tone="warning">Review overdue</StatusBadge>
        ) : null}
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
      <div className="repository-summary-grid">
        <section
          className="repository-preview-card"
          aria-label="Observed evidence"
        >
          <div className="detail-card-heading">
            <h2>
              <ShieldCheck size={17} aria-hidden="true" />
              Observed evidence
            </h2>
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
          <Disclosure
            className="repository-assessment"
            title="Expectation check"
            icon={ShieldCheck}
            description={
              assessment.reasons.length
                ? `${assessment.reasons.length} item${assessment.reasons.length === 1 ? "" : "s"} to review`
                : "Met by fresh observations"
            }
          >
            <ul>
              {assessment.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p>Requirements need fresh provider evidence to pass.</p>
          </Disclosure>
        </section>
        <section aria-label="Expectations summary">
          <Disclosure
            title="Expectations"
            icon={SlidersHorizontal}
            description={
              repository.expectations.reviewDate
                ? "Review by " +
                  dates.calendarDate(repository.expectations.reviewDate)
                : "No review scheduled"
            }
          >
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
                <dd
                  className={reviewIsDue(repository, now) ? "review-due" : ""}
                >
                  {repository.expectations.reviewDate
                    ? dates.calendarDate(repository.expectations.reviewDate)
                    : "Not scheduled"}
                </dd>
              </div>
            </dl>
            {repository.expectations.note ? (
              <div className="repository-note">
                <h3>Maintainer context</h3>
                <p>{repository.expectations.note}</p>
              </div>
            ) : null}
          </Disclosure>
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
      <Disclosure
        className="repository-linked-details"
        title="Linked resources"
        icon={Webhook}
        description={
          context.data
            ? ` / ${context.data.hooks.total} hooks, ${context.data.monitoring.total} monitors, ${context.data.secrets.total} Secrets resources`
            : undefined
        }
      >
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
          Open a resource to inspect health evidence. Links may outlive removed
          resources.
          {context.data ? (
            <> Links read {dates.dateTime(context.data.generatedAt)}.</>
          ) : null}
        </p>
      </Disclosure>
      {activity.error ? (
        <ReadFailure
          label="Activity"
          retry={() => void activity.refetch()}
          fetching={activity.isFetching}
        />
      ) : null}
      <section aria-label="Recent repository activity">
        <Disclosure
          title="Recent activity"
          icon={Activity}
          className="repository-recent-activity"
        >
          <div className="detail-card-heading">
            <Link className="quiet-link" to={sectionHref("activity")}>
              View journal <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
          {activity.isPending ? (
            <p role="status">Loading recent activity...</p>
          ) : null}
          {activity.data?.groups.length ? (
            <ol className="repository-preview-list">
              {activity.data.groups.map((group) => {
                const goal = group.kind === "goal" ? group.goal : null;
                const event = group.kind === "event" ? group.event : null;
                const time =
                  group.kind === "goal"
                    ? group.latestAt
                    : group.event.createdAt;
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
        </Disclosure>
      </section>
      <Disclosure
        className="repository-full-evidence"
        title="Evidence and record details"
        icon={Info}
      >
        <p>
          Repository ID <code>{repository.id}</code> / Revision{" "}
          {repository.revision}
        </p>
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
                <GitHubEvidenceList
                  requirements={repository.expectations.githubSecurity}
                  evidence={item.details.github}
                  fullName={item.name}
                />
              ) : (
                <p>No per-check details were reported.</p>
              )}
            </section>
          ))
        ) : (
          <p>No GitHub evidence has been collected for this repository.</p>
        )}
      </Disclosure>
    </div>
  );
}
