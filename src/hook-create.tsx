import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import type { HookConnection } from "../shared/hooks";
import type { HookSetupConfiguration } from "../shared/hook-setup";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { HookError, restoreHookFocus } from "./hook-components";
import { CreateHook } from "./hook-resolution";

export function HookCreateDialog({ snapshot, connection, repositoryId, returnFocus, onRepository, onReview, onManual, onClose }: {
  snapshot: Snapshot;
  connection: HookConnection;
  repositoryId: string | null;
  returnFocus: HTMLElement | null;
  onRepository: (id: string) => void;
  onReview: (id: string) => void;
  onManual: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const repository = snapshot.repositories.find(item => item.id === repositoryId);
  const setup = useQuery({
    queryKey: ["hooks", snapshot.workspace.id, "setup-configuration", connection.id, connection.revision],
    queryFn: ({ signal }) => command<{ status: "supported" | "unsupported"; configuration: HookSetupConfiguration | null }>(
      "hooks_setup_configuration", { workspaceId: snapshot.workspace.id, connectionId: connection.id }, signal),
    retry: false,
    staleTime: 0,
  });
  const configuration = setup.data?.configuration;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="hook-resolution" showCloseButton={!busy}
      onCloseAutoFocus={event => { event.preventDefault(); restoreHookFocus(returnFocus); }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>New GitHub hook</DialogTitle><DialogDescription>Select a repository to inspect existing webhooks, then review automatic installation through HQ.</DialogDescription></DialogHeader>
      <div className="hook-resolution-scroll hook-resolution-stack">
        <label htmlFor="hook-create-repository">Repository</label>
        <select id="hook-create-repository" disabled={busy} value={repository?.id ?? ""} onChange={event => onRepository(event.target.value)}>
          <option value="">Select a repository</option>
          {[...snapshot.repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)).map(item => <option key={item.id} value={item.id}>{item.fullName}</option>)}
        </select>
        {!snapshot.repositories.length ? <p>Add a repository to this workspace before using App installation.</p> : null}
        {setup.isPending ? <p role="status">Checking App installation readiness...</p> : null}
        {setup.error ? <><HookError error={setup.error} /><Button variant="outline" onClick={() => void setup.refetch()}>Retry installation readiness</Button></> : null}
        {setup.data?.status === "unsupported" ? <p>This provider does not support direct GitHub installation. Manual handoff is available separately.</p> : null}
        {configuration && !configuration.canCreate ? <p role="status">{configuration.reason === "grant_required" ? "The provider credential needs the hook provisioning grant before HQ can install webhooks." : configuration.reason === "inactive" ? "Online routing must be active before installing a webhook." : "The provider administrator must finish GitHub setup before HQ can install webhooks."}</p> : null}
        {repository && configuration ? <CreateHook
          key={[snapshot.workspace.id, snapshot.principal.subject, snapshot.capabilities.join(","), repository.id, repository.revision, connection.id, connection.revision].join("/")}
          snapshot={snapshot} repository={repository} connection={connection} configuration={configuration} resume={null} onBusy={setBusy}
          navigate={fields => { if (fields.setupReview) onReview(fields.setupReview); else onClose(); }} /> : null}
        <section className="hook-resolution-stack" aria-label="Manual GitHub handoff">
          <h3>Repository administered by someone else?</h3>
          <p>Manual handoff creates a receiver and supplies private installation instructions for that repository's administrator.</p>
          <Button variant="outline" disabled={busy || !snapshot.capabilities.includes(CAPABILITY.SECRETS)} onClick={onManual}>Prepare manual handoff</Button>
        </section>
      </div>
      <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
    </DialogContent>
  </Dialog>;
}
