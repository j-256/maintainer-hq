import {
  CAPABILITY,
  LIMITS,
  type Capability,
  type Connection,
  type Principal,
  type Workspace,
} from "../shared/domain";
import {
  SOURCE_LIMITS,
  enrollSourceInput,
  updateSourceInput,
  sourceInput,
  issuePublisherCredentialInput,
  revokePublisherCredentialInput,
  publishObservationsInput,
  type SourceFields,
  type PublisherCredential,
  type PublicationReceipt,
} from "../shared/sources";
import { HQ_CREDENTIAL_PREFIX } from "../shared/credentials";
import { credentialHash } from "./credential-hash";
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
type SourceRow = {
  id: string;
  name: string;
  revision: number;
  enabled: number;
  freshness_minutes: number;
  last_success_at: string | null;
};
const CREDENTIAL_FIELDS =
  "id, name, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt";
const SOURCE_FIELDS =
  "id, name, revision, enabled, freshness_minutes, last_success_at";

const ACCEPT_REPORT_SQL = [
  "INSERT INTO publisher_reports (workspace_id, source_id, report_id, input_hash, received_at, accepted, changed, write_id)",
  "SELECT ?, ?, ?, ?, ?, ?,",
  "(SELECT count(*) FROM json_each(?) j LEFT JOIN observations o",
  "ON o.workspace_id = ? AND o.source_id = ? AND o.resource_type = 'repository' AND o.resource_id = json_extract(j.value, '$.repositoryId')",
  "WHERE o.resource_id IS NULL OR o.details_json != json_extract(j.value, '$.details')), ?",
  "WHERE EXISTS (SELECT 1 FROM connections s",
  "JOIN credentials c ON c.workspace_id = s.workspace_id AND c.source_id = s.id",
  "JOIN members m ON m.workspace_id = c.workspace_id AND m.subject = c.owner_subject",
  "WHERE s.workspace_id = ? AND s.id = ? AND s.revision = ? AND s.enabled = 1",
  "AND c.id = ? AND c.owner_subject = ? AND c.revoked_at IS NULL",
  "AND c.expires_at > ? AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  "AND c.scopes_json = ? AND m.role IN ('owner', 'operator')",
  "AND (s.last_success_at IS NULL OR s.last_success_at <= ?))",
  "AND NOT EXISTS (SELECT 1 FROM observations o JOIN json_each(?) j",
  "ON o.resource_id = json_extract(j.value, '$.repositoryId')",
  "WHERE o.workspace_id = ? AND o.source_id = ? AND o.resource_type = 'repository'",
  "AND julianday(o.observed_at) >= julianday(json_extract(j.value, '$.observedAt')))",
  "AND (SELECT count(*) FROM observations WHERE workspace_id = ?) +",
  "(SELECT count(*) FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM observations o",
  "WHERE o.workspace_id = ? AND o.source_id = ? AND o.resource_type = 'repository'",
  "AND o.resource_id = json_extract(j.value, '$.repositoryId'))) <= ?",
  "ON CONFLICT (workspace_id, source_id, report_id) DO NOTHING",
].join(" ");

export class SourceService {
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
    await this.context.authorize(workspaceId, CAPABILITY.ADMIN);
    await this.context.authorize(workspaceId, CAPABILITY.READ);
  }

  private async row(workspaceId: string, sourceId: string) {
    const row = await this.db
      .prepare(
        `SELECT ${SOURCE_FIELDS} FROM connections WHERE workspace_id = ? AND id = ? AND provider = 'local'`,
      )
      .bind(workspaceId, sourceId)
      .first<SourceRow>();
    if (!row)
      throw new DomainError("not_found", "Publisher source not found", 404);
    return row;
  }

  async repositoryIds(workspaceId: string, sourceId: string) {
    return (
      await this.db
        .prepare(
          "SELECT repository_id AS id FROM source_repositories WHERE workspace_id = ? AND source_id = ? ORDER BY repository_id",
        )
        .bind(workspaceId, sourceId)
        .all<{ id: string }>()
    ).results.map((item) => item.id);
  }

  private async validateRepositories(workspaceId: string, ids: string[]) {
    const count = await this.db
      .prepare(
        "SELECT count(*) AS total FROM repositories WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(workspaceId, JSON.stringify(ids))
      .first<{ total: number }>();
    if (count?.total !== ids.length)
      throw new DomainError(
        "validation",
        "Choose repositories enrolled in this workspace",
        400,
      );
  }

  private audit(
    workspaceId: string,
    type: string,
    title: string,
    summary: string,
    table: "connections" | "credentials" | "publisher_reports",
    writeId: string,
  ) {
    return this.db
      .prepare(
        `INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = ? AND write_id = ?${table === "publisher_reports" ? " AND changed > 0" : ""})`,
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

  private scopeInsert(
    workspaceId: string,
    sourceId: string,
    repositoryIds: string[],
    writeId: string,
  ) {
    return this.db
      .prepare(
        "INSERT INTO source_repositories (workspace_id, source_id, repository_id) SELECT ?, ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)",
      )
      .bind(
        workspaceId,
        sourceId,
        JSON.stringify(repositoryIds),
        workspaceId,
        sourceId,
        writeId,
      );
  }

  async get(input: unknown): Promise<Connection> {
    const { workspaceId, sourceId } = sourceInput.parse(input);
    await this.context.authorize(workspaceId);
    const row = await this.row(workspaceId, sourceId);
    const credential = await this.db
      .prepare(
        "SELECT c.id FROM credentials c JOIN members m ON m.workspace_id = c.workspace_id AND m.subject = c.owner_subject WHERE c.workspace_id = ? AND c.source_id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND m.role IN ('owner', 'operator') LIMIT 1",
      )
      .bind(workspaceId, sourceId, this.timestamp())
      .first();
    return {
      id: row.id,
      name: row.name,
      provider: "local",
      revision: row.revision,
      enabled: Boolean(row.enabled),
      freshnessMinutes: row.freshness_minutes,
      repositoryIds: await this.repositoryIds(workspaceId, sourceId),
      lastAttemptAt: row.last_success_at,
      lastSuccessAt: row.last_success_at,
      lastError: null,
      credentialConfigured: Boolean(credential),
    };
  }

  async enroll(input: unknown) {
    const { workspaceId, sourceId, source } = enrollSourceInput.parse(input);
    await this.admin(workspaceId);
    await this.validateRepositories(workspaceId, source.repositoryIds);
    const existing = await this.db
      .prepare("SELECT id FROM connections WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, sourceId)
      .first();
    if (existing) return this.enrollmentRetry(workspaceId, sourceId, source);
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO connections (id, workspace_id, name, provider, enabled, freshness_minutes, write_id) SELECT ?, ?, ?, 'local', ?, ?, ? WHERE (SELECT count(*) FROM connections WHERE workspace_id = ?) < ? ON CONFLICT (workspace_id, id) DO NOTHING",
        )
        .bind(
          sourceId,
          workspaceId,
          source.name,
          Number(source.enabled),
          source.freshnessMinutes,
          writeId,
          workspaceId,
          SOURCE_LIMITS.SOURCES,
        ),
      this.scopeInsert(workspaceId, sourceId, source.repositoryIds, writeId),
      this.audit(
        workspaceId,
        "source.enrolled",
        "Publisher enrolled",
        source.name + ": reports are limited to the selected repositories",
        "connections",
        writeId,
      ),
    ]);
    if (!results[0]?.meta.changes) {
      const exists = await this.db
        .prepare("SELECT id FROM connections WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, sourceId)
        .first();
      if (exists) return this.enrollmentRetry(workspaceId, sourceId, source);
      throw new DomainError("capacity", "Workspace source limit reached", 409);
    }
    return this.get({ workspaceId, sourceId });
  }

  private async enrollmentRetry(
    workspaceId: string,
    sourceId: string,
    source: SourceFields,
  ) {
    const existing = await this.get({ workspaceId, sourceId });
    if (
      existing.revision !== 1 ||
      existing.name !== source.name ||
      existing.enabled !== source.enabled ||
      existing.freshnessMinutes !== source.freshnessMinutes ||
      JSON.stringify(existing.repositoryIds) !==
        JSON.stringify([...source.repositoryIds].sort())
    ) {
      throw new DomainError(
        "conflict",
        "This source ID already exists with different settings. Inspect the source before retrying.",
        409,
      );
    }
    return existing;
  }

  async update(input: unknown) {
    const { workspaceId, sourceId, source, revision } =
      updateSourceInput.parse(input);
    await this.admin(workspaceId);
    await this.row(workspaceId, sourceId);
    await this.validateRepositories(workspaceId, source.repositoryIds);
    const writeId = crypto.randomUUID();
    const timestamp = this.timestamp();
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE connections SET name = ?, enabled = ?, freshness_minutes = ?, revision = revision + 1, write_id = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND provider = 'local'",
        )
        .bind(
          source.name,
          Number(source.enabled),
          source.freshnessMinutes,
          writeId,
          workspaceId,
          sourceId,
          revision,
        ),
      this.db
        .prepare(
          "DELETE FROM source_repositories WHERE workspace_id = ? AND source_id = ? AND EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)",
        )
        .bind(workspaceId, sourceId, workspaceId, sourceId, writeId),
      this.scopeInsert(workspaceId, sourceId, source.repositoryIds, writeId),
      this.db
        .prepare(
          "UPDATE observations SET expires_at = min(expires_at, strftime('%Y-%m-%dT%H:%M:%fZ', julianday(observed_at) + ? / 1440.0), CASE WHEN ? = 0 OR resource_id NOT IN (SELECT value FROM json_each(?)) THEN ? ELSE expires_at END) WHERE workspace_id = ? AND source_id = ? AND EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND write_id = ?)",
        )
        .bind(
          source.freshnessMinutes,
          Number(source.enabled),
          JSON.stringify(source.repositoryIds),
          timestamp,
          workspaceId,
          sourceId,
          workspaceId,
          sourceId,
          writeId,
        ),
      this.audit(
        workspaceId,
        "source.updated",
        "Publisher settings saved",
        source.name +
          (source.enabled
            ? ": scope and freshness policy apply to every credential"
            : ": publishing disabled and existing evidence expired"),
        "connections",
        writeId,
      ),
    ]);
    if (!results[0]?.meta.changes)
      throw new DomainError(
        "revision_conflict",
        "This source changed while you were editing. Your draft has been preserved.",
        409,
      );
    return this.get({ workspaceId, sourceId });
  }

  async credentials(input: unknown): Promise<PublisherCredential[]> {
    const { workspaceId, sourceId } = sourceInput.parse(input);
    await this.admin(workspaceId);
    await this.row(workspaceId, sourceId);
    return (
      await this.db
        .prepare(
          `SELECT ${CREDENTIAL_FIELDS} FROM credentials WHERE workspace_id = ? AND source_id = ? ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC, id DESC LIMIT ?`,
        )
        .bind(workspaceId, sourceId, this.timestamp(), LIMITS.PAGE_SIZE)
        .all<PublisherCredential>()
    ).results;
  }

  async issue(input: unknown) {
    const {
      workspaceId,
      sourceId,
      revision,
      credentialId,
      name,
      expiresInDays,
    } = issuePublisherCredentialInput.parse(input);
    await this.admin(workspaceId);
    const source = await this.row(workspaceId, sourceId);
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.context.now() + expiresInDays * SOURCE_LIMITS.DAY_MS,
    ).toISOString();
    const token =
      HQ_CREDENTIAL_PREFIX.PUBLISHER +
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    const writeId = crypto.randomUUID();
    const results = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO credentials (id, workspace_id, owner_subject, name, token_hash, scopes_json, source_id, created_at, expires_at, write_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE workspace_id = ? AND id = ? AND revision = ? AND enabled = 1 AND provider = 'local') AND (SELECT count(*) FROM credentials WHERE workspace_id = ? AND source_id = ? AND revoked_at IS NULL AND expires_at > ?) < ? ON CONFLICT (id) DO NOTHING",
        )
        .bind(
          credentialId,
          workspaceId,
          this.principal.subject,
          name,
          await credentialHash(token),
          JSON.stringify([CAPABILITY.PUBLISH]),
          sourceId,
          createdAt,
          expiresAt,
          writeId,
          workspaceId,
          sourceId,
          revision,
          workspaceId,
          sourceId,
          createdAt,
          SOURCE_LIMITS.ACTIVE_CREDENTIALS,
        ),
      this.audit(
        workspaceId,
        "publisher.credential.issued",
        "Publisher credential created",
        source.name + ": " + name + "; expires " + expiresAt,
        "credentials",
        writeId,
      ),
    ]);
    if (!results[0]?.meta.changes)
      throw new DomainError(
        "conflict",
        "Credential not created. Refresh the source and inspect its credentials. A previously issued value cannot be retrieved; revoke it before creating a replacement.",
        409,
      );
    return {
      credential: {
        id: credentialId,
        name,
        createdAt,
        expiresAt,
        revokedAt: null,
      },
      token,
    };
  }

  async revoke(input: unknown): Promise<PublisherCredential> {
    const { workspaceId, sourceId, credentialId } =
      revokePublisherCredentialInput.parse(input);
    await this.admin(workspaceId);
    const source = await this.row(workspaceId, sourceId);
    const before = await this.db
      .prepare(
        `SELECT ${CREDENTIAL_FIELDS} FROM credentials WHERE workspace_id = ? AND source_id = ? AND id = ?`,
      )
      .bind(workspaceId, sourceId, credentialId)
      .first<PublisherCredential>();
    if (!before)
      throw new DomainError("not_found", "Publisher credential not found", 404);
    if (before.revokedAt) return before;
    const writeId = crypto.randomUUID();
    const timestamp = this.timestamp();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE credentials SET revoked_at = ?, write_id = ? WHERE workspace_id = ? AND source_id = ? AND id = ? AND revoked_at IS NULL",
        )
        .bind(timestamp, writeId, workspaceId, sourceId, credentialId),
      this.audit(
        workspaceId,
        "publisher.credential.revoked",
        "Publisher credential revoked",
        source.name + ": " + before.name,
        "credentials",
        writeId,
      ),
    ]);
    return (await this.db
      .prepare(
        `SELECT ${CREDENTIAL_FIELDS} FROM credentials WHERE workspace_id = ? AND source_id = ? AND id = ?`,
      )
      .bind(workspaceId, sourceId, credentialId)
      .first<PublisherCredential>())!;
  }

  async publish(input: unknown): Promise<PublicationReceipt> {
    const parsed = publishObservationsInput.parse(input);
    const { workspaceId, sourceId, reportId } = parsed;
    await this.context.authorize(workspaceId, CAPABILITY.PUBLISH);
    if (this.principal.sourceId !== sourceId)
      throw new DomainError(
        "forbidden",
        "This credential belongs to a different publisher source",
        403,
      );
    const source = await this.row(workspaceId, sourceId);
    if (!source.enabled)
      throw new DomainError(
        "forbidden",
        "Publishing is disabled for this source",
        403,
      );
    const timestamp = this.timestamp();
    const valid = await this.db
      .prepare(
        "SELECT c.id FROM credentials c JOIN members m ON m.workspace_id = c.workspace_id AND m.subject = c.owner_subject WHERE c.workspace_id = ? AND c.id = ? AND c.source_id = ? AND c.owner_subject = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND c.scopes_json = ? AND m.role IN ('owner', 'operator')",
      )
      .bind(
        workspaceId,
        this.principal.tokenId,
        sourceId,
        this.principal.subject,
        timestamp,
        JSON.stringify([CAPABILITY.PUBLISH]),
      )
      .first();
    if (!valid)
      throw new DomainError(
        "unauthorized",
        "This publisher credential is no longer valid",
        401,
      );
    const permitted = new Set(await this.repositoryIds(workspaceId, sourceId));
    const observations = parsed.observations
      .map((item) => ({
        ...item,
        observedAt: new Date(item.observedAt).toISOString(),
      }))
      .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
    for (const item of observations) {
      if (!permitted.has(item.repositoryId))
        throw new DomainError(
          "forbidden",
          "This report includes a repository outside the publisher scope",
          403,
        );
      if (
        Date.parse(item.observedAt) >
        this.context.now() + LIMITS.FUTURE_SKEW_MS
      )
        throw new DomainError(
          "validation",
          "An observation timestamp is too far in the future",
          400,
        );
    }
    const inputHash = await credentialHash(JSON.stringify(observations));
    const previous = await this.receipt(
      workspaceId,
      sourceId,
      reportId,
      inputHash,
    );
    if (previous) return previous;
    this.checkReportInterval(source.last_success_at);
    const rows = observations.map((item) => ({
      repositoryId: item.repositoryId,
      observedAt: item.observedAt,
      expiresAt: new Date(
        Math.min(Date.parse(item.observedAt), this.context.now()) +
          source.freshness_minutes * SOURCE_LIMITS.MINUTE_MS,
      ).toISOString(),
      health: item.dirty || item.ahead ? "warning" : "healthy",
      summary: item.dirty
        ? "Local checkout has uncommitted changes"
        : item.ahead
          ? "Local checkout has commits to publish"
          : "Local checkout is clean with no commits ahead",
      details: JSON.stringify({
        branch: item.branch,
        dirty: item.dirty,
        ahead: item.ahead,
      }),
    }));
    const json = JSON.stringify(rows);
    const writeId = crypto.randomUUID();
    const cutoff = new Date(
      this.context.now() - SOURCE_LIMITS.REPORT_INTERVAL_MS,
    ).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(ACCEPT_REPORT_SQL)
        .bind(
          workspaceId,
          sourceId,
          reportId,
          inputHash,
          timestamp,
          rows.length,
          json,
          workspaceId,
          sourceId,
          writeId,
          workspaceId,
          sourceId,
          source.revision,
          this.principal.tokenId,
          this.principal.subject,
          timestamp,
          JSON.stringify([CAPABILITY.PUBLISH]),
          cutoff,
          json,
          workspaceId,
          sourceId,
          workspaceId,
          json,
          workspaceId,
          sourceId,
          LIMITS.MAX_OBSERVATIONS,
        ),
      this.db
        .prepare(
          "INSERT INTO observations (workspace_id, source_id, resource_type, resource_id, name, health, summary, details_json, observed_at, received_at, expires_at) SELECT ?, ?, 'repository', r.id, r.full_name, json_extract(j.value, '$.health'), json_extract(j.value, '$.summary'), json_extract(j.value, '$.details'), json_extract(j.value, '$.observedAt'), ?, json_extract(j.value, '$.expiresAt') FROM json_each(?) j JOIN repositories r ON r.workspace_id = ? AND r.id = json_extract(j.value, '$.repositoryId') WHERE EXISTS (SELECT 1 FROM publisher_reports WHERE workspace_id = ? AND source_id = ? AND report_id = ? AND write_id = ?) ON CONFLICT (workspace_id, source_id, resource_type, resource_id) DO UPDATE SET name = excluded.name, health = excluded.health, summary = excluded.summary, details_json = excluded.details_json, observed_at = excluded.observed_at, received_at = excluded.received_at, expires_at = excluded.expires_at",
        )
        .bind(
          workspaceId,
          sourceId,
          timestamp,
          json,
          workspaceId,
          workspaceId,
          sourceId,
          reportId,
          writeId,
        ),
      this.db
        .prepare(
          "UPDATE connections SET last_attempt_at = ?, last_success_at = ?, last_error = NULL WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM publisher_reports WHERE workspace_id = ? AND source_id = ? AND report_id = ? AND write_id = ?)",
        )
        .bind(
          timestamp,
          timestamp,
          workspaceId,
          sourceId,
          workspaceId,
          sourceId,
          reportId,
          writeId,
        ),
      this.audit(
        workspaceId,
        "source.reported",
        "Local checkout observations updated",
        source.name + ": " + rows.length + " repositories reported",
        "publisher_reports",
        writeId,
      ),
      this.db
        .prepare(
          "DELETE FROM publisher_reports WHERE workspace_id = ? AND source_id = ? AND received_at < ?",
        )
        .bind(
          workspaceId,
          sourceId,
          new Date(
            this.context.now() -
              SOURCE_LIMITS.RECEIPT_DAYS * SOURCE_LIMITS.DAY_MS,
          ).toISOString(),
        ),
    ]);
    if (!results[0]?.meta.changes) {
      const concurrent = await this.receipt(
        workspaceId,
        sourceId,
        reportId,
        inputHash,
      );
      if (concurrent) return concurrent;
      this.checkReportInterval(
        (await this.row(workspaceId, sourceId)).last_success_at,
      );
      throw new DomainError(
        "conflict",
        "Report not accepted. Wait at least five seconds between reports, use newer observation times, and check that the source scope and credential remain valid. Workspace observation limits also apply.",
        409,
      );
    }
    return { reportId, sourceId, receivedAt: timestamp, accepted: rows.length };
  }

  private checkReportInterval(lastSuccessAt: string | null) {
    if (
      lastSuccessAt &&
      Date.parse(lastSuccessAt) >
        this.context.now() - SOURCE_LIMITS.REPORT_INTERVAL_MS
    )
      throw new DomainError(
        "rate_limited",
        "Wait at least five seconds between new reports from this source. Retry the same report ID and content after that interval.",
        429,
      );
  }

  private async receipt(
    workspaceId: string,
    sourceId: string,
    reportId: string,
    inputHash: string,
  ) {
    const row = await this.db
      .prepare(
        "SELECT report_id AS reportId, source_id AS sourceId, received_at AS receivedAt, accepted, input_hash AS inputHash FROM publisher_reports WHERE workspace_id = ? AND source_id = ? AND report_id = ?",
      )
      .bind(workspaceId, sourceId, reportId)
      .first<PublicationReceipt & { inputHash: string }>();
    if (!row) return null;
    if (row.inputHash !== inputHash)
      throw new DomainError(
        "conflict",
        "This report ID was already used for different observations",
        409,
      );
    return {
      reportId: row.reportId,
      sourceId: row.sourceId,
      receivedAt: row.receivedAt,
      accepted: row.accepted,
    };
  }
}
