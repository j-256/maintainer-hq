import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Repository, Snapshot } from "../shared/domain";
import type { HookConnection } from "../shared/hooks";
import type { HookGitHubInventory } from "../shared/hook-setup";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { HookError, HookTime } from "./hook-components";

export function HookGitHubInventory({ snapshot, connection, repository, onReady }: {
  snapshot: Snapshot;
  connection: HookConnection;
  repository: Repository;
  onReady: (ready: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["hooks", snapshot.workspace.id, "github-inventory", snapshot.principal.subject,
      snapshot.capabilities.join(","), connection.id, connection.revision, repository.id, repository.revision, page],
    queryFn: ({ signal }) => command<HookGitHubInventory>("hooks_github_inventory", {
      workspaceId: snapshot.workspace.id, connectionId: connection.id, repositoryId: repository.id, page,
    }, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  useEffect(() => { onReady(query.isSuccess && !query.isFetching); }, [query.isSuccess, query.isFetching, onReady]);
  const data = query.error ? undefined : query.data;
  return <section className="hook-resolution-stack" aria-label="Existing GitHub webhooks">
    <h3>Existing GitHub webhooks</h3>
    <p>Read from GitHub using the configured repository access. Private receiver URLs are hidden.</p>
    {query.isFetching ? <p role="status">Reading GitHub webhooks...</p> : null}
    {query.error ? <><HookError error={query.error} /><Button type="button" variant="outline" onClick={() => void query.refetch()}>Retry GitHub hooks</Button></> : null}
    {data ? <>
      {data.items.map(hook => <article className="hook-resolution-subscription" key={hook.id}>
        <h4>Webhook #{hook.id}</h4>
        <p>{hook.active ? "Active" : "Disabled"}</p>
        <p className="break-words">Events: {hook.events.join(", ") || "None"}</p>
      </article>)}
      {!data.items.length ? <p>No GitHub webhooks found on this page.</p> : null}
      {data.limited ? <p role="status">GitHub webhook discovery reached its page limit. This inventory is incomplete.</p> : null}
      <p className="hook-muted">Page {data.page}. Observed <HookTime value={data.observedAt} />.</p>
    </> : null}
    {data || page > 1 ? <div className="hook-resolution-actions">
        <Button type="button" variant="outline" disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}>Previous GitHub hooks</Button>
        {data ? <>
        <Button type="button" variant="outline" disabled={data.nextPage === null || query.isFetching} onClick={() => { if (data.nextPage !== null) setPage(data.nextPage); }}>Next GitHub hooks</Button>
        <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh GitHub hooks</Button>
        </> : null}
      </div> : null}
  </section>;
}
