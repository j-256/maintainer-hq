import {
  SYNC_COLLECTIONS,
  SYNC_CAPACITY,
  VIEW_COLLECTIONS,
  sameScope,
  syncKey,
  type SyncScope,
  type SyncUpdate,
  type WorkspaceView,
} from "../../shared/workspace-sync";
import { isOpenGoal } from "../../shared/goals";
import { settingsSection } from "../../shared/settings-navigation";
import {
  normalizeAppPathname,
  resourceIdFromPath,
} from "../../shared/app-pathname";

export type CachedWorkspaceView = WorkspaceView & { resync?: boolean };

export function routeScope(
  pathname: string,
  section: string | null,
): SyncScope {
  pathname = normalizeAppPathname(pathname);
  const settings = settingsSection(pathname);
  if (settings) return { view: settings.view };
  if (pathname === "/settings" || pathname === "/settings/")
    return { view: "workspace" };
  const projectPath = /^\/projects(?:\/([^/]+))?$/.exec(pathname);
  if (projectPath?.[1] && !resourceIdFromPath(projectPath[1]))
    return { view: "workspace" };
  if (projectPath)
    return {
      view:
        section === "dependencies" ? "projects-dependencies" : section === "activity"
          ? "projects-activity"
          : section === "hooks"
            ? "projects-hooks"
            : section === "monitoring"
              ? "projects-monitoring"
              : section === "releases"
                ? "projects-releases"
                : section === "secrets"
                  ? "projects-secrets"
                  : "projects",
    };
  const repositoryPath = /^\/repositories\/([^/]+)$/.exec(pathname)?.[1];
  const repositoryId = repositoryPath
    ? resourceIdFromPath(repositoryPath)
    : undefined;
  if (repositoryPath && !repositoryId) return { view: "workspace" };
  if (repositoryId)
    return {
      view:
        section === "dependencies" ? "repository-dependencies" : section === "work"
          ? "repository-work"
          : section === "activity"
            ? "repository-activity"
            : section === "hooks"
              ? "repository-hooks"
              : section === "monitoring"
                ? "repository-monitoring"
                : section === "releases"
                  ? "repository-releases"
                  : section === "secrets"
                    ? "repository-secrets"
                    : "repository",
      repositoryId,
    };
  return {
    view:
      pathname === "/dependencies" ? "dependencies" : pathname === "/repositories"
        ? "repositories"
        : pathname === "/overview" || pathname === "/"
          ? "overview"
          : pathname === "/hooks"
            ? "hooks"
            : pathname === "/monitoring"
              ? "monitoring"
              : pathname === "/secrets"
                ? "secrets"
                : pathname === "/activity"
                  ? "activity"
                  : "workspace",
  };
}

export function applyViewUpdate(
  prior: CachedWorkspaceView,
  scope: SyncScope,
  update: SyncUpdate,
): CachedWorkspaceView {
  if (!sameScope(prior.scope, scope)) return prior;
  if (update.type === "reset") return { ...prior, resync: true };
  if (prior.resync || update.cursor <= prior.cursor) return prior;
  if (update.from > prior.cursor) return { ...prior, resync: true };
  const allowed = VIEW_COLLECTIONS[scope.view];
  if (
    Object.keys(update.upserts).some(
      (key) => !allowed.includes(key as (typeof SYNC_COLLECTIONS)[number]),
    ) ||
    update.removals.some(({ collection }) => !allowed.includes(collection)) ||
    update.upserts.repositories?.some(
      (record) => record.workspaceId !== prior.workspace.id,
    ) ||
    update.upserts.projects?.some(
      (record) => record.workspaceId !== prior.workspace.id,
    )
  )
    return { ...prior, resync: true };
  const records = { ...prior.records };
  for (const collection of SYNC_COLLECTIONS) {
    const upserts = update.upserts[collection] ?? [];
    const removals = update.removals.filter(
      (item) => item.collection === collection,
    );
    if (!upserts.length && !removals.length) continue;
    const values = new Map(
      (records[collection] ?? []).map((record) => [
        syncKey(collection, record),
        record,
      ]),
    );
    for (const { key } of removals) values.delete(key);
    for (const record of upserts)
      values.set(syncKey(collection, record), record);
    if (values.size > SYNC_CAPACITY[collection])
      return { ...prior, resync: true };
    // Each collection keeps its domain type; the discriminant selects the matching array
    Object.assign(records, { [collection]: [...values.values()] });
  }
  return {
    ...prior,
    records,
    cursor: update.cursor,
    generatedAt: update.generatedAt,
  };
}

export function sortView(view: CachedWorkspaceView): CachedWorkspaceView {
  const records = { ...view.records };
  if (records.repositories)
    records.repositories = [...records.repositories].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    );
  if (records.projects)
    records.projects = [...records.projects].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  if (records.connections)
    records.connections = [...records.connections].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  if (records.observations)
    records.observations = [...records.observations].sort(
      (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
    );
  if (records.goals)
    records.goals = [...records.goals].sort(
      (a, b) =>
        Number(isOpenGoal(b.status)) - Number(isOpenGoal(a.status)) ||
        Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
        b.id.localeCompare(a.id),
    );
  return { ...view, records };
}
