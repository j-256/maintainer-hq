import {
  MANAGED_CREDENTIAL_PREFIX,
  PROVIDER_CREDENTIAL_LIMITS,
  providerCredentialFieldsSchema,
  type ProviderCredential,
  type ProviderCredentialFields,
  type ProviderCredentialKind,
} from "../shared/provider-credentials";
import { hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import {
  openProviderCredential,
  providerCredentialKeyStatus,
  type CredentialBinding,
} from "./provider-credential-crypto";
import type { WorkspaceService } from "./service";

export const PROVIDER_CREDENTIAL_COLUMNS =
  "workspace_id,id,provider_kind,settings_json,revision,identity,key_id,created_at,updated_at,retired_at";
export type ProviderCredentialRow = {
  workspace_id: string;
  id: string;
  provider_kind: ProviderCredentialKind;
  settings_json: string;
  revision: number;
  identity: string;
  key_id: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
};
export function managedCredentialReference(reference: string) {
  return reference.startsWith(MANAGED_CREDENTIAL_PREFIX);
}
export function providerCredentialGuard(
  workspaceId: string,
  kind: ProviderCredentialKind,
  reference: string,
  identity: string,
) {
  if (!managedCredentialReference(reference)) return { sql: "1", values: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.workspace_id=? AND pc.id=? AND pc.provider_kind=?
      AND pc.identity=? AND pc.retired_at IS NULL AND julianday(json_extract(pc.settings_json,'$.expiresAt'))>julianday('now'))`,
    values: [workspaceId, reference, kind, identity],
  };
}
export function providerCredentialUnavailable(): never {
  throw new DomainError(
    "provider_credential_unavailable",
    "This provider credential is unavailable, retired, expired, or outside the requested workspace and provider scope. Ask the owner to review it.",
    503,
  );
}
export function providerCredentialBinding(
  row: ProviderCredentialRow,
): CredentialBinding {
  let settings: ProviderCredentialFields;
  try {
    settings = providerCredentialFieldsSchema.parse(
      JSON.parse(row.settings_json),
    );
  } catch {
    return providerCredentialUnavailable();
  }
  if (settings.providerKind !== row.provider_kind)
    providerCredentialUnavailable();
  return {
    workspaceId: row.workspace_id,
    credentialId: row.id,
    revision: row.revision,
    identity: row.identity,
    settings,
  };
}
export function describeProviderCredential(
  context: WorkspaceService,
  row: ProviderCredentialRow,
): ProviderCredential {
  const { settings } = providerCredentialBinding(row);
  return {
    id: row.id,
    revision: row.revision,
    settings,
    status: row.retired_at
      ? "retired"
      : Date.parse(settings.expiresAt) <= context.now()
        ? "expired"
        : !row.key_id || !providerCredentialKeyStatus(context.env, row.key_id)
          ? "key-unavailable"
          : "available",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}
export async function managedProviderCredentialRows(
  context: WorkspaceService,
  workspaceId: string,
  kind: ProviderCredentialKind,
) {
  const guard = hookActorGuard(context, workspaceId);
  const result = await context.db
    .prepare(
      `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM provider_credentials
    WHERE workspace_id=? AND provider_kind=? AND retired_at IS NULL AND ${guard.sql} ORDER BY id LIMIT ?`,
    )
    .bind(
      workspaceId,
      kind,
      ...guard.values,
      PROVIDER_CREDENTIAL_LIMITS.WORKSPACE + 1,
    )
    .all<ProviderCredentialRow>();
  if (result.results.length > PROVIDER_CREDENTIAL_LIMITS.WORKSPACE) {
    throw new DomainError(
      "capacity",
      "Too many provider credentials are enrolled in this workspace. Ask the owner to retire unused credentials.",
      409,
    );
  }
  return result.results;
}
export async function managedProviderCredential(
  context: WorkspaceService,
  workspaceId: string,
  reference: string,
  kind: ProviderCredentialKind,
) {
  if (!managedCredentialReference(reference)) providerCredentialUnavailable();
  const guard = hookActorGuard(context, workspaceId);
  const row = await context.db
    .prepare(
      `SELECT ${PROVIDER_CREDENTIAL_COLUMNS},nonce,ciphertext FROM provider_credentials
    WHERE workspace_id=? AND id=? AND provider_kind=? AND retired_at IS NULL AND ${guard.sql}`,
    )
    .bind(workspaceId, reference, kind, ...guard.values)
    .first<ProviderCredentialRow & { nonce: string; ciphertext: string }>();
  if (!row || !row.key_id) providerCredentialUnavailable();
  const binding = providerCredentialBinding(row);
  if (Date.parse(binding.settings.expiresAt) <= context.now())
    providerCredentialUnavailable();
  const token = await openProviderCredential(context.env, binding, {
    keyId: row.key_id,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  });
  return {
    settings: binding.settings,
    revision: row.revision,
    identity: row.identity,
    token,
  };
}
