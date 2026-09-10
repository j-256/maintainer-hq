import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { idSchema, type Snapshot } from "../shared/domain";
import type { DepartedResourceContext } from "../shared/project-transfers";
import { command } from "./lib/api";
import { ActivityView } from "./activity";
import { Button } from "./components/ui/button";
import { HookError } from "./hook-components";
import { useDateTime } from "./date-time";

const REQUEST_MS = 15_000;

export function DepartedResource({
  snapshot,
  kind,
  resourceId,
}: {
  snapshot: Snapshot;
  kind: "project" | "repository";
  resourceId: string;
}) {
  const [params] = useSearchParams();
  const dates = useDateTime();
  const validId = idSchema.safeParse(resourceId).success;
  const context = useQuery({
    queryKey: ["departed-resource", snapshot.workspace.id, kind, resourceId],
    queryFn: ({ signal }) =>
      command<DepartedResourceContext | null>(
        "departed_resource_context",
        { workspaceId: snapshot.workspace.id, kind, resourceId },
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      ),
    retry: false,
    enabled: validId,
  });
  const label = kind === "project" ? "Project" : "Repository";
  const collection = kind === "project" ? "projects" : "repositories";
  const data = !context.error ? context.data : null;
  const activityParams = new URLSearchParams(params);
  activityParams.delete("transfer");
  activityParams.set("section", "activity");
  return (
    <>
      <Link
        className="back-link"
        to={
          "/" +
          collection +
          "?" +
          new URLSearchParams({ workspace: snapshot.workspace.id })
        }
      >
        <ArrowLeft size={16} /> Back to {collection}
      </Link>
      {!validId ? (
        <section className="empty-state">
          <h1 tabIndex={-1}>Invalid {kind} link</h1>
          <p>
            This link does not contain a valid {kind} ID. Open the {collection}{" "}
            list to find it.
          </p>
        </section>
      ) : context.error ? (
        <section className="detail-card">
          <h1>Could not load {kind} history</h1>
          <HookError error={context.error} />
          <Button
            variant="outline"
            disabled={context.isFetching}
            onClick={() => void context.refetch()}
          >
            Try again
          </Button>
        </section>
      ) : context.isPending ? (
        <p role="status">Checking {kind} history...</p>
      ) : data ? (
        <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">HISTORICAL {kind.toUpperCase()}</div>
              <h1 tabIndex={-1}>{data.name}</h1>
              <p>
                This {kind} moved out of {snapshot.workspace.name} on{" "}
                {dates.dateTime(data.movedAt)}.
              </p>
            </div>
          </div>
          <p className="permission-notice">
            <ArrowRightLeft size={18} /> This is the original workspace's
            read-only history, not the {kind}'s current state. Membership in
            another workspace is required to view its current metadata. No
            destination or destination access is disclosed here.
          </p>
          {params.get("section") === "activity" ? (
            <ActivityView
              snapshot={snapshot}
              readOnly
              scopedProjectId={kind === "project" ? resourceId : undefined}
              scopedRepositoryId={
                kind === "repository" ? resourceId : undefined
              }
            />
          ) : (
            <Button asChild variant="outline">
              <Link to={"?" + activityParams}>View retained Activity</Link>
            </Button>
          )}
        </>
      ) : (
        <div className="empty-state">
          <h1>{label} not found</h1>
          <p>
            No current metadata or retained transfer context is available in
            this workspace.
          </p>
        </div>
      )}
    </>
  );
}
