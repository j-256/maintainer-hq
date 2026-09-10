import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Link2,
  Monitor,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { CAPABILITY, type Project, type Snapshot } from "../shared/domain";
import type {
  ProjectResource,
  ProjectResourceKind,
  ProjectResources,
} from "../shared/project-resources";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { HookError } from "./hook-components";
import { ResourceProjectEditor } from "./resource-project";
import { projectListContext } from "./project-inventory";

const RESOURCE_VIEWS = {
  hook: {
    path: "/hooks",
    section: "subscriptions",
    label: "Hooks",
    Icon: Webhook,
  },
  monitor: {
    path: "/monitoring",
    section: "targets",
    label: "Monitoring",
    Icon: Monitor,
  },
  secret: {
    path: "/secrets",
    section: "inventory",
    label: "Secrets",
    Icon: KeyRound,
  },
} as const;
export function projectResourceHref(
  workspaceId: string,
  projectId: string,
  resource: Pick<ProjectResource, "kind" | "connectionId" | "resourceKey">,
  context?: URLSearchParams,
) {
  const params = new URLSearchParams({
    workspace: workspaceId,
    project: projectId,
    connection: resource.connectionId,
  });
  if (context) params.set("projectList", projectListContext(context));
  if (resource.kind === "hook") {
    params.set("view", "deliveries");
    params.set("subscription", resource.resourceKey);
  } else if (resource.kind === "monitor")
    params.set("target", resource.resourceKey);
  else {
    params.set("view", "inventory");
    params.set("resource", resource.resourceKey);
  }
  return RESOURCE_VIEWS[resource.kind].path + "?" + params;
}
export function ProjectResourcesView({
  snapshot,
  project,
  kind,
}: {
  snapshot: Snapshot;
  project: Project;
  kind: ProjectResourceKind;
}) {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const [cursors, setCursors] = useState<ProjectResources["nextCursor"][]>([
    null,
  ]);
  const [editing, setEditing] = useState<ProjectResource | null>(null);
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: [
      "project-resources",
      snapshot.workspace.id,
      project.id,
      kind,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<ProjectResources>(
        "project_resources",
        {
          workspaceId: snapshot.workspace.id,
          projectId: project.id,
          kind,
          cursor,
        },
        signal,
      ),
    staleTime: 30000,
    retry: false,
  });
  const { label, Icon, path, section } = RESOURCE_VIEWS[kind];
  const browse =
    path +
    "?" +
    new URLSearchParams({
      workspace: snapshot.workspace.id,
      project: project.id,
      view: section,
      projectList: projectListContext(params),
    });
  function page(next: ProjectResources["nextCursor"][]) {
    setCursors(next);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }
  function refresh() {
    if (cursor) {
      void client.invalidateQueries({
        queryKey: [
          "project-resources",
          snapshot.workspace.id,
          project.id,
          kind,
          null,
        ],
      });
      page([null]);
    } else void query.refetch();
  }
  return (
    <section
      className="repository-resources"
      aria-label={"Project " + label.toLowerCase()}
    >
      <div className="resource-section-heading">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {label}
          </h2>
          <p>
            Resources linked directly to this project or through its
            repositories. Connection context alone does not include resources.
          </p>
        </div>
        <div className="resource-actions">
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={refresh}
          >
            <RefreshCw size={16} /> Refresh
          </Button>
          <Button variant="outline" asChild>
            <Link to={browse}>
              <Link2 size={16} /> Browse and link
            </Link>
          </Button>
        </div>
      </div>
      {notice ? (
        <p role="status" className="save-notice">
          {notice}
        </p>
      ) : null}
      {query.error ? <HookError error={query.error} /> : null}
      {query.isPending ? (
        <p role="status">Loading project resources...</p>
      ) : null}
      {query.data ? (
        <>
          <div className="repository-resource-grid">
            {query.data.items.map((resource) => (
              <article
                className="repository-resource-card"
                key={JSON.stringify([
                  resource.kind,
                  resource.connectionId,
                  resource.resourceKey,
                ])}
              >
                <div className="resource-card-heading">
                  <Icon size={20} />
                  <h3>
                    <Link
                      to={projectResourceHref(
                        snapshot.workspace.id,
                        project.id,
                        resource,
                        params,
                      )}
                    >
                      {resource.label}
                    </Link>
                  </h3>
                </div>
                <p>{resource.connectionName}</p>
                <div className="resource-actions">
                  <Badge variant="outline">
                    {resource.direct ? "Primary project" : "Via repositories"}
                  </Badge>
                  {!resource.connectionEnabled ? (
                    <Badge variant="outline">Connection disabled in HQ</Badge>
                  ) : null}
                </div>
                <p>
                  {resource.repositoryCount} linked{" "}
                  {resource.repositoryCount === 1
                    ? "repository"
                    : "repositories"}{" "}
                  in this project
                  {resource.sharedRepositoryCount
                    ? "; " +
                      resource.sharedRepositoryCount +
                      " outside this project"
                    : ""}
                  .
                </p>
                <p className="hook-muted">
                  {kind === "secret"
                    ? "Enrolled resource metadata only. Open Secrets to inspect provider inventory; values are never shown."
                    : "This link is not a health check. Open the provider view to inspect evidence; a removed resource may still be linked."}
                </p>
                <div className="resource-actions">
                  <Button asChild variant="outline">
                    <Link
                      to={projectResourceHref(
                        snapshot.workspace.id,
                        project.id,
                        resource,
                        params,
                      )}
                    >
                      Open {label.toLowerCase()} <ArrowUpRight size={15} />
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!snapshot.capabilities.includes(CAPABILITY.EDIT)}
                    onClick={(event) => {
                      focus.current = event.currentTarget;
                      setEditing(resource);
                    }}
                  >
                    Project association
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!query.data.items.length ? (
            <div className="empty-state">
              <Icon size={28} />
              <h3>
                {cursor
                  ? "No more linked resources"
                  : "No " + label.toLowerCase() + " linked"}
              </h3>
              <p>
                Browse existing connections to associate a resource with this
                project. Nothing is linked automatically.
              </p>
            </div>
          ) : null}
          <nav
            className="repository-pagination"
            aria-label={label + " project resource pages"}
          >
            <p>Page {cursors.length}</p>
            <Button
              variant="outline"
              disabled={cursors.length === 1 || query.isFetching}
              onClick={() => page(cursors.slice(0, -1))}
            >
              <ChevronLeft size={16} /> Previous
            </Button>
            <Button
              variant="outline"
              disabled={!query.data.nextCursor || query.isFetching}
              onClick={() => page([...cursors, query.data!.nextCursor])}
            >
              Next <ChevronRight size={16} />
            </Button>
          </nav>
        </>
      ) : null}
      {editing ? (
        <ResourceProjectEditor
          reference={{
            workspaceId: snapshot.workspace.id,
            kind,
            connectionId: editing.connectionId,
            resourceKey: editing.resourceKey,
          }}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          onSaved={() =>
            setNotice(
              "Project association saved. Provider configuration is unchanged.",
            )
          }
          returnFocus={focus.current}
        />
      ) : null}
    </section>
  );
}
