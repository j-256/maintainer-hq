import { z } from "zod";
import { idSchema, repositoryFields } from "../shared/domain";
import {
  SECRET_LIMITS,
  type SecretCapabilities,
  type SecretEntryKind,
  type SecretInventory,
  type SecretProviderKind,
  type SecretProviderReference,
  type SecretScopes,
  type SecretScope,
  type SecretTargetSnapshot,
  type SecretMetadata,
  type SecretWriteResult,
} from "../shared/secrets";
import type { WorkspaceService } from "./service";
import type {
  ManagedProviderSnapshot,
} from "../shared/managed-configurations";

export const secretResourceBindingSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(255),
    identity: z.string().min(1).max(255),
    repositories: z
      .array(
        z
          .object({ id: idSchema, fullName: repositoryFields.shape.fullName })
          .strict(),
      )
      .max(SECRET_LIMITS.RESOURCES),
  })
  .strict();
export type SecretResourceBinding = z.infer<typeof secretResourceBindingSchema>;
export function describeSecretResource(binding: SecretResourceBinding) {
  return {
    id: binding.id,
    label: binding.label,
    repositoryIds: binding.repositories.map((item) => item.id),
  };
}
export interface ConnectedSecretProvider {
  identity: string;
  writable: boolean;
  selectResources(ids: string[]): Promise<SecretResourceBinding[]>;
  checkResources(resources: SecretResourceBinding[]): Promise<void>;
  scopes(resource: SecretResourceBinding, page: number): Promise<SecretScopes>;
  inventory(
    resource: SecretResourceBinding,
    scope: SecretScope,
    entryKind: SecretEntryKind,
    page: number,
  ): Promise<SecretInventory>;
  inspectManaged?(
    resource: SecretResourceBinding,
    scope: SecretScope,
    entryKind: SecretEntryKind,
    name: string,
  ): Promise<ManagedProviderSnapshot>;
  writeManagedVariable?(
    resource: SecretResourceBinding,
    snapshot: ManagedProviderSnapshot,
    action: "create" | "update" | "delete",
    value: string | null,
  ): Promise<SecretWriteResult>;
  prepare(
    resource: SecretResourceBinding,
    scope: SecretScope,
    name: string,
  ): Promise<SecretTargetSnapshot>;
  checkPrepared(
    resource: SecretResourceBinding,
    snapshot: SecretTargetSnapshot,
  ): Promise<void>;
  validateSealedInput(
    snapshot: SecretTargetSnapshot,
    ciphertext: string,
  ): boolean;
  writeSealed(
    resource: SecretResourceBinding,
    snapshot: SecretTargetSnapshot,
    ciphertext: string,
  ): Promise<SecretWriteResult>;
  validateTransientInput?(
    snapshot: SecretTargetSnapshot,
    value: string,
  ): boolean;
  writeTransient?(
    resource: SecretResourceBinding,
    snapshot: SecretTargetSnapshot,
    value: string,
  ): Promise<SecretWriteResult>;
  observe(
    resource: SecretResourceBinding,
    snapshot: SecretTargetSnapshot,
  ): Promise<SecretMetadata | null>;
  remove(
    resource: SecretResourceBinding,
    snapshot: SecretTargetSnapshot,
  ): Promise<SecretWriteResult>;
}
export interface SecretAdapter {
  kind: SecretProviderKind;
  capabilities: SecretCapabilities;
  references(
    context: WorkspaceService,
    workspaceId: string,
  ): Promise<SecretProviderReference[]>;
  connect(
    context: WorkspaceService,
    workspaceId: string,
    reference: string,
  ): Promise<ConnectedSecretProvider>;
}
