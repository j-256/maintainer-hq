import { providerCredentialApplyInput } from "../shared/provider-credentials";
import {
  ProviderCredentialInputError,
  supplyProviderCredential,
} from "../shared/provider-credential-input";
import { callCommand, clientConfiguration, ClientError } from "./client";
import { secretEnvironmentInput } from "./secret-input";

export const providerCredentialEnvironmentInput = providerCredentialApplyInput
  .extend({
    environmentVariable: secretEnvironmentInput.shape.environmentVariable,
  })
  .strict();

export async function supplyProviderCredentialInput(
  configuration: ReturnType<typeof clientConfiguration>,
  selection: unknown,
  read: () => Promise<Uint8Array>,
) {
  try {
    return await supplyProviderCredential({
      selection,
      read,
      review: (input) =>
        callCommand(configuration, "provider_credential_review", input),
      send: (path, init) =>
        fetch(new URL(path, configuration.origin), {
          ...init,
          headers: {
            ...configuration.headers,
            ...Object.fromEntries(new Headers(init.headers)),
          },
        }),
    });
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      error instanceof ProviderCredentialInputError
        ? error.message
        : "Private credential input could not be supplied. Inspect the same review before retrying.",
      error instanceof ProviderCredentialInputError && !error.uncertain ? 2 : 1,
    );
  }
}
