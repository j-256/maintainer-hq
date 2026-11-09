import { HANDOFF_PROFILES, handoffRecordSchema, type HandoffReceipt } from "../shared/hook-handoff";
import { HOOK_DELIVERY_STATES, HOOK_LIMITS } from "../shared/hooks";
import type { Env } from "./types";

// Imported only by the isolated development entrypoint
const authorityId = "d".repeat(32);
const workspaceId = "development";
const credentialRef = "handoff-demo";
const receipts = new Map<string, HandoffReceipt>();
const repositories = new Map<string, { id: string; repository: string; record: ReturnType<typeof handoffRecordSchema.parse>; resources: Map<string, HandoffReceipt> }>();
let revision = 1;
const events = Object.freeze({ activity: ["push", "workflow_run", "pull_request"], stars: ["star"], alerts: ["code_scanning_alert", "dependabot_alert", "secret_scanning_alert"] });
const now = () => new Date().toISOString();
function detail(receipt: HandoffReceipt) { return { resourceId: receipt.resourceId, name: receipt.name, source: "github", policy: { enabled: true, sinks: receipt.sinks, filter: null, sinkFilters: {} } }; }
const fetcher = { fetch: async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)); const input = body.input;
  const fail = () => Response.json({ error: { code: "validation" } }, { status: 400, headers: { "cache-control": "no-store" } });
  if (input.workspaceId !== workspaceId) return fail();
  let result: unknown;
  const authority = { authorityId, revision, mode: "active" };
  const all = [...repositories.values()].flatMap(repository => [...repository.resources.values()]);
  if (body.action === "reveal" || body.action === "export") {
    const repository = [...repositories.values()].find(repository => body.action === "export" ? repository.id === input.repositoryId : [...repository.resources.values()].some(receipt => receipt.resourceId === input.resourceId));
    if (!repository) return fail();
    if (body.action === "reveal") {
      const receipt = [...repository.resources.values()].find(receipt => receipt.resourceId === input.resourceId)!;
      result = { resourceId: receipt.resourceId, repository: repository.repository, profile: receipt.profile, url: `https://hooks.example/hook/github/${repository.record.slugs[receipt.profile]}`, secret: repository.record.hmac.value,
        events: events[receipt.profile], contentType: "application/json", sslVerification: true, settingsUrl: `https://github.com/${repository.repository}/settings/hooks/new` };
    } else {
      const profiles = HANDOFF_PROFILES.filter(profile => repository.resources.has(profile));
      result = { version: 1, repository: repository.repository, origin: "https://hooks.example", record: { ...repository.record, profiles, provider: { kind: "hookrelay-handoff-v1", authorityId, workspaceId, repositoryId: repository.id, bundleRevision: 1,
        resources: Object.fromEntries(profiles.map(profile => [profile, { resourceId: repository.resources.get(profile)!.resourceId, authMode: "bundle" }])) } },
        routes: await Promise.all(profiles.map(async profile => {
          const receipt = repository.resources.get(profile)!;
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repository.record.slugs[profile]));
          return { name: receipt.name, source: "github", enabled: true, sinks: receipt.sinks, slugHash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            auth: { scheme: "github-sha256", secretEnv: "HOOK_HANDOFF_KEYS", credentialId: repository.id }, githubHandoff: { authorityId, workspaceId, repositoryId: repository.id, resourceId: receipt.resourceId, repository: repository.repository, profile }, setup: { github: { repo: repository.repository, eventProfiles: [profile] } } };
        })), exportedAt: now() };
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }
  switch (body.command) {
    case "github_handoff_configuration": result = { ...authority, canCreate: true, canReveal: true, reason: "ready", observedAt: now() }; break;
    case "github_handoff_repository": { const repository = repositories.get(input.repository.toLowerCase()); result = { repository: repository?.repository ?? input.repository, repositoryId: repository?.id ?? null, resources: repository ? [...repository.resources.values()].map(receipt => ({ resourceId: receipt.resourceId, profile: receipt.profile, authMode: "bundle" })) : [], adoptionRequired: false, observedAt: now() }; break; }
    case "github_handoff_plan": {
      if (input.revision !== revision) return fail();
      if (!receipts.has(input.planId)) {
        const key = input.repository.toLowerCase(); let repository = repositories.get(key);
        if (!repository) { const id = crypto.randomUUID(); repository = { id, repository: input.repository, record: { hmac: { name: "HMAC_GITHUB_" + input.repository.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), value: "synthetic-demo-shared-signing-secret-" + id }, slugs: { activity: "synthetic-demo-activity-" + id, stars: "synthetic-demo-stars-" + id, alerts: "synthetic-demo-alerts-" + id }, state: "active", profiles: [] }, resources: new Map() }; repositories.set(key, repository); }
        if (repository.resources.has(input.profile)) return fail();
        receipts.set(input.planId, { planId: input.planId, repositoryId: repository.id, resourceId: crypto.randomUUID(), repository: repository.repository, name: `github:${repository.repository}${input.profile === "activity" ? "" : ":" + input.profile}`, profile: input.profile, profiles: [input.profile], sinks: input.sinks, action: "create", status: "ready", routingConfigured: false, createdAt: now(), expiresAt: new Date(Date.now() + 300000).toISOString(), updatedAt: now() });
      }
      result = receipts.get(input.planId); break;
    }
    case "github_handoff_apply": { const receipt = receipts.get(input.planId); if (!receipt) return fail(); if (!receipt.routingConfigured) { receipt.routingConfigured = true; receipt.status = "configured"; receipt.updatedAt = now(); repositories.get(receipt.repository.toLowerCase())!.resources.set(receipt.profile, receipt); revision++; } result = receipt; break; }
    case "github_handoff_get": result = receipts.get(input.planId); if (!result) return fail(); break;
    case "github_handoff_status": { const receipt = all.find(receipt => receipt.resourceId === input.resourceId); if (!receipt) return fail(); result = { resourceId: receipt.resourceId, repository: receipt.repository, profile: receipt.profile, routingConfigured: receipt.routingConfigured, credentialAvailable: true, pingAt: null, deliveredAt: null, sample: { events: 0, limit: 100, truncated: false }, observedAt: now() }; break; }
    case "configuration": result = { ...authority, canConfigure: true, supported: { policy: true, create: false, retire: false }, observedAt: now() }; break;
    case "configuration_sinks": result = { ...authority, items: [{ resourceId: "00000000-0000-4000-8000-000000000001", name: "discord:repo-activity", type: "discord", retired: false }, { resourceId: "00000000-0000-4000-8000-000000000002", name: "discord:github-stars", type: "discord", retired: false }, { resourceId: "00000000-0000-4000-8000-000000000003", name: "discord:repo-alerts", type: "discord", retired: false }], nextCursor: null, observedAt: now() }; break;
    case "configuration_subscription": { const receipt = all.find(receipt => receipt.resourceId === input.resourceId); if (!receipt) return fail(); result = { ...authority, ...detail(receipt), observedAt: now() }; break; }
    case "configuration_subscriptions": result = { ...authority, items: all.map(detail), nextCursor: null, observedAt: now() }; break;
    case "snapshot": result = { observedAt: now(), deliveries: { totals: Object.fromEntries(HOOK_DELIVERY_STATES.map(state => [state, 0])), sampled: 0, limit: HOOK_LIMITS.HEALTH_SAMPLE, truncated: false }, signals: { items: [], truncated: false }, lastRetentionAt: null }; break;
    case "deliveries": result = { items: [], nextCursor: null, scanned: 0, observedAt: now(), pagination: "live-updated-desc" }; break;
    default: return fail();
  }
  return Response.json({ version: 1, capabilities: ["read"], result });
} };
export async function handoffDemoEnvironment(env: Env): Promise<Env> {
  if ((env as unknown as Record<string, unknown>).HQ_HANDOFF_DEMO !== "true") return env;
  if (!await env.HQ_DB.prepare("SELECT id FROM workspaces WHERE id='development'").first()) return env;
  await env.HQ_DB.prepare("INSERT OR IGNORE INTO connections(id,workspace_id,name,provider,configuration_json,credential_ref,enabled,revision,write_id) VALUES('handoff-demo','development','Synthetic handoff demo','hookrelay','{}','handoff-demo',1,1,'handoff-demo')").run();
  return new Proxy(env, { get(target, key, receiver) {
    if (key === "HOOKRELAY_HANDOFF_DEMO") return fetcher;
    if (key === "HOOKRELAY_CREDENTIALS") return JSON.stringify({ [credentialRef]: { workspaceId, name: "Synthetic handoff demo", binding: "HOOKRELAY_HANDOFF_DEMO", providerId: "synthetic-handoff", revision: 1, token: "hkr_" + "d".repeat(43) } });
    return Reflect.get(target, key, receiver);
  } });
}
