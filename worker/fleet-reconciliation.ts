import { z } from "zod";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  LIMITS,
  repositoryFields,
  type RepositoryFields,
} from "../shared/domain";
import {
  FLEET_DISCOVERY_LIMITS,
  fleetProviderResultSchema,
  fleetReconciliationApplyInput,
  fleetReconciliationPlanInput,
  fleetReconciliationReviewInput,
  type FleetLookup,
  type FleetReconciliationChange,
  type FleetReconciliationInput,
  type FleetReconciliationReceipt,
  type FleetReconciliationReview,
} from "../shared/fleet-discovery";
import { SOURCE_LIMITS } from "../shared/sources";
import {
  FleetAuthority,
  readFleetProvider,
  authorizeFleet,
  fleetActorGuard,
} from "./fleet-authority";
import { compareFleetRecords } from "./fleet-comparison";
import { assertFleetLookups, fleetInventory } from "./fleet-discovery";
import { collectFleetDiscovery } from "./fleet-discovery-client";
import { credentialHash } from "./credential-hash";
import { githubCredentialIdentity } from "./github-credentials";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

const PLAN_KIND = "fleet.reconcile";
type PlanRow = { input: string; fingerprint: string; expiresAt: string };
type Reviewed = {
  fields: FleetReconciliationInput;
  changes: FleetReconciliationChange[];
  source: FleetReconciliationReview["source"];
  sourceScope: string[];
  credentialHash: string;
  credentialRef: string;
  sourceConfiguration: string;
  workspaceName: string;
  actor: string;
  memberRevision: number;
  tokenId: string | null;
  observedAt: string;
};
const verificationSchema = z
  .object({
    nodes: fleetProviderResultSchema,
    names: fleetProviderResultSchema.nullable(),
    retryAt: z.iso.datetime().nullable(),
  })
  .strict();

export class FleetReconciliationService {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  get principal() {
    return this.context.principal;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private conflict(): never {
    throw new DomainError(
      "revision_conflict",
      "This enrollment review expired or its repository identity, settings, source scope or workspace access changed. No new changes were applied. Recover the saved review or prepare a fresh review with your choices.",
      409,
    );
  }
  private async authorize(workspaceId: string) {
    const revision = await authorizeFleet(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
    if (
      (await authorizeFleet(this.context, workspaceId, CAPABILITY.EDIT)) !==
      revision
    )
      this.conflict();
    return revision;
  }
  private actorGuard(
    workspaceId: string,
    memberRevision: number | null = null,
  ) {
    const admin = fleetActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.ADMIN,
      memberRevision,
    );
    const edit = fleetActorGuard(
      this.context,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    return {
      sql: `${admin.sql} AND ${edit.sql}`,
      values: [...admin.values, ...edit.values],
    };
  }
  private async projectsMatch(
    workspaceId: string,
    fields: FleetReconciliationInput,
  ) {
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 WHERE NOT EXISTS (
          SELECT 1 FROM json_each(?) selected LEFT JOIN projects p
            ON p.workspace_id=? AND p.id=json_extract(selected.value,'$.projectId')
          WHERE json_type(selected.value,'$.repositoryId')='null'
            AND (p.id IS NULL OR p.revision<>json_extract(selected.value,'$.projectRevision'))
        )`,
        )
        .bind(JSON.stringify(fields.selections), workspaceId)
        .first(),
    );
  }
  private boundary(workspaceId: string, reviewed: Reviewed) {
    const actor = this.actorGuard(workspaceId, reviewed.memberRevision);
    const changes = JSON.stringify(reviewed.changes);
    const selections = JSON.stringify(reviewed.fields.selections);
    return {
      sql: `${actor.sql}
        AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND provider='github' AND revision=? AND enabled=1 AND credential_ref=? AND configuration_json=?)
        AND (SELECT count(*) FROM source_repositories WHERE workspace_id=? AND source_id=?)=?
        AND NOT EXISTS(SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS(SELECT 1 FROM source_repositories sr WHERE sr.workspace_id=? AND sr.source_id=? AND sr.repository_id=selected.value))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) selected LEFT JOIN repositories r ON r.workspace_id=? AND r.id=json_extract(selected.value,'$.repositoryId')
          WHERE (json_type(selected.value,'$.before')<>'null' AND (r.id IS NULL OR r.revision<>json_extract(selected.value,'$.before.revision')))
            OR (json_type(selected.value,'$.before')='null' AND r.id IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) selected JOIN repositories r ON r.workspace_id=? AND r.full_name=json_extract(selected.value,'$.after.fullName')
          WHERE r.id<>json_extract(selected.value,'$.repositoryId'))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) selected JOIN github_repository_identities g ON g.workspace_id=?
          JOIN repositories r ON r.workspace_id=g.workspace_id AND r.id=g.repository_id AND r.full_name=g.full_name
          WHERE (g.repository_id=json_extract(selected.value,'$.repositoryId') AND g.github_id<>json_extract(selected.value,'$.githubId'))
            OR (g.github_id=json_extract(selected.value,'$.githubId') AND g.repository_id<>json_extract(selected.value,'$.repositoryId')))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) selected LEFT JOIN projects p
          ON p.workspace_id=? AND p.id=json_extract(selected.value,'$.projectId')
          WHERE json_type(selected.value,'$.repositoryId')='null'
            AND (p.id IS NULL OR p.revision<>json_extract(selected.value,'$.projectRevision')))
        AND (SELECT count(*) FROM repositories WHERE workspace_id=?)+?<=?`,
      values: [
        ...actor.values,
        workspaceId,
        reviewed.source.id,
        reviewed.source.revision,
        reviewed.credentialRef,
        reviewed.sourceConfiguration,
        workspaceId,
        reviewed.source.id,
        reviewed.sourceScope.length,
        JSON.stringify(reviewed.sourceScope),
        workspaceId,
        reviewed.source.id,
        changes,
        workspaceId,
        changes,
        workspaceId,
        changes,
        workspaceId,
        selections,
        workspaceId,
        workspaceId,
        reviewed.changes.filter((row) => !row.before).length,
        LIMITS.MAX_REPOSITORIES,
      ],
    };
  }
  private async matching(workspaceId: string, reviewed: Reviewed) {
    const credential = await githubCredentialIdentity(
      this.context.env,
      workspaceId,
      reviewed.credentialRef,
    );
    if (credential?.hash !== reviewed.credentialHash) return false;
    const guard = this.boundary(workspaceId, reviewed);
    return Boolean(
      await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first(),
    );
  }
  private async load(workspaceId: string, planId: string, optional = false) {
    await this.authorize(workspaceId);
    const guard = this.actorGuard(workspaceId);
    const plan = await this.db
      .prepare(
        `SELECT input_json AS input,fingerprint,expires_at AS expiresAt FROM action_plans
      WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND ${guard.sql}`,
      )
      .bind(
        planId,
        workspaceId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<PlanRow>();
    if (!plan) {
      if (optional) return null;
      throw new DomainError(
        "not_found",
        "This enrollment review is not available to this workspace and identity.",
        404,
      );
    }
    const reviewed = JSON.parse(plan.input) as Reviewed;
    fleetReconciliationPlanInput.parse(reviewed.fields);
    if (
      reviewed.fields.workspaceId !== workspaceId ||
      reviewed.fields.reviewId !== planId ||
      reviewed.tokenId !== (this.principal.tokenId ?? null) ||
      (await credentialHash(plan.input)) !== plan.fingerprint
    )
      this.conflict();
    return { plan, reviewed };
  }
  private async receipt(workspaceId: string, planId: string) {
    const guard = this.actorGuard(workspaceId);
    const row = await this.db
      .prepare(
        `SELECT result_json AS result FROM operations WHERE workspace_id=? AND plan_id=? AND actor_subject=? AND kind=? AND status='succeeded' AND ${guard.sql}`,
      )
      .bind(
        workspaceId,
        planId,
        this.principal.subject,
        PLAN_KIND,
        ...guard.values,
      )
      .first<{ result: string }>();
    return row ? (JSON.parse(row.result) as FleetReconciliationReceipt) : null;
  }
  private async response(
    workspaceId: string,
    planId: string,
    plan: PlanRow,
    reviewed: Reviewed,
  ): Promise<FleetReconciliationReview> {
    let receipt = await this.receipt(workspaceId, planId);
    let state: FleetReconciliationReview["state"] = receipt
      ? "applied"
      : Date.parse(plan.expiresAt) <= this.context.now()
        ? "expired"
        : (await this.matching(workspaceId, reviewed))
          ? "ready"
          : "stale";
    if (!receipt && state !== "ready") {
      receipt = await this.receipt(workspaceId, planId);
      if (receipt) state = "applied";
    }
    await this.authorize(workspaceId);
    return {
      workspaceId,
      workspaceName: reviewed.workspaceName,
      planId,
      fingerprint: plan.fingerprint,
      actor: reviewed.actor,
      expiresAt: plan.expiresAt,
      observedAt: reviewed.observedAt,
      source: reviewed.source,
      fields: reviewed.fields,
      changes: reviewed.changes,
      state,
      receipt,
    };
  }
  async review(input: unknown) {
    const { workspaceId, planId } = fleetReconciliationReviewInput.parse(input);
    const { plan, reviewed } = (await this.load(workspaceId, planId))!;
    return this.response(workspaceId, planId, plan, reviewed);
  }
  async plan(input: unknown) {
    const fields = fleetReconciliationPlanInput.parse(input);
    fields.selections.sort((a, b) =>
      a.githubId.localeCompare(b.githubId, "en"),
    );
    const { workspaceId, sourceId, sourceRevision, reviewId } = fields;
    const prior = await this.load(workspaceId, reviewId, true);
    if (prior) {
      if (JSON.stringify(fields) !== JSON.stringify(prior.reviewed.fields))
        this.conflict();
      return this.response(workspaceId, reviewId, prior.plan, prior.reviewed);
    }
    const authority = await FleetAuthority.open(
      this.context,
      workspaceId,
      sourceId,
      sourceRevision,
    );
    await this.authorize(workspaceId);
    if (
      !authority.source.enabled ||
      !authority.configured ||
      !authority.credential ||
      !authority.source.credential_ref
    )
      throw new DomainError(
        "validation",
        "Choose an enabled GitHub source with a configured read credential before preparing enrollment changes.",
        422,
      );
    if (!(await this.projectsMatch(workspaceId, fields))) this.conflict();
    const inventory = await fleetInventory(authority);
    const selected = fields.selections.map((selection) => {
      const row = selection.repositoryId
        ? inventory.find((row) => row.id === selection.repositoryId)
        : null;
      if (
        (selection.repositoryId &&
          (!row || row.revision !== selection.revision)) ||
        (row &&
          (row.githubIds.length > 1 ||
            (row.githubIds.length === 1 &&
              row.githubIds[0] !== selection.githubId)))
      )
        this.conflict();
      return { selection, row, id: row?.id ?? crypto.randomUUID() };
    });
    const lookups: FleetLookup[] = selected.flatMap(({ row }) =>
      row
        ? [
            {
              repositoryId: row.id,
              fullName: row.fullName,
              githubId: row.githubIds[0] ?? null,
            },
          ]
        : [],
    );
    const names = lookups.filter((lookup) => lookup.githubId === null);
    const nodes: FleetLookup[] = selected.map(({ selection, id }) => ({
      repositoryId: id,
      fullName: selection.fullName,
      githubId: selection.githubId,
    }));
    const verification = await readFleetProvider(
      authority,
      { kind: "verify", fields },
      verificationSchema,
      async (token) => {
        const options = {
          now: this.context.now,
          signal: AbortSignal.timeout(
            FLEET_DISCOVERY_LIMITS.REQUEST_TIMEOUT_MS,
          ),
        };
        const nodeReads = await collectFleetDiscovery(
          { kind: "enrolled", cursor: null },
          nodes,
          token,
          options,
        );
        await assertFleetLookups(authority, lookups);
        await this.authorize(workspaceId);
        await authority.assertLive();
        const nameReads =
          names.length &&
          nodeReads.read.state === "observed" &&
          !nodeReads.retryAt
            ? await collectFleetDiscovery(
                { kind: "enrolled", cursor: null },
                names,
                token,
                options,
              )
            : null;
        return {
          nodes: nodeReads,
          names: nameReads,
          retryAt:
            [nodeReads.retryAt, nameReads?.retryAt]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? null,
        };
      },
      async () => {
        await assertFleetLookups(authority, lookups);
        await this.authorize(workspaceId);
      },
    );
    const verified = verification.evidence;
    if (verification.state !== "ready" || !verified)
      throw new DomainError(
        "provider_waiting",
        `The bounded GitHub read is ${verification.state}. Keep this review attempt and retry after ${verification.nextReadAt ?? "the source is configured"}.`,
        409,
      );
    if (
      verified.nodes.read.state !== "observed" ||
      (names.length && verified.names?.read.state !== "observed")
    )
      throw new DomainError(
        "provider_unavailable",
        "GitHub could not verify every selected identity with this source's read access. No enrollment review was saved. Inspect discovery coverage and select only verified rows.",
        422,
      );
    const liveInventory = await fleetInventory(authority);
    const comparisonRecords = selected.map(({ selection, row }) => {
      const record = verified.nodes.records.find(
        (record) => record.lookupGithubId === selection.githubId,
      );
      if (
        !record?.repository ||
        record.read.state !== "observed" ||
        record.repository.fullName !== selection.fullName ||
        record.repository.archived !== (selection.lifecycle === "archived")
      )
        this.conflict();
      if (row && !row.githubIds.length) {
        const name = verified.names?.records.find(
          (record) => record.repositoryId === row.id,
        );
        if (
          name?.read.state !== "observed" ||
          name.repository?.githubId !== selection.githubId ||
          name.repository.fullName !== selection.fullName ||
          name.repository.archived !== record.repository.archived
        )
          this.conflict();
      }
      return {
        ...record,
        repositoryId: row?.id ?? null,
        lookupFullName: row?.fullName ?? null,
      };
    });
    const comparisons = compareFleetRecords(comparisonRecords, liveInventory);
    if (
      comparisons.some(
        (row, index) =>
          row.state === "conflict" ||
          row.state === "unavailable" ||
          row.repository?.id !== (selected[index].row?.id ?? undefined),
      )
    )
      this.conflict();
    const beforeRows = await this.db
      .prepare(
        `SELECT id,full_name AS fullName,description,project_id AS projectId,classification,lifecycle,expectations_json AS expectations,revision FROM repositories
      WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.repositoryId') FROM json_each(?))`,
      )
      .bind(workspaceId, JSON.stringify(lookups))
      .all<
        Omit<RepositoryFields, "expectations"> & {
          id: string;
          expectations: string;
          revision: number;
        }
      >();
    const changes: FleetReconciliationChange[] = selected.map(
      ({ selection, row, id }, index) => {
        const stored = beforeRows.results.find((before) => before.id === id);
        if (row && (!stored || stored.revision !== selection.revision))
          this.conflict();
        const before = stored
          ? {
              ...repositoryFields.parse({
                fullName: stored.fullName,
                description: stored.description,
                projectId: stored.projectId,
                classification: stored.classification,
                lifecycle: stored.lifecycle,
                expectations: JSON.parse(stored.expectations),
              }),
              revision: stored.revision,
            }
          : null;
        return {
          repositoryId: id,
          githubId: selection.githubId,
          before,
          after: repositoryFields.parse({
            fullName: selection.fullName,
            lifecycle: selection.lifecycle,
            description:
              before?.description ?? comparisons[index].provider!.description,
            classification: before?.classification ?? selection.classification,
            projectId: before?.projectId ?? selection.projectId,
            expectations: before?.expectations ?? DEFAULT_EXPECTATIONS,
          }),
          collectedBefore: row?.collected ?? false,
          collectedAfter: selection.collect,
        };
      },
    );
    const sourceScope = liveInventory
      .filter((row) => row.collected)
      .map((row) => row.id)
      .sort();
    const afterCount =
      sourceScope.length +
      changes.filter((row) => !row.collectedBefore && row.collectedAfter)
        .length -
      changes.filter((row) => row.collectedBefore && !row.collectedAfter)
        .length;
    if (afterCount > SOURCE_LIMITS.REPOSITORIES || afterCount < 1)
      throw new DomainError(
        "capacity",
        `An enabled GitHub source needs between 1 and ${SOURCE_LIMITS.REPOSITORIES} collection members. To stop its final member, disable the source and edit its scope in GitHub settings.`,
        422,
      );
    if (
      liveInventory.length + changes.filter((row) => !row.before).length >
      LIMITS.MAX_REPOSITORIES
    )
      throw new DomainError(
        "capacity",
        "These additions exceed HQ workspace repository capacity.",
        422,
      );
    const workspace = await this.context.authorize(
      workspaceId,
      CAPABILITY.ADMIN,
    );
    const reviewed: Reviewed = {
      fields,
      changes,
      sourceScope,
      source: {
        id: sourceId,
        name: authority.source.name,
        revision: sourceRevision,
        beforeCount: sourceScope.length,
        afterCount,
      },
      credentialHash: authority.credential.hash,
      credentialRef: authority.source.credential_ref,
      sourceConfiguration: authority.source.configuration_json,
      workspaceName: workspace.name,
      actor: this.principal.displayName,
      memberRevision: authority.memberRevision,
      tokenId: this.principal.tokenId ?? null,
      observedAt: [verified.nodes.observedAt, verified.names?.observedAt]
        .filter((value): value is string => Boolean(value))
        .sort()[0],
    };
    const serialized = JSON.stringify(reviewed);
    if (
      new TextEncoder().encode(serialized).byteLength >
      FLEET_DISCOVERY_LIMITS.RESPONSE_BYTES
    )
      throw new DomainError(
        "capacity",
        "Select fewer repositories for this enrollment review.",
        413,
      );
    const fingerprint = await credentialHash(serialized);
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      Math.min(this.context.now(), Date.parse(reviewed.observedAt)) +
        LIMITS.PLAN_TTL_MS,
    ).toISOString();
    if (Date.parse(expiresAt) <= this.context.now()) this.conflict();
    await authority.assertLive();
    const boundary = this.boundary(workspaceId, reviewed);
    const actor = this.actorGuard(workspaceId, authority.memberRevision);
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM action_plans WHERE id IN(SELECT id FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at<=?
        AND NOT EXISTS(SELECT 1 FROM operations WHERE plan_id=action_plans.id) LIMIT ?) AND ${actor.sql}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          createdAt,
          FLEET_DISCOVERY_LIMITS.CLEANUP_ROWS,
          ...actor.values,
        ),
      this.db
        .prepare(
          `INSERT INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${boundary.sql} AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?
        ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          reviewId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          serialized,
          fingerprint,
          createdAt,
          expiresAt,
          ...boundary.values,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          createdAt,
          FLEET_DISCOVERY_LIMITS.PENDING_PLANS,
        ),
    ]);
    const saved = await this.load(workspaceId, reviewId, true);
    if (!saved) {
      if (!(await this.matching(workspaceId, reviewed))) this.conflict();
      throw new DomainError(
        "capacity",
        "This review ID is unavailable or too many enrollment reviews are open. Recover an existing review or wait for it to expire before starting another.",
        409,
      );
    }
    if (JSON.stringify(fields) !== JSON.stringify(saved.reviewed.fields))
      this.conflict();
    return this.response(workspaceId, reviewId, saved.plan, saved.reviewed);
  }
  async apply(input: unknown): Promise<FleetReconciliationReceipt> {
    const { workspaceId, planId, fingerprint } =
      fleetReconciliationApplyInput.parse(input);
    const { plan, reviewed } = (await this.load(workspaceId, planId))!;
    if (plan.fingerprint !== fingerprint) this.conflict();
    try {
      return await this.commit(
        workspaceId,
        planId,
        fingerprint,
        plan,
        reviewed,
      );
    } catch (error) {
      if (error instanceof DomainError && error.status === 409) {
        const committed = await this.receipt(workspaceId, planId);
        if (committed) {
          await this.authorize(workspaceId);
          return committed;
        }
      }
      throw error;
    }
  }
  private async commit(
    workspaceId: string,
    planId: string,
    fingerprint: string,
    plan: PlanRow,
    reviewed: Reviewed,
  ): Promise<FleetReconciliationReceipt> {
    const prior = await this.receipt(workspaceId, planId);
    if (prior) {
      await this.authorize(workspaceId);
      return prior;
    }
    if (
      Date.parse(plan.expiresAt) <= this.context.now() ||
      !(await this.matching(workspaceId, reviewed))
    )
      this.conflict();
    const authority = await FleetAuthority.open(
      this.context,
      workspaceId,
      reviewed.source.id,
      reviewed.source.revision,
    );
    if (
      authority.credential?.hash !== reviewed.credentialHash ||
      authority.memberRevision !== reviewed.memberRevision
    )
      this.conflict();
    const boundary = this.boundary(workspaceId, reviewed);
    const writeId = crypto.randomUUID();
    const appliedAt = this.timestamp();
    const created = reviewed.changes.filter((row) => !row.before);
    const updated = reviewed.changes.filter(
      (row) =>
        row.before &&
        (row.before.fullName !== row.after.fullName ||
          row.before.lifecycle !== row.after.lifecycle),
    );
    const added = reviewed.changes.filter(
      (row) => !row.collectedBefore && row.collectedAfter,
    );
    const removed = reviewed.changes.filter(
      (row) => row.collectedBefore && !row.collectedAfter,
    );
    const sourceChanged =
      added.length > 0 ||
      removed.length > 0 ||
      updated.some(
        (row) =>
          row.collectedAfter && row.before!.fullName !== row.after.fullName,
      );
    const receipt: FleetReconciliationReceipt = {
      workspaceId,
      planId,
      fingerprint,
      appliedAt,
      sourceId: reviewed.source.id,
      sourceRevision: reviewed.source.revision + Number(sourceChanged),
      createdRepositoryIds: created.map((row) => row.repositoryId),
      updatedRepositoryIds: updated.map((row) => row.repositoryId),
      addedToSource: added.map((row) => row.repositoryId),
      removedFromSource: removed.map((row) => row.repositoryId),
    };
    const changed = reviewed.changes.filter(
      (row) =>
        created.includes(row) ||
        updated.includes(row) ||
        added.includes(row) ||
        removed.includes(row),
    );
    const events = changed.map((row) => ({
      ...row,
      eventId: crypto.randomUUID(),
      summary: `${row.before && row.before.fullName !== row.after.fullName ? row.before.fullName + " -> " : ""}${row.after.fullName}: ${row.before ? "reviewed HQ metadata" : "added to HQ"}; ${row.collectedAfter ? "included in" : "outside"} ${reviewed.source.name} collection. GitHub was not changed.`,
    }));
    const written =
      "EXISTS(SELECT 1 FROM operations WHERE id=? AND workspace_id=? AND plan_id=? AND status='succeeded')";
    const writeValues = [writeId, workspaceId, planId];
    const changeJson = JSON.stringify(reviewed.changes);
    const eventJson = JSON.stringify(events);
    const updatedJson = JSON.stringify(updated);
    await authority.assertLive();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
        SELECT ?,?,?,?,?,'succeeded',?,?,?,? WHERE ${boundary.sql}
        AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND actor_subject=? AND kind=? AND input_json=? AND fingerprint=? AND applied_at IS NULL AND expires_at>? AND julianday(expires_at)>julianday('now'))
        ON CONFLICT(plan_id) DO NOTHING`,
        )
        .bind(
          writeId,
          workspaceId,
          planId,
          this.principal.subject,
          PLAN_KIND,
          "Reviewed GitHub fleet enrollment",
          JSON.stringify(receipt),
          appliedAt,
          appliedAt,
          ...boundary.values,
          planId,
          workspaceId,
          this.principal.subject,
          PLAN_KIND,
          plan.input,
          fingerprint,
          appliedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO repositories(id,workspace_id,full_name,description,project_id,classification,lifecycle,expectations_json,revision,updated_at,write_id)
        SELECT json_extract(value,'$.repositoryId'),?,json_extract(value,'$.after.fullName'),json_extract(value,'$.after.description'),json_extract(value,'$.after.projectId'),json_extract(value,'$.after.classification'),json_extract(value,'$.after.lifecycle'),json_extract(value,'$.after.expectations'),1,?,?
        FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          appliedAt,
          writeId,
          JSON.stringify(created),
          ...writeValues,
        ),
      this.db
        .prepare(
          `UPDATE repositories SET full_name=(SELECT json_extract(value,'$.after.fullName') FROM json_each(?) WHERE json_extract(value,'$.repositoryId')=repositories.id),
        lifecycle=(SELECT json_extract(value,'$.after.lifecycle') FROM json_each(?) WHERE json_extract(value,'$.repositoryId')=repositories.id),revision=revision+1,updated_at=?,write_id=?
        WHERE workspace_id=? AND id IN(SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          updatedJson,
          updatedJson,
          appliedAt,
          writeId,
          workspaceId,
          updatedJson,
          ...writeValues,
        ),
      this.db
        .prepare(
          `DELETE FROM source_repositories WHERE workspace_id=? AND source_id=? AND repository_id IN(SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          workspaceId,
          reviewed.source.id,
          JSON.stringify(removed),
          ...writeValues,
        ),
      this.db
        .prepare(
          `INSERT INTO source_repositories(workspace_id,source_id,repository_id) SELECT ?,?,json_extract(value,'$.repositoryId') FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          reviewed.source.id,
          JSON.stringify(added),
          ...writeValues,
        ),
      this.db
        .prepare(
          `UPDATE connections SET revision=revision+1,write_id=?,next_refresh_at=? WHERE workspace_id=? AND id=? AND ?=1 AND ${written}`,
        )
        .bind(
          writeId,
          appliedAt,
          workspaceId,
          reviewed.source.id,
          Number(sourceChanged),
          ...writeValues,
        ),
      this.db
        .prepare(
          `UPDATE observations SET expires_at=MIN(expires_at,?) WHERE workspace_id=? AND source_id=?
        AND resource_id IN(SELECT json_extract(value,'$.repositoryId') FROM json_each(?)) AND ${written}`,
        )
        .bind(
          appliedAt,
          workspaceId,
          reviewed.source.id,
          JSON.stringify(removed),
          ...writeValues,
        ),
      this.db
        .prepare(
          `UPDATE github_refresh_items SET status='cancelled',summary='Fleet enrollment changed; refresh with the saved source scope',updated_at=?,lease_id=NULL,lease_until=NULL
        WHERE workspace_id=? AND status IN('queued','running') AND refresh_id IN(SELECT id FROM github_refreshes WHERE workspace_id=? AND source_id=? AND status IN('queued','running')) AND ?=1 AND ${written}`,
        )
        .bind(
          appliedAt,
          workspaceId,
          workspaceId,
          reviewed.source.id,
          Number(sourceChanged),
          ...writeValues,
        ),
      this.db
        .prepare(
          `UPDATE github_refreshes SET status='cancelled',summary='Fleet enrollment changed; refresh with the saved source scope',completed_at=?,write_id=?
        WHERE workspace_id=? AND source_id=? AND status IN('queued','running') AND ?=1 AND ${written}`,
        )
        .bind(
          appliedAt,
          writeId,
          workspaceId,
          reviewed.source.id,
          Number(sourceChanged),
          ...writeValues,
        ),
      this.db
        .prepare(
          `INSERT INTO github_repository_identities(workspace_id,source_id,repository_id,github_id,full_name,observed_at)
        SELECT ?,?,json_extract(value,'$.repositoryId'),json_extract(value,'$.githubId'),json_extract(value,'$.after.fullName'),? FROM json_each(?) WHERE ${written}
        ON CONFLICT(workspace_id,source_id,repository_id) DO UPDATE SET github_id=excluded.github_id,full_name=excluded.full_name,observed_at=excluded.observed_at`,
        )
        .bind(
          workspaceId,
          reviewed.source.id,
          reviewed.observedAt,
          changeJson,
          ...writeValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,resource_id,created_at)
        SELECT json_extract(value,'$.eventId'),?,?,?,'fleet.reconciled','Fleet enrollment updated',json_extract(value,'$.summary'),json_extract(value,'$.repositoryId'),? FROM json_each(?) WHERE ${written}`,
        )
        .bind(
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          appliedAt,
          eventJson,
          ...writeValues,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links(workspace_id,event_id,repository_id)
        SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.repositoryId') FROM json_each(?) WHERE ${written}`,
        )
        .bind(workspaceId, eventJson, ...writeValues),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
        SELECT ?,json_extract(value,'$.eventId'),json_extract(value,'$.after.projectId') FROM json_each(?) WHERE json_extract(value,'$.after.projectId') IS NOT NULL AND ${written}`,
        )
        .bind(workspaceId, eventJson, ...writeValues),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE workspace_id=? AND id=? AND ${written}`,
        )
        .bind(appliedAt, workspaceId, planId, ...writeValues),
    ]);
    await this.authorize(workspaceId);
    const committed = await this.receipt(workspaceId, planId);
    if (!committed) this.conflict();
    await this.authorize(workspaceId);
    return committed;
  }
}
