import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import { HOOK_LIFECYCLE_EVENTS, lifecyclePlanInput, type LifecycleChange, type LifecycleConfiguration, type LifecycleReview } from "../shared/hook-lifecycle";
import type { HookConnection, HookResult } from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { HookError, HookTime, restoreHookFocus } from "./hook-components";
import { LifecyclePrivateInput } from "./hook-lifecycle-private";
import "./hook-lifecycle.css";

const REQUEST_TIMEOUT_MS = 30000;
type Destination = HookResult<"configuration_sinks">["items"][number];
export function HookLifecycleDialog({ snapshot, connection, planId, resourceId, returnFocus, onReview, onBack, onClose }: { snapshot: Snapshot; connection: HookConnection; planId: string | null; resourceId: string | null; returnFocus: HTMLElement | null; onReview: (id: string) => void; onBack: () => void; onClose: () => void }) {
  const workspaceId = snapshot.workspace.id; const client = useQueryClient();
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState(""); const [type, setType] = useState<"ntfy" | "discord" | "webhook">("ntfy");
  const [repository, setRepository] = useState(""); const [hookId, setHookId] = useState(""); const [events, setEvents] = useState<string[]>(["push"]); const [active, setActive] = useState(true);
  const [cursors, setCursors] = useState<(string | null)[]>([null]); const cursor = cursors.at(-1) ?? null;
  const attempt = useRef<{ serialized: string; id: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const configuration = useQuery({ queryKey: ["hooks", workspaceId, "lifecycle-configuration", connection.id, connection.revision], queryFn: ({ signal }) => command<LifecycleConfiguration>("hooks_lifecycle_configuration", { workspaceId, connectionId: connection.id }, signal), retry: false, staleTime: 0 });
  const config = configuration.data;
  const key = ["hooks", workspaceId, "lifecycle-review", planId];
  const saved = useQuery({ queryKey: key, queryFn: ({ signal }) => command<LifecycleReview>("hooks_lifecycle_get", { workspaceId, planId }, signal), enabled: Boolean(planId), retry: false, staleTime: 0 });
  const review = saved.data;
  const destinations = useQuery({ queryKey: ["hooks", workspaceId, "lifecycle-destinations", connection.id, config?.authorityId, config?.revision, cursor], queryFn: ({ signal }) => command<{ result: HookResult<"configuration_sinks"> }>("hooks_policy_destinations", { workspaceId, connectionId: connection.id, authorityId: config!.authorityId, revision: config!.revision, cursor }, signal), enabled: !planId && !resourceId && config?.mode === "active", retry: false });
  const detail = useQuery({ queryKey: ["hooks", workspaceId, "lifecycle-subscription", connection.id, resourceId], queryFn: ({ signal }) => command<{ result: HookResult<"configuration_subscription"> }>("hooks_policy_subscription", { workspaceId, connectionId: connection.id, resourceId }, signal), enabled: Boolean(resourceId && !planId), retry: false, staleTime: 0 });
  const expired = Boolean(review && Date.parse(review.expiresAt) <= now);
  const uncertain = review?.operation && ["pending", "running", "partial", "indeterminate"].includes(review.operation.status);
  async function prepare(change: LifecycleChange) {
    if (!config || busy || !canOperate) return;
    setBusy(true); setError(null);
    try {
      const fields = { workspaceId, connectionId: connection.id, connectionRevision: connection.revision, authorityId: config.authorityId, revision: config.revision, change };
      const serialized = JSON.stringify(fields); if (attempt.current?.serialized !== serialized) attempt.current = { serialized, id: crypto.randomUUID() };
      const result = await command<LifecycleReview>("hooks_lifecycle_plan", lifecyclePlanInput.parse({ ...fields, planId: attempt.current.id }), AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      client.setQueryData(["hooks", workspaceId, "lifecycle-review", result.id], result); onReview(result.id);
    } catch (failure) { setError(failure instanceof Error && !("status" in failure) ? new Error("Check the destination, repository, hook ID and supported event selection. Refresh saved state if it changed.") : failure); }
    finally { setBusy(false); }
  }
  async function act(reconcile: boolean) {
    if (busy || !review) return;
    setBusy(true); setError(null);
    try {
      const result = await command<LifecycleReview>(reconcile ? "hooks_lifecycle_reconcile" : "hooks_lifecycle_apply", { workspaceId, planId: review.id, ...(!reconcile ? { fingerprint: review.fingerprint } : {}) }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      client.setQueryData(key, result); void client.invalidateQueries({ queryKey: ["hooks", workspaceId] });
    } catch (failure) { setError(failure); void saved.refetch(); }
    finally { setBusy(false); }
  }
  function destinationActions(item: Destination) {
    return <div className="lifecycle-actions">
      <Button variant="outline" disabled={busy || !canOperate || !config?.canProvision} onClick={() => void prepare({ kind: item.retired ? "destination-restore" : "destination-retire", resourceId: item.resourceId })}>{item.retired ? "Review restoration" : "Review retirement"}</Button>
      {!item.retired ? <Button variant="outline" disabled={busy || !canOperate || !config?.canProvision || !config.canSupplyPrivate || !["discord", "ntfy", "webhook"].includes(item.type)} onClick={() => void prepare({ kind: "destination-update", resourceId: item.resourceId, replaceCredentials: true })}>Replace private configuration</Button> : null}
    </div>;
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="lifecycle-dialog" onCloseAutoFocus={event => { event.preventDefault(); restoreHookFocus(returnFocus); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>{planId ? "Review lifecycle change" : resourceId ? "Subscription lifecycle" : "Manage destinations"}</DialogTitle><DialogDescription>{planId ? "Confirm the exact metadata review. Configuration, upstream changes, and delivery evidence have separate outcomes." : resourceId ? "Manage this subscription and its owned upstream GitHub hook through separate reviewed actions." : "Create and manage notification destinations without exposing private credentials in routing metadata."}</DialogDescription></DialogHeader>
    {!canOperate ? <p className="permission-notice">Your role can read this view. An owner or operator must review, apply, or supply destination input.</p> : null}
    {error ? error instanceof Error && !("status" in error) ? <p role="alert">{error.message}</p> : <HookError error={error} /> : null}
    {planId ? <>
      {saved.isPending ? <p role="status">Loading saved review...</p> : null}{saved.error ? <HookError error={saved.error} /> : null}
      {review ? <>
        <dl className="lifecycle-summary"><dt>Change</dt><dd>{review.change.kind}</dd><dt>Connection</dt><dd>{review.connectionName}</dd><dt>Resource</dt><dd>{review.after?.name ?? review.before?.name}</dd><dt>Resource ID</dt><dd><code>{review.after?.resourceId ?? review.before?.resourceId}</code></dd><dt>Authority</dt><dd><code>{review.authorityId}</code>, revision {review.revision}</dd><dt>Expires</dt><dd><HookTime value={review.expiresAt} /></dd></dl>
        <div className="lifecycle-comparison">{(["before", "after"] as const).map(side => <section key={side}><h3>{side === "before" ? "Before" : "After"}</h3>{review[side] ? <dl className="lifecycle-state">{Object.entries(review[side]!).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>)}</dl> : <p>No resource</p>}</section>)}</div>
        {review.affectedSubscriptions.length ? <section><h3>Affected subscriptions</h3><ul>{review.affectedSubscriptions.map(item => <li key={item.resourceId}>{item.name} <code>{item.resourceId}</code></li>)}</ul><p>Destination retirement is refused while enabled subscriptions select it. Remove those destinations through Edit routing, then review again.</p></section> : null}
        {review.change.kind === "subscription-retire" ? <p>Retiring this subscription preserves history and pending deliveries. It does not delete its upstream GitHub hook.</p> : null}
        {review.change.kind === "subscription-restore" ? <p>Restoration keeps the subscription disabled until a separate routing review enables future ingress. Retained events are not replayed.</p> : null}
        {review.change.kind === "github-hook-delete" ? <p className="hook-notice">This explicitly deletes the exact owned upstream GitHub hook. Subscription history and retained deliveries remain available.</p> : null}
        {review.change.kind === "github-hook-adopt" ? <p>Adoption requires current numeric repository authority and an exact HTTPS receiver match. Signing remains unverified until an authenticated ping is observed.</p> : null}
        {review.privateInputRequired && !review.privateInputReceived && !review.operation && !expired && review.state === "ready" && review.actorMatches && canOperate ? <LifecyclePrivateInput key={workspaceId + "/" + review.id} review={review} onSubmitted={() => void saved.refetch()} /> : null}
        {review.privateInputReceived ? <p role="status">Private input received. Supplied values are never returned or compared by this receipt.</p> : null}
        {review.operation ? <p role="status" className="hook-notice">{review.operation.summary}</p> : null}
        {review.outcome ? <p>Configuration: {review.outcome.configuration}. Upstream: {review.outcome.upstream}.{review.outcome.errorCode ? " Provider result: " + review.outcome.errorCode + "." : ""}</p> : null}
        {expired && !review.operation ? <p>This review expired. Refresh the resource and prepare a new review.</p> : null}
        {!review.actorMatches ? <p>Only the original actor and credential may apply or reconcile this review.</p> : null}
        <div className="lifecycle-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Close {review.operation ? "receipt" : "review"}</Button>
          {!review.operation ? <Button variant="outline" disabled={busy} onClick={onBack}>Back to management</Button> : null}
          {canOperate && review.actorMatches && !review.operation ? <Button disabled={busy || expired || review.state !== "ready" || review.privateInputRequired && !review.privateInputReceived || review.change.kind === "destination-retire" && review.affectedSubscriptions.length > 0} onClick={() => void act(false)}>{busy ? "Applying..." : "Apply lifecycle change"}</Button> : null}
          {canOperate && review.actorMatches && (uncertain || review.privateInputRequired && !review.operation) ? <Button variant="outline" disabled={busy} onClick={() => void act(true)}>{busy ? "Reconciling..." : "Reconcile saved receipt"}</Button> : null}
        </div>
      </> : null}
    </> : <>
      {configuration.isPending ? <p role="status">Checking lifecycle capabilities...</p> : null}{configuration.error ? <HookError error={configuration.error} /> : null}
      {config && config.reason !== "ready" ? <p role="status" className="permission-notice">{config.reason === "inactive" ? "Online configuration is inactive. Ask the deployment owner to activate it." : config.reason === "custody_required" ? "Private destination custody is unavailable. Ask the deployment owner to restore its wrapping keyring." : "The provider credential needs lifecycle grants. Ask the deployment owner to grant the required bounded capabilities."}</p> : null}
      <Button variant="outline" disabled={busy || configuration.isFetching} onClick={() => { setCursors([null]); void configuration.refetch(); void detail.refetch(); void destinations.refetch(); }}>Refresh saved state</Button>
      {resourceId ? <>
        {detail.error ? <HookError error={detail.error} /> : null}{detail.isPending ? <p role="status">Reading subscription...</p> : null}
        {detail.data ? <p><strong>{detail.data.result.name}</strong> {detail.data.result.retired ? "(Retired)" : ""} <code>{resourceId}</code></p> : null}
        <section><h3>Subscription</h3><p>Retirement preserves retained deliveries and history. Upstream hook deletion is a separate action.</p><div className="lifecycle-actions"><Button variant="outline" disabled={busy || !canOperate || !config?.canConfigure || !detail.data || Boolean(detail.data.result.retired)} onClick={() => void prepare({ kind: "subscription-retire", resourceId })}>Review subscription retirement</Button><Button variant="outline" disabled={busy || !canOperate || !config?.canConfigure || !detail.data || !detail.data.result.retired} onClick={() => void prepare({ kind: "subscription-restore", resourceId })}>Review subscription restoration</Button></div></section>
        <section><h3>Owned GitHub hook</h3><p>The provider checks ownership and current repository authority. Receiver credentials remain in custody. GitHub's redacted secret cannot establish signing verification.</p>
          {!config?.canManageHooks ? <p>Upstream management needs the provider grant and a ready GitHub App or scoped token.</p> : null}
          <form onSubmit={event => { event.preventDefault(); void prepare({ kind: "github-hook-adopt", resourceId, repository, hookId: Number(hookId) }); }}><fieldset disabled={busy || !canOperate || !config?.canManageHooks}><legend>Adopt an existing hook</legend><label htmlFor="lifecycle-repository">Repository (owner/name)</label><Input id="lifecycle-repository" required value={repository} onChange={event => setRepository(event.target.value)} /><label htmlFor="lifecycle-hook-id">Numeric GitHub hook ID</label><Input id="lifecycle-hook-id" required inputMode="numeric" value={hookId} onChange={event => setHookId(event.target.value)} /><Button type="submit" variant="outline">Review hook adoption</Button></fieldset></form>
          <form onSubmit={event => { event.preventDefault(); void prepare({ kind: "github-hook-update", resourceId, events: events as (typeof HOOK_LIFECYCLE_EVENTS)[number][], active }); }}><fieldset disabled={busy || !canOperate || !config?.canManageHooks}><legend>Update the owned hook</legend><div className="lifecycle-events">{HOOK_LIFECYCLE_EVENTS.map(value => <label key={value}><input type="checkbox" checked={events.includes(value)} onChange={event => setEvents(event.target.checked ? [...events, value] : events.filter(item => item !== value))} />{value}</label>)}</div><label><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /> Active upstream hook</label><Button type="submit" variant="outline" disabled={!events.length}>Review hook update</Button></fieldset></form>
          <Button variant="outline" disabled={busy || !canOperate || !config?.canManageHooks} onClick={() => void prepare({ kind: "github-hook-delete", resourceId })}>Review upstream hook deletion</Button>
        </section>
      </> : <>
        <section><h3>New destination</h3><form onSubmit={event => { event.preventDefault(); void prepare({ kind: "destination-create", name, type }); }}><fieldset disabled={busy || !canOperate || !config?.canProvision || !config.canSupplyPrivate}><label htmlFor="lifecycle-name">Destination name</label><Input id="lifecycle-name" required maxLength={160} value={name} onChange={event => setName(event.target.value)} /><label htmlFor="lifecycle-type">Destination type</label><select id="lifecycle-type" value={type} onChange={event => setType(event.target.value as typeof type)}><option value="ntfy">ntfy</option><option value="discord">Discord</option><option value="webhook">Webhook</option></select><p>Private URLs and credentials are supplied after metadata review.</p><Button type="submit">Review destination</Button></fieldset></form></section>
        <section><h3>Saved destinations</h3>{destinations.error ? <HookError error={destinations.error} /> : null}{destinations.isFetching ? <p role="status">Reading destination metadata...</p> : null}{destinations.data ? <><ul className="lifecycle-destinations">{destinations.data.result.items.map(item => <li key={item.resourceId}><div><strong>{item.name}</strong><p>{item.type} / {item.retired ? "Retired" : "Active"}</p><code>{item.resourceId}</code></div>{destinationActions(item)}</li>)}</ul>{!destinations.data.result.items.length ? <p>No destinations on this page. Create one above.</p> : null}<div className="lifecycle-actions"><Button variant="outline" disabled={cursors.length <= 1 || destinations.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>Previous destinations</Button><Button variant="outline" disabled={!destinations.data.result.nextCursor || destinations.isFetching} onClick={() => setCursors([...cursors, destinations.data!.result.nextCursor])}>Next destinations</Button></div></> : null}</section>
      </>}
      <Button variant="outline" disabled={busy} onClick={onClose}>Close management</Button>
    </>}
  </DialogContent></Dialog>;
}
