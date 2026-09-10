import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  AUTOMATION_DURATIONS,
  AUTOMATION_LIMITS,
  AUTOMATION_PROFILE,
  automationPlanInput,
  type AutomationCredential,
  type AutomationPlan,
  type AutomationProfile,
  type IssuedAutomationCredential,
} from "../shared/automation";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { useDateTime } from "./date-time";
import "./membership.css";
import "./automation.css";

const PROFILE_LABEL = { reporter: "Reporter", reader: "Reader" } as const;
const PROFILE_DESCRIPTION = {
  reporter:
    "Publish progress and verbatim goals for one reporter. No workspace reads, expectation edits, provider operations, or access management.",
  reader:
    "Read workspace status, repository metadata, and activity. No updates, operations, access management, or secret values.",
} as const;
const timeout = () => AbortSignal.timeout(AUTOMATION_LIMITS.REQUEST_TIMEOUT_MS);

export function AutomationSettings({ snapshot }: { snapshot: Snapshot }) {
  const { dateTime: time } = useDateTime();
  const workspaceId = snapshot.workspace.id;
  const canManage = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const cache = useQueryClient();
  const createButton = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<AutomationCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["automation-credentials", workspaceId],
    queryFn: ({ signal }) =>
      command<AutomationCredential[]>(
        "automation_credentials_list",
        { workspaceId },
        signal,
      ),
    enabled: canManage,
    retry: false,
  });
  function refresh() {
    void query.refetch();
    void cache.invalidateQueries({ queryKey: ["workspace", workspaceId] });
  }
  async function revokeCredential() {
    if (!revoke || busy) return;
    setBusy(true);
    setError("");
    try {
      await command(
        "automation_credential_revoke",
        { workspaceId, credentialId: revoke.id },
        timeout(),
      );
      setRevoke(null);
      createButton.current?.focus();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Revocation could not be confirmed. Refresh and inspect the credential before retrying.",
      );
    } finally {
      setBusy(false);
      refresh();
    }
  }
  return (
    <section
      className="access-card automation-card"
      aria-labelledby="automation-heading"
    >
      <div className="access-heading">
        <div>
          <h1 id="automation-heading">Automation access</h1>
          <p>Manage workspace credentials for agents and scripts.</p>
        </div>
      </div>
      {!canManage ? (
        <p>
          Only a workspace owner can review or manage automation credentials.
        </p>
      ) : (
        <>
          <div className="access-actions automation-toolbar">
            <Button ref={createButton} onClick={() => setCreating(true)}>
              <KeyRound size={15} /> Create automation credential
            </Button>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw size={14} /> Refresh credentials
            </Button>
          </div>
          <details className="automation-boundary">
            <summary>Connecting to a protected dashboard</summary>
            <p>
              Access service credentials get a machine through the hosted
              sign-in gate. These workspace credentials decide what it may do.
              Neither replaces the other.
            </p>
          </details>
          {query.isPending ? (
            <p role="status">Loading automation credentials...</p>
          ) : null}
          {query.error ? (
            <p className="field-error" role="alert">
              {query.error.message} Use Refresh credentials to try again.
            </p>
          ) : null}
          {query.data?.length === 0 ? (
            <div className="automation-empty">
              <KeyRound size={22} aria-hidden="true" />
              <div>
                <h2>No automation credentials</h2>
                <p>
                  Start with a Reporter to publish work without granting access
                  to fleet data.
                </p>
              </div>
            </div>
          ) : null}
          {query.data?.map((credential) => {
            const expired = Date.parse(credential.expiresAt) <= Date.now();
            const disabled = Boolean(credential.revokedAt) || expired;
            return (
              <div className="access-row" key={credential.id}>
                <div className="automation-record">
                  <h2>{credential.name}</h2>
                  <p>
                    {PROFILE_LABEL[credential.profile]}
                    {credential.reporterId ? " / " + credential.reporterId : ""}
                  </p>
                  <p>
                    {credential.revokedAt
                      ? "Revoked " + time(credential.revokedAt)
                      : (expired ? "Expired " : "Expires ") +
                        time(credential.expiresAt)}
                  </p>
                  <details>
                    <summary>Credential details</summary>
                    <dl>
                      <dt>ID</dt>
                      <dd>{credential.id}</dd>
                      <dt>Owner account</dt>
                      <dd>{credential.owner}</dd>
                      <dt>Created</dt>
                      <dd>{time(credential.createdAt)}</dd>
                    </dl>
                  </details>
                </div>
                <div className="access-actions">
                  <Badge variant="outline">
                    {credential.revokedAt
                      ? "Revoked"
                      : expired
                        ? "Expired"
                        : "Active"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      setError("");
                      setRevoke(credential);
                    }}
                  >
                    Revoke<span className="sr-only"> {credential.name}</span>
                  </Button>
                </div>
              </div>
            );
          })}
          {query.data && query.data.length >= AUTOMATION_LIMITS.HISTORY ? (
            <p>
              Showing the bounded credential history, with active credentials
              first.
            </p>
          ) : null}
        </>
      )}
      {creating && canManage ? (
        <CreateAutomation
          snapshot={snapshot}
          onClose={() => setCreating(false)}
          returnFocus={createButton.current}
          onChanged={refresh}
        />
      ) : null}
      <Dialog
        open={Boolean(revoke) && canManage}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoke(null);
        }}
      >
        <DialogContent
          className="access-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            createButton.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Revoke automation access?</DialogTitle>
            <DialogDescription>
              {revoke?.name} will stop authenticating immediately. Published
              goals and activity remain. Revocation cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}
          <div className="access-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRevoke(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={revokeCredential}
            >
              {busy ? "Revoking..." : "Revoke credential"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CreateAutomation({
  snapshot,
  onClose,
  returnFocus,
  onChanged,
}: {
  snapshot: Snapshot;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  onChanged: () => void;
}) {
  const [credentialId] = useState(() => crypto.randomUUID());
  const { dateTime: time } = useDateTime();
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<AutomationProfile>(
    AUTOMATION_PROFILE.REPORTER,
  );
  const [reporterId, setReporterId] = useState("");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [issued, setIssued] = useState<IssuedAutomationCredential | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const nameInput = useRef<HTMLInputElement>(null);
  const reporterInput = useRef<HTMLInputElement>(null);
  const guard = useCloseGuard(
    Boolean(name || reporterId || issued || busy),
    onClose,
  );
  useEffect(() => {
    if (!plan || issued) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [plan, issued]);
  async function review(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = automationPlanInput.safeParse({
      workspaceId: snapshot.workspace.id,
      credentialId,
      name,
      profile,
      reporterId: profile === AUTOMATION_PROFILE.REPORTER ? reporterId : null,
      expiresInDays: days,
    });
    if (!parsed.success) {
      if (!name.trim()) {
        setError(
          "Enter a name so you can identify and revoke this credential.",
        );
        nameInput.current?.focus();
      } else {
        setError(
          "Enter a reporter ID using letters, numbers, underscores, or hyphens, up to 100 characters.",
        );
        reporterInput.current?.focus();
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      setPlan(
        await command<AutomationPlan>(
          "automation_credential_plan",
          parsed.data,
          timeout(),
        ),
      );
      setNow(Date.now());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The review could not be prepared. Your draft is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function issue() {
    if (!plan || busy || uncertain) return;
    setBusy(true);
    setError("");
    try {
      const value = await command<IssuedAutomationCredential>(
        "automation_credential_issue",
        {
          workspaceId: snapshot.workspace.id,
          planId: plan.planId,
          fingerprint: plan.fingerprint,
        },
        timeout(),
      );
      setIssued(value);
    } catch (error) {
      setUncertain(true);
      setError(
        (error instanceof Error
          ? error.message
          : "Issuance could not be confirmed.") +
          " Inspect the credential list. Revoke any credential whose value was not saved before creating a replacement.",
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  const expired = Boolean(plan && Date.parse(plan.expiresAt) <= now);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="access-dialog automation-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {issued
                ? "Save this credential"
                : plan
                  ? "Review automation access"
                  : "Create automation credential"}
            </DialogTitle>
            <DialogDescription>
              {issued
                ? "This value is shown once. It cannot be retrieved after you close this view."
                : "Grant only the access this client needs. Expiry and revocation are enforced by the workspace."}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}
          {issued ? (
            <div className="automation-value">
              <p>
                Save as <code>HQ_TOKEN</code> in your client's protected secret
                storage. Do not paste into Activity, repository files, chat, or
                command arguments.
              </p>
              <label htmlFor="automation-value">
                Automation credential value
              </label>
              <Input
                id="automation-value"
                type={reveal ? "text" : "password"}
                readOnly
                value={issued.token}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="access-actions">
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
                        "Clipboard access was denied. Reveal and copy the value manually.",
                      );
                    }
                  }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? "Copied" : "Copy credential"}
                </Button>
              </div>
              <p>
                For a protected hosted workspace, also configure the paired
                Access service credentials. This view does not create or grant
                those.
              </p>
              <Button
                onClick={() => {
                  setIssued(null);
                  guard.saved();
                }}
              >
                I have saved the credential
              </Button>
            </div>
          ) : plan ? (
            <div className="automation-review">
              <dl>
                <dt>Workspace</dt>
                <dd>{plan.workspaceName}</dd>
                <dt>Owner</dt>
                <dd>{plan.actor}</dd>
                <dt>Credential</dt>
                <dd>{plan.name}</dd>
                <dt>Profile</dt>
                <dd>{PROFILE_LABEL[plan.profile]}</dd>
                {plan.reporterId ? (
                  <>
                    <dt>Reporter ID</dt>
                    <dd>{plan.reporterId}</dd>
                  </>
                ) : null}
                <dt>Credential lifetime</dt>
                <dd>{plan.expiresInDays} days from creation</dd>
                <dt>Review valid until</dt>
                <dd>{time(plan.expiresAt)}</dd>
              </dl>
              <p>{PROFILE_DESCRIPTION[plan.profile]}</p>
              <p className="automation-scopes">
                Exact permissions: {plan.scopes.join(", ")}
              </p>
              {expired ? (
                <p role="alert" className="field-error">
                  This review expired. Review the preserved draft again before
                  creating a credential.
                </p>
              ) : null}
              <div className="access-actions">
                {uncertain ? (
                  <Button onClick={guard.saved}>Inspect credential list</Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setPlan(null);
                        setError("");
                      }}
                    >
                      Back to edit
                    </Button>
                    <Button disabled={busy || expired} onClick={issue}>
                      {busy ? "Creating..." : "Create reviewed credential"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <form onSubmit={review} noValidate>
              <div className="form-field">
                <label htmlFor="automation-name">Credential name</label>
                <Input
                  ref={nameInput}
                  id="automation-name"
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                  placeholder="For example, maintainer agent"
                />
              </div>
              <div className="form-field">
                <label htmlFor="automation-profile">Permission profile</label>
                <Select
                  value={profile}
                  onValueChange={(value) =>
                    setProfile(value as AutomationProfile)
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    id="automation-profile"
                    aria-describedby="automation-profile-help"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTOMATION_PROFILE.REPORTER}>
                      Reporter
                    </SelectItem>
                    <SelectItem value={AUTOMATION_PROFILE.READER}>
                      Reader
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p id="automation-profile-help" className="field-help">
                  {PROFILE_DESCRIPTION[profile]}
                </p>
              </div>
              {profile === AUTOMATION_PROFILE.REPORTER ? (
                <div className="form-field">
                  <label htmlFor="automation-reporter">Reporter ID</label>
                  <Input
                    ref={reporterInput}
                    id="automation-reporter"
                    value={reporterId}
                    maxLength={100}
                    onChange={(event) => setReporterId(event.target.value)}
                    disabled={busy}
                    placeholder="maintainer-agent"
                    aria-describedby="automation-reporter-help"
                  />
                  <p id="automation-reporter-help" className="field-help">
                    Use this exact ID as sourceId in goal reports. Keep it when
                    replacing this reporter's credential. Different reporters
                    should use different IDs.
                  </p>
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="automation-duration">Expires after</label>
                <Select
                  value={String(days)}
                  onValueChange={(value) =>
                    setDays(Number(value) as 7 | 30 | 90)
                  }
                  disabled={busy}
                >
                  <SelectTrigger id="automation-duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTOMATION_DURATIONS.map((duration) => (
                      <SelectItem key={duration} value={String(duration)}>
                        {duration} days
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="access-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={guard.requestClose}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Preparing review..." : "Review permissions"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} credential={Boolean(issued)} />
    </>
  );
}
