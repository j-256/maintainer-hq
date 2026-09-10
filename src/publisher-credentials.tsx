import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { type Connection, type Snapshot } from "../shared/domain";
import {
  type PublisherCredential,
  type IssuedPublisherCredential,
} from "../shared/sources";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  DiscardDialog,
  useCloseGuard,
  SOURCE_REQUEST_TIMEOUT_MS,
} from "./source-editor";
import { useSourceTime } from "./date-time";

export function CredentialManager({
  source,
  snapshot,
  onClose,
  returnFocus,
}: {
  source: Connection;
  snapshot: Snapshot;
  onClose: () => void;
  returnFocus: HTMLElement | null;
}) {
  const [reviewed] = useState(source);
  const displaySourceTime = useSourceTime();
  const [name, setName] = useState("");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [credentialId, setCredentialId] = useState(() => crypto.randomUUID());
  const [issued, setIssued] = useState<IssuedPublisherCredential | null>(null);
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState<PublisherCredential | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const guard = useCloseGuard(Boolean(issued) || busy, onClose);
  const queryClient = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const input = { workspaceId, sourceId: source.id };
  const credentials = useQuery({
    queryKey: ["publisher-credentials", workspaceId, source.id],
    queryFn: ({ signal }) =>
      command<PublisherCredential[]>(
        "publisher_credentials_list",
        input,
        signal,
      ),
    retry: false,
  });
  function refresh() {
    void credentials.refetch();
    void queryClient.invalidateQueries({
      queryKey: ["workspace", workspaceId],
    });
  }
  async function issue(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError(
        "Enter a name so you can identify and revoke this credential later.",
      );
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = await command<IssuedPublisherCredential>(
        "publisher_credential_issue",
        {
          ...input,
          revision: reviewed.revision,
          credentialId,
          name,
          expiresInDays: days,
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      setIssued(value);
      setCopied(false);
      setReveal(false);
      setCredentialId(crypto.randomUUID());
      refresh();
    } catch (error) {
      setError(
        (error instanceof Error
          ? error.message
          : "Credential creation could not be confirmed.") +
          " Refresh the credential list before trying again. Revoke any issued credential whose value was not saved.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  async function revokeCredential() {
    if (!revoke || busy) return;
    setBusy(true);
    setError("");
    try {
      await command(
        "publisher_credential_revoke",
        { ...input, credentialId: revoke.id },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      if (issued?.credential.id === revoke.id) setIssued(null);
      setRevoke(null);
      setCredentialId(crypto.randomUUID());
      refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Revocation could not be confirmed. Refresh and inspect the credential.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }
  const changed = source.revision !== reviewed.revision;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="source-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Publisher credentials</DialogTitle>
            <DialogDescription>
              {source.name} can report local checkout facts only. Credentials
              cannot read the workspace or operate providers.
            </DialogDescription>
          </DialogHeader>
          <div className="source-form-scroll">
            {error ? (
              <p role="alert" className="source-error">
                {error}
              </p>
            ) : null}
            {changed ? (
              <p role="alert" className="source-error">
                This source's scope changed. Close and reopen this dialog to
                review it before creating a credential.
              </p>
            ) : null}
            {issued ? (
              <section
                className="credential-reveal"
                aria-label="New publisher credential"
              >
                <h3>
                  <ShieldCheck size={18} /> Save this credential now
                </h3>
                <p>
                  The value is shown once. Store it privately as HQ_TOKEN on the
                  publishing client. Do not paste it into Activity, repository
                  files, or command arguments.
                </p>
                <label htmlFor="publisher-value">
                  Publisher credential value
                </label>
                <Input
                  id="publisher-value"
                  type={reveal ? "text" : "password"}
                  readOnly
                  value={issued.token}
                  autoComplete="off"
                />
                <div className="credential-value-actions">
                  <Button variant="outline" onClick={() => setReveal(!reveal)}>
                    {reveal ? "Hide value" : "Reveal value"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(issued.token);
                        setCopied(true);
                      } catch {
                        setError(
                          "Clipboard access was denied. Reveal the value and copy it manually.",
                        );
                      }
                    }}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied ? "Copied" : "Copy credential"}
                  </Button>
                </div>
                <Button
                  onClick={() => {
                    setIssued(null);
                    setName("");
                  }}
                >
                  I have saved the credential
                </Button>
              </section>
            ) : (
              <form onSubmit={issue} noValidate className="credential-create">
                <h3>Create a credential</h3>
                <p>
                  Grant access to {reviewed.repositoryIds.length} selected
                  repositories for a limited time. Existing credentials remain
                  valid until expired or revoked.
                </p>
                <div className="credential-scope">
                  {reviewed.repositoryIds.map((id) => (
                    <span key={id}>
                      {snapshot.repositories.find(
                        (repository) => repository.id === id,
                      )?.fullName ?? "Repository no longer enrolled"}
                    </span>
                  ))}
                </div>
                <div className="form-field">
                  <label htmlFor="credential-name">Credential name</label>
                  <Input
                    id="credential-name"
                    ref={nameInput}
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busy}
                    placeholder="For example, scheduled checkout publisher"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="credential-expiry">Expires after</label>
                  <Select
                    value={String(days)}
                    onValueChange={(value) =>
                      setDays(Number(value) as 7 | 30 | 90)
                    }
                    disabled={busy}
                  >
                    <SelectTrigger id="credential-expiry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[7, 30, 90].map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {day} days
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    changed ||
                    !source.enabled ||
                    credentials.isError ||
                    credentials.isPending
                  }
                >
                  {busy ? "Creating..." : "Create publisher credential"}
                </Button>
                {!source.enabled ? (
                  <p className="field-help">
                    Enable publishing in source settings before creating
                    credentials.
                  </p>
                ) : null}
              </form>
            )}
            <section
              className="credential-list"
              aria-label="Issued credentials"
            >
              <div className="source-section-heading">
                <h3>Issued credentials</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void credentials.refetch()}
                >
                  Refresh list
                </Button>
              </div>
              {credentials.isError ? (
                <p role="alert">
                  Credentials could not be loaded. Refresh the list to try
                  again.
                </p>
              ) : credentials.isPending ? (
                <p role="status">Loading credentials...</p>
              ) : !credentials.data.length ? (
                <p>No credentials have been issued.</p>
              ) : (
                credentials.data.map((credential) => {
                  const expired =
                    Date.parse(credential.expiresAt) <= Date.now();
                  return (
                    <div className="credential-row" key={credential.id}>
                      <div>
                        <strong>{credential.name}</strong>
                        <small>
                          {credential.revokedAt
                            ? "Revoked " +
                              displaySourceTime(credential.revokedAt)
                            : "Expires " +
                              displaySourceTime(credential.expiresAt)}
                        </small>
                      </div>
                      <Badge variant="outline">
                        {credential.revokedAt
                          ? "Revoked"
                          : expired
                            ? "Expired"
                            : "Active"}
                      </Badge>
                      {!credential.revokedAt ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRevoke(credential)}
                          aria-label={"Revoke " + credential.name}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  );
                })
              )}
            </section>
          </div>
          <div className="source-dialog-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={guard.requestClose}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} credential />
      <AlertDialog
        open={Boolean(revoke)}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke this publisher credential?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revoke?.name} will immediately lose publishing access to{" "}
              {source.name}. Other credentials are unaffected. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="source-error">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep credential
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void revokeCredential()}
            >
              {busy ? "Revoking..." : "Revoke credential"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
