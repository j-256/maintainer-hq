import {
  GITHUB_APP_LIMITS as LIMITS,
  GITHUB_CAPABILITY,
  githubAppGrantSchema,
  githubAppMetadataSchema,
  type GitHubCapability,
  type GitHubAuthReference,
} from "../shared/github-apps";
import {
  githubCredentialIdentity,
  githubCredentialReferences as legacyReferences,
} from "./github-credentials";
import { githubAppQuotaKey } from "./github-app-authority";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import type { GitHubCredentialContext } from "./github-app-types";
export type GitHubCredentialDescriptor = {
  id: string;
  name: string;
  kind: "app" | "token";
  reference: GitHubAuthReference;
  hash: string;
  quotaKey: string;
  capabilities: GitHubCapability[];
  repositoryNames: string[] | null;
  expiresAt: string | null;
  revision: number;
  available: boolean;
  appBinding?: {
    registrationId: string;
    registrationRevision: number;
    keyRevision: number;
    grantId: string;
    grantRevision: number;
  };
};
type AppRow = {
  reference_id: string;
  grant_json: string;
  grant_state: string;
  grant_revision: number;
  expires_at: string | null;
  registration_json: string;
  registration_revision: number;
  key_revision: number;
};
const APP_ROWS = `SELECT ref.reference_id,g.metadata_json AS grant_json,g.state AS grant_state,g.revision AS grant_revision,g.expires_at,r.metadata_json AS registration_json,r.revision AS registration_revision,r.key_revision
  FROM github_app_credential_references ref LEFT JOIN github_app_grants g ON g.id=ref.grant_id AND g.workspace_id=ref.workspace_id LEFT JOIN github_app_registrations r ON r.id=g.registration_id WHERE ref.workspace_id=?`;
async function appDescriptor(
  context: GitHubCredentialContext,
  row: AppRow,
): Promise<GitHubCredentialDescriptor> {
  const grant = githubAppGrantSchema.parse(JSON.parse(row.grant_json));
  const registration = githubAppMetadataSchema.parse(
    JSON.parse(row.registration_json),
  );
  const capabilities = grant.capabilities.filter((capability) =>
    registration.capabilities.includes(capability),
  );
  return {
    id: row.reference_id,
    appBinding: {
      registrationId: registration.id,
      registrationRevision: row.registration_revision,
      keyRevision: row.key_revision,
      grantId: grant.id,
      grantRevision: row.grant_revision,
    },
    name: (registration.name + " / " + grant.account.login).slice(0, 80),
    kind: "app",
    reference: { kind: "app", grantId: grant.id },
    hash: await credentialHash(
      JSON.stringify([
        "github-app-configuration",
        registration.id,
        registration.appId,
        row.registration_revision,
        row.key_revision,
        grant.installationId,
        grant.id,
        row.grant_revision,
        capabilities,
        grant.repositories,
        row.grant_state,
        row.expires_at,
      ]),
    ),
    quotaKey: await githubAppQuotaKey(
      context,
      registration.appId,
      grant.installationId,
    ),
    capabilities,
    repositoryNames: grant.repositories.map(
      (repository) => repository.fullName,
    ),
    expiresAt: row.expires_at,
    revision: row.grant_revision,
    available:
      row.grant_state === "active" &&
      registration.state === "active" &&
      (!row.expires_at || Date.parse(row.expires_at) > context.now()) &&
      capabilities.length > 0,
  };
}
export async function githubCredentialDescriptors(
  context: GitHubCredentialContext,
  workspaceId: string,
  input: (string | null)[],
) {
  const references = [
    ...new Set(
      input.filter((reference): reference is string => reference !== null),
    ),
  ];
  if (references.length > LIMITS.GRANTS + LIMITS.REGISTRATIONS)
    throw new DomainError(
      "capacity",
      "Choose a bounded set of workspace credential references.",
      409,
    );
  const rows = await context.db
    .prepare(
      APP_ROWS +
        " AND ref.reference_id IN (SELECT value FROM json_each(?)) ORDER BY ref.reference_id",
    )
    .bind(workspaceId, JSON.stringify(references))
    .all<AppRow>();
  const result = new Map<string | null, GitHubCredentialDescriptor | null>([
    [null, null],
  ]);
  for (const row of rows.results)
    result.set(row.reference_id, await appDescriptor(context, row));
  for (const reference of references) {
    if (result.has(reference)) continue;
    result.set(
      reference,
      await manualGitHubCredentialDescriptor(context, workspaceId, reference),
    );
  }
  return result;
}
// Metadata for an explicitly pinned manual-token mode; claims and receipts still use the resolver fence
export async function manualGitHubCredentialDescriptor(
  context: GitHubCredentialContext,
  workspaceId: string,
  reference: string,
): Promise<GitHubCredentialDescriptor | null> {
  const token = await githubCredentialIdentity(
    context.env,
    workspaceId,
    reference,
  );
  return token
    ? {
        id: reference,
        name: token.name,
        kind: "token",
        reference: { kind: "token", reference },
        hash: token.hash,
        quotaKey: token.hash,
        capabilities: [GITHUB_CAPABILITY.COLLECTION],
        repositoryNames: null,
        expiresAt: null,
        revision: 1,
        available: true,
      }
    : null;
}
export async function githubCredentialDescriptor(
  context: GitHubCredentialContext,
  workspaceId: string,
  reference: string | null,
) {
  return (
    (await githubCredentialDescriptors(context, workspaceId, [reference])).get(
      reference,
    ) ?? null
  );
}
export async function githubAppCredentialReferences(
  context: GitHubCredentialContext,
  workspaceId: string,
) {
  const rows = await context.db
    .prepare(APP_ROWS + " ORDER BY ref.reference_id LIMIT ?")
    .bind(workspaceId, LIMITS.GRANTS + 1)
    .all<AppRow>();
  if (rows.results.length > LIMITS.GRANTS)
    throw new DomainError(
      "capacity",
      "This workspace has too many App credential references. Ask its owner to review unused grants.",
      409,
    );
  return Promise.all(rows.results.map((row) => appDescriptor(context, row)));
}
export async function githubCredentialReferences(
  context: GitHubCredentialContext,
  workspaceId: string,
) {
  const apps = await githubAppCredentialReferences(context, workspaceId);
  const appIds = new Set(apps.map((app) => app.id));
  return [
    ...legacyReferences(context.env, workspaceId)
      .filter((reference) => !appIds.has(reference.id))
      .map((reference) => ({
        ...reference,
        kind: "token" as const,
        capabilities: [GITHUB_CAPABILITY.COLLECTION],
        available: true,
      })),
    ...apps
      .filter((app) => app.capabilities.includes(GITHUB_CAPABILITY.COLLECTION))
      .map((app) => ({
        id: app.id,
        name: app.name,
        kind: app.kind,
        capabilities: app.capabilities,
        available: app.available,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function githubCredentialDescriptorGuard(
  workspaceId: string,
  credential: GitHubCredentialDescriptor,
) {
  const app = credential.appBinding;
  if (!app)
    return {
      sql: "NOT EXISTS(SELECT 1 FROM github_app_credential_references WHERE workspace_id=? AND reference_id=?)",
      values: [workspaceId, credential.id] as unknown[],
    };
  return {
    sql: `EXISTS(SELECT 1 FROM github_app_credential_references ref JOIN github_app_grants g ON g.id=ref.grant_id JOIN github_app_registrations r ON r.id=g.registration_id
      WHERE ref.workspace_id=? AND ref.reference_id=? AND g.workspace_id=ref.workspace_id AND g.id=? AND g.revision=? AND g.state='active'
      AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.id=? AND r.revision=? AND r.key_revision=? AND json_extract(r.metadata_json,'$.state')='active')`,
    values: [
      workspaceId,
      credential.id,
      app.grantId,
      app.grantRevision,
      app.registrationId,
      app.registrationRevision,
      app.keyRevision,
    ] as unknown[],
  };
}

export function githubCredentialCoversRepository(
  credential: GitHubCredentialDescriptor | null | undefined,
  fullName: string,
  capability: GitHubCapability = GITHUB_CAPABILITY.COLLECTION,
) {
  return Boolean(
    credential?.available &&
    credential.capabilities.includes(capability) &&
    (credential.repositoryNames === null ||
      credential.repositoryNames.some(
        (name) => name.toLowerCase() === fullName.toLowerCase(),
      )),
  );
}
