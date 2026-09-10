import { z } from "zod";
import { idSchema } from "../shared/domain";
import type { GitHubCredentialReference } from "../shared/github";
import { credentialHash } from "./credential-hash";
import type { Env } from "./types";

const CATALOG_LIMIT = 100;
const CATALOG_BYTES = 512 * 1024;
const descriptorSchema = z
  .object({
    workspaceId: idSchema,
    name: z.string().trim().min(1).max(80),
    token: z.string().regex(/^[\x21-\x7e]{1,2048}$/),
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;

function catalog(env: Env) {
  const entries = new Map<string, Descriptor>();
  if (!env.GITHUB_CREDENTIALS || env.GITHUB_CREDENTIALS.length > CATALOG_BYTES)
    return entries;
  try {
    const value: unknown = JSON.parse(env.GITHUB_CREDENTIALS);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return entries;
    const fields = Object.entries(value);
    if (fields.length > CATALOG_LIMIT) return entries;
    for (const [id, input] of fields) {
      if (!idSchema.safeParse(id).success) continue;
      const parsed = descriptorSchema.safeParse(input);
      if (parsed.success) entries.set(id, parsed.data);
    }
  } catch {
    // Invalid deployment bindings fail closed
  }
  return entries;
}
export function githubCredentialReferences(
  env: Env,
  workspaceId: string,
): GitHubCredentialReference[] {
  return [...catalog(env)]
    .filter(([, entry]) => entry.workspaceId === workspaceId)
    .map(([id, entry]) => ({ id, name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function githubCredential(
  env: Env,
  workspaceId: string,
  reference: string | null,
) {
  const entry = reference ? catalog(env).get(reference) : undefined;
  return entry?.workspaceId === workspaceId ? entry : null;
}
export async function githubCredentialIdentity(
  env: Env,
  workspaceId: string,
  reference: string | null,
) {
  const credential = githubCredential(env, workspaceId, reference);
  return credential
    ? { ...credential, hash: await credentialHash(credential.token) }
    : null;
}
