import { useRef, useState } from "react";
import { PUSH_LIMITS } from "../shared/workspace-push";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MailPlus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { CAPABILITY, ROLES, type Role, type Snapshot } from "../shared/domain";
import {
  invitationCreateInput,
  type Invitation,
  type ManagedMember,
  type OwnInvitation,
  type SetupStatus,
} from "../shared/membership";
import { command, RequestError } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { useDateTime } from "./date-time";
import "./membership.css";

const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Manage workspace access, credentials, settings, and operations.",
  operator:
    "Edit repository expectations and run permitted operations. No access or credential administration.",
  viewer:
    "Read workspace status and activity, and set personal display preferences. No workspace changes or operations.",
};
const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  operator: "Operator",
  viewer: "Viewer",
};

function RoleField({
  value,
  onChange,
  disabled = false,
}: {
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-field">
      <label htmlFor="access-role">Role</label>
      <Select
        value={value}
        onValueChange={(role) => onChange(role as Role)}
        disabled={disabled}
      >
        <SelectTrigger
          id="access-role"
          aria-describedby="access-role-description"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((role) => (
            <SelectItem key={role} value={role}>
              {ROLE_LABEL[role]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="field-help" id="access-role-description">
        {ROLE_DESCRIPTION[value]}
      </p>
    </div>
  );
}

export function AccountInvitations({ development }: { development: boolean }) {
  const { dateTime: time } = useDateTime();
  const cache = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["account-invitations"],
    queryFn: ({ signal }) =>
      command<OwnInvitation[]>("invitations_mine", {}, signal),
    enabled: !development,
    retry: false,
    refetchInterval: PUSH_LIMITS.FALLBACK_MS,
  });
  if (development) return null;
  async function accept(invitation: OwnInvitation) {
    setPending(invitation.id);
    setError("");
    try {
      await command("invitation_accept", {
        invitationId: invitation.id,
        revision: invitation.revision,
      });
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["session"] }),
        cache.invalidateQueries({ queryKey: ["account-invitations"] }),
      ]);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The invitation could not be accepted",
      );
    } finally {
      setPending(null);
    }
  }
  return (
    <section
      className="access-card"
      aria-labelledby="account-invitations-heading"
    >
      <div className="access-heading">
        <div>
          <h2 id="account-invitations-heading">Your invitations</h2>
          <p>
            Only invitations addressed to your verified sign-in email appear
            here.
          </p>
        </div>
        <MailPlus size={20} />
      </div>
      {query.isPending ? <p role="status">Checking invitations...</p> : null}
      {query.error || error ? (
        <p role="alert" className="field-error">
          {error || query.error?.message}
        </p>
      ) : null}
      {query.error ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          Check again
        </Button>
      ) : null}
      {query.data?.length === 0 ? (
        <p>
          No pending invitations. Ask a workspace owner to invite the email you
          use to sign in.
        </p>
      ) : null}
      {query.data?.map((invitation) => (
        <article className="access-row" key={invitation.id}>
          <div>
            <h3>{invitation.workspaceName}</h3>
            <p>
              {ROLE_LABEL[invitation.role]} access.{" "}
              {ROLE_DESCRIPTION[invitation.role]}
            </p>
            <small>Expires {time(invitation.expiresAt)}</small>
          </div>
          <Button
            disabled={pending !== null}
            onClick={() => void accept(invitation)}
          >
            {pending === invitation.id ? "Joining..." : "Join workspace"}
          </Button>
        </article>
      ))}
    </section>
  );
}

export function Onboarding({
  displayName,
  development,
}: {
  displayName: string;
  development: boolean;
}) {
  const { dateTime: time } = useDateTime();
  const cache = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const setup = useQuery({
    queryKey: ["owner-setup"],
    queryFn: ({ signal }) => command<SetupStatus>("setup_status", {}, signal),
    retry: false,
    enabled: !development,
  });
  async function initialize() {
    if (setup.data?.state !== "ready" || !accepted) return;
    setPending(true);
    setError("");
    try {
      await command("setup_apply", { fingerprint: setup.data.fingerprint });
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["session"] }),
        cache.invalidateQueries({ queryKey: ["owner-setup"] }),
      ]);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Owner setup could not be completed",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="onboarding">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WELCOME TO MAINTAINER HQ</div>
          <h1>Find your workspace</h1>
          <p>
            Signed in as {displayName}. Signing in verifies your identity; it
            does not grant workspace access.
          </p>
        </div>
      </div>
      {setup.data?.state === "ready" ? (
        <section
          className="access-card setup-card"
          aria-labelledby="owner-setup-heading"
        >
          <ShieldCheck size={26} />
          <h2 id="owner-setup-heading">Set up your workspace</h2>
          <p>
            The deployment operator approved{" "}
            <strong>{setup.data.workspaceName}</strong> for this account.
            Accepting makes you its first owner.
          </p>
          <dl>
            <div>
              <dt>Workspace</dt>
              <dd>{setup.data.workspaceName}</dd>
            </div>
            <div>
              <dt>Owner account</dt>
              <dd>{setup.data.owner}</dd>
            </div>
            <div>
              <dt>Approval expires</dt>
              <dd>{time(setup.data.expiresAt)}</dd>
            </div>
          </dl>
          <label className="access-confirm">
            <Checkbox
              checked={accepted}
              onCheckedChange={(checked) => setAccepted(checked === true)}
              disabled={pending}
            />
            <span>
              I accept responsibility for this workspace and its access
              settings.
            </span>
          </label>
          <Button
            disabled={pending || !accepted}
            onClick={() => void initialize()}
          >
            {pending ? "Creating workspace..." : "Create workspace"}
          </Button>
        </section>
      ) : null}
      {setup.data?.state === "complete" ? (
        <div className="access-card">
          <h2>Setup has already been completed</h2>
          <p>
            This account has no available workspace membership. Ask another
            owner to restore access, or follow the deployment recovery
            procedure. Setup cannot be used to bypass that process.
          </p>
        </div>
      ) : null}
      {setup.error || error ? (
        <div role="alert" className="error-banner">
          <p>{error || setup.error?.message}</p>
          <Button
            variant="outline"
            onClick={() => {
              setAccepted(false);
              void setup.refetch();
            }}
          >
            Review setup again
          </Button>
        </div>
      ) : null}
      <AccountInvitations development={development} />
      {development ? (
        <p>
          The isolated preview workspace is missing. Restore the development
          fixture; production owner setup is disabled here.
        </p>
      ) : null}
    </div>
  );
}

type Edit =
  | { kind: "role" | "remove"; member: ManagedMember }
  | { kind: "revoke"; invitation: Invitation };
export function MembershipSettings({ snapshot }: { snapshot: Snapshot }) {
  const { dateTime: time } = useDateTime();
  const workspaceId = snapshot.workspace.id;
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const cache = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitationId, setInvitationId] = useState(() => crypto.randomUUID());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [expiry, setExpiry] = useState("7");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const query = useQuery({
    queryKey: ["membership", workspaceId],
    enabled: canAdmin,
    retry: false,
    queryFn: async ({ signal }) => {
      const [members, invitations] = await Promise.all([
        command<ManagedMember[]>("members_list", { workspaceId }, signal),
        command<Invitation[]>("invitations_list", { workspaceId }, signal),
      ]);
      return { members, invitations };
    },
  });
  function begin(action: Edit | "invite") {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setError("");
    setNotice("");
    setConflict(false);
    if (action === "invite") {
      setEmail("");
      setRole("viewer");
      setExpiry("7");
      setInvitationId(crypto.randomUUID());
      setInviteOpen(true);
    } else {
      setEdit(action);
      if (action.kind === "role") setRole(action.member.role);
    }
  }
  async function refresh() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["membership", workspaceId] }),
      cache.invalidateQueries({ queryKey: ["workspace", workspaceId] }),
      cache.invalidateQueries({ queryKey: ["session"] }),
    ]);
  }
  async function save() {
    setError("");
    setConflict(false);
    let invite;
    if (inviteOpen) {
      invite = invitationCreateInput.safeParse({
        workspaceId,
        invitationId,
        email: email.trim(),
        role,
        expiresInDays: Number(expiry),
      });
      if (!invite.success) {
        setError("Enter a valid email address and choose a role and expiry.");
        emailRef.current?.focus();
        return;
      }
    }
    setPending(true);
    try {
      if (invite?.success) {
        await command("invitation_create", invite.data);
        setNotice(
          "Invitation created. Ask the recipient to sign in with that email; no email was sent.",
        );
      } else if (edit?.kind === "role") {
        await command("member_update", {
          workspaceId,
          subject: edit.member.subject,
          revision: edit.member.revision,
          role,
        });
        setNotice("Member role saved.");
      } else if (edit?.kind === "remove") {
        await command("member_remove", {
          workspaceId,
          subject: edit.member.subject,
          revision: edit.member.revision,
        });
        setNotice(
          "Member removed. Their workspace credentials and pending invitations were revoked.",
        );
      } else if (edit?.kind === "revoke") {
        await command("invitation_revoke", {
          workspaceId,
          invitationId: edit.invitation.id,
          revision: edit.invitation.revision,
        });
        setNotice("Invitation revoked.");
      }
      setEdit(null);
      setInviteOpen(false);
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Access could not be updated",
      );
      setConflict(error instanceof RequestError && error.status === 409);
    } finally {
      setPending(false);
    }
  }
  async function reviewLatest() {
    const latest = await query.refetch();
    if (latest.error) {
      setError(latest.error.message);
      return;
    }
    if (edit?.kind === "role" || edit?.kind === "remove") {
      const member = latest.data?.members.find(
        (item) => item.subject === edit.member.subject,
      );
      if (!member) {
        setError(
          "This member no longer has access. Close this review and refresh the workspace.",
        );
        return;
      }
      setEdit({ kind: edit.kind, member });
      setError(
        "Latest access loaded: " +
          ROLE_LABEL[member.role] +
          ". Review your selection before saving.",
      );
    } else if (edit?.kind === "revoke") {
      const invitation = latest.data?.invitations.find(
        (item) => item.id === edit.invitation.id,
      );
      if (!invitation || invitation.state !== "pending") {
        setError(
          "This invitation is no longer pending. Close this review and refresh the workspace.",
        );
        return;
      }
      setEdit({ kind: "revoke", invitation });
      setError("Latest invitation loaded. Review it before revoking.");
    }
    setConflict(false);
  }
  const ownerCount =
    query.data?.members.filter((item) => item.role === "owner").length ?? 0;
  const title = inviteOpen
    ? "Invite a member"
    : edit?.kind === "role"
      ? "Change member role"
      : edit?.kind === "remove"
        ? "Remove workspace access?"
        : "Revoke invitation?";
  return (
    <>
      <section className="access-card" aria-labelledby="members-heading">
        <div className="access-heading">
          <div>
            <div className="eyebrow">PEOPLE & PERMISSIONS</div>
            <h1 id="members-heading" ref={headingRef} tabIndex={-1}>
              Workspace members
            </h1>
            <p>
              Invite people, review their roles, and keep access deliberate.
            </p>
          </div>
          <Button disabled={!canAdmin} onClick={() => begin("invite")}>
            <Users size={16} />
            Invite member
          </Button>
        </div>
        <p className="permission-notice">
          <ShieldCheck size={16} />
          Your role: {ROLE_LABEL[snapshot.workspace.role]}.{" "}
          {canAdmin
            ? "At least one owner must remain."
            : "Only workspace owners can view or change access settings."}
        </p>
        {notice ? (
          <p className="save-notice" role="status">
            <Check size={16} />
            {notice}
          </p>
        ) : null}
        {canAdmin && query.isPending ? (
          <p role="status">Loading workspace access...</p>
        ) : null}
        {query.error ? (
          <div className="error-banner" role="alert">
            <p>{query.error.message}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {canAdmin
          ? query.data?.members.map((member) => (
              <article
                className="access-row"
                key={member.subject}
                aria-label={member.displayName}
              >
                <div className="access-person">
                  <div className="access-avatar">
                    {member.displayName[0]?.toUpperCase()}
                  </div>
                  <div>
                    <h2>
                      {member.displayName}{" "}
                      {member.subject === snapshot.principal.subject ? (
                        <small>(you)</small>
                      ) : null}
                    </h2>
                    <p>{ROLE_DESCRIPTION[member.role]}</p>
                  </div>
                </div>
                <div className="access-actions">
                  <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => begin({ kind: "role", member })}
                    disabled={member.role === "owner" && ownerCount === 1}
                  >
                    Change role
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => begin({ kind: "remove", member })}
                    disabled={member.role === "owner" && ownerCount === 1}
                  >
                    Remove
                  </Button>
                </div>
              </article>
            ))
          : null}
        {canAdmin && query.data ? (
          <div className="access-invitations">
            <h2>Invitations</h2>
            <p>
              Pending invitations are shown first. History is bounded; email
              addresses stay restricted to owners and the recipient.
            </p>
            {!query.data.invitations.length ? (
              <p>No invitations yet.</p>
            ) : (
              query.data.invitations.map((invitation) => (
                <article
                  className="access-row"
                  key={invitation.id}
                  aria-label={invitation.email}
                >
                  <div>
                    <h3>{invitation.email}</h3>
                    <p>
                      {ROLE_LABEL[invitation.role]} access. Expires{" "}
                      {time(invitation.expiresAt)}
                    </p>
                  </div>
                  <div className="access-actions">
                    <Badge variant="outline">{invitation.state}</Badge>
                    {invitation.state === "pending" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => begin({ kind: "revoke", invitation })}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
        ) : null}
      </section>
      <AccountInvitations development={snapshot.development} />
      <Dialog
        open={inviteOpen || edit !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setInviteOpen(false);
            setEdit(null);
          }
        }}
      >
        <DialogContent
          className="access-dialog"
          showCloseButton={!pending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current;
            (target?.isConnected ? target : headingRef.current)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {inviteOpen
                ? "Invite the email the recipient uses to sign in. No email or secret invitation link is sent."
                : edit?.kind === "revoke"
                  ? "The recipient will no longer be able to join using this invitation."
                  : edit?.kind === "remove"
                    ? "This removes membership and revokes its workspace credentials and pending invitations. A new invitation is required to restore access."
                    : "Changes apply immediately to this member and their existing credentials. Keep another owner before giving up ownership."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            noValidate
          >
            {inviteOpen ? (
              <>
                <div className="form-field">
                  <label htmlFor="invite-email">Email address</label>
                  <Input
                    id="invite-email"
                    ref={emailRef}
                    type="email"
                    autoComplete="email"
                    value={email}
                    disabled={pending}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setInvitationId(crypto.randomUUID());
                      setConflict(false);
                    }}
                    aria-describedby={error ? "access-error" : undefined}
                  />
                </div>
                <RoleField
                  value={role}
                  onChange={(value) => {
                    setRole(value);
                    setInvitationId(crypto.randomUUID());
                    setConflict(false);
                  }}
                  disabled={pending}
                />
                <div className="form-field">
                  <label htmlFor="invite-expiry">Invitation expires in</label>
                  <Select
                    value={expiry}
                    onValueChange={(value) => {
                      setExpiry(value);
                      setInvitationId(crypto.randomUUID());
                      setConflict(false);
                    }}
                    disabled={pending}
                  >
                    <SelectTrigger id="invite-expiry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 7, 30].map((days) => (
                        <SelectItem key={days} value={String(days)}>
                          {days} {days === 1 ? "day" : "days"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}
            {edit ? (
              <div className="access-review">
                <strong>
                  {edit.kind === "revoke"
                    ? edit.invitation.email
                    : edit.member.displayName}
                </strong>
                <p>
                  Reviewed role:{" "}
                  {
                    ROLE_LABEL[
                      edit.kind === "revoke"
                        ? edit.invitation.role
                        : edit.member.role
                    ]
                  }
                </p>
              </div>
            ) : null}
            {edit?.kind === "role" ? (
              <RoleField value={role} onChange={setRole} disabled={pending} />
            ) : null}
            {error ? (
              <div id="access-error" role="alert" className="field-error">
                <p>{error}</p>
                {conflict && edit ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void reviewLatest()}
                  >
                    <RefreshCw size={14} />
                    Review latest access
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="access-dialog-actions">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setInviteOpen(false);
                  setEdit(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={
                  edit?.kind === "remove" || edit?.kind === "revoke"
                    ? "destructive"
                    : "default"
                }
                disabled={
                  pending ||
                  (conflict && !inviteOpen) ||
                  (edit?.kind === "role" && role === edit.member.role)
                }
              >
                {pending
                  ? "Saving..."
                  : inviteOpen
                    ? "Create invitation"
                    : edit?.kind === "role"
                      ? "Save role"
                      : edit?.kind === "remove"
                        ? "Remove member"
                        : "Revoke invitation"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
