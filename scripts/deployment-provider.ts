import { z } from "zod";
import { sha256, type ReleaseProfile } from "./release-profile";
import type { clientConfiguration } from "../cli/client";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 1000;
const envelope = z.object({ success: z.literal(true), result: z.unknown(), result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional() }).optional() });
const binding = z.object({ type: z.string(), name: z.string(), id: z.string().optional() }).passthrough();
const deployments = z.object({ deployments: z.array(z.object({ id: z.string(), versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })) })) });

export class DeploymentProviderError extends Error {}

export type Target = { accountId: string; workerName: string; hostname: string; profile?: ReleaseProfile };
export type TargetSnapshot = { deploymentId: string; versions: { version_id: string; percentage: number }[]; secretNames: string[]; domainId?: string; variableFingerprints: Record<string, string>; serviceBindings: { binding: string; service: string }[] };

async function request(path: string, token: string, transport: typeof fetch) {
  let response: Response;
  try {
    response = await transport(API + path, { headers: { Authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch { throw new DeploymentProviderError("Cloudflare readback could not be completed"); }
  if (!response.ok) throw new DeploymentProviderError("Cloudflare readback failed with HTTP " + response.status);
  try { return envelope.parse(await response.json()); }
  catch { throw new DeploymentProviderError("Cloudflare returned an unsupported readback response"); }
}

export async function cloudflareList(path: string, token: string, transport: typeof fetch = fetch): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await request(path + `?per_page=100&page=${page}`, token, transport);
    if (!Array.isArray(result.result)) throw new DeploymentProviderError("Cloudflare inventory response is not a list");
    items.push(...result.result);
    if (result.result_info?.total_pages !== undefined) {
      if (page >= result.result_info.total_pages) return items;
    } else if (result.result.length < 100) return items;
  }
  throw new DeploymentProviderError("Cloudflare inventory exceeded the pagination limit");
}

export async function servingDeployment(target: Target, token: string, transport: typeof fetch = fetch) {
  const base = `/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.workerName)}`;
  const value = deployments.parse((await request(base + "/deployments", token, transport)).result).deployments[0];
  if (!value) throw new DeploymentProviderError("Worker has no retained deployment");
  return { deploymentId: value.id, versions: value.versions };
}

export async function assertUploaded(target: Target, token: string, runId: string, previous: TargetSnapshot, transport: typeof fetch = fetch) {
  const current = await servingDeployment(target, token, transport);
  if (current.deploymentId === previous.deploymentId || current.versions.length !== 1 || current.versions[0].percentage !== 100)
    throw new DeploymentProviderError("Serving deployment did not advance to one complete uploaded version");
  const version = z.object({ metadata: z.object({ annotations: z.record(z.string(), z.string()).optional() }).optional(), annotations: z.record(z.string(), z.string()).optional() }).passthrough().parse(
    (await request(`/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.workerName)}/versions/${current.versions[0].version_id}`, token, transport)).result,
  );
  const annotations = version.annotations ?? version.metadata?.annotations;
  if (annotations?.["workers/tag"] !== runId) throw new DeploymentProviderError("Serving version does not match this deployment run");
  return current;
}

export async function checkTarget(target: Target, token: string, transport: typeof fetch = fetch): Promise<TargetSnapshot> {
  const account = `/accounts/${target.accountId}`;
  const worker = `${account}/workers/scripts/${encodeURIComponent(target.workerName)}`;
  const domains = z.array(z.object({ id: z.string().optional(), hostname: z.string(), service: z.string(), environment: z.string().optional() })).parse(await cloudflareList(account + "/workers/domains", token, transport));
  const domain = domains.find(value => value.hostname === target.hostname);
  if (!domain || domain.service !== target.workerName || (domain.environment && domain.environment !== "production"))
    throw new DeploymentProviderError("Expected hostname is not owned by the selected production Worker");
  const settings = z.object({ bindings: z.array(binding) }).parse((await request(worker + "/settings", token, transport)).result);
  const ingress = z.object({ enabled: z.boolean(), previews_enabled: z.boolean().optional() }).parse((await request(worker + "/subdomain", token, transport)).result);
  if (ingress.enabled || ingress.previews_enabled !== false) throw new DeploymentProviderError("Unexpected workers.dev or preview ingress; review separately");
  const serviceBindings = settings.bindings.filter(value => value.type === "service").map(value => {
    if (typeof value.service !== "string" || value.entrypoint || (value.environment && value.environment !== "production"))
      throw new DeploymentProviderError("Unsupported private service binding; review separately");
    return { binding: value.name, service: value.service };
  }).sort((a, b) => a.binding.localeCompare(b.binding));
  if (target.profile) {
    const profile = target.profile;
    const expectedServices = [...profile.hookrelayBindings ?? [], ...profile.monitoringBindings ?? []].sort((a, b) => a.binding.localeCompare(b.binding));
    if (JSON.stringify(serviceBindings) !== JSON.stringify(expectedServices))
      throw new DeploymentProviderError("Deployed private service bindings differ from the selected profile; review provider changes separately");
    for (const [name, expected] of [["ACCESS_ISSUER", profile.accessIssuer], ["ACCESS_AUDIENCE", profile.accessAudience]]) {
      if (!settings.bindings.some(value => value.type === "plain_text" && value.name === name && value.text === expected))
        throw new DeploymentProviderError("Deployed Access identity differs from the profile; review identity changes separately");
    }
    const database = settings.bindings.filter(value => value.type === "d1");
    if (database.length !== 1 || database[0].name !== "HQ_DB" || database[0].id !== profile.databaseId)
      throw new DeploymentProviderError("Deployed database binding differs from the selected profile");
    const d1 = z.object({ uuid: z.string(), name: z.string() }).parse((await request(`${account}/d1/database/${profile.databaseId}`, token, transport)).result);
    if (d1.uuid !== profile.databaseId || d1.name !== profile.databaseName) throw new DeploymentProviderError("Selected database identity differs from the profile");
    const scripts = z.array(z.object({ id: z.string(), tag: z.string().optional() })).parse(await cloudflareList(account + "/workers/scripts", token, transport));
    const script = scripts.find(value => value.id === target.workerName);
    if (!script?.tag) throw new DeploymentProviderError("Cannot verify immutable Worker identity");
    const apps = z.array(z.object({ aud: z.string().optional(), domain: z.string().optional(), destinations: z.array(z.object({ type: z.string(), worker_id: z.string().optional(), uri: z.string().optional() }).passthrough()).optional() }).passthrough()).parse(await cloudflareList(account + "/access/apps", token, transport));
    if (!apps.some(app => app.aud === profile.accessAudience && (app.domain === target.hostname || app.destinations?.some(destination => destination.type === "worker" && destination.worker_id === script.tag))))
      throw new DeploymentProviderError("Expected Access application does not cover the deployment");
  } else if (settings.bindings.some(value => value.type !== "assets")) {
    throw new DeploymentProviderError("Documentation Worker has unexpected runtime bindings");
  }
  return { ...await servingDeployment(target, token, transport), serviceBindings, secretNames: settings.bindings.filter(value => value.type === "secret_text").map(value => value.name).sort(), domainId: domain.id, variableFingerprints: Object.fromEntries(settings.bindings.filter(value => ["plain_text", "json"].includes(value.type)).map(value => [value.name, sha256(JSON.stringify(value.type === "plain_text" ? value.text : value.json))]).sort(([a], [b]) => a.localeCompare(b))) };
}

async function get(url: string, headers: Record<string, string>, transport: typeof fetch) {
  try { return await transport(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new DeploymentProviderError("Deployment smoke request could not be completed"); }
}

export async function smokeApplication(configuration: ReturnType<typeof clientConfiguration>, issuer: string, transport: typeof fetch = fetch) {
  for (const path of ["/", "/healthz", "/api/session"]) {
    const anonymous = await get(configuration.origin + path, {}, transport);
    const location = anonymous.headers.get("location");
    const login = location ? new URL(location, configuration.origin) : undefined;
    const denied = [401, 403].includes(anonymous.status) || ([302, 303, 307].includes(anonymous.status) && login?.origin === issuer && login.pathname.startsWith("/cdn-cgi/access/"));
    await anonymous.body?.cancel();
    if (!denied) throw new DeploymentProviderError("Anonymous application ingress was not denied by the expected boundary");
  }
  const shell = await get(configuration.origin + "/", configuration.headers, transport);
  if (shell.status !== 200 || !shell.headers.get("content-type")?.includes("text/html")) throw new DeploymentProviderError("Authenticated application shell smoke failed");
  await shell.body?.cancel();
  const health = await get(configuration.origin + "/healthz", configuration.headers, transport);
  if (health.status !== 200 || (await health.json() as { status?: string }).status !== "ok") throw new DeploymentProviderError("Authenticated application health smoke failed");
  const session = await get(configuration.origin + "/api/session", configuration.headers, transport);
  if (session.status !== 200 || !session.headers.get("content-type")?.includes("application/json")) throw new DeploymentProviderError("Authenticated application session smoke failed");
  const body: unknown = await session.json();
  if (!body || typeof body !== "object" || !("workspaces" in body) || !Array.isArray(body.workspaces) || body.workspaces.length === 0) throw new DeploymentProviderError("Smoke identity has no application workspace access");
}

export async function smokeDocs(target: Target, searchPath: string, transport: typeof fetch = fetch) {
  const origin = "https://" + target.hostname;
  for (const [path, status] of [["/", 200], ["/release/", 200], ["/deployment-smoke-missing-page", 404], [searchPath, 200]] as const) {
    const response = await get(origin + path, {}, transport);
    if (response.status !== status) throw new DeploymentProviderError("Documentation smoke failed: " + path);
    if (response.headers.get("x-content-type-options") !== "nosniff" || response.headers.get("x-frame-options") !== "DENY") throw new DeploymentProviderError("Documentation security header smoke failed");
    await response.body?.cancel();
  }
}
