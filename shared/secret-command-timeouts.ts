import type { CommandName } from "./commands";

export const SECRET_CLIENT_TIMEOUTS = Object.freeze({
  METADATA_MS: 15_000,
  PROVIDER_READ_MS: 75_000,
  PREPARATION_MS: 135_000,
  EXECUTION_MS: 180_000,
});
export const SECRET_REQUEST_INTERRUPTED =
  "The Secrets request was interrupted or its receipt was incomplete. Inspect the same review or removal receipt before continuing. A submitted request may have succeeded; do not assume cancellation or start a replacement operation.";

export function secretCommandTimeout(name: CommandName): number | undefined {
  switch (name) {
    case "provider_credential_verify":
    case "secrets_inventory":
    case "secrets_scopes":
    case "secrets_reconcile":
    case "secrets_cleanup_reconcile":
    case "secrets_configuration_status":
    case "secrets_configuration_reconcile":
      return SECRET_CLIENT_TIMEOUTS.PROVIDER_READ_MS;
    case "secrets_draft":
    case "secrets_recovery_plan":
    case "secrets_cleanup_plan":
    case "secrets_configuration_plan":
      return SECRET_CLIENT_TIMEOUTS.PREPARATION_MS;
    case "secrets_run":
    case "secrets_cleanup_apply":
    case "secrets_configuration_apply":
      return SECRET_CLIENT_TIMEOUTS.EXECUTION_MS;
    default:
      return name.startsWith("secrets_") ||
        name.startsWith("provider_credential")
        ? SECRET_CLIENT_TIMEOUTS.METADATA_MS
        : undefined;
  }
}
