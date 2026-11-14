import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import { HANDOFF_PROFILES, handoffPlanInput, handoffConfigurationSchema, normalizeHandoffRepository, type HandoffReview, type HandoffStatus } from "../shared/hook-handoff";
import type { HookConnection, HookResult } from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { HookDestinations } from "./hook-policy-editor";
import { HookError, HookTime, restoreHookFocus } from "./hook-components";
import { HandoffPrivatePanel } from "./hook-handoff-private";
import type { z } from "zod";
import "./hook-handoff.css";

const RECEIVER_LOOKUP_DEBOUNCE_MS = 300;
const PROFILE_EVENTS = Object.freeze({ activity: "push, workflow_run, pull_request", stars: "star", alerts: "code_scanning_alert, dependabot_alert, secret_scanning_alert" });
const PROFILE_LABELS = Object.freeze({ activity: "Activity", stars: "Stars", alerts: "Security alerts" });
type Configuration = z.infer<typeof handoffConfigurationSchema>;
export function HookHandoffDialog({ snapshot, connection, planId, repositoryId, returnFocus, onReview, onBack, onClose }: { snapshot: Snapshot; connection: HookConnection; planId: string | null; repositoryId: string | null; returnFocus: HTMLElement | null; onReview: (id: string) => void; onBack: () => void; onClose: () => void }) {
  const workspaceId = snapshot.workspace.id;
  const owner = snapshot.capabilities.includes(CAPABILITY.SECRETS);
  const contextRepository = snapshot.repositories.find(repository => repository.id === repositoryId);
  const [repository, setRepository] = useState(contextRepository?.fullName ?? "");
  const [projectId, setProjectId] = useState(contextRepository?.projectId ?? snapshot.projects[0]?.id ?? "");
  const [profile, setProfile] = useState<(typeof HANDOFF_PROFILES)[number]>("activity");
  const [sinks, setSinks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  let normalizedRepository: string | null = null;
  try { normalizedRepository = normalizeHandoffRepository(repository); } catch { /* Incomplete repository input does not trigger a provider read */ }
  const [lookupRepository, setLookupRepository] = useState<string | null>(null);
  useEffect(() => {
    const timeout = setTimeout(() => setLookupRepository(normalizedRepository), RECEIVER_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [normalizedRepository]);
  const [existingResource, setExistingResource] = useState<string | null>(null);
  const attempt = useRef<{ serialized: string; id: string } | null>(null);
  const client = useQueryClient();
  const receiverKey = (name: string | null) => ["hooks", workspaceId, "handoff-repository", snapshot.principal.subject, connection.id, connection.revision, name];
  const existingQuery = useQuery({
    queryKey: receiverKey(lookupRepository),
    queryFn: ({ signal }) => command<HookResult<"github_handoff_repository">>("hooks_handoff_repository", { workspaceId, connectionId: connection.id, repository: lookupRepository! }, signal),
    enabled: owner && !planId && lookupRepository !== null && lookupRepository === normalizedRepository,
    retry: false, staleTime: 0, refetchOnWindowFocus: false,
  });
  const existing = normalizedRepository === lookupRepository && !existingQuery.error ? existingQuery.data : undefined;
  const configuration = useQuery({ queryKey: ["hooks", workspaceId, "handoff-configuration", connection.id, connection.revision], queryFn: ({ signal }) => command<{ status: "supported" | "unsupported"; configuration: Configuration | null }>("hooks_handoff_configuration", { workspaceId, connectionId: connection.id }, signal), retry: false, staleTime: 0 });
  const saved = useQuery({ queryKey: ["hooks", workspaceId, "handoff-review", planId], queryFn: ({ signal }) => command<HandoffReview>("hooks_handoff_get", { workspaceId, planId }, signal), enabled: Boolean(planId), retry: false, staleTime: 0 });
  const receipt = saved.data?.provider;
  const evidence = useQuery({ queryKey: ["hooks", workspaceId, "handoff-status", connection.id, receipt?.resourceId], queryFn: ({ signal }) => command<HandoffStatus>("hooks_handoff_status", { workspaceId, connectionId: connection.id, resourceId: receipt!.resourceId }, signal), enabled: Boolean(receipt?.routingConfigured), retry: false, staleTime: 0 });
  const config = configuration.data?.configuration;
  async function review() {
    if (busy || !config) return;
    setBusy(true); setError(null);
    try {
      const selectedProject = snapshot.projects.find(project => project.id === projectId);
      const normalized = normalizeHandoffRepository(repository);
      const enrolled = contextRepository?.fullName.toLowerCase() === normalized.toLowerCase() && contextRepository.projectId === projectId ? contextRepository : undefined;
      const fields = { workspaceId, connectionId: connection.id, connectionRevision: connection.revision, projectId, projectRevision: selectedProject?.revision,
        ...(enrolled ? { savedRepositoryId: enrolled.id, savedRepositoryRevision: enrolled.revision } : {}), authorityId: config.authorityId, revision: config.revision, repository: normalized, profile, sinks };
      const serialized = JSON.stringify(fields);
      if (attempt.current?.serialized !== serialized) attempt.current = { serialized, id: crypto.randomUUID() };
      const input = handoffPlanInput.parse({ ...fields, reviewId: attempt.current.id });
      const scope = await command<HookResult<"github_handoff_repository">>("hooks_handoff_repository", { workspaceId, connectionId: connection.id, repository: normalized }, AbortSignal.timeout(30000));
      client.setQueryData(receiverKey(normalized), scope);
      if (scope.adoptionRequired) throw new Error("This repository has an existing legacy receiver. Use the trusted local adoption adapter to import its protected recovery record before adding profiles.");
      if (scope.resources.some(resource => resource.profile === profile)) throw new Error("This profile already exists. Open its saved receipt or use the existing receiver's private retrieval action.");
      const result = await command<HandoffReview>("hooks_handoff_plan", input, AbortSignal.timeout(30000));
      client.setQueryData(["hooks", workspaceId, "handoff-review", result.id], result); onReview(result.id);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function apply(reconcile: boolean) {
    if (busy || !saved.data || !planId) return;
    setBusy(true); setError(null);
    try {
      const result = await command<HandoffReview>(reconcile ? "hooks_handoff_reconcile" : "hooks_handoff_apply", { workspaceId, planId, ...(!reconcile ? { fingerprint: saved.data.fingerprint } : {}) }, AbortSignal.timeout(30000));
      client.setQueryData(["hooks", workspaceId, "handoff-review", planId], result);
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId, "handoff-status"] });
      void client.invalidateQueries({ queryKey: ["hooks", workspaceId, "history"] });
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="handoff-dialog" onCloseAutoFocus={event => { event.preventDefault(); restoreHookFocus(returnFocus); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>{planId ? "Review manual GitHub handoff" : "Manual GitHub handoff"}</DialogTitle><DialogDescription>Create a receiver for a trusted GitHub repository, then hand its credentials to the repository administrator.</DialogDescription></DialogHeader>
    {connection.id === "handoff-demo" ? <p role="note">Synthetic demonstration. No GitHub hook or notification is created. Provider fixture state resets when the development server restarts.</p> : null}
    {error ? error instanceof Error && !("status" in error) ? <p role="alert">{error.message.startsWith("This ") ? error.message : "Check the repository, project and destination selection. Your draft is preserved."}</p> : <HookError error={error} /> : null}
    {!owner ? <p>Only a workspace owner can create hooks or retrieve credentials.</p> : null}
    {planId ? <>
      {saved.isPending ? <p role="status">Loading saved review...</p> : null}{saved.error ? <HookError error={saved.error} /> : null}
      {saved.data ? <>
        <dl className="handoff-summary"><dt>Repository</dt><dd>{saved.data.repository}</dd><dt>Connection</dt><dd>{saved.data.connectionName}</dd><dt>Profile</dt><dd>{receipt ? PROFILE_LABELS[receipt.profile] : "Unconfirmed"}</dd><dt>Destinations</dt><dd>{receipt?.sinks.join(", ") ?? "Unconfirmed"}</dd><dt>Events</dt><dd>{receipt ? PROFILE_EVENTS[receipt.profile] : "Unconfirmed"}</dd></dl>
        {saved.data.operation ? <p role="status">{saved.data.operation.summary}</p> : <p>Creates routing in Hookrelay. The repository administrator must install the GitHub webhook using the private credentials.</p>}
        {!saved.data.operation ? <div className="handoff-actions"><Button variant="outline" disabled={busy} onClick={onBack}>Back to editing</Button><Button disabled={busy || !owner || !saved.data.actorMatches || receipt?.status !== "ready" || Date.parse(saved.data.expiresAt) <= Date.now()} onClick={() => void apply(false)}>{busy ? "Creating hook..." : "Create hook"}</Button></div> : <Button variant="outline" disabled={busy || !owner || !saved.data.actorMatches} onClick={() => void apply(true)}>{busy ? "Reconciling..." : "Reconcile saved operation"}</Button>}
        {!receipt ? <p>The provider review is unconfirmed. Reconcile the same review before preparing another.</p> : null}
        {!saved.data.operation && !receipt ? <Button variant="outline" disabled={busy || !owner} onClick={() => void apply(true)}>Reconcile review</Button> : null}
        {receipt?.routingConfigured ? <>
          <section aria-label="Routing and delivery evidence"><h3>Connection evidence</h3>{evidence.isPending ? <p role="status">Checking observed events...</p> : null}{evidence.error ? <HookError error={evidence.error} /> : null}{evidence.data ? <>
            <p>{evidence.data.routingConfigured ? "Routing configured" : "Routing is disabled or unavailable"}</p><p>{evidence.data.pingAt ? <>Authenticated GitHub ping observed: <HookTime value={evidence.data.pingAt} /></> : "Authenticated ping not observed"}</p>
            <p>{evidence.data.deliveredAt ? <>Notification delivered: <HookTime value={evidence.data.deliveredAt} /></> : "Successful notification delivery not observed"}</p><p className="hook-muted">Checked {evidence.data.sample.events} recent events (limit {evidence.data.sample.limit}{evidence.data.sample.truncated ? ", bounded sample" : ""}). A ping confirms authenticated receipt; it does not prove notification delivery or all upstream settings.</p>
          </> : null}<Button variant="outline" disabled={evidence.isFetching} onClick={() => void evidence.refetch()}>Refresh evidence</Button></section>
          {owner && config?.canReveal ? <HandoffPrivatePanel key={receipt.resourceId} workspaceId={workspaceId} connectionId={connection.id} repositoryId={receipt.repositoryId} resourceId={receipt.resourceId} /> : <p>Private retrieval requires an owner and the provider custody grant with an available wrapping key.</p>}
        </> : null}
      </> : null}
    </> : <>
      {configuration.isPending ? <p role="status">Checking provider readiness...</p> : null}{configuration.error ? <HookError error={configuration.error} /> : null}
      {configuration.data?.status === "unsupported" ? <p>This provider does not support manual GitHub handoff. Ask the deployment owner to update the provider.</p> : null}
      {config && !config.canCreate ? <p role="status">{config.reason === "grant_required" ? "The provider credential needs the manual handoff grant." : config.reason === "inactive" ? "Online routing must be active before creating a hook." : "The provider needs its public hook origin and protected wrapping keyring configured."}</p> : null}
      <form className="handoff-form" onSubmit={event => { event.preventDefault(); void review(); }}>
        <fieldset disabled={busy || !owner || !config?.canCreate}>
          <label htmlFor="handoff-project">Project</label><select id="handoff-project" value={projectId} onChange={event => setProjectId(event.target.value)} required>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <label htmlFor="handoff-repository">GitHub repository</label><Input id="handoff-repository" value={repository} onChange={event => { setRepository(event.target.value); setError(null); setExistingResource(null); }} placeholder="https://github.com/owner/repository" maxLength={512} required />
          <p className="hook-muted">An enrolled repository or local checkout is optional. The exact repository identity is enforced on incoming events.</p>
          <label htmlFor="handoff-profile">Profile</label><select id="handoff-profile" value={profile} onChange={event => { const next = HANDOFF_PROFILES.find(value => value === event.target.value); if (next) setProfile(next); }}>
            {HANDOFF_PROFILES.map(value => <option key={value} value={value}>{PROFILE_LABELS[value]}</option>)}
          </select><p>GitHub events: <code>{PROFILE_EVENTS[profile]}</code>. {profile === "activity" ? "Push changes, workflow activity, and opened or closed pull requests." : profile === "alerts" ? "Security alert payloads are sent to the selected destinations." : "Star creation and removal."}</p>
          <h3>Destinations</h3>{config ? <HookDestinations workspaceId={workspaceId} connectionId={connection.id} base={config} selected={sinks} onChange={setSinks} disabled={busy || !owner || !config.canCreate} limit={25} /> : null}
          <Button type="submit" disabled={!repository.trim() || !projectId || sinks.length === 0}>{busy ? "Preparing review..." : "Review hook"}</Button>
        </fieldset>
      </form>
      {owner && normalizedRepository ? <section aria-label="Known Hookrelay receivers"><h3>Known Hookrelay receivers</h3>
        <p>These are Hookrelay's manual receiver records. They do not establish which webhooks are installed in GitHub.</p>
        {normalizedRepository !== lookupRepository || existingQuery.isFetching ? <p role="status">Reading known receivers...</p> : null}
        {normalizedRepository === lookupRepository && existingQuery.error ? <><HookError error={existingQuery.error} /><Button variant="outline" onClick={() => void existingQuery.refetch()}>Retry receiver lookup</Button></> : null}
        {existing ? <><p>{existing.repository}</p>{existing.adoptionRequired ? <p>Import this repository's protected legacy recovery record with the trusted local adoption adapter before adding profiles.</p> : existing.resources.length === 0 ? <p>No Hookrelay manual receivers found for this repository.</p> : <div className="handoff-actions">{existing.resources.map(resource => <Button variant="outline" key={resource.resourceId} onClick={() => setExistingResource(resource.resourceId)}>Open {resource.profile} credentials</Button>)}</div>}
          <Button variant="outline" disabled={existingQuery.isFetching} onClick={() => void existingQuery.refetch()}>Refresh receivers</Button>
          {existingResource && existing.repositoryId && config?.canReveal ? <HandoffPrivatePanel key={existingResource} workspaceId={workspaceId} connectionId={connection.id} repositoryId={existing.repositoryId} resourceId={existingResource} /> : null}
        </> : null}
      </section> : null}
    </>}
    <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
  </DialogContent></Dialog>;
}
