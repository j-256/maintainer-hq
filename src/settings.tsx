import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FileInput,
  FolderGit2,
  Laptop,
  Users,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import type { PreferenceRecord } from "../shared/preferences";
import { SETTINGS_SECTIONS } from "../shared/settings-navigation";
import { Button } from "./components/ui/button";
import "./settings.css";

const MembershipSettings = lazy(() =>
  import("./membership").then((module) => ({
    default: module.MembershipSettings,
  })),
);
const AutomationSettings = lazy(() =>
  import("./automation").then((module) => ({
    default: module.AutomationSettings,
  })),
);
const GitHubSources = lazy(() =>
  import("./github-sources").then((module) => ({
    default: module.GitHubSources,
  })),
);
const SourceSettings = lazy(() =>
  import("./sources").then((module) => ({ default: module.SourceSettings })),
);
const ImportSettings = lazy(() =>
  import("./import").then((module) => ({ default: module.ImportSettings })),
);
const PreferenceSummary = lazy(() =>
  import("./preferences").then((module) => ({
    default: module.PreferenceSummary,
  })),
);
const PreferenceSettings = lazy(() =>
  import("./preferences").then((module) => ({
    default: module.PreferenceSettings,
  })),
);
const TASK_ICONS = {
  members: Users,
  automation: Bot,
  github: FolderGit2,
  publishers: Laptop,
  import: FileInput,
};
const TASKS = SETTINGS_SECTIONS.filter(
  (section) => section.id !== "preferences",
);
const GROUPS = [...new Set(TASKS.map((section) => section.group))];

function SettingsHome({ snapshot }: { snapshot: Snapshot }) {
  const suffix = "?workspace=" + encodeURIComponent(snapshot.workspace.id);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE</div>
          <h1>Settings</h1>
          <p>Manage access, evidence sources, and your preferences.</p>
        </div>
      </div>
      <div className="settings-index">
        {GROUPS.map((group) => (
          <section className="settings-group" key={group}>
            <h2>{group}</h2>
            <ul>
              {TASKS.filter((section) => section.group === group).map(
                (section) => {
                  const Icon = TASK_ICONS[section.id];
                  return (
                    <li key={section.id}>
                      <Link to={"/settings/" + section.id + suffix}>
                        <Icon size={20} aria-hidden="true" />
                        <span>
                          <strong>{section.label}</strong>
                          <span>{section.description}</span>
                        </span>
                        <ArrowRight size={17} aria-hidden="true" />
                      </Link>
                    </li>
                  );
                },
              )}
            </ul>
          </section>
        ))}
        <PreferenceSummary workspaceId={snapshot.workspace.id} />
      </div>
      <section
        className="settings-provider-links"
        aria-labelledby="provider-settings-title"
      >
        <h2 id="provider-settings-title">Provider connections</h2>
        <div>
          <Link to={"/hooks" + suffix}>Hooks</Link>
          <Link to={"/monitoring" + suffix}>Monitoring</Link>
          <Link
            to={
              "/secrets" +
              suffix +
              (snapshot.capabilities.includes(CAPABILITY.ADMIN)
                ? "&view=providers"
                : "")
            }
          >
            Secrets
          </Link>
        </div>
      </section>
      <details className="settings-access-summary">
        <summary>Your account in this workspace</summary>
        <dl>
          <div>
            <dt>Workspace</dt>
            <dd>{snapshot.workspace.name}</dd>
          </div>
          <div>
            <dt>Signed in as</dt>
            <dd>{snapshot.principal.displayName}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{snapshot.workspace.role}</dd>
          </div>
        </dl>
      </details>
    </>
  );
}

function SettingsTask({
  snapshot,
  children,
}: {
  snapshot: Snapshot;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => {
    const heading = root.current?.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [location.pathname, snapshot.workspace.id]);
  return (
    <div className="settings-task" ref={root}>
      <Link
        className="quiet-link settings-back"
        to={"/settings?workspace=" + encodeURIComponent(snapshot.workspace.id)}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        All settings
      </Link>
      {children}
    </div>
  );
}

export function SettingsView({
  snapshot,
  record,
  onSaved,
}: {
  snapshot: Snapshot;
  record: PreferenceRecord;
  onSaved: (record: PreferenceRecord) => void;
}) {
  return (
    <Suspense fallback={<p role="status">Opening settings...</p>}>
      <Routes>
        <Route index element={<SettingsHome snapshot={snapshot} />} />
        <Route
          path="members"
          element={
            <SettingsTask snapshot={snapshot}>
              <MembershipSettings
                key={snapshot.workspace.id}
                snapshot={snapshot}
              />
            </SettingsTask>
          }
        />
        <Route
          path="automation"
          element={
            <SettingsTask snapshot={snapshot}>
              <AutomationSettings
                key={snapshot.workspace.id}
                snapshot={snapshot}
              />
            </SettingsTask>
          }
        />
        <Route
          path="github"
          element={
            <SettingsTask snapshot={snapshot}>
              <GitHubSources key={snapshot.workspace.id} snapshot={snapshot} />
            </SettingsTask>
          }
        />
        <Route
          path="publishers"
          element={
            <SettingsTask snapshot={snapshot}>
              <SourceSettings key={snapshot.workspace.id} snapshot={snapshot} />
            </SettingsTask>
          }
        />
        <Route
          path="import"
          element={
            <SettingsTask snapshot={snapshot}>
              <ImportSettings key={snapshot.workspace.id} snapshot={snapshot} />
            </SettingsTask>
          }
        />
        <Route
          path="preferences"
          element={
            <PreferenceSettings
              key={snapshot.principal.subject}
              snapshot={snapshot}
              record={record}
              onSaved={onSaved}
            />
          }
        />
        <Route
          path="*"
          element={
            <SettingsTask snapshot={snapshot}>
              <section className="settings-card navigation-recovery">
                <h1>Page not found</h1>
                <p>This settings page is not available.</p>
                <Button asChild>
                  <Link
                    to={
                      "/settings?workspace=" +
                      encodeURIComponent(snapshot.workspace.id)
                    }
                  >
                    Open settings
                  </Link>
                </Button>
              </section>
            </SettingsTask>
          }
        />
      </Routes>
    </Suspense>
  );
}
