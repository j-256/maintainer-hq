import { z } from "zod";
import { CAPABILITY, LIMITS } from "../shared/domain";
import { HOOK_LIMITS, hookRetryInput, hookRetryApplyInput } from "../shared/hooks";
import { HOOK_LIFECYCLE_KIND, HOOK_LIFECYCLE_PRIVATE_BYTES, lifecycleConnectionInput, lifecyclePlanInput, lifecycleReceiptSchema, lifecycleSelectionInput, lifecyclePrivateSchema, lifecycleInputReceiptSchema, type LifecycleReceipt, type LifecycleReview } from "../shared/hook-lifecycle";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { callHookProvider, hookProvider, hookProviderActor, HookProviderError, hookProviderRejection, type HookProvider } from "./hook-client";
import { HooksService } from "./hooks";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

const reviewedSchema = lifecyclePlanInput.extend({ memberRevision: z.number().int().positive(), tokenId: z.string().nullable(), providerRef: z.string(), providerIdentity: z.string(), providerActor: z.string(), connectionName: z.string(), target: z.string() }).strict();
type Reviewed = z.infer<typeof reviewedSchema>;
type Row = { id: string; actor_subject: string; fingerprint: string; input_json: string; created_at: string; expires_at: string; applied_at: string | null; provider_review_json: string | null };
type Operation = NonNullable<LifecycleReview["operation"]> & { result_json: string };
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;

export class HookLifecycle {
  readonly hooks: HooksService;
  constructor(readonly context: WorkspaceService) { this.hooks = new HooksService(context); }
  get db() { return this.context.db; }
  timestamp() { return new Date(this.context.now()).toISOString(); }
  conflict(): never { throw new DomainError("revision_conflict", "The lifecycle review or its authority changed. Refresh and review again. Reconcile the original receipt before another change.", 409); }
  async configuration(input: unknown) {
    const { workspaceId, connectionId } = lifecycleConnectionInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const { row, provider } = await this.hooks.active(workspaceId, connectionId);
    const result = (await callHookProvider(provider, "lifecycle_configuration", workspaceId, await hookProviderActor(this.context.principal.subject))).result;
    await this.hooks.unchanged(workspaceId, row);
    if ((await hookProvider(this.context.env, workspaceId, row.credential_ref)).identity !== provider.identity) this.conflict();
    await authorizeHooks(this.context, workspaceId);
    return result;
  }
  async row(workspaceId: string, planId: string) {
    const row = await this.db.prepare("SELECT p.*,h.provider_review_json FROM action_plans p JOIN hook_reviews h ON h.plan_id=p.id WHERE p.id=? AND p.workspace_id=? AND p.kind=?").bind(planId, workspaceId, HOOK_LIFECYCLE_KIND).first<Row>();
    if (!row) throw new DomainError("not_found", "Lifecycle review not found.", 404);
    return row;
  }
  operation(workspaceId: string, planId: string) { return this.db.prepare("SELECT id,status,summary,updated_at AS updatedAt,result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=?").bind(workspaceId, planId, HOOK_LIFECYCLE_KIND).first<Operation>(); }
  actor(row: Row, reviewed: Reviewed) {
    if (row.actor_subject !== this.context.principal.subject || reviewed.tokenId !== (this.context.principal.tokenId ?? null)) this.conflict();
  }
  async provider(reviewed: Reviewed) {
    const provider = await hookProvider(this.context.env, reviewed.workspaceId, reviewed.providerRef);
    if (provider.identity !== reviewed.providerIdentity) throw new DomainError("hooks_provider_changed", "Restore the original scoped provider credential before reconciling this receipt.", 409);
    return provider;
  }
  async ready(row: Row, reviewed: Reviewed) {
    this.actor(row, reviewed);
    if (await authorizeHooks(this.context, reviewed.workspaceId, CAPABILITY.OPERATE) !== reviewed.memberRevision) this.conflict();
    const { row: connection, provider } = await this.hooks.active(reviewed.workspaceId, reviewed.connectionId);
    if (connection.revision !== reviewed.connectionRevision || provider.identity !== reviewed.providerIdentity) this.conflict();
    return provider;
  }
  check(receipt: LifecycleReceipt, reviewed: Reviewed, baseline?: LifecycleReceipt) {
    if (receipt.id !== reviewed.planId || receipt.authorityId !== reviewed.authorityId || receipt.revision !== reviewed.revision || canonical(receipt.change) !== canonical(reviewed.change) || (baseline && (receipt.fingerprint !== baseline.fingerprint || receipt.expiresAt !== baseline.expiresAt || canonical(receipt.before) !== canonical(baseline.before) || canonical(receipt.after) !== canonical(baseline.after) || canonical(receipt.affectedSubscriptions) !== canonical(baseline.affectedSubscriptions) || receipt.privateInputRequired !== baseline.privateInputRequired))) throw new HookProviderError("metadata_invalid");
  }
  async get(input: unknown): Promise<LifecycleReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    await authorizeHooks(this.context, workspaceId);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    const operation = await this.operation(workspaceId, planId);
    const result = operation ? z.object({ receipt: lifecycleReceiptSchema.nullable().optional() }).parse(JSON.parse(operation.result_json)).receipt : null;
    const receipt = result ?? (row.provider_review_json ? lifecycleReceiptSchema.parse(JSON.parse(row.provider_review_json)) : null);
    if (!receipt) throw new DomainError("hooks_review_incomplete", "Provider review acceptance is unconfirmed. Reconcile this same plan ID to recover its receipt.", 409);
    this.check(receipt, reviewed);
    let canSupplyPrivate = false;
    const inputIntent = await this.db.prepare("SELECT status FROM hook_lifecycle_inputs WHERE plan_id=?").bind(planId).first<{ status: string }>();
    if ((!inputIntent || inputIntent.status === "rejected") && !operation && receipt.privateInputRequired && !receipt.privateInputReceived && receipt.state === "ready" && Date.parse(row.expires_at) > this.context.now() && Date.parse(receipt.expiresAt) > this.context.now()) {
      try {
        const provider = await this.ready(row, reviewed);
        const configuration = (await callHookProvider(provider, "lifecycle_configuration", workspaceId, reviewed.providerActor)).result;
        await this.ready(row, reviewed);
        canSupplyPrivate = configuration.canSupplyPrivate && configuration.canProvision && configuration.authorityId === reviewed.authorityId && configuration.revision === reviewed.revision;
      } catch { /* Receipts remain readable when private input authority is unavailable */ }
    }
    await authorizeHooks(this.context, workspaceId);
    return { ...receipt, fingerprint: row.fingerprint, state: !operation && Date.parse(row.expires_at) <= this.context.now() ? "expired" : receipt.state,
      workspaceId, connectionId: reviewed.connectionId, connectionName: reviewed.connectionName, actorMatches: row.actor_subject === this.context.principal.subject && reviewed.tokenId === (this.context.principal.tokenId ?? null), canSupplyPrivate, createdAt: row.created_at,
      operation: operation ? { id: operation.id, status: operation.status, summary: operation.summary, updatedAt: operation.updatedAt } : null };
  }
  async plan(input: unknown): Promise<LifecycleReview> {
    const fields = lifecyclePlanInput.parse(input); const { workspaceId, connectionId, planId } = fields;
    const memberRevision = await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const { row: connection, provider } = await this.hooks.active(workspaceId, connectionId);
    if (connection.revision !== fields.connectionRevision) this.conflict();
    const reviewed: Reviewed = { ...fields, memberRevision, tokenId: this.context.principal.tokenId ?? null, providerRef: connection.credential_ref, providerIdentity: provider.identity, providerActor: await hookProviderActor(this.context.principal.subject), connectionName: connection.name, target: "resourceId" in fields.change ? fields.change.resourceId : "destination:" + fields.change.name };
    const serialized = JSON.stringify(reviewed); const fingerprint = await credentialHash(serialized);
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE, memberRevision);
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO action_plans(id,workspace_id,actor_subject,kind,input_json,fingerprint,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
        AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND credential_ref=?)
        AND (SELECT count(*) FROM action_plans WHERE workspace_id=? AND actor_subject=? AND kind=? AND applied_at IS NULL AND expires_at>?)<?
        AND NOT EXISTS(SELECT 1 FROM operations o JOIN action_plans p ON p.id=o.plan_id WHERE o.workspace_id=? AND o.kind=? AND o.status IN ('pending','running','indeterminate') AND json_extract(p.input_json,'$.connectionId')=? AND json_extract(p.input_json,'$.target')=?)`).bind(planId, workspaceId, this.context.principal.subject, HOOK_LIFECYCLE_KIND, serialized, fingerprint, this.timestamp(), new Date(this.context.now() + LIMITS.PLAN_TTL_MS).toISOString(), ...guard.values, workspaceId, connectionId, connection.revision, connection.credential_ref, workspaceId, this.context.principal.subject, HOOK_LIFECYCLE_KIND, this.timestamp(), HOOK_LIMITS.PENDING_REVIEWS, workspaceId, HOOK_LIFECYCLE_KIND, connectionId, reviewed.target),
      this.db.prepare("INSERT OR IGNORE INTO hook_reviews(plan_id) SELECT id FROM action_plans WHERE id=? AND workspace_id=? AND fingerprint=? AND kind=?").bind(planId, workspaceId, fingerprint, HOOK_LIFECYCLE_KIND),
    ]);
    const row = await this.row(workspaceId, planId).catch(error => { if (error instanceof DomainError && error.code === "not_found") this.conflict(); throw error; });
    if (row.fingerprint !== fingerprint) this.conflict(); this.actor(row, reviewed);
    if (row.provider_review_json || row.applied_at) return this.get({ workspaceId, planId });
    if (Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const receipt = (await callHookProvider(await this.ready(row, reviewed), "lifecycle_plan", workspaceId, reviewed.providerActor, { planId, authorityId: fields.authorityId, revision: fields.revision, change: fields.change })).result;
    this.check(receipt, reviewed); if (receipt.state !== "ready") this.conflict();
    await this.ready(row, reviewed);
    await this.db.prepare(`UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=? AND provider_review_json IS NULL AND ${guard.sql}`).bind(JSON.stringify(receipt), planId, ...guard.values).run();
    return this.get({ workspaceId, planId });
  }
  async record(reviewed: Reviewed, operationId: string, receipt: LifecycleReceipt | null, failed = false, failureCode: HookProviderError["rejectionCode"] = null) {
    const components = receipt?.outcome ? [receipt.outcome.configuration, receipt.outcome.upstream] : [];
    const partial = components.includes("applied");
    const unresolved = components.some(value => value === "pending" || value === "indeterminate");
    const componentFailed = components.includes("failed");
    let status: Operation["status"] = "indeterminate";
    if (!unresolved) {
      if (componentFailed) status = partial ? "partial" : "failed";
      else if (receipt?.state === "applied" && receipt.outcome) status = "succeeded";
      else if (receipt?.state === "failed" || receipt?.state === "expired" || failed) status = partial ? "partial" : "failed";
    }
    const summary = status === "succeeded" ? "Lifecycle change accepted. Delivery and authenticated signing evidence remain separate outcomes." : status === "failed" ? "Lifecycle change was not accepted" + (failureCode ? " (provider " + failureCode + ")" : "") + ". Refresh the resource or restore its required authority before reviewing again." : status === "partial" ? "Lifecycle change partially completed. Inspect configuration and upstream outcomes before reviewing recovery." : "Lifecycle outcome needs reconciliation. Read the original receipt before another change.";
    await this.db.batch([
      this.db.prepare("UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE id=? AND workspace_id=? AND kind=? AND status IN ('pending','running','indeterminate','partial')").bind(status, summary, JSON.stringify({ receipt }), this.timestamp(), operationId, reviewed.workspaceId, HOOK_LIFECYCLE_KIND),
      this.db.prepare("INSERT OR IGNORE INTO activity(id,workspace_id,actor_subject,actor_name,type,title,summary,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(operationId + "_" + status, reviewed.workspaceId, this.context.principal.subject, this.context.principal.displayName, "hook.lifecycle." + status, "Hook lifecycle " + status, summary, this.timestamp()),
    ]);
    emitDiagnostic({ event: "hq.hooks.lifecycle", reference: operationId, workspaceId: reviewed.workspaceId, state: status });
  }
  async apply(input: unknown): Promise<LifecycleReview> {
    const { workspaceId, planId, fingerprint } = hookRetryApplyInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    this.actor(row, reviewed); if (row.fingerprint !== fingerprint) this.conflict();
    if (await this.operation(workspaceId, planId)) return this.get({ workspaceId, planId });
    const provider = await this.ready(row, reviewed);
    if (!row.provider_review_json || Date.parse(row.expires_at) <= this.context.now()) this.conflict();
    const baseline = lifecycleReceiptSchema.parse(JSON.parse(row.provider_review_json)); this.check(baseline, reviewed);
    const live = (await callHookProvider(provider, "lifecycle_get", workspaceId, reviewed.providerActor, { planId })).result;
    this.check(live, reviewed, baseline);
    if (live.state !== "ready" || Date.parse(live.expiresAt) <= this.context.now() || (live.privateInputRequired && !live.privateInputReceived)) this.conflict();
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE, reviewed.memberRevision); const operationId = crypto.randomUUID();
    const saved = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO operations(id,workspace_id,plan_id,actor_subject,kind,status,summary,created_at,updated_at) SELECT ?,?,?,?,?,'pending','Lifecycle change requested',?,? WHERE ${guard.sql}
        AND EXISTS(SELECT 1 FROM connections WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND credential_ref=?)
        AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND fingerprint=? AND applied_at IS NULL AND expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM operations o JOIN action_plans p ON p.id=o.plan_id WHERE o.workspace_id=? AND o.kind=? AND o.status IN ('pending','running','indeterminate') AND json_extract(p.input_json,'$.connectionId')=? AND json_extract(p.input_json,'$.target')=?)`).bind(operationId, workspaceId, planId, this.context.principal.subject, HOOK_LIFECYCLE_KIND, this.timestamp(), this.timestamp(), ...guard.values, workspaceId, reviewed.connectionId, reviewed.connectionRevision, reviewed.providerRef, planId, fingerprint, this.timestamp(), workspaceId, HOOK_LIFECYCLE_KIND, reviewed.connectionId, reviewed.target),
      this.db.prepare("UPDATE action_plans SET applied_at=? WHERE id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND plan_id=?)").bind(this.timestamp(), planId, operationId, planId),
    ]);
    if (!saved[0]!.meta.changes) { if (await this.operation(workspaceId, planId)) return this.get({ workspaceId, planId }); this.conflict(); }
    let receipt: LifecycleReceipt | null = null; let submitted = false; let failed = false; let failureCode: HookProviderError["rejectionCode"] = null;
    try { const current = await this.ready(row, reviewed); submitted = true; receipt = (await callHookProvider(current, "lifecycle_apply", workspaceId, reviewed.providerActor, { planId })).result; this.check(receipt, reviewed, baseline); }
    catch (error) { receipt = null; failed = !submitted || error instanceof HookProviderError && error.definiteRejection; if (error instanceof HookProviderError && error.definiteRejection) failureCode = error.rejectionCode; }
    await this.record(reviewed, operationId, receipt, failed, failureCode);
    return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown): Promise<LifecycleReview> {
    const { workspaceId, planId } = hookRetryInput.parse(input);
    const revision = await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json)); this.actor(row, reviewed);
    const provider = await this.provider(reviewed);
    const receipt = (await callHookProvider(provider, "lifecycle_get", workspaceId, reviewed.providerActor, { planId })).result;
    this.check(receipt, reviewed, row.provider_review_json ? lifecycleReceiptSchema.parse(JSON.parse(row.provider_review_json)) : undefined);
    if (await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE) !== revision || (await this.provider(reviewed)).identity !== provider.identity) this.conflict();
    await this.db.prepare("UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=?").bind(JSON.stringify(receipt), planId).run();
    if (receipt.privateInputReceived) await this.db.prepare("UPDATE hook_lifecycle_inputs SET status='accepted',updated_at=? WHERE plan_id=?").bind(this.timestamp(), planId).run();
    const operation = await this.operation(workspaceId, planId);
    if (operation) await this.record(reviewed, operation.id, receipt);
    return this.get({ workspaceId, planId });
  }
  async supply(request: Request, planId: string) {
    const selected = lifecycleSelectionInput.safeParse({ workspaceId: request.headers.get("x-workspace-id"), planId, fingerprint: request.headers.get("if-match") });
    if (!selected.success) throw new DomainError("validation", "Select the exact lifecycle review, workspace and fingerprint.", 400);
    const { workspaceId, fingerprint } = selected.data;
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.row(workspaceId, planId); const reviewed = reviewedSchema.parse(JSON.parse(row.input_json));
    this.actor(row, reviewed); if (row.fingerprint !== fingerprint) this.conflict();
    const provider = await this.ready(row, reviewed);
    const baseline = row.provider_review_json ? lifecycleReceiptSchema.parse(JSON.parse(row.provider_review_json)) : null;
    if (!baseline) this.conflict();
    const live = (await callHookProvider(provider, "lifecycle_get", workspaceId, reviewed.providerActor, { planId })).result; this.check(live, reviewed, baseline);
    if (live.privateInputReceived || live.state === "applied") return { planId, state: live.state, privateInputReceived: live.privateInputReceived, submitted: false };
    if (row.applied_at || !live.privateInputRequired || live.state !== "ready" || Date.parse(row.expires_at) <= this.context.now() || Date.parse(live.expiresAt) <= this.context.now()) this.conflict();
    const configuration = (await callHookProvider(provider, "lifecycle_configuration", workspaceId, reviewed.providerActor)).result;
    if (!configuration.canSupplyPrivate || !configuration.canProvision || configuration.authorityId !== reviewed.authorityId || configuration.revision !== reviewed.revision) throw new DomainError("forbidden", "Private destination input requires current provision and custody grants.", 403);
    const inputIntent = await this.db.prepare("SELECT status FROM hook_lifecycle_inputs WHERE plan_id=?").bind(planId).first<{ status: string }>();
    if (inputIntent && inputIntent.status !== "rejected") throw new DomainError("hooks_input_uncertain", "Private input already has a durable intent. Reconcile this same review before supplying anything else.", 409);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new DomainError("media_type", "Supply a private JSON document.", 415);
    const chunks: Uint8Array[] = []; let size = 0; const reader = request.body?.getReader();
    if (!reader) throw new DomainError("validation", "Private input is required.", 400);
    let bytes: Uint8Array | undefined;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > HOOK_LIFECYCLE_PRIVATE_BYTES) throw new DomainError("too_large", "Private destination input exceeds its byte limit.", 413); chunks.push(value); }
      bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body: string;
      try { body = JSON.stringify(lifecyclePrivateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))); }
      catch { throw new DomainError("validation", "Supply the documented private destination JSON document.", 400); }
      await this.ready(row, reviewed);
      const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE, reviewed.memberRevision);
      const saved = await this.db.prepare(`INSERT OR IGNORE INTO hook_lifecycle_inputs(plan_id,status,created_at,updated_at) SELECT ?,'pending',?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM action_plans WHERE id=? AND applied_at IS NULL AND expires_at>?) AND EXISTS(SELECT 1 FROM connections WHERE id=? AND workspace_id=? AND revision=? AND enabled=1 AND credential_ref=?) ON CONFLICT(plan_id) DO UPDATE SET status='pending',updated_at=excluded.updated_at WHERE hook_lifecycle_inputs.status='rejected'`).bind(planId, this.timestamp(), this.timestamp(), ...guard.values, planId, this.timestamp(), reviewed.connectionId, workspaceId, reviewed.connectionRevision, reviewed.providerRef).run();
      if (!saved.meta.changes) this.conflict();
      let dispatched = false;
      try {
        await this.ready(row, reviewed);
        dispatched = true;
        const result = await privateInput(provider, planId, workspaceId, reviewed.providerActor, live.fingerprint, body);
        if (result.planId !== planId || !result.privateInputReceived) throw new HookProviderError("metadata_invalid");
        await this.db.prepare("UPDATE hook_lifecycle_inputs SET status='accepted',updated_at=? WHERE plan_id=?").bind(this.timestamp(), planId).run();
        await this.db.prepare("UPDATE hook_reviews SET provider_review_json=? WHERE plan_id=?").bind(JSON.stringify({ ...live, privateInputReceived: true }), planId).run();
        return result;
      } catch (error) {
        const knownRejection = !dispatched || error instanceof PrivateInputRejected;
        await this.db.prepare("UPDATE hook_lifecycle_inputs SET status=?,updated_at=? WHERE plan_id=? AND status='pending'").bind(knownRejection ? "rejected" : "indeterminate", this.timestamp(), planId).run();
        if (knownRejection) throw error;
        throw new DomainError("hooks_input_uncertain", "Private destination acceptance is uncertain. Reconcile this same review; do not submit another value.", 503);
      }
    } finally { bytes?.fill(0); for (const chunk of chunks) chunk.fill(0); void reader.cancel().catch(() => {}); }
  }
}

class PrivateInputRejected extends DomainError {
  constructor(status: number) { super("hooks_input_rejected", "Hookrelay refused the private input before accepting it. Refresh this review, correct its private document or restore the required authority, then supply it again.", status); }
}

async function privateInput(provider: HookProvider, planId: string, workspaceId: string, actorId: string, fingerprint: string, body: string) {
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new HookProviderError("unavailable")); }, HOOK_LIMITS.PROVIDER_TIMEOUT_MS); });
  try { return await Promise.race([deadline, (async () => {
    const response = await provider.fetcher.fetch("https://hookrelay.internal/admin/api/v1/lifecycle-input/" + planId, { method: "POST", redirect: "manual", signal: controller.signal, headers: { authorization: "Bearer " + provider.token, "content-type": "application/json", "x-workspace-id": workspaceId, "x-actor-id": actorId, "if-match": fingerprint }, body });
    if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || response.headers.get("cache-control") !== "no-store") { void response.body?.cancel().catch(() => {}); throw new HookProviderError("unavailable"); }
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > HOOK_LIFECYCLE_PRIVATE_BYTES) throw new HookProviderError("metadata_invalid"); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (response.status !== 200) {
      if (hookProviderRejection(response.status, data, "private")) throw new PrivateInputRejected(response.status);
      throw new HookProviderError("unavailable");
    }
    return lifecycleInputReceiptSchema.parse(data);
  })()]); } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}
