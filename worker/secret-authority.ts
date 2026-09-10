import { CAPABILITY } from "../shared/domain";
import { hookActorGuard } from "./hook-authority";
import { SecretsService } from "./secrets";
import { DomainError } from "./errors";
import type { CapturedSecretDestination } from "./secret-reviews";
import type { WorkspaceService } from "./service";

export function secretReviewConflict(): never {
  throw new DomainError(
    "secret_review_conflict",
    "This review changed, expired, or lost its original authority. Keep your draft and inspect its status before preparing another operation.",
    409,
  );
}
export function capturedSecretGuard(
  context: WorkspaceService,
  workspaceId: string,
  memberRevision: number,
  items: CapturedSecretDestination[],
) {
  const actor = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.SECRETS,
    memberRevision,
  );
  return {
    sql: `${actor.sql} AND NOT EXISTS (SELECT 1 FROM json_each(?) i WHERE NOT EXISTS
      (SELECT 1 FROM secret_connections c WHERE c.workspace_id=? AND c.id=json_extract(i.value,'$.destination.connectionId')
        AND c.revision=json_extract(i.value,'$.destination.connectionRevision') AND c.provider_kind=json_extract(i.value,'$.providerKind')
        AND c.credential_ref=json_extract(i.value,'$.providerRef') AND c.enabled=1))`,
    values: [...actor.values, JSON.stringify(items), workspaceId],
  };
}
export async function connectCapturedSecrets(
  context: WorkspaceService,
  workspaceId: string,
  items: CapturedSecretDestination[],
) {
  const secrets = new SecretsService(context);
  const connected = [];
  for (const item of items) {
    const selected = await secrets.resource(
      workspaceId,
      item.destination.connectionId,
      item.destination.target.resourceId,
    );
    if (
      selected.row.revision !== item.destination.connectionRevision ||
      selected.row.provider_kind !== item.providerKind ||
      selected.row.credential_ref !== item.providerRef ||
      selected.provider.identity !== item.providerIdentity ||
      !selected.provider.writable
    )
      secretReviewConflict();
    await selected.provider.checkPrepared(item.resource, item.snapshot);
    connected.push(selected.provider);
  }
  return connected;
}
