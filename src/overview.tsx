import { useEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Clock3,
  RefreshCw,
  Search,
  Unplug,
} from "lucide-react";
import type { Snapshot } from "../shared/domain";
import {
  ATTENTION_CATEGORIES,
  ATTENTION_LABELS,
  ATTENTION_LIMITS,
  attentionHref,
  attentionPage,
  workspaceAttention,
  type AttentionConnection,
  type AttentionItem,
} from "../shared/attention";
import { operationalItem } from "../shared/attention-operations";
import { Button } from "./components/ui/button";
import { StatusBadge } from "./components/ui/status";
import { Input } from "./components/ui/input";
import { command, RequestError } from "./lib/api";
import { useDateTime } from "./date-time";
import "./overview.css";

const ATTENTION_PRESENTATION = {
  problem: { Icon: CircleX, tone: "danger" },
  review: { Icon: Clock3, tone: "warning" },
  coverage: { Icon: Unplug, tone: "warning" },
} as const;

function useAttentionClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(
          () => setNow(Date.now()),
          ATTENTION_LIMITS.CLOCK_MS,
        );
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return now;
}

function AttentionRow({
  item,
  snapshot,
}: {
  item: AttentionItem;
  snapshot: Snapshot;
}) {
  const dates = useDateTime();
  const repositories = item.repositoryIds.flatMap(
    (id) =>
      snapshot.repositories.find((repository) => repository.id === id) ?? [],
  );
  const projects = item.projectIds.flatMap(
    (id) => snapshot.projects.find((project) => project.id === id) ?? [],
  );
  const external = item.href.startsWith("https://");
  const action = (
    <>
      {item.action}
      <ArrowUpRight size={15} aria-hidden="true" />
    </>
  );
  return (
    <li
      className="attention-row"
      data-category={item.category}
      data-tone={ATTENTION_PRESENTATION[item.category].tone}
    >
      <div className="attention-row-main">
        <div className="attention-row-heading">
          <h2>{item.title}</h2>
          <StatusBadge tone={ATTENTION_PRESENTATION[item.category].tone}>
            {ATTENTION_LABELS[item.category]}
          </StatusBadge>
          {item.severity === "critical" ? (
            <StatusBadge tone="danger">Critical</StatusBadge>
          ) : null}
        </div>
        <div className="attention-context">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={attentionHref(
                "/projects/" + project.id,
                snapshot.workspace.id,
              )}
            >
              {project.name}
              {project.importance !== "standard"
                ? " / " + project.importance + " importance"
                : ""}
            </Link>
          ))}
          {repositories.map((repository) => (
            <Link
              key={repository.id}
              to={attentionHref(
                "/repositories/" + repository.id,
                snapshot.workspace.id,
              )}
            >
              {repository.fullName}
            </Link>
          ))}
          {item.resourceKey ? <span>{item.resourceKey}</span> : null}
          {!projects.length && !repositories.length ? (
            <span>
              {item.resourceKey
                ? "Not linked to a project or repository"
                : "Connection-wide context"}
            </span>
          ) : null}
        </div>
        <p>{item.reason}</p>
        {item.source || item.observedAt ? (
          <div className="attention-provenance">
            {item.source ? <span>{item.source}</span> : null}
            {item.observedAt ? (
              <span>
                Observed{" "}
                <time
                  dateTime={item.observedAt}
                  title={dates.tooltip(item.observedAt)}
                >
                  {dates.dateTime(item.observedAt)}
                </time>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {external ? (
        <a
          className="attention-action"
          href={item.href}
          target="_blank"
          rel="noreferrer"
          aria-label={item.action + " (opens in a new tab)"}
        >
          {action}
        </a>
      ) : (
        <Link className="attention-action" to={item.href}>
          {action}
        </Link>
      )}
    </li>
  );
}

export function OverviewView({ snapshot }: { snapshot: Snapshot }) {
  const [params, setParams] = useSearchParams();
  const [operationsExpanded, setOperationsExpanded] = useState(false);
  const dates = useDateTime();
  const now = useAttentionClock();
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const workspaceId = snapshot.workspace.id;
  const category =
    ATTENTION_CATEGORIES.find((value) => value === params.get("attention")) ??
    "all";
  const search = (params.get("q") ?? "").slice(0, 160);
  const page = Math.min(1000, Math.max(1, Number(params.get("page")) || 1));
  const operational = snapshot.connections.filter(
    (source) =>
      source.provider === "hookrelay" || source.provider === "endpoint-monitor",
  );
  const connectionPages = Math.max(
    1,
    Math.ceil(operational.length / ATTENTION_LIMITS.CONNECTIONS_VISIBLE),
  );
  const connectionPage = Math.min(
    connectionPages,
    Math.max(1, Math.floor(Number(params.get("connectionsPage")) || 1)),
  );
  const selected = operational.slice(
    (connectionPage - 1) * ATTENTION_LIMITS.CONNECTIONS_VISIBLE,
    connectionPage * ATTENTION_LIMITS.CONNECTIONS_VISIBLE,
  );
  const queries = useQueries({
    queries: selected.map((source) => ({
      queryKey: [
        source.provider === "hookrelay"
          ? "attention-hooks"
          : "attention-monitoring",
        workspaceId,
        source.id,
        source.revision,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        command<AttentionConnection>(
          "attention_connection",
          { workspaceId, connectionId: source.id, revision: source.revision },
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        ),
      staleTime: ATTENTION_LIMITS.READ_FRESH_MS,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });
  const operationItems = queries.flatMap((query, index) => {
    const source = selected[index];
    if (query.error)
      return [
        ...(query.error instanceof RequestError &&
        [401, 403, 404, 409].includes(query.error.status)
          ? []
          : (query.data?.items ?? []).map((item) => ({
              ...item,
              expiresAt: new Date(0).toISOString(),
            }))),
        operationalItem(
          workspaceId,
          source,
          source.provider === "hookrelay" ? "hook" : "monitor",
          now,
          {
            id: "read-failed",
            category: "coverage",
            title: "Operational evidence could not be refreshed",
            reason:
              "Retry the preview or inspect the connection. A failed read is not evidence that its resources are failing.",
            expiresAt: null,
          },
        ),
      ];
    if (!query.data) return [];
    const items = query.data.items;
    if (now < Date.parse(query.data.readAt) + ATTENTION_LIMITS.READ_FRESH_MS)
      return items;
    return [
      ...items,
      operationalItem(
        workspaceId,
        source,
        source.provider === "hookrelay" ? "hook" : "monitor",
        now,
        {
          id: "read-stale",
          category: "coverage",
          title: "Operational preview needs a refresh",
          reason:
            "This preview is from the last read. Refresh operations to check for changes at the provider.",
          observedAt: query.data.readAt,
          expiresAt: null,
        },
      ),
    ];
  });
  const result = attentionPage(
    [...workspaceAttention(snapshot, now), ...operationItems],
    snapshot,
    { category, search, page: Math.floor(page) },
    now,
  );
  function navigate(fields: Record<string, string | null>, focus = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: "q" in fields, preventScrollReset: true });
    if (focus) requestAnimationFrame(() => summaryRef.current?.focus());
  }
  const pending = queries.some((query) => query.isPending);
  const refreshing = queries.some((query) => query.isFetching);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>What needs your attention.</p>
        </div>
        <Link
          className="quiet-link"
          to={attentionHref("/repositories", workspaceId)}
        >
          View repositories
          <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <div
        className="attention-metrics"
        role="group"
        aria-label="Attention categories"
      >
        {ATTENTION_CATEGORIES.map((value) => {
          const { Icon, tone } = ATTENTION_PRESENTATION[value];
          return (
            <button
              type="button"
              className="attention-metric"
              key={value}
              data-tone={result.counts[value] ? tone : "neutral"}
              aria-pressed={category === value}
              onClick={() =>
                navigate({
                  attention: category === value ? null : value,
                  page: null,
                })
              }
            >
              <span className="attention-metric-label">
                <span className="attention-category-icon">
                  <Icon size={20} aria-hidden="true" />
                </span>
                {ATTENTION_LABELS[value]}
              </span>
              <strong>{result.counts[value]}</strong>
              <span>
                {value === "problem"
                  ? "Observed issues"
                  : value === "review"
                    ? "Overdue decisions"
                    : "Missing or incomplete evidence"}
              </span>
            </button>
          );
        })}
      </div>
      <section
        className="attention-operations"
        aria-label="Operational previews"
      >
        <div className="attention-operations-heading">
          <h2>
            <button
              type="button"
              aria-expanded={operationsExpanded}
              aria-controls="overview-operational-details"
              aria-label="Inspect operational previews"
              aria-describedby="overview-operational-status"
              onClick={() => setOperationsExpanded((value) => !value)}
            >
              <ChevronRight
                size={16}
                aria-hidden="true"
                className={
                  operationsExpanded ? "attention-expanded" : undefined
                }
              />
              <span>Operational previews</span>
              <span
                className="attention-read-status"
                id="overview-operational-status"
              >
                {selected.length} of {operational.length} connections /{" "}
                {queries.some((query) => query.error)
                  ? "Read failed"
                  : pending
                    ? "Reading..."
                    : queries.some(
                          (query) =>
                            query.data &&
                            now >=
                              Date.parse(query.data.readAt) +
                                ATTENTION_LIMITS.READ_FRESH_MS,
                        )
                      ? "Refresh needed"
                      : selected.length
                        ? "Read"
                        : "Not configured"}
              </span>
            </button>
          </h2>
          {selected.length ? (
            <Button
              variant="outline"
              size="sm"
              aria-label="Refresh operations"
              disabled={refreshing}
              onClick={() =>
                queries.forEach((query) => {
                  void query.refetch();
                })
              }
            >
              <RefreshCw size={14} aria-hidden="true" />
              {refreshing ? "Reading..." : "Refresh"}
            </Button>
          ) : null}
        </div>
        <div id="overview-operational-details" hidden={!operationsExpanded}>
          {selected.length ? (
            <ul>
              {selected.map((source, index) => {
                const query = queries[index];
                const data = query.data;
                const stale =
                  data &&
                  now >=
                    Date.parse(data.readAt) + ATTENTION_LIMITS.READ_FRESH_MS;
                return (
                  <li key={source.id}>
                    <Link
                      to={attentionHref(
                        source.provider === "hookrelay"
                          ? "/hooks"
                          : "/monitoring",
                        workspaceId,
                        { connection: source.id },
                      )}
                    >
                      {source.name}
                    </Link>
                    <span>
                      {query.error
                        ? "Read failed"
                        : query.isPending
                          ? "Reading..."
                          : stale
                            ? "Refresh needed"
                            : "Preview read"}
                      {data ? " / " + dates.dateTime(data.readAt) : ""}
                    </span>
                    {query.error ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={query.isFetching}
                        onClick={() => void query.refetch()}
                        aria-label={"Retry " + source.name}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>
              No Hooks or Monitoring connections in this workspace.{" "}
              <Link to={attentionHref("/hooks", workspaceId)}>Open Hooks</Link>{" "}
              or{" "}
              <Link to={attentionHref("/monitoring", workspaceId)}>
                Monitoring
              </Link>{" "}
              to review setup.
            </p>
          )}
          {connectionPages > 1 ? (
            <nav
              className="attention-pagination"
              aria-label="Operational connection pagination"
            >
              <span>
                Connections{" "}
                {(connectionPage - 1) * ATTENTION_LIMITS.CONNECTIONS_VISIBLE +
                  1}
                -
                {Math.min(
                  connectionPage * ATTENTION_LIMITS.CONNECTIONS_VISIBLE,
                  operational.length,
                )}{" "}
                of {operational.length}. Other connections are not in these
                counts.
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={connectionPage === 1}
                onClick={() =>
                  navigate({
                    connectionsPage: String(connectionPage - 1),
                    page: null,
                  })
                }
              >
                Previous connections
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={connectionPage === connectionPages}
                onClick={() =>
                  navigate({
                    connectionsPage: String(connectionPage + 1),
                    page: null,
                  })
                }
              >
                Next connections
              </Button>
            </nav>
          ) : null}
        </div>
      </section>
      <div className="attention-toolbar">
        <div className="attention-search">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search attention"
            value={search}
            placeholder="Search project, repository or reason"
            onChange={(event) =>
              navigate({ q: event.target.value, page: null })
            }
            maxLength={160}
          />
        </div>
        <Button
          variant={category === "all" ? "secondary" : "outline"}
          aria-pressed={category === "all"}
          onClick={() => navigate({ attention: null, page: null })}
        >
          All attention
        </Button>
        {search || category !== "all" ? (
          <Button
            variant="ghost"
            onClick={() => navigate({ q: null, attention: null, page: null })}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      <p
        className="attention-results"
        ref={summaryRef}
        role="status"
        tabIndex={-1}
      >
        {result.total
          ? `${result.offset + 1}-${result.offset + result.items.length} of ${result.total} attention items`
          : "No matching attention items"}
        {pending ? " / Checking operational previews" : ""}
      </p>
      {result.items.length ? (
        <ul className="overview-attention-list" aria-label="Attention items">
          {result.items.map((item) => (
            <AttentionRow item={item} snapshot={snapshot} key={item.id} />
          ))}
        </ul>
      ) : (
        <div className="attention-empty">
          <h2>
            {search
              ? "No matches"
              : category === "review"
                ? "No overdue reviews"
                : category === "coverage"
                  ? "No coverage gaps in this view"
                  : "No observed problems in this view"}
          </h2>
          <p>
            {search
              ? "Try a project, repository or a shorter search."
              : "This is not an all-clear. Missing evidence, provider preview limits and resources without connections still need consideration."}
          </p>
          <Link to={attentionHref("/settings/github", workspaceId)}>
            Inspect GitHub evidence coverage
          </Link>
        </div>
      )}
      <nav className="attention-pagination" aria-label="Attention pagination">
        <span>
          Page {result.page} of {result.pages}
        </span>
        <div>
          <Button
            variant="outline"
            disabled={result.page === 1}
            onClick={() => navigate({ page: String(result.page - 1) }, true)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={result.page === result.pages}
            onClick={() => navigate({ page: String(result.page + 1) }, true)}
          >
            Next
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </>
  );
}
