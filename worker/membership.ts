import {
  CAPABILITY,
  workspaceInput,
  type Capability,
  type Principal,
  type Workspace,
} from "../shared/domain";
import {
  MEMBERSHIP_LIMITS,
  identityInput,
  initialOwnerSetupSchema,
  setupApplyInput,
  invitationCreateInput,
  invitationInput,
  invitationRevokeInput,
  memberRemoveInput,
  memberUpdateInput,
  type Invitation,
  type ManagedMember,
  type OwnInvitation,
  type SetupStatus,
} from "../shared/membership";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import {
  membershipActorGuard,
  INVITER_AUTHORITY_SQL,
} from "./membership-authority";
import type { Env } from "./types";

type Context = {
  env: Env;
  db: D1Database;
  principal: Principal;
  development: boolean;
  now: () => number;
  authorize: (
    workspaceId: string,
    capability?: Capability,
  ) => Promise<Workspace>;
};
type InvitationRow = Invitation & {
  workspaceId: string;
  inviterSubject: string;
  durationDays: number;
  acceptedSubject: string | null;
};
type SetupReceipt = {
  fingerprint: string;
  workspaceId: string;
  ownerSubject: string;
};
const INVITATION_FIELDS =
  "id, workspace_id AS workspaceId, email, role, revision, created_at AS createdAt, expires_at AS expiresAt, state, inviter_subject AS inviterSubject, duration_days AS durationDays, accepted_subject AS acceptedSubject";
const MEMBER_FIELDS = "subject, display_name AS displayName, role, revision";
const OWNER_REMAINS_SQL =
  "(role != 'owner' OR (SELECT count(*) FROM members WHERE workspace_id = ? AND role = 'owner') > 1)";

export class MembershipService {
  constructor(readonly context: Context) {}
  get db() {
    return this.context.db;
  }
  get principal() {
    return this.context.principal;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private human() {
    const { access, tokenId, scopes } = this.principal;
    if (
      this.context.development ||
      tokenId ||
      scopes ||
      !access ||
      access.issuer !== this.context.env.ACCESS_ISSUER ||
      access.audience !== this.context.env.ACCESS_AUDIENCE
    )
      throw new DomainError(
        "forbidden",
        "Sign in with your verified account to use this operation",
        403,
      );
    return access;
  }
  private async admin(workspaceId: string) {
    await this.context.authorize(workspaceId, CAPABILITY.READ);
    await this.context.authorize(workspaceId, CAPABILITY.ADMIN);
    return membershipActorGuard(
      workspaceId,
      this.principal.subject,
      this.principal.tokenId ?? null,
      this.timestamp(),
    );
  }
  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "Access changed or this action is no longer allowed. Your draft is preserved. Refresh and review before trying again. Keep at least one owner.",
      409,
    );
  }
  private audit(
    workspaceId: string,
    type: string,
    title: string,
    summary: string,
    condition: string,
    values: (string | number | null)[],
    eventId = crypto.randomUUID(),
  ) {
    return this.db
      .prepare(
        `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
      SELECT ?,?,?,?,?,?,?,NULL,? WHERE ${condition}`,
      )
      .bind(
        eventId,
        workspaceId,
        this.principal.subject,
        this.principal.displayName,
        type,
        title,
        summary,
        this.timestamp(),
        ...values,
      );
  }
  private async receipt() {
    return this.db
      .prepare(
        "SELECT fingerprint, workspace_id AS workspaceId, owner_subject AS ownerSubject FROM installation_setup WHERE singleton=1",
      )
      .first<SetupReceipt>();
  }
  private async permit() {
    const access = this.human();
    const raw = this.context.env.INITIAL_OWNER_SETUP;
    if (!raw) return null;
    let input: unknown;
    try {
      if (new TextEncoder().encode(raw).length > MEMBERSHIP_LIMITS.SETUP_BYTES)
        throw new Error();
      input = JSON.parse(raw);
    } catch {
      throw new DomainError(
        "configuration",
        "Owner setup is not configured correctly. Contact the deployment operator.",
        503,
      );
    }
    const result = initialOwnerSetupSchema.safeParse(input);
    if (!result.success)
      throw new DomainError(
        "configuration",
        "Owner setup is not configured correctly. Contact the deployment operator.",
        503,
      );
    const permit = result.data;
    if (permit.ownerSubject !== this.principal.subject) return null;
    const issued = Date.parse(permit.issuedAt);
    const expires = Date.parse(permit.expiresAt);
    if (
      issued > this.context.now() ||
      expires <= this.context.now() ||
      expires <= issued ||
      expires - issued > MEMBERSHIP_LIMITS.SETUP_TTL_MS
    )
      throw new DomainError(
        "setup_expired",
        "Owner setup has expired or is outside its approved time window. Ask the deployment operator for a new permit.",
        409,
      );
    return {
      ...permit,
      fingerprint: await credentialHash(
        JSON.stringify({
          ...permit,
          issuer: access.issuer,
          audience: access.audience,
        }),
      ),
    };
  }
  async setupStatus(input: unknown): Promise<SetupStatus> {
    identityInput.parse(input);
    if (
      this.context.development ||
      !this.principal.access ||
      this.principal.tokenId
    )
      return { state: "unavailable" };
    this.human();
    const receipt = await this.receipt();
    if (receipt)
      return receipt.ownerSubject === this.principal.subject
        ? { state: "complete", workspaceId: receipt.workspaceId }
        : { state: "unavailable" };
    const permit = await this.permit();
    if (
      !permit ||
      (await this.db.prepare("SELECT id FROM workspaces LIMIT 1").first())
    )
      return { state: "unavailable" };
    return {
      state: "ready",
      fingerprint: permit.fingerprint,
      workspaceId: permit.workspaceId,
      workspaceName: permit.workspaceName,
      owner: this.principal.displayName,
      expiresAt: permit.expiresAt,
    };
  }
  async setupApply(input: unknown): Promise<SetupStatus> {
    const { fingerprint } = setupApplyInput.parse(input);
    this.human();
    const existing = await this.receipt();
    if (existing) {
      if (
        existing.fingerprint !== fingerprint ||
        existing.ownerSubject !== this.principal.subject
      )
        this.conflict();
      return { state: "complete", workspaceId: existing.workspaceId };
    }
    const permit = await this.permit();
    if (!permit || permit.fingerprint !== fingerprint) this.conflict();
    const writeId = crypto.randomUUID();
    const time = this.timestamp();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO installation_setup (singleton,setup_id,fingerprint,workspace_id,owner_subject,completed_at,write_id)
        SELECT 1,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workspaces) AND NOT EXISTS (SELECT 1 FROM members)
        AND julianday(?) > julianday('now') ON CONFLICT (singleton) DO NOTHING`,
        )
        .bind(
          permit.setupId,
          fingerprint,
          permit.workspaceId,
          this.principal.subject,
          time,
          writeId,
          permit.expiresAt,
        ),
      this.db
        .prepare(
          "INSERT INTO workspaces (id,name,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM installation_setup WHERE write_id=?)",
        )
        .bind(permit.workspaceId, permit.workspaceName, time, writeId),
      this.db
        .prepare(
          "INSERT INTO members (workspace_id,subject,display_name,role,write_id) SELECT ?,?,?,'owner',? WHERE EXISTS (SELECT 1 FROM installation_setup WHERE write_id=?)",
        )
        .bind(
          permit.workspaceId,
          this.principal.subject,
          this.principal.displayName,
          writeId,
          writeId,
        ),
      this.audit(
        permit.workspaceId,
        "workspace.initialized",
        "Workspace initialized",
        "The deployment-approved account accepted first ownership.",
        "EXISTS (SELECT 1 FROM installation_setup WHERE write_id=?)",
        [writeId],
      ),
    ]);
    const receipt = await this.receipt();
    if (
      !receipt ||
      receipt.fingerprint !== fingerprint ||
      receipt.ownerSubject !== this.principal.subject
    )
      this.conflict();
    return { state: "complete", workspaceId: receipt.workspaceId };
  }
  async list(input: unknown): Promise<ManagedMember[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.admin(workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT ${MEMBER_FIELDS} FROM members WHERE workspace_id=? ORDER BY display_name,subject LIMIT ?`,
        )
        .bind(workspaceId, MEMBERSHIP_LIMITS.MEMBERS)
        .all<ManagedMember>()
    ).results;
  }
  async update(input: unknown) {
    const { workspaceId, subject, revision, role } =
      memberUpdateInput.parse(input);
    const guard = await this.admin(workspaceId);
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE members SET role=?, revision=revision+1, write_id=? WHERE workspace_id=? AND subject=? AND revision=?
        AND ${guard.sql} AND (? = 'owner' OR ${OWNER_REMAINS_SQL})`,
        )
        .bind(
          role,
          writeId,
          workspaceId,
          subject,
          revision,
          ...guard.values,
          role,
          workspaceId,
        ),
      this.db
        .prepare(
          "UPDATE invitations SET state='revoked',revision=revision+1 WHERE workspace_id=? AND inviter_subject=? AND state='pending' AND ? != 'owner' AND EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND write_id=?)",
        )
        .bind(workspaceId, subject, role, workspaceId, subject, writeId),
      this.audit(
        workspaceId,
        "member.updated",
        "Member role changed",
        "A workspace member was assigned the " + role + " role.",
        "EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND write_id=?)",
        [workspaceId, subject, writeId],
      ),
    ]);
    if (!results[0].meta.changes) this.conflict();
    return { subject, role, revision: revision + 1 };
  }
  async remove(input: unknown) {
    const { workspaceId, subject, revision } = memberRemoveInput.parse(input);
    const guard = await this.admin(workspaceId);
    const eventId = crypto.randomUUID();
    const applied =
      "EXISTS (SELECT 1 FROM activity WHERE id=? AND workspace_id=?)";
    const results = await this.db.batch([
      this.audit(
        workspaceId,
        "member.removed",
        "Workspace access removed",
        "A member was removed and their workspace credentials and pending invitations were revoked.",
        `EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND revision=? AND ${OWNER_REMAINS_SQL}) AND ${guard.sql}`,
        [workspaceId, subject, revision, workspaceId, ...guard.values],
        eventId,
      ),
      this.db
        .prepare(
          `UPDATE credentials SET revoked_at=? WHERE workspace_id=? AND owner_subject=? AND revoked_at IS NULL AND ${applied}`,
        )
        .bind(this.timestamp(), workspaceId, subject, eventId, workspaceId),
      this.db
        .prepare(
          `UPDATE invitations SET state='revoked',revision=revision+1 WHERE workspace_id=? AND inviter_subject=? AND state='pending' AND ${applied}`,
        )
        .bind(workspaceId, subject, eventId, workspaceId),
      this.db
        .prepare(
          `INSERT INTO member_generations (workspace_id,subject,next_revision) SELECT ?,?,? WHERE ${applied}
        ON CONFLICT (workspace_id,subject) DO UPDATE SET next_revision=max(next_revision,excluded.next_revision)`,
        )
        .bind(workspaceId, subject, revision + 1, eventId, workspaceId),
      this.db
        .prepare(
          `DELETE FROM members WHERE workspace_id=? AND subject=? AND revision=? AND ${applied}`,
        )
        .bind(workspaceId, subject, revision, eventId, workspaceId),
    ]);
    if (!results[0].meta.changes) this.conflict();
    return { removed: true };
  }
  async invitations(input: unknown): Promise<Invitation[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.admin(workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT id,email,role,revision,created_at AS createdAt,expires_at AS expiresAt,
      CASE WHEN state='pending' AND julianday(expires_at)<=julianday(?) THEN 'expired' ELSE state END AS state
      FROM invitations WHERE workspace_id=? ORDER BY (state='pending' AND julianday(expires_at)>julianday(?)) DESC,created_at DESC,id LIMIT ?`,
        )
        .bind(
          this.timestamp(),
          workspaceId,
          this.timestamp(),
          MEMBERSHIP_LIMITS.HISTORY,
        )
        .all<Invitation>()
    ).results;
  }
  async invite(input: unknown): Promise<Invitation> {
    const parsed = invitationCreateInput.parse(input);
    const { workspaceId, invitationId, email, role, expiresInDays } = parsed;
    const guard = await this.admin(workspaceId);
    const writeId = crypto.randomUUID();
    const time = this.timestamp();
    const expires = new Date(
      this.context.now() + expiresInDays * 86400000,
    ).toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE invitations SET state='expired',revision=revision+1 WHERE workspace_id=? AND state='pending'
        AND julianday(expires_at)<=julianday(?) AND ${guard.sql}`,
        )
        .bind(workspaceId, time, ...guard.values),
      this.db
        .prepare(
          `INSERT INTO invitations (id,workspace_id,email,role,inviter_subject,inviter_token_id,duration_days,created_at,expires_at,state,write_id)
        SELECT ?,?,?,?,?,?,?,?,?,'pending',? WHERE ${guard.sql}
        AND (SELECT count(*) FROM invitations WHERE workspace_id=? AND state='pending') < ?
        AND (SELECT count(*) FROM members WHERE workspace_id=?) < ?
        AND NOT EXISTS (SELECT 1 FROM invitations WHERE workspace_id=? AND email=? AND state='pending')
        ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          invitationId,
          workspaceId,
          email,
          role,
          this.principal.subject,
          this.principal.tokenId ?? null,
          expiresInDays,
          time,
          expires,
          writeId,
          ...guard.values,
          workspaceId,
          MEMBERSHIP_LIMITS.PENDING_INVITATIONS,
          workspaceId,
          MEMBERSHIP_LIMITS.MEMBERS,
          workspaceId,
          email,
        ),
      this.audit(
        workspaceId,
        "invitation.created",
        "Member invited",
        "An account was invited with the " +
          role +
          " role. Invitation details are restricted to owners and the recipient.",
        "EXISTS (SELECT 1 FROM invitations WHERE workspace_id=? AND id=? AND write_id=?)",
        [workspaceId, invitationId, writeId],
      ),
    ]);
    const row = await this.db
      .prepare(
        `SELECT ${INVITATION_FIELDS} FROM invitations WHERE workspace_id=? AND id=?`,
      )
      .bind(workspaceId, invitationId)
      .first<InvitationRow>();
    if (
      !row ||
      row.email !== email ||
      row.role !== role ||
      row.durationDays !== expiresInDays ||
      row.inviterSubject !== this.principal.subject
    )
      this.conflict();
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      revision: row.revision,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      state: row.state,
    };
  }
  async revoke(input: unknown) {
    const { workspaceId, invitationId, revision } =
      invitationRevokeInput.parse(input);
    const guard = await this.admin(workspaceId);
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE invitations SET state='revoked',revision=revision+1,write_id=? WHERE workspace_id=? AND id=? AND revision=? AND state='pending' AND ${guard.sql}`,
        )
        .bind(writeId, workspaceId, invitationId, revision, ...guard.values),
      this.audit(
        workspaceId,
        "invitation.revoked",
        "Invitation revoked",
        "A pending workspace invitation was revoked.",
        "EXISTS (SELECT 1 FROM invitations WHERE workspace_id=? AND id=? AND write_id=?)",
        [workspaceId, invitationId, writeId],
      ),
    ]);
    if (!results[0].meta.changes) this.conflict();
    return { revoked: true };
  }
  async ownInvitations(input: unknown): Promise<OwnInvitation[]> {
    identityInput.parse(input);
    if (
      this.context.development ||
      !this.principal.access ||
      this.principal.tokenId
    )
      return [];
    const access = this.human();
    if (!access.email) return [];
    return (
      await this.db
        .prepare(
          `SELECT i.id,i.role,i.revision,i.expires_at AS expiresAt,i.workspace_id AS workspaceId,w.name AS workspaceName
      FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.email=? AND i.state='pending' AND i.expires_at>?
      AND julianday(i.expires_at)>julianday('now') AND ${INVITER_AUTHORITY_SQL}
      AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=i.workspace_id AND subject=?)
      ORDER BY i.created_at DESC LIMIT ?`,
        )
        .bind(
          access.email,
          this.timestamp(),
          this.principal.subject,
          MEMBERSHIP_LIMITS.HISTORY,
        )
        .all<OwnInvitation>()
    ).results;
  }
  async accept(input: unknown) {
    const { invitationId, revision } = invitationInput.parse(input);
    const access = this.human();
    if (!access.email)
      throw new DomainError(
        "forbidden",
        "A verified account email is required to accept an invitation",
        403,
      );
    const row = await this.db
      .prepare(
        `SELECT ${INVITATION_FIELDS} FROM invitations WHERE id=? AND email=?`,
      )
      .bind(invitationId, access.email)
      .first<InvitationRow>();
    if (!row) throw new DomainError("not_found", "Invitation not found", 404);
    const writeId = crypto.randomUUID();
    const memberExists = await this.db
      .prepare("SELECT subject FROM members WHERE workspace_id=? AND subject=?")
      .bind(row.workspaceId, this.principal.subject)
      .first();
    if (
      row.state === "accepted" &&
      row.acceptedSubject === this.principal.subject &&
      memberExists &&
      row.revision === revision + 1
    )
      return { workspaceId: row.workspaceId };
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE invitations AS i SET state='accepted',accepted_subject=?,revision=revision+1,write_id=?
        WHERE i.id=? AND i.email=? AND i.revision=? AND i.state='pending' AND i.expires_at>?
        AND julianday(i.expires_at)>julianday('now') AND ${INVITER_AUTHORITY_SQL}
        AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=i.workspace_id AND subject=?)
        AND (SELECT count(*) FROM members WHERE workspace_id=i.workspace_id) < ?`,
        )
        .bind(
          this.principal.subject,
          writeId,
          invitationId,
          access.email,
          revision,
          this.timestamp(),
          this.principal.subject,
          MEMBERSHIP_LIMITS.MEMBERS,
        ),
      this.db
        .prepare(
          "INSERT INTO members (workspace_id,subject,display_name,role,write_id,revision) SELECT i.workspace_id,?,?,i.role,?,coalesce((SELECT next_revision FROM member_generations WHERE workspace_id=i.workspace_id AND subject=?),1) FROM invitations i WHERE i.id=? AND i.write_id=?",
        )
        .bind(
          this.principal.subject,
          this.principal.displayName,
          writeId,
          this.principal.subject,
          invitationId,
          writeId,
        ),
      this.audit(
        row.workspaceId,
        "invitation.accepted",
        "Member joined",
        "A verified account accepted its workspace invitation.",
        "EXISTS (SELECT 1 FROM invitations WHERE id=? AND write_id=?)",
        [invitationId, writeId],
      ),
    ]);
    if (!results[0].meta.changes) {
      const accepted = await this.db
        .prepare(
          "SELECT i.workspace_id FROM invitations i JOIN members m ON m.workspace_id=i.workspace_id AND m.subject=i.accepted_subject WHERE i.id=? AND i.accepted_subject=? AND i.state='accepted' AND i.revision=?",
        )
        .bind(invitationId, this.principal.subject, revision + 1)
        .first();
      if (!accepted) this.conflict();
    }
    return { workspaceId: row.workspaceId };
  }
}
