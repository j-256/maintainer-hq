import {
  CAPABILITY,
  LIMITS,
  workspaceInput,
  type Capability,
  type Principal,
  type Workspace,
} from "../shared/domain";
import {
  AUTOMATION_LIMITS,
  AUTOMATION_SCOPES,
  automationIssueInput,
  automationPlanInput,
  automationRevokeInput,
  type AutomationCredential,
  type AutomationPlan,
  type AutomationPlanFields,
  type IssuedAutomationCredential,
} from "../shared/automation";
import { HQ_CREDENTIAL_PREFIX } from "../shared/credentials";
import { credentialHash } from "./credential-hash";
import { membershipActorGuard } from "./membership-authority";
import { DomainError } from "./errors";

type Context = {
  db: D1Database;
  principal: Principal;
  now: () => number;
  authorize: (
    workspaceId: string,
    capability?: Capability,
  ) => Promise<Workspace>;
};
type ReviewedInput = {
  fields: AutomationPlanFields;
  memberRevision: number;
  tokenId: string | null;
};
const PLAN_KIND = "automation.credential.issue";
const CREDENTIAL_FIELDS =
  "c.id, c.name, c.automation_profile AS profile, c.reporter_id AS reporterId, c.owner_subject AS owner, c.created_at AS createdAt, c.expires_at AS expiresAt, c.revoked_at AS revokedAt";

export class AutomationService {
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
  private async admin(workspaceId: string) {
    await this.context.authorize(workspaceId, CAPABILITY.READ);
    return this.context.authorize(workspaceId, CAPABILITY.ADMIN);
  }
  private guard(workspaceId: string) {
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
      "The review expired, access changed, a limit was reached, or this credential was already issued. Refresh the credential list and review again. A value cannot be retrieved twice; revoke any credential whose value was not saved.",
      409,
    );
  }
  private audit(
    workspaceId: string,
    type: string,
    title: string,
    summary: string,
    writeId: string,
  ) {
    return this.db
      .prepare(
        "INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM credentials WHERE workspace_id=? AND write_id=?)",
      )
      .bind(
        crypto.randomUUID(),
        workspaceId,
        this.principal.subject,
        this.principal.displayName,
        type,
        title,
        summary,
        this.timestamp(),
        workspaceId,
        writeId,
      );
  }
  async list(input: unknown): Promise<AutomationCredential[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.admin(workspaceId);
    const guard = this.guard(workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT ${CREDENTIAL_FIELDS} FROM credentials c WHERE c.workspace_id=? AND c.automation_profile IS NOT NULL AND ${guard.sql} ORDER BY (c.revoked_at IS NULL AND c.expires_at > ?) DESC, c.created_at DESC, c.id DESC LIMIT ?`,
        )
        .bind(
          workspaceId,
          ...guard.values,
          this.timestamp(),
          AUTOMATION_LIMITS.HISTORY,
        )
        .all<AutomationCredential>()
    ).results;
  }
  async plan(input: unknown): Promise<AutomationPlan> {
    const fields = automationPlanInput.parse(input);
    const { workspaceId } = fields;
    const workspace = await this.admin(workspaceId);
    const pending = await this.db
      .prepare(
        "SELECT count(*) AS total FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?",
      )
      .bind(workspaceId, this.principal.subject, PLAN_KIND, this.timestamp())
      .first<number>("total");
    if ((pending ?? 0) >= AUTOMATION_LIMITS.PENDING_PLANS)
      throw new DomainError(
        "capacity",
        "Too many pending credential reviews. Wait for the existing five-minute reviews to expire before starting another.",
        409,
      );
    const member = await this.db
      .prepare(
        "SELECT revision FROM members WHERE workspace_id=? AND subject=?",
      )
      .bind(workspaceId, this.principal.subject)
      .first<{ revision: number }>();
    if (!member) this.conflict();
    const reviewed: ReviewedInput = {
      fields,
      memberRevision: member.revision,
      tokenId: this.principal.tokenId ?? null,
    };
    const serialized = JSON.stringify(reviewed);
    const fingerprint = await credentialHash(serialized);
    const planId = crypto.randomUUID();
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + LIMITS.PLAN_TTL_MS,
    ).toISOString();
    const guard = this.guard(workspaceId);
    const result = await this.db
      .prepare(
        `INSERT INTO action_plans (id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
       SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
       AND EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND revision=?)
       AND NOT EXISTS (SELECT 1 FROM credentials WHERE id=?)
       AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?) < ?`,
      )
      .bind(
        planId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        serialized,
        fingerprint,
        createdAt,
        expiresAt,
        ...guard.values,
        workspaceId,
        this.principal.subject,
        member.revision,
        fields.credentialId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        createdAt,
        AUTOMATION_LIMITS.PENDING_PLANS,
      )
      .run();
    if (!result.meta.changes) this.conflict();
    return {
      ...fields,
      planId,
      fingerprint,
      actor: this.principal.displayName,
      workspaceName: workspace.name,
      scopes: AUTOMATION_SCOPES[fields.profile],
      expiresAt,
    };
  }
  async issue(input: unknown): Promise<IssuedAutomationCredential> {
    const { workspaceId, planId, fingerprint } =
      automationIssueInput.parse(input);
    await this.admin(workspaceId);
    const active = await this.db
      .prepare(
        "SELECT count(*) AS total FROM credentials WHERE workspace_id=? AND automation_profile IS NOT NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .bind(workspaceId, this.timestamp())
      .first<number>("total");
    if ((active ?? 0) >= AUTOMATION_LIMITS.ACTIVE_CREDENTIALS)
      throw new DomainError(
        "capacity",
        "The workspace has reached its active automation credential limit. Review and revoke unused credentials before issuing another.",
        409,
      );
    const plan = await this.db
      .prepare(
        "SELECT input_json AS input, expires_at AS expiresAt FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND fingerprint=? AND applied_at IS NULL",
      )
      .bind(planId, workspaceId, this.principal.subject, PLAN_KIND, fingerprint)
      .first<{ input: string; expiresAt: string }>();
    if (!plan || Date.parse(plan.expiresAt) <= this.context.now())
      this.conflict();
    const reviewed = JSON.parse(plan.input) as ReviewedInput;
    const fields = automationPlanInput.parse(reviewed.fields);
    if (
      fields.workspaceId !== workspaceId ||
      reviewed.tokenId !== (this.principal.tokenId ?? null)
    )
      this.conflict();
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + fields.expiresInDays * AUTOMATION_LIMITS.DAY_MS,
    ).toISOString();
    const token =
      HQ_CREDENTIAL_PREFIX.AUTOMATION +
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    const writeId = crypto.randomUUID();
    const guard = this.guard(workspaceId);
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO credentials (id,workspace_id,owner_subject,name,token_hash,scopes_json,created_at,expires_at,write_id,automation_profile,reporter_id)
         SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
         AND EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND revision=?)
         AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND fingerprint=? AND input_json=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))
         AND (SELECT count(*) FROM credentials WHERE workspace_id=? AND automation_profile IS NOT NULL AND revoked_at IS NULL AND expires_at>?) < ?
         ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          fields.credentialId,
          workspaceId,
          this.principal.subject,
          fields.name,
          await credentialHash(token),
          JSON.stringify(AUTOMATION_SCOPES[fields.profile]),
          createdAt,
          expiresAt,
          writeId,
          fields.profile,
          fields.reporterId,
          ...guard.values,
          workspaceId,
          this.principal.subject,
          reviewed.memberRevision,
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          fingerprint,
          plan.input,
          createdAt,
          workspaceId,
          createdAt,
          AUTOMATION_LIMITS.ACTIVE_CREDENTIALS,
        ),
      this.db
        .prepare(
          "UPDATE action_plans SET applied_at=? WHERE id=? AND EXISTS (SELECT 1 FROM credentials WHERE workspace_id=? AND write_id=?)",
        )
        .bind(createdAt, planId, workspaceId, writeId),
      this.audit(
        workspaceId,
        "automation.credential.issued",
        "Automation credential created",
        fields.name + "; " + fields.profile + "; expires " + expiresAt,
        writeId,
      ),
    ]);
    if (!results[0]?.meta.changes) this.conflict();
    return {
      credential: {
        id: fields.credentialId,
        name: fields.name,
        profile: fields.profile,
        reporterId: fields.reporterId,
        owner: this.principal.subject,
        createdAt,
        expiresAt,
        revokedAt: null,
      },
      token,
    };
  }
  async revoke(input: unknown): Promise<AutomationCredential> {
    const { workspaceId, credentialId } = automationRevokeInput.parse(input);
    await this.admin(workspaceId);
    const guard = this.guard(workspaceId);
    const row = () =>
      this.db
        .prepare(
          `SELECT ${CREDENTIAL_FIELDS} FROM credentials c WHERE c.workspace_id=? AND c.id=? AND c.automation_profile IS NOT NULL AND ${guard.sql}`,
        )
        .bind(workspaceId, credentialId, ...guard.values)
        .first<AutomationCredential>();
    const before = await row();
    if (!before)
      throw new DomainError(
        "not_found",
        "Automation credential not found or access changed",
        404,
      );
    if (before.revokedAt) return before;
    const writeId = crypto.randomUUID();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE credentials SET revoked_at=?, write_id=? WHERE workspace_id=? AND id=? AND automation_profile IS NOT NULL AND revoked_at IS NULL AND ${guard.sql}`,
        )
        .bind(
          this.timestamp(),
          writeId,
          workspaceId,
          credentialId,
          ...guard.values,
        ),
      this.audit(
        workspaceId,
        "automation.credential.revoked",
        "Automation credential revoked",
        before.name,
        writeId,
      ),
    ]);
    const after = await row();
    if (!after?.revokedAt) this.conflict();
    return after;
  }
}
