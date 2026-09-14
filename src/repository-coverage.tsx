import { expectationHref } from "../shared/expectation-resolution";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { Monitor, RefreshCw, Webhook } from "lucide-react";
import {
  COVERAGE_LABELS,
  COVERAGE_LIMITS,
  coverageAssessment,
  coverageState,
} from "../shared/coverage-evidence";
import type { RepositoryCoverage } from "../shared/repository-coverage";
import type { Repository, Snapshot } from "../shared/domain";
import { REQUIREMENT_LABELS } from "../shared/presentation";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { StatusBadge } from "./components/ui/status";
import { useDateTime } from "./date-time";
import { resourceHref } from "./repository-resources";
import {
  coverageObservationVersion,
  invalidateSupersededCoverage,
  latestCoverage,
} from "./lib/coverage-convergence";

type CoverageQuery = Pick<
  UseQueryResult<RepositoryCoverage>,
  "data" | "isPending" | "isFetching" | "error" | "refetch"
> & {
  isChecking: boolean;
  retainedError: Error | null;
  reload: UseQueryResult<RepositoryCoverage>["refetch"];
};

export function useRepositoryCoverage(
  repository: Repository,
  snapshot: Snapshot,
) {
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const connections = snapshot.connections
    .filter(
      (item) =>
        item.provider === "hookrelay" || item.provider === "endpoint-monitor",
    )
    .map((item) => [item.id, item.revision, item.enabled]);
  const identity = [
    workspaceId,
    repository.id,
    repository.revision,
    connections,
  ];
  const check = useQuery({
    queryKey: ["repository-coverage", ...identity],
    queryFn: ({ signal }) =>
      command<RepositoryCoverage>(
        "repository_coverage",
        { workspaceId, repositoryId: repository.id },
        signal,
      ),
    staleTime: COVERAGE_LIMITS.REFRESH_MS,
    retry: false,
  });
  const retained = useQuery({
    queryKey: [
      "repository-coverage-cache",
      ...identity,
      coverageObservationVersion(repository.id, snapshot.observations),
    ],
    queryFn: ({ signal }) =>
      command<RepositoryCoverage>(
        "repository_coverage_get",
        { workspaceId, repositoryId: repository.id },
        signal,
      ),
    enabled: !check.isPending,
    initialData: () => {
      const prefix = JSON.stringify(["repository-coverage-cache", ...identity]);
      return client
        .getQueriesData<RepositoryCoverage>({
          predicate: (query) =>
            JSON.stringify(query.queryKey.slice(0, identity.length + 1)) ===
            prefix,
        })
        .reduce<RepositoryCoverage | undefined>(
          (latest, [, value]) => latestCoverage(latest, value),
          check.data,
        );
    },
    initialDataUpdatedAt: 0,
    staleTime: COVERAGE_LIMITS.REFRESH_MS,
    retry: false,
  });
  return {
    data: invalidateSupersededCoverage(
      latestCoverage(check.data, retained.data),
      snapshot.observations,
    ),
    isPending: check.isPending,
    isFetching: check.isFetching || retained.isFetching,
    isChecking: check.isFetching,
    error: check.error,
    retainedError: retained.error,
    refetch: () => check.refetch(),
    reload: () => retained.refetch(),
  } satisfies CoverageQuery;
}

export function RepositoryOperationalChecks({
  repository,
  workspaceId,
  query,
  now,
}: {
  repository: Repository;
  workspaceId: string;
  query: CoverageQuery;
  now: number;
}) {
  const dates = useDateTime();
  const heading = useRef<HTMLHeadingElement>(null);
  const data = query.data;
  const cooling = Boolean(
    data?.nextReadAt && Date.parse(data.nextReadAt) > now,
  );
  return (
    <section
      className="repository-operational-checks"
      aria-labelledby="repository-operational-title"
    >
      <div className="resource-section-heading">
        <div>
          <h2 id="repository-operational-title" ref={heading} tabIndex={-1}>
            Operational checks
          </h2>
          <p>
            Linked resources and their latest evidence. Checks do not run probes
            or send notifications.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching || cooling}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" />{" "}
          {query.isChecking
            ? "Checking resources..."
            : "Check linked resources"}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Reading linked operational evidence...</p>
      ) : null}
      {query.error ? (
        <p className="hook-notice" role="alert">
          Operational evidence could not be refreshed. Retained results keep
          their original deadlines. Use Check linked resources to retry.
        </p>
      ) : null}
      {query.retainedError ? (
        <div className="hook-notice" role="alert">
          <p>
            HQ's saved result could not be read. Displayed evidence keeps its
            original deadline.
          </p>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={async (event) => {
              const control = event.currentTarget;
              const result = await query.reload();
              if (
                !result.error &&
                (document.activeElement === control ||
                  document.activeElement === document.body)
              )
                heading.current?.focus();
            }}
          >
            Retry saved result
          </Button>
        </div>
      ) : null}
      {data?.phase === "pending" && cooling ? (
        <p role="status">
          Another check is in progress. Its accepted result will appear here
          when received; no fresh result is implied yet.
        </p>
      ) : null}
      {data?.phase === "pending" && !cooling ? (
        <p role="status">
          The previous check has no confirmed completion. Check linked resources
          to try again.
        </p>
      ) : null}
      {data?.phase === "cooldown" ? (
        <p role="status">
          The read window is busy or the links changed. Retained results are not
          a new check.
        </p>
      ) : null}
      {data ? (
        <div className="repository-operational-grid">
          {(["hook", "monitor"] as const).map((kind) => {
            const hook = kind === "hook";
            const key = hook ? "hooks" : "monitoring";
            const title = hook
              ? "Hookrelay subscriptions"
              : "Endpoint monitoring";
            const Icon = hook ? Webhook : Monitor;
            const groups = data.evidence.filter((item) => item.kind === kind);
            const total = data.links[key];
            const checked = groups.reduce(
              (sum, item) =>
                sum + item.observation.details.coverage.resources.length,
              0,
            );
            const satisfied =
              total > 0 &&
              groups.reduce(
                (sum, item) => sum + item.observation.details.coverage.total,
                0,
              ) === total &&
              groups.every(
                (item) =>
                  Date.parse(item.observation.expiresAt) > now &&
                  coverageAssessment(item.observation.details.coverage, now)
                    .satisfied,
              );
            const problem = groups.some(
              (item) =>
                Date.parse(item.observation.expiresAt) > now &&
                coverageAssessment(item.observation.details.coverage, now)
                  .health === "warning",
            );
            const browse = hook
              ? expectationHref(workspaceId, repository.id, "hooks")
              : "/monitoring?" +
                new URLSearchParams({
                  workspace: workspaceId,
                  repository: repository.id,
                  view: hook ? "subscriptions" : "targets",
                });
            return (
              <article
                className="repository-preview-card"
                key={kind}
                aria-label={title + " coverage"}
              >
                <div className="detail-card-heading">
                  <h3>
                    <Icon size={18} aria-hidden="true" /> {title}
                  </h3>
                  <StatusBadge
                    tone={
                      satisfied ? "success" : problem ? "warning" : "neutral"
                    }
                  >
                    {satisfied
                      ? "Coverage verified"
                      : problem
                        ? "Needs attention"
                        : !total
                          ? "No linked resources"
                          : "Coverage unverified"}
                  </StatusBadge>
                </div>
                <p>
                  Assessment rule:{" "}
                  {REQUIREMENT_LABELS[repository.expectations[key]]}. {total}{" "}
                  linked.
                </p>
                {!total ? (
                  <p>
                    {hook
                      ? "Link an existing subscription or configure hook delivery."
                      : "Add a monitoring target or link an existing one."}
                  </p>
                ) : null}
                {groups.map((group) => {
                  const expired =
                    Date.parse(group.observation.expiresAt) <= now;
                  return (
                    <div key={group.connectionId}>
                      <p className="repository-evidence-source">
                        {group.connectionName} / Read{" "}
                        <time
                          dateTime={group.observation.observedAt}
                          title={dates.tooltip(group.observation.observedAt)}
                        >
                          {dates.dateTime(group.observation.observedAt)}
                        </time>
                        {expired ? " / Expired or invalidated" : ""}
                      </p>
                      <ul className="repository-coverage-resources">
                        {group.observation.details.coverage.resources.map(
                          (resource) => (
                            <li key={resource.resourceKey}>
                              <Link
                                to={resourceHref(
                                  workspaceId,
                                  {
                                    kind,
                                    connectionId: group.connectionId,
                                    resourceKey: resource.resourceKey,
                                  },
                                  repository.id,
                                )}
                              >
                                {resource.resourceKey}
                              </Link>
                              <span>
                                {expired ? "Last known: " : ""}
                                {COVERAGE_LABELS[coverageState(resource, now)]}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  );
                })}
                {checked < total ? (
                  <p>
                    {checked} of {total} linked resources were inspected.
                    Omitted resources do not establish coverage; open the
                    provider workspace for the complete inventory.
                  </p>
                ) : null}
                {hook ? (
                  <p className="field-help">
                    Subscription configuration only. GitHub webhook setup and
                    delivery are separate.
                  </p>
                ) : null}
                <Button asChild variant="outline">
                  <Link to={browse}>
                    {total
                      ? hook
                        ? "Manage hooks"
                        : "Manage monitoring"
                      : hook
                        ? "Set up hooks"
                        : "Set up monitoring"}
                  </Link>
                </Button>
              </article>
            );
          })}
        </div>
      ) : null}
      {cooling && data?.nextReadAt ? (
        <p className="field-help">
          Next provider check available{" "}
          <time
            dateTime={data.nextReadAt}
            title={dates.tooltip(data.nextReadAt)}
          >
            {dates.dateTime(data.nextReadAt)}
          </time>
          .
        </p>
      ) : null}
    </section>
  );
}
