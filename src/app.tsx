import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  LoaderCircle,
  Radio,
  RefreshCw,
} from "lucide-react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import type { Workspace } from "../shared/domain";
import { ActivityView } from "./activity";
import { command, request } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Skeleton } from "./components/ui/skeleton";
import {
  DEFAULT_PREFERENCES,
  type PreferenceRecord,
} from "../shared/preferences";
import { createDateTimeFormatter } from "../shared/date-time";
import { DateTimeContext } from "./date-time";
import { useWorkspacePush } from "./workspace-push";
import { ConnectionDetails } from "./connection-details";
import {
  viewQueryKey,
  viewSnapshot,
  type SyncUpdate,
  type WorkspaceView,
} from "../shared/workspace-sync";
import {
  applyViewUpdate,
  routeScope,
  sortView,
  type CachedWorkspaceView,
} from "./lib/workspace-sync";
import { PUSH_STATUS_LABEL, workspaceQueryMatches } from "./lib/workspace-push";
import { PUSH_TOPICS } from "../shared/workspace-push";
import { documentationForRoute } from "../shared/documentation";
import { WorkspaceNavigation } from "./navigation";
import { navigationContext, workspaceDestination } from "./lib/navigation";

type Session = {
  principal: { subject: string; displayName: string };
  workspaces: Workspace[];
  development: boolean;
  preferences: PreferenceRecord;
};
const subscribeOnline = (listener: () => void) =>
  onlineManager.subscribe(listener);
const readOnline = () => onlineManager.isOnline();
const SOURCE_REPOSITORY_URL = "https://github.com/j-256/maintainer-hq";

const RepositoriesView = lazy(() =>
  import("./repositories").then((module) => ({
    default: module.RepositoriesView,
  })),
);
const ProjectsView = lazy(() =>
  import("./projects").then((module) => ({ default: module.ProjectsView })),
);
const ProjectDetail = lazy(() =>
  import("./projects").then((module) => ({ default: module.ProjectDetail })),
);
const HooksView = lazy(() =>
  import("./hooks").then((module) => ({ default: module.HooksView })),
);
const MonitoringView = lazy(() =>
  import("./monitoring").then((module) => ({ default: module.MonitoringView })),
);
const SecretsView = lazy(() =>
  import("./secrets").then((module) => ({ default: module.SecretsView })),
);
const RepositoryDetail = lazy(() =>
  import("./repositories").then((module) => ({
    default: module.RepositoryDetail,
  })),
);
const OverviewView = lazy(() =>
  import("./overview").then((module) => ({ default: module.OverviewView })),
);
const DependenciesView = lazy(() =>
  import("./dependencies").then((module) => ({ default: module.DependenciesView })),
);
const SettingsView = lazy(() =>
  import("./settings").then((module) => ({ default: module.SettingsView })),
);
const Onboarding = lazy(() =>
  import("./membership").then((module) => ({ default: module.Onboarding })),
);

export function App() {
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const session = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => request<Session>("/api/session", { signal }),
    retry: false,
  });
  const workspaceId =
    params.get("workspace") ?? session.data?.workspaces[0]?.id;
  const workspaceAvailable = Boolean(
    session.data?.workspaces.some((workspace) => workspace.id === workspaceId),
  );
  const scope = routeScope(location.pathname, params.get("section"));
  const key = viewQueryKey(workspaceId, scope);
  const snapshot = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<CachedWorkspaceView> => {
      const prior = queryClient.getQueryData<CachedWorkspaceView>(key);
      if (prior && !prior.resync) {
        const update = await command<SyncUpdate>(
          "workspace_changes",
          {
            workspaceId,
            ...scope,
            cursor: prior.cursor,
            memberRevision: prior.memberRevision,
          },
          signal,
        );
        const next = applyViewUpdate(
          queryClient.getQueryData<CachedWorkspaceView>(key) ?? prior,
          scope,
          update,
        );
        if (!next.resync) return sortView(next);
      }
      const loaded = await command<WorkspaceView>(
        "workspace_view",
        { workspaceId, ...scope },
        signal,
      );
      const latest = queryClient.getQueryData<CachedWorkspaceView>(key);
      return latest && !latest.resync && latest.cursor > loaded.cursor
        ? latest
        : sortView(loaded);
    },
    enabled: workspaceAvailable,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const push = useWorkspacePush(
    workspaceId,
    Boolean(workspaceAvailable && snapshot.data),
    scope,
    snapshot.data?.memberRevision,
  );
  const pushStatus = push.status;
  const error = session.error ?? snapshot.error;
  const data = useMemo(
    () =>
      workspaceAvailable && snapshot.data
        ? viewSnapshot(snapshot.data)
        : undefined,
    [workspaceAvailable, snapshot.data],
  );
  const preferences = session.data?.preferences ?? {
    preferences: DEFAULT_PREFERENCES,
    revision: 0,
    updatedAt: null,
  };
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dates = useMemo(
    () => createDateTimeFormatter(preferences.preferences, localTimeZone),
    [preferences.preferences, localTimeZone],
  );
  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("hq.theme.v1", next ? "dark" : "light");
    } catch {
      /* A blocked preference store does not prevent theme changes */
    }
  }
  function refreshView() {
    queryClient.setQueryData<CachedWorkspaceView>(key, (prior) =>
      prior ? { ...prior, resync: true } : prior,
    );
    void queryClient.invalidateQueries({
      predicate: (query) =>
        Boolean(
          workspaceId &&
          workspaceQueryMatches(query.queryKey, workspaceId, PUSH_TOPICS),
        ),
    });
  }
  const suffix = workspaceId
    ? "?workspace=" + encodeURIComponent(workspaceId)
    : "";
  const guide = documentationForRoute(location.pathname, location.search);
  const pageContext = navigationContext(
    location.pathname,
    location.search,
    data,
  );
  useEffect(() => {
    document.title = pageContext.title;
  }, [pageContext.title]);
  return (
    <DateTimeContext.Provider value={dates}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <WorkspaceNavigation
          workspaceId={workspaceId}
          workspaces={session.data?.workspaces ?? []}
          loading={session.isPending}
          displayName={
            session.data?.principal.displayName ?? "Workspace member"
          }
          role={
            data?.workspace.role ?? (session.data ? "Signed in" : "Connecting")
          }
          dark={dark}
          toggleTheme={toggleTheme}
          canSignOut={session.data?.development === false}
        />
        <div className="workspace-body">
          <header className="topbar">
            <div className="breadcrumb">
              <span>
                {session.data?.workspaces.find(
                  (workspace) => workspace.id === workspaceId,
                )?.name ??
                  data?.workspace.name ??
                  "Workspace"}
              </span>
              <ChevronRight size={13} />
              <span>{pageContext.label}</span>
            </div>
            <div className="connection-state">
              <a
                className="context-guide"
                href={guide.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={guide.label + " guide (opens in a new tab)"}
                title={guide.label + " guide (opens in a new tab)"}
              >
                <BookOpen size={17} />
                <span>Guide</span>
              </a>
              <ConnectionDetails
                key={
                  workspaceId +
                  ":" +
                  scope.view +
                  ":" +
                  (scope.repositoryId ?? "")
                }
                status={!online ? "offline" : pushStatus}
                label={
                  !online
                    ? "Offline"
                    : error
                      ? "Refresh interrupted"
                      : snapshot.isFetching
                        ? "Syncing..."
                        : workspaceId
                          ? PUSH_STATUS_LABEL[pushStatus]
                          : "Account setup"
                }
                read={push.diagnostics}
                viewLabel={pageContext.label}
                acceptedAt={data?.generatedAt}
                refreshing={snapshot.isFetching}
                refreshFailed={Boolean(error)}
                canRefresh={online && workspaceAvailable}
                onRefresh={refreshView}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Refresh view"
                disabled={!online || snapshot.isFetching || !workspaceAvailable}
                onClick={refreshView}
              >
                <RefreshCw
                  size={14}
                  className={snapshot.isFetching ? "animate-spin" : ""}
                />
              </Button>
            </div>
          </header>
          {session.data?.development ? (
            <section
              className="preview-banner"
              aria-label="Development environment"
            >
              <Radio size={14} />
              <span>
                Local preview{" "}
                <span className="banner-detail">
                  / Isolated identity and workspace data. Use test credentials
                  only.
                </span>
              </span>
              <Badge variant="outline">DOGFOOD</Badge>
            </section>
          ) : null}
          <main id="main-content" tabIndex={-1}>
            {!data &&
            (!session.data || workspaceAvailable) &&
            (error || !online) ? (
              <div className="page-heading">
                <h1>Unable to load workspace</h1>
              </div>
            ) : null}
            {!online ? (
              <div className="error-banner" role="status">
                <strong>You are offline</strong>
                <p>
                  {data
                    ? "Showing the last successful snapshot from " +
                      dates.dateTime(data.generatedAt) +
                      "."
                    : "Reconnect to load your workspace."}
                </p>
                <p>
                  Updates resume when your connection returns. Unsaved drafts
                  stay in this tab.
                </p>
              </div>
            ) : null}
            {error && online ? (
              <div className="error-banner" role="alert">
                <strong>Workspace update interrupted</strong>
                <p>{error.message}</p>
                {data ? (
                  <p>
                    Showing the last successful snapshot from{" "}
                    {dates.dateTime(data.generatedAt)}.
                  </p>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => {
                    void session.refetch();
                    void snapshot.refetch();
                  }}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {!data &&
            !error &&
            online &&
            (session.isPending ||
              (workspaceAvailable && snapshot.isPending)) ? (
              <div className="loading-state" role="status">
                <LoaderCircle className="animate-spin" size={20} />
                <span>Opening your workspace...</span>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : null}
            {session.data && workspaceId && !workspaceAvailable ? (
              <section className="settings-card navigation-recovery">
                <h1>Workspace unavailable</h1>
                <p>
                  This link points to a workspace that is not available to your
                  account. Choose one of your workspaces, or ask an owner to
                  review your membership.
                </p>
                <div className="navigation-recovery-links">
                  {session.data.workspaces.map((workspace) => (
                    <Button key={workspace.id} variant="outline" asChild>
                      <NavLink
                        to={workspaceDestination(
                          location.pathname,
                          workspace.id,
                        )}
                      >
                        {workspace.name}
                      </NavLink>
                    </Button>
                  ))}
                </div>
                {!session.data.workspaces.length ? (
                  <Button asChild>
                    <NavLink to="/activity">Open account setup</NavLink>
                  </Button>
                ) : null}
              </section>
            ) : null}
            {session.data && !workspaceId ? (
              <Suspense
                fallback={<p role="status">Opening account setup...</p>}
              >
                <Onboarding
                  displayName={session.data.principal.displayName}
                  development={session.data.development}
                />
              </Suspense>
            ) : null}
            {data && workspaceAvailable ? (
              <Suspense
                fallback={
                  <div className="loading-state" role="status">
                    <LoaderCircle className="animate-spin" size={18} />
                    Opening view...
                  </div>
                }
              >
                <Routes>
                  <Route path="/dependencies" element={<DependenciesView key={data.workspace.id} snapshot={data} />} />
                  <Route
                    path="/overview"
                    element={<OverviewView snapshot={data} />}
                  />
                  <Route
                    path="/activity"
                    element={
                      <ActivityView key={data.workspace.id} snapshot={data} />
                    }
                  />
                  <Route
                    path="/repositories"
                    element={
                      <RepositoriesView
                        key={data.workspace.id}
                        snapshot={data}
                        setParams={setParams}
                      />
                    }
                  />
                  <Route
                    path="/projects"
                    element={
                      <ProjectsView
                        key={data.workspace.id}
                        snapshot={data}
                        setParams={setParams}
                      />
                    }
                  />
                  <Route
                    path="/projects/:projectId"
                    element={
                      <ProjectDetail
                        key={data.workspace.id + location.pathname}
                        snapshot={data}
                        setParams={setParams}
                      />
                    }
                  />
                  <Route
                    path="/repositories/:repositoryId"
                    element={
                      <RepositoryDetail
                        key={data.workspace.id + location.pathname}
                        snapshot={data}
                      />
                    }
                  />
                  <Route
                    path="/hooks"
                    element={
                      <HooksView key={data.workspace.id} snapshot={data} />
                    }
                  />
                  <Route
                    path="/secrets"
                    element={
                      <SecretsView key={data.workspace.id} snapshot={data} />
                    }
                  />
                  <Route
                    path="/monitoring"
                    element={
                      <MonitoringView key={data.workspace.id} snapshot={data} />
                    }
                  />
                  <Route
                    path="/settings/*"
                    element={
                      <SettingsView
                        snapshot={data}
                        record={preferences}
                        onSaved={(record) =>
                          queryClient.setQueryData<Session>(
                            ["session"],
                            (prior) =>
                              prior ? { ...prior, preferences: record } : prior,
                          )
                        }
                      />
                    }
                  />
                  <Route
                    path="/"
                    element={<Navigate replace to={"/overview" + suffix} />}
                  />
                  <Route
                    path="*"
                    element={
                      <section className="settings-card navigation-recovery">
                        <h1>Page not found</h1>
                        <p>
                          This link does not match an HQ page. Your workspace is
                          still available.
                        </p>
                        <div className="navigation-recovery-links">
                          <Button asChild>
                            <NavLink to={"/overview" + suffix}>
                              Open overview
                            </NavLink>
                          </Button>
                          <Button variant="outline" asChild>
                            <NavLink to={"/projects" + suffix}>
                              Browse projects
                            </NavLink>
                          </Button>
                        </div>
                      </section>
                    }
                  />
                </Routes>
              </Suspense>
            ) : null}
            <footer className="workspace-footer">
              <span>
                Maintainer HQ <span aria-hidden="true">/</span> Work worth
                keeping track of.
              </span>
              <span>
                {data?.development
                  ? "Development workspace"
                  : "Workspace-scoped access"}
                <span aria-hidden="true">/</span>
                <a
                  aria-label="Source code (opens in a new tab)"
                  href={SOURCE_REPOSITORY_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  Source
                  <ArrowUpRight aria-hidden="true" size={12} />
                </a>
              </span>
            </footer>
          </main>
        </div>
      </div>
    </DateTimeContext.Provider>
  );
}
