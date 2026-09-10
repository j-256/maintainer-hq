import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Collapsible } from "radix-ui";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  CircleDot,
  Flag,
  MessageSquare,
  Pause,
  TriangleAlert,
  Archive,
} from "lucide-react";
import { type Activity, type Snapshot } from "../shared/domain";
import { GOAL_STATUS_LABELS, isOpenGoal } from "../shared/goals";
import {
  type ActivityFeed,
  type ActivityFilters,
  type ActivityGroup,
  type GoalActivity,
} from "../shared/activity";
import { command } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { useDateTime } from "./date-time";
import { projectHref } from "./project-inventory";
import { githubReceiptHref } from "../shared/github-refresh-summary";

const GitHubRefreshDialog = lazy(() =>
  import("./github-sources").then((module) => ({
    default: module.GitHubRefreshDialog,
  })),
);

function eventPresentation(type: string) {
  if (type.startsWith("github.refresh."))
    return {
      Icon: CircleDot,
      label: "GitHub collection",
      tone: type === "github.refresh.failed" ? "danger" : "muted",
    };
  if (type === "goal.active")
    return { Icon: Flag, label: "Goal started", tone: "accent" };
  if (type === "goal.complete")
    return { Icon: CheckCheck, label: "Goal complete", tone: "success" };
  if (type === "goal.blocked")
    return { Icon: TriangleAlert, label: "Goal blocked", tone: "warning" };
  if (type === "goal.paused")
    return { Icon: Pause, label: "Goal paused", tone: "muted" };
  if (type === "goal.cleared")
    return { Icon: Archive, label: "Goal cleared", tone: "muted" };
  if (type === "update.checkpoint.completed")
    return { Icon: CheckCheck, label: "Checkpoint complete", tone: "success" };
  if (type === "update.checkpoint.started")
    return { Icon: Flag, label: "Checkpoint", tone: "accent" };
  if (type === "update.verification")
    return { Icon: CheckCheck, label: "Reported check", tone: "success" };
  if (type === "update.attention")
    return { Icon: TriangleAlert, label: "Needs attention", tone: "warning" };
  if (type === "update.note")
    return { Icon: MessageSquare, label: "Note", tone: "muted" };
  return {
    Icon: CircleDot,
    label: type.startsWith("update.") ? "Progress update" : "Workspace change",
    tone: "muted",
  };
}

function ActivityEvent({
  event,
  snapshot,
}: {
  event: Activity;
  snapshot: Snapshot;
}) {
  const { Icon, label, tone } = eventPresentation(event.type);
  const dates = useDateTime();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const receiptLink = useRef<HTMLAnchorElement>(null);
  const repository = snapshot.repositories.find(
    (item) => item.id === event.resourceId,
  );
  const project = snapshot.projects.find(
    (item) => item.id === event.resourceId,
  );
  return (
    <li className="activity-event" id={"event-" + event.id}>
      <div className={"event-icon " + tone}>
        <Icon size={17} aria-hidden="true" />
      </div>
      <article className="event-body">
        <div className="event-meta">
          <span>{label}</span>
          <span aria-hidden="true">/</span>
          <span>{event.actor}</span>
          <time
            dateTime={event.createdAt}
            title={dates.tooltip(event.createdAt)}
          >
            {dates.dateTime(event.createdAt)}
          </time>
        </div>
        <h3>{event.title}</h3>
        {event.summary && !(event.goalId && event.type.startsWith("goal.")) ? (
          <p className="event-summary">{event.summary}</p>
        ) : null}
        {event.githubSourceId && event.githubRefreshId ? (
          <>
            <Link
              ref={receiptLink}
              className="repo-tag"
              to={githubReceiptHref(
                snapshot.workspace.id,
                event.githubSourceId,
                event.githubRefreshId,
              )}
              onClick={(click) => {
                if (
                  click.button !== 0 ||
                  click.metaKey ||
                  click.ctrlKey ||
                  click.altKey ||
                  click.shiftKey
                )
                  return;
                click.preventDefault();
                setReceiptOpen(true);
              }}
            >
              View refresh receipt
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
            {receiptOpen ? (
              <Suspense
                fallback={<p role="status">Opening refresh receipt...</p>}
              >
                <GitHubRefreshDialog
                  source={{
                    id: event.githubSourceId,
                    name: event.githubSourceName ?? "GitHub connection",
                  }}
                  snapshot={snapshot}
                  initialId={event.githubRefreshId}
                  onClose={() => setReceiptOpen(false)}
                  returnFocus={receiptLink.current}
                />
              </Suspense>
            ) : null}
          </>
        ) : null}
        {project ? (
          <Link
            className="repo-tag"
            to={projectHref(snapshot.workspace.id, project.id, "activity")}
          >
            Project: {project.name}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        ) : null}
        {repository ? (
          <Link
            className="repo-tag"
            to={
              "/repositories/" +
              encodeURIComponent(repository.id) +
              "?workspace=" +
              encodeURIComponent(snapshot.workspace.id)
            }
          >
            {repository.fullName}
            <ArrowUpRight size={11} aria-hidden="true" />
          </Link>
        ) : null}
      </article>
    </li>
  );
}

function PageError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="activity-page-error" role="alert">
      <p>{error.message}</p>
      <Button variant="outline" onClick={retry}>
        Retry activity
      </Button>
    </div>
  );
}

function GoalEntries({
  group,
  filters,
  snapshot,
}: {
  group: Extract<ActivityGroup, { kind: "goal" }>;
  filters: ActivityFilters;
  snapshot: Snapshot;
}) {
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1) ?? group.eventsCursor;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusPage = useRef(false);
  const query = useQuery({
    ...COORDINATED_QUERY_OPTIONS,
    queryKey: [
      "workspace",
      filters.workspaceId,
      "goal-activity",
      filters,
      group.goal.id,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<GoalActivity>(
        "goal_activity",
        { ...filters, goalId: group.goal.id, cursor },
        signal,
      ),
    retry: false,
  });
  const data = query.data;
  const pageNumber = pages.length || 1;
  const paginated = Boolean(data?.nextCursor || pages.length > 1);
  useEffect(() => {
    if (
      focusPage.current &&
      !query.isFetching &&
      (query.isSuccess || query.isError)
    ) {
      heading.current?.focus();
      focusPage.current = false;
    }
  }, [cursor, query.isFetching, query.isSuccess, query.isError]);
  function navigate(next: string[]) {
    focusPage.current = true;
    setPages(next);
  }
  return (
    <div className="goal-entries" aria-busy={query.isFetching}>
      <div className="goal-entry-toolbar">
        <h3 ref={heading} tabIndex={-1} aria-live="polite">
          Updates{paginated ? " / page " + pageNumber : ""}
        </h3>
        {pages.length ? (
          <Button variant="ghost" onClick={() => navigate([])}>
            Newest updates
          </Button>
        ) : null}
      </div>
      {query.error ? (
        <PageError error={query.error} retry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p role="status">Loading goal activity...</p>
      ) : data?.events.length ? (
        <ol>
          {data.events.map((event) => (
            <ActivityEvent key={event.id} event={event} snapshot={snapshot} />
          ))}
        </ol>
      ) : (
        <p>No matching updates in this goal.</p>
      )}
      {paginated ? (
        <nav className="activity-pagination" aria-label="Goal activity pages">
          <Button
            variant="outline"
            disabled={pages.length < 2 || query.isFetching}
            onClick={() => navigate(pages.slice(0, -1))}
          >
            <ArrowLeft aria-hidden="true" />
            Newer updates
          </Button>
          <Button
            variant="outline"
            disabled={!data?.nextCursor || query.isFetching || query.isError}
            onClick={() => {
              if (data?.nextCursor)
                navigate([
                  ...(pages.length ? pages : [data.viewCursor]),
                  data.nextCursor!,
                ]);
            }}
          >
            Older updates
            <ArrowRight aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function GoalSection({
  group,
  filters,
  snapshot,
  openOverride,
  onOpenChange,
}: {
  group: Extract<ActivityGroup, { kind: "goal" }>;
  filters: ActivityFilters;
  snapshot: Snapshot;
  openOverride: boolean | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const goal =
    snapshot.goals.find((item) => item.id === group.goal.id) ?? group.goal;
  const dates = useDateTime();
  const open =
    openOverride ??
    (isOpenGoal(goal.status) ||
      Boolean(
        filters.search || filters.repositoryId || filters.filter !== "all",
      ));
  const status = GOAL_STATUS_LABELS[goal.status];
  return (
    <li className="goal-feed-item">
      <Collapsible.Root
        className="goal-group"
        open={open}
        onOpenChange={onOpenChange}
      >
        <h2>
          <Collapsible.Trigger asChild>
            <Button variant="ghost" className="goal-group-trigger">
              <ChevronRight className="goal-group-chevron" aria-hidden="true" />
              <span className="goal-group-objective">
                {group.goal.objective}
              </span>
            </Button>
          </Collapsible.Trigger>
        </h2>
        <div className="goal-group-meta">
          <Badge variant="outline">{status}</Badge>
          {goal.status === "cleared" ? (
            <span>Removed from the source, not marked complete</span>
          ) : null}
          <span>
            {group.eventCount}{" "}
            {group.eventCount === 1 ? "matching event" : "matching events"}
          </span>
          <time dateTime={group.latestAt} title={dates.tooltip(group.latestAt)}>
            {dates.dateTime(group.latestAt)}
          </time>
        </div>
        <Collapsible.Content>
          {open ? (
            <GoalEntries group={group} filters={filters} snapshot={snapshot} />
          ) : null}
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
}

export function PaginatedActivity({
  filters,
  snapshot,
  clearFilters,
}: {
  filters: ActivityFilters;
  snapshot: Snapshot;
  clearFilters: () => void;
}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [openGoals, setOpenGoals] = useState<Record<string, boolean>>({});
  const cursor = pages.at(-1) ?? null;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusPage = useRef(false);
  const query = useQuery({
    ...COORDINATED_QUERY_OPTIONS,
    queryKey: [
      "workspace",
      filters.workspaceId,
      "activity-feed",
      filters,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<ActivityFeed>("activity_feed", { ...filters, cursor }, signal),
    staleTime: 0,
    retry: false,
  });
  const data = query.data;
  useEffect(() => {
    if (
      focusPage.current &&
      !query.isFetching &&
      (query.isSuccess || query.isError)
    ) {
      heading.current?.focus();
      focusPage.current = false;
    }
  }, [cursor, query.isFetching, query.isSuccess, query.isError]);
  function navigate(next: (string | null)[]) {
    focusPage.current = true;
    setPages(next);
  }
  const filtered = Boolean(
    filters.search || filters.repositoryId || filters.filter !== "all",
  );
  return (
    <div className="activity-results" aria-busy={query.isFetching}>
      <div className="activity-results-heading">
        <h2 ref={heading} tabIndex={-1}>
          Activity / page {pages.length}
        </h2>
        <span>{cursor === null ? "Live" : "History view"}</span>
        {cursor !== null ? (
          <Button variant="outline" onClick={() => navigate([null])}>
            Return to live activity
          </Button>
        ) : null}
      </div>
      {cursor !== null ? (
        <p className="activity-history-hint">
          New activity will not move this page while you read.
        </p>
      ) : null}
      {query.error ? (
        <PageError error={query.error} retry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p role="status">Loading activity...</p>
      ) : data?.groups.length ? (
        <ol className="activity-feed-list">
          {data.groups.map((group) =>
            group.kind === "event" ? (
              <ActivityEvent
                key={"event:" + group.event.id}
                event={group.event}
                snapshot={snapshot}
              />
            ) : (
              <GoalSection
                key={"goal:" + group.goal.id}
                group={group}
                filters={filters}
                snapshot={snapshot}
                openOverride={openGoals[group.goal.id]}
                onOpenChange={(open) =>
                  setOpenGoals((value) => ({ ...value, [group.goal.id]: open }))
                }
              />
            ),
          )}
        </ol>
      ) : (
        <div className="empty-state">
          <MessageSquare size={28} aria-hidden="true" />
          <h2>
            {filtered ? "No matching activity" : "A fresh page for your work"}
          </h2>
          <p>
            {filtered
              ? "Try another filter or a different search."
              : "Post your first note to start the workspace journal."}
          </p>
          {filtered ? (
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      )}
      <nav className="activity-pagination" aria-label="Activity pages">
        <Button
          variant="outline"
          disabled={pages.length < 2 || query.isFetching}
          onClick={() => navigate(pages.slice(0, -1))}
        >
          <ArrowLeft aria-hidden="true" />
          Newer activity
        </Button>
        <span aria-live="polite">Page {pages.length}</span>
        <Button
          variant="outline"
          disabled={!data?.nextCursor || query.isFetching || query.isError}
          onClick={() => {
            if (data?.nextCursor)
              navigate([
                ...pages.slice(0, -1),
                data.viewCursor,
                data.nextCursor,
              ]);
          }}
        >
          Older activity
          <ArrowRight aria-hidden="true" />
        </Button>
      </nav>
      <div className="journal-footer">
        {data && !query.isError
          ? `${data.groups.length} goals and standalone events on this page. `
          : ""}
        Search covers the full journal. Times use your timezone.
      </div>
    </div>
  );
}
