import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Link2,
  Monitor,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import type {
  RepositoryResource,
  RepositoryResources,
  ResourceKind,
} from "../shared/resource-links";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { HookError } from "./hook-components";
import { ResourceRepositoriesEditor } from "./resource-repositories";

export function resourceHref(
  workspaceId: string,
  resource: Pick<RepositoryResource, "kind" | "connectionId" | "resourceKey">,
  repositoryId: string,
) {
  const fields = new URLSearchParams({
    workspace: workspaceId,
    connection: resource.connectionId,
    repository: repositoryId,
  });
  if (resource.kind === "hook") {
    fields.set("view", "deliveries");
    fields.set("subscription", resource.resourceKey);
  } else fields.set("target", resource.resourceKey);
  return (resource.kind === "hook" ? "/hooks?" : "/monitoring?") + fields;
}

export function RepositoryResourcesView({
  snapshot,
  repository,
  kind,
}: {
  snapshot: Snapshot;
  repository: Repository;
  kind: ResourceKind;
}) {
  const [cursors, setCursors] = useState<RepositoryResources["nextCursor"][]>([
    null,
  ]);
  const [editing, setEditing] = useState<RepositoryResource | null>(null);
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  const cursor = cursors.at(-1) ?? null;
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  function refresh() {
    if (!cursor) void query.refetch();
    else {
      void client.invalidateQueries({
        queryKey: [
          "repository-resources",
          workspaceId,
          repository.id,
          kind,
          null,
        ],
      });
      setCursors([null]);
    }
  }
  const query = useQuery({
    queryKey: [
      "repository-resources",
      workspaceId,
      repository.id,
      kind,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<RepositoryResources>(
        "repository_resources",
        { workspaceId, repositoryId: repository.id, kind, cursor },
        signal,
      ),
    staleTime: 30000,
  });
  const hooks = kind === "hook";
  const Icon = hooks ? Webhook : Monitor;
  const browse =
    (hooks ? "/hooks?" : "/monitoring?") +
    new URLSearchParams({
      workspace: workspaceId,
      repository: repository.id,
      view: hooks ? "subscriptions" : "targets",
    });
  return (
    <section
      className="repository-resources"
      aria-label={hooks ? "Repository hooks" : "Repository monitoring"}
    >
      <div className="resource-section-heading">
        <div>
          <h2>{hooks ? "Hooks" : "Monitoring"}</h2>
          <p>
            {hooks
              ? "Subscriptions explicitly linked to this repository."
              : "Monitor targets explicitly linked to this repository."}{" "}
            Shared resources appear in every linked repository.
          </p>
        </div>
        <div className="resource-actions">
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={refresh}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh
          </Button>
          <Button asChild variant="outline">
            <Link to={browse}>
              <Link2 size={16} aria-hidden="true" /> Browse and link
            </Link>
          </Button>
        </div>
      </div>
      {query.error ? <HookError error={query.error} /> : null}
      {query.isPending ? (
        <p role="status">Loading linked resources...</p>
      ) : null}
      {notice ? (
        <p role="status" className="save-notice">
          {notice}
        </p>
      ) : null}
      {query.data ? (
        <>
          <div className="repository-resource-grid">
            {query.data.items.map((resource) => (
              <article
                className="repository-resource-card"
                key={JSON.stringify([
                  resource.connectionId,
                  resource.resourceKey,
                ])}
              >
                <div className="resource-card-heading">
                  <Icon size={20} aria-hidden="true" />
                  <h3>
                    <Link
                      to={resourceHref(workspaceId, resource, repository.id)}
                    >
                      {resource.resourceKey}
                    </Link>
                  </h3>
                </div>
                <p>{resource.connectionName}</p>
                <div className="resource-actions">
                  <Badge variant="outline">
                    {resource.connectionEnabled
                      ? "Linked"
                      : "Connection disabled in HQ"}
                  </Badge>
                  {resource.repositoryCount > 1 ? (
                    <Badge variant="secondary">
                      Shared with {resource.repositoryCount - 1} other{" "}
                      {resource.repositoryCount === 2 ? "repo" : "repos"}
                    </Badge>
                  ) : null}
                </div>
                <p className="hook-muted">
                  {resource.connectionEnabled
                    ? "Open to read current provider state. A saved link is not a health check; removed resources may still be linked."
                    : "Provider reads are disabled through this connection. The provider itself has not been paused."}
                </p>
                <div className="resource-actions">
                  <Button asChild variant="outline">
                    <Link
                      to={resourceHref(workspaceId, resource, repository.id)}
                    >
                      {hooks ? "View deliveries" : "Inspect monitor"}
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      focus.current = document.activeElement as HTMLElement;
                      setEditing(resource);
                    }}
                  >
                    {snapshot.capabilities.includes(CAPABILITY.EDIT)
                      ? "Edit repository links"
                      : "Related repositories"}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!query.data.items.length ? (
            <div className="resource-empty">
              <Icon size={28} aria-hidden="true" />
              <h3>No {hooks ? "hooks" : "monitors"} linked yet</h3>
              <p>
                This is an association view, not evidence that the repository
                has no {hooks ? "hooks" : "monitoring"}. Browse the provider's
                resources and choose Related repositories to add the connection
                here.
              </p>
              <Button asChild variant="outline">
                <Link to={browse}>
                  Browse {hooks ? "subscriptions" : "monitor targets"}
                </Link>
              </Button>
            </div>
          ) : null}
          <nav
            className="resource-pagination"
            aria-label="Repository resources pagination"
          >
            <span>Page {cursors.length}</span>
            <div className="resource-actions">
              <Button
                variant="outline"
                disabled={cursors.length === 1 || query.isFetching}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                <ChevronLeft size={16} aria-hidden="true" /> Previous
              </Button>
              <Button
                variant="outline"
                disabled={!query.data.nextCursor || query.isFetching}
                onClick={() => setCursors([...cursors, query.data!.nextCursor])}
              >
                Next <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </nav>
        </>
      ) : null}
      {editing ? (
        <ResourceRepositoriesEditor
          reference={{
            workspaceId,
            kind,
            connectionId: editing.connectionId,
            resourceKey: editing.resourceKey,
          }}
          snapshot={snapshot}
          returnFocus={focus.current}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setCursors([null]);
            setNotice(
              "Repository links saved. Provider configuration is unchanged.",
            );
          }}
        />
      ) : null}
    </section>
  );
}
