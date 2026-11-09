import { z } from "zod";
import { CAPABILITY, LIMITS } from "../shared/domain";
import { HOOK_LIMITS, hookRetryInput, hookRetryApplyInput } from "../shared/hooks";
import { HOOK_HANDOFF_KIND, normalizeHandoffRepository, handoffConnectionInput, handoffRepositoryInput, handoffPlanInput, handoffStatusInput, handoffExportInput,
  handoffAdoptionInput, handoffReceiptSchema, handoffRevealSchema, handoffExportSchema, type HandoffReceipt, type HandoffReview } from "../shared/hook-handoff";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { callHookProvider, hookProvider, hookProviderActor, HookProviderError } from "./hook-client";
import { callPrivateHandoff } from "./hook-handoff-client";
import { HooksService } from "./hooks";
import { ResourceLinksService } from "./resource-links";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

const reviewedSchema = handoffPlanInput.safeExtend({ memberRevision: z.number().int().positive(), tokenId: z.string().nullable(),
  providerRef: z.string(), providerIdentity: z.string(), providerActor: z.string(), connectionName: z.string(),
  action: z.enum(["create", "adopt"]), privateDigest: z.string().nullable() }).strict();
type Reviewed = z.infer<typeof reviewedSchema>;
type Row = { id: string; actor_subject: string; fingerprint: string; input_json: string; created_at: string; expires_at: string; applied_at: string | null; provider_review_json: string | null };
type Operation = NonNullable<HandoffReview["operation"]> & { result_json: string };
export class HookHandoff {
  readonly hooks: HooksService;
  constructor(readonly context: WorkspaceService) { this.hooks = new HooksService(context); }
  get db() { return this.context.db; }
  timestamp() { return new Date(this.context.now()).toISOString(); }
  conflict(): never { throw new DomainError("revision_conflict", "Manual hook scope changed or the review expired. Keep the draft and reconcile any saved operation before reviewing again.", 409); }
  async configuration(input: unknown) {
    const fields = handoffConnectionInput.parse(input);
    await authorizeHooks(this.context, fields.workspaceId);
    const { row, provider } = await this.hooks.active(fields.workspaceId, fields.connectionId);
    let result;
    try { result = { status: "supported" as const, configuration: (await callHookProvider(provider, "github_handoff_configuration", fields.workspaceId, await hookProviderActor(this.context.principal.subject))).result }; }
    catch (error) { if (!(error instanceof HookProviderError) || error.providerCode !== "validation") throw error; result = { status: "unsupported" as const, configuration: null }; }
    await this.hooks.unchanged(fields.workspaceId, row); await authorizeHooks(this.context, fields.workspaceId); return result;
  }
  async repository(input: unknown) {
    const parsed = handoffRepositoryInput.parse(input);
    const fields = { ...parsed, repository: normalizeHandoffRepository(parsed.repository) };
    await authorizeHooks(this.context, fields.workspaceId);
    const { row, provider } = await this.hooks.active(fields.workspaceId, fields.connectionId);
    const result = (await callHookProvider(provider, "github_handoff_repository", fields.workspaceId, await hookProviderActor(this.context.principal.subject), { repository: fields.repository })).result;
    if (result.repository.toLowerCase() !== fields.repository.toLowerCase()) throw new HookProviderError("metadata_invalid");
    await this.hooks.unchanged(fields.workspaceId, row); await authorizeHooks(this.context, fields.workspaceId); return result;
  }
  async status(input: unknown) {
    const fields = handoffStatusInput.parse(input);
    await authorizeHooks(this.context, fields.workspaceId);
    const { row, provider } = await this.hooks.active(fields.workspaceId, fields.connectionId);
    const result = (await callHookProvider(provider, "github_handoff_status", fields.workspaceId, await hookProviderActor(this.context.principal.subject), { resourceId: fields.resourceId })).result;
    if (result.resourceId !== fields.resourceId) throw new HookProviderError("metadata_invalid");
    await this.hooks.unchanged(fields.workspaceId, row); await authorizeHooks(this.context, fields.workspaceId); return result;
  }
  async row(workspaceId: string, planId: string) {
    const row = await this.db.prepare("SELECT p.*,h.provider_review_json FROM action_plans p JOIN hook_reviews h ON h.plan_id=p.id WHERE p.id=? AND p.workspace_id=? AND p.kind=?").bind(planId, workspaceId, HOOK_HANDOFF_KIND).first<Row>();
    if (!row) throw new DomainError("not_found", "Manual hook review not found.", 404); return row;
  }
  operation(workspaceId: string, planId: string) { return this.db.prepare("SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?").bind(workspaceId, planId, HOOK_HANDOFF_KIND).first<Operation>(); }
  async linked(reviewed: Reviewed, receipt: HandoffReceipt | null) {
    if (!receipt?.routingConfigured) return false;
    for (const profile of receipt.profiles) {
      const name = `github:${receipt.repository}${profile === "activity" ? "" : ":" + profile}`;
      const association = await this.db.prepare("SELECT project_id FROM hook_associations WHERE workspace_id=? AND connection_id=? AND lower(subscription)=?").bind(reviewed.workspaceId, reviewed.connectionId, name.toLowerCase()).all<{ project_id: string }>();
      if (association.results.length !== 1 || association.results[0]!.project_id !== reviewed.projectId) return false;
      if (reviewed.savedRepositoryId && !await this.db.prepare("SELECT repository_id FROM repository_resource_links WHERE workspace_id=? AND repository_id=? AND connection_id=? AND kind='hook' AND lower(resource_key)=?").bind(reviewed.workspaceId, reviewed.savedRepositoryId, reviewed.connectionId, name.toLowerCase()).first()) return false;
    }
    return true;
  }
  async get(input: unknown): Promise<HandoffReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input); await authorizeHooks(this.context, workspaceId);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const operation = await this.operation(workspaceId, planId);
    const receipt = operation ? z.object({ receipt: handoffReceiptSchema.nullable().optional() }).parse(JSON.parse(operation.result_json)).receipt ?? null : null;
    const provider = receipt ?? (row.provider_review_json ? handoffReceiptSchema.parse(JSON.parse(row.provider_review_json)) : null);
    const linked = await this.linked(reviewed, provider); await authorizeHooks(this.context, workspaceId);
    return { id: row.id, fingerprint: row.fingerprint, connectionId: reviewed.connectionId, connectionName: reviewed.connectionName, projectId: reviewed.projectId,
      repository: reviewed.repository, createdAt: row.created_at, expiresAt: row.expires_at, actorMatches: row.actor_subject === this.context.principal.subject && reviewed.tokenId === (this.context.principal.tokenId ?? null), linked, provider,
      operation: operation ? { id: operation.id, status: operation.status, summary: operation.summary, updatedAt: operation.updatedAt } : null };
  }
  async ready(reviewed: Reviewed) {
    const revision = await authorizeHooks(this.context, reviewed.workspaceId, CAPABILITY.SECRETS);
    if (revision !== reviewed.memberRevision) this.conflict();
    const project = await this.db.prepare("SELECT revision FROM projects WHERE workspace_id=? AND id=?").bind(reviewed.workspaceId, reviewed.projectId).first<{ revision: number }>();
    if (project?.revision !== reviewed.projectRevision) this.conflict();
    if (reviewed.savedRepositoryId) {
      const repository = await this.db.prepare("SELECT revision,project_id,full_name FROM repositories WHERE workspace_id=? AND id=?").bind(reviewed.workspaceId, reviewed.savedRepositoryId).first<{ revision: number; project_id: string; full_name: string }>();
      if (!repository || repository.revision !== reviewed.savedRepositoryRevision || repository.project_id !== reviewed.projectId || repository.full_name.toLowerCase() !== reviewed.repository.toLowerCase()) this.conflict();
    }
    const { row, provider } = await this.hooks.active(reviewed.workspaceId, reviewed.connectionId);
    if (row.revision !== reviewed.connectionRevision || provider.identity !== reviewed.providerIdentity) this.conflict(); return provider;
  }
  checkReceipt(receipt: HandoffReceipt, reviewed: Reviewed, baseline?: HandoffReceipt) {
    const expectedName = `github:${reviewed.repository}${reviewed.profile === "activity" ? "" : ":" + reviewed.profile}`;
    if (receipt.planId !== reviewed.reviewId || receipt.repository.toLowerCase() !== reviewed.repository.toLowerCase() || receipt.name.toLowerCase() !== expectedName.toLowerCase() || receipt.profile !== reviewed.profile || receipt.action !== reviewed.action ||
      JSON.stringify(receipt.sinks) !== JSON.stringify(reviewed.sinks) || (baseline && (baseline.resourceId !== receipt.resourceId || baseline.repositoryId !== receipt.repositoryId || baseline.expiresAt !== receipt.expiresAt || baseline.createdAt !== receipt.createdAt || JSON.stringify(baseline.profiles) !== JSON.stringify(receipt.profiles)))) throw new HookProviderError("metadata_invalid");
  }
  async plan(input: unknown, adoption = false): Promise<HandoffReview> {
    const parsed = adoption ? handoffAdoptionInput.parse(input) : handoffPlanInput.parse(input);
    const { record: privateRecord, ...rawFields } = adoption ? handoffAdoptionInput.parse(parsed) : { ...handoffPlanInput.parse(parsed), record: undefined };
    const fields = { ...rawFields, repository: normalizeHandoffRepository(rawFields.repository) };
    const { workspaceId, connectionId, reviewId } = fields;
    const memberRevision = await authorizeHooks(this.context, workspaceId, CAPABILITY.SECRETS);
    const { row: connection, provider } = await this.hooks.active(workspaceId, connectionId);
    const reviewed: Reviewed = { ...fields, memberRevision, tokenId: this.context.principal.tokenId ?? null, providerRef: connection.credential_ref, providerIdentity: provider.identity,
      providerActor: await hookProviderActor(this.context.principal.subject), connectionName: connection.name, action: adoption ? "adopt" : "create", privateDigest: privateRecord ? await credentialHash(JSON.stringify(privateRecord)) : null };
    await this.ready(reviewed);
    const serialized = JSON.stringify(reviewed); const fingerprint = await credentialHash(serialized);
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.SECRETS, memberRevision);
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?`).bind(reviewId, workspaceId, this.context.principal.subject, HOOK_HANDOFF_KIND, serialized, fingerprint, this.timestamp(), new Date(this.context.now() + LIMITS.PLAN_TTL_MS).toISOString(), ...guard.values, workspaceId, this.context.principal.subject, HOOK_HANDOFF_KIND, this.timestamp(), HOOK_LIMITS.PENDING_REVIEWS),
      this.db.prepare("INSERT OR IGNORE INTO hook_reviews(plan_id) SELECT id FROM action_plans WHERE id=? AND workspace_id=? AND fingerprint=? AND kind=?").bind(reviewId, workspaceId, fingerprint, HOOK_HANDOFF_KIND),
    ]);
    const row = await this.row(workspaceId, reviewId);
    if (row.fingerprint !== fingerprint || row.actor_subject !== this.context.principal.subject) this.conflict();
    if (row.provider_review_json || row.applied_at) return this.get({ workspaceId, planId: reviewId });
    if (Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const providerInput = { planId: reviewId, authorityId: fields.authorityId, revision: fields.revision, repository: fields.repository };
    const current = await this.ready(reviewed);
    const receipt = adoption ? await callPrivateHandoff(current, "adopt_plan", workspaceId, reviewed.providerActor, { ...providerInput, record: privateRecord }, handoffReceiptSchema) :
      (await callHookProvider(current, "github_handoff_plan", workspaceId, reviewed.providerActor, { ...providerInput, profile: fields.profile, sinks: fields.sinks })).result;
    this.checkReceipt(receipt, reviewed); if (receipt.status !== "ready") this.conflict(); await this.ready(reviewed);
    await this.db.prepare(`UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL AND ${guard.sql}`).bind(JSON.stringify(receipt), reviewId, ...guard.values).run();
    return this.get({ workspaceId, planId: reviewId });
  }
  async link(reviewed: Reviewed, receipt: HandoffReceipt) {
    const provider = await this.ready(reviewed);
    let targets = [{ resourceId: receipt.resourceId, profile: receipt.profile }];
    if (receipt.profiles.length > 1) {
      const repository = (await callHookProvider(provider, "github_handoff_repository", reviewed.workspaceId, reviewed.providerActor, { repository: receipt.repository })).result;
      if (repository.repositoryId !== receipt.repositoryId || repository.repository.toLowerCase() !== receipt.repository.toLowerCase()) throw new HookProviderError("metadata_invalid");
      targets = receipt.profiles.map(profile => { const matches = repository.resources.filter(resource => resource.profile === profile); if (matches.length !== 1 || (profile === receipt.profile && matches[0]!.resourceId !== receipt.resourceId)) throw new HookProviderError("metadata_invalid"); return matches[0]!; });
    }
    for (const target of targets) {
      const expectedName = `github:${receipt.repository}${target.profile === "activity" ? "" : ":" + target.profile}`;
      const detail = (await callHookProvider(provider, "configuration_subscription", reviewed.workspaceId, reviewed.providerActor, { resourceId: target.resourceId })).result;
      if (detail.resourceId !== target.resourceId || detail.name.toLowerCase() !== expectedName.toLowerCase()) throw new HookProviderError("metadata_invalid");
      const association = await this.hooks.association({ workspaceId: reviewed.workspaceId, connectionId: reviewed.connectionId, subscription: detail.name });
      if (association.projectId && association.projectId !== reviewed.projectId) this.conflict();
      if (!association.projectId) await this.hooks.associate({ workspaceId: reviewed.workspaceId, connectionId: reviewed.connectionId, subscription: detail.name, revision: association.revision, projectId: reviewed.projectId });
      if (reviewed.savedRepositoryId) {
        const links = new ResourceLinksService(this.context);
        const fields = { workspaceId: reviewed.workspaceId, connectionId: reviewed.connectionId, kind: "hook" as const, resourceKey: detail.name };
        const current = await links.get(fields);
        if (!current.repositoryIds.includes(reviewed.savedRepositoryId)) await links.save({ ...fields, revision: current.revision, connectionRevision: reviewed.connectionRevision, repositoryIds: [...current.repositoryIds, reviewed.savedRepositoryId] });
      }
    }
  }
  async record(reviewed: Reviewed, operationId: string, receipt: HandoffReceipt | null, submitted = true) {
    const linked = await this.linked(reviewed, receipt);
    const status = receipt?.routingConfigured ? linked ? "succeeded" : "partial" : receipt?.status === "expired" || receipt?.status === "conflict" || !submitted ? "failed" : "indeterminate";
    const summary = receipt?.routingConfigured ? linked ? "Manual hook routing configured. Share credentials privately with the repository administrator; installation and delivery need separate evidence." : "Manual hook routing configured; project or repository association is incomplete. Reconcile this operation." : "Manual hook completion is unconfirmed. Reconcile this operation before another attempt.";
    await this.db.batch([
      this.db.prepare("UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE id=? AND workspace_id=? AND kind=?").bind(status, summary, JSON.stringify({ receipt }), this.timestamp(), operationId, reviewed.workspaceId, HOOK_HANDOFF_KIND),
      this.db.prepare("INSERT OR IGNORE INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(operationId + "_" + status, reviewed.workspaceId, this.context.principal.subject, this.context.principal.displayName, "hook.handoff." + status, "Manual hook " + status, summary, this.timestamp()),
    ]);
    emitDiagnostic({ event: "hq.hooks.handoff", reference: operationId, workspaceId: reviewed.workspaceId, state: receipt?.status ?? "unavailable", linked });
  }
  async apply(input: unknown) {
    const { workspaceId, planId, fingerprint } = hookRetryApplyInput.parse(input); await authorizeHooks(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    if (row.fingerprint !== fingerprint || row.actor_subject !== this.context.principal.subject || reviewed.tokenId !== (this.context.principal.tokenId ?? null)) this.conflict();
    if (await this.operation(workspaceId, planId)) return this.get({ workspaceId, planId });
    await this.ready(reviewed);
    if (!row.provider_review_json || Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const baseline = handoffReceiptSchema.parse(JSON.parse(row.provider_review_json)); this.checkReceipt(baseline, reviewed);
    if (baseline.status !== "ready" || Date.parse(baseline.expiresAt) <= this.context.now()) this.conflict();
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.SECRETS, reviewed.memberRevision); const operationId = crypto.randomUUID();
    const saved = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at) SELECT ?,?,?,?,?,'pending','Manual hook requested',?,? WHERE ${guard.sql}
        AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1)
        AND EXISTS(SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND revision=?)
        AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND fingerprint=? AND applied_at IS NULL AND expires_at>?)`).bind(operationId, workspaceId, planId, this.context.principal.subject, HOOK_HANDOFF_KIND, this.timestamp(), this.timestamp(), ...guard.values, workspaceId, reviewed.connectionId, reviewed.connectionRevision, workspaceId, reviewed.projectId, reviewed.projectRevision, planId, fingerprint, this.timestamp()),
      this.db.prepare("UPDATE action_plans SET applied_at=? WHERE id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND plan_id=?)").bind(this.timestamp(), planId, operationId, planId),
    ]);
    if (!saved[0]!.meta.changes) { if (await this.operation(workspaceId, planId)) return this.get({ workspaceId, planId }); this.conflict(); }
    let receipt: HandoffReceipt | null = null; let submitted = false;
    try { const provider = await this.ready(reviewed); submitted = true; const result = (await callHookProvider(provider, "github_handoff_apply", workspaceId, reviewed.providerActor, { planId })).result; this.checkReceipt(result, reviewed, baseline); receipt = result; } catch { /* Reconcile the original operation after uncertain submission */ }
    if (receipt?.routingConfigured) { try { await this.link(reviewed, receipt); } catch { /* Association remains a visible partial outcome */ } }
    await this.record(reviewed, operationId, receipt, submitted); return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown) {
    const { workspaceId, planId } = hookRetryInput.parse(input); await authorizeHooks(this.context, workspaceId, CAPABILITY.SECRETS);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    if (row.actor_subject !== this.context.principal.subject || reviewed.tokenId !== (this.context.principal.tokenId ?? null)) this.conflict();
    const provider = await hookProvider(this.context.env, workspaceId, reviewed.providerRef); if (provider.identity !== reviewed.providerIdentity) this.conflict();
    const receipt = (await callHookProvider(provider, "github_handoff_get", workspaceId, reviewed.providerActor, { planId })).result;
    this.checkReceipt(receipt, reviewed, row.provider_review_json ? handoffReceiptSchema.parse(JSON.parse(row.provider_review_json)) : undefined);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.SECRETS);
    const operation = await this.operation(workspaceId, planId);
    if (!operation) { await this.db.prepare("UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL").bind(JSON.stringify(receipt), planId).run(); return this.get({ workspaceId, planId }); }
    if (receipt.routingConfigured) { try { await this.link(reviewed, receipt); } catch { /* Preserve confirmation when local association authority changed */ } }
    await this.record(reviewed, operation.id, receipt); return this.get({ workspaceId, planId });
  }
  async private(action: "reveal" | "export", input: unknown) {
    const started = Date.now();
    const fields = action === "reveal" ? handoffStatusInput.parse(input) : handoffExportInput.parse(input);
    const memberRevision = await authorizeHooks(this.context, fields.workspaceId, CAPABILITY.SECRETS);
    const { row, provider } = await this.hooks.active(fields.workspaceId, fields.connectionId);
    const actor = await hookProviderActor(this.context.principal.subject);
    const result = action === "reveal" ? await callPrivateHandoff(provider, action, fields.workspaceId, actor, { resourceId: handoffStatusInput.parse(fields).resourceId }, handoffRevealSchema) :
      await callPrivateHandoff(provider, action, fields.workspaceId, actor, { repositoryId: handoffExportInput.parse(fields).repositoryId }, handoffExportSchema);
    if (action === "reveal" ? !("resourceId" in result) || result.resourceId !== handoffStatusInput.parse(fields).resourceId : !("record" in result) || result.record.provider.repositoryId !== handoffExportInput.parse(fields).repositoryId || result.record.provider.workspaceId !== fields.workspaceId) throw new HookProviderError("metadata_invalid");
    await this.hooks.unchanged(fields.workspaceId, row);
    if ((await hookProvider(this.context.env, fields.workspaceId, row.credential_ref)).identity !== provider.identity) this.conflict();
    if (await authorizeHooks(this.context, fields.workspaceId, CAPABILITY.SECRETS) !== memberRevision) this.conflict();
    emitDiagnostic({ event: "hq.hooks.handoff.private", reference: crypto.randomUUID(), workspaceId: fields.workspaceId, action, state: "accepted", elapsedMs: Date.now() - started }); return result;
  }
}
