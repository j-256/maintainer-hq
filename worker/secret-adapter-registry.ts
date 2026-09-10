import type { SecretProviderKind } from "../shared/secrets";
import type { SecretAdapter } from "./secret-adapters";
import { githubSecretAdapter } from "./secret-github";
import { cloudflareSecretAdapter } from "./secret-cloudflare";
import { DomainError } from "./errors";

export const secretAdapters: readonly SecretAdapter[] = [
  githubSecretAdapter,
  cloudflareSecretAdapter,
];

export function secretAdapter(kind: SecretProviderKind): SecretAdapter {
  const adapter = secretAdapters.find((item) => item.kind === kind);
  if (!adapter)
    throw new DomainError(
      "secret_provider_unsupported",
      "This Secrets provider adapter is not installed. No provider operation was attempted.",
      409,
    );
  return adapter;
}
