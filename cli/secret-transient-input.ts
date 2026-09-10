import { secretRunInput } from "../shared/secrets";
import {
  SecretTransientInputError,
  supplyTransientSecret,
} from "../shared/secret-transient-input";
import { callCommand, clientConfiguration, ClientError } from "./client";
import { secretEnvironmentInput } from "./secret-input";

export const secretTransientEnvironmentInput = secretRunInput
  .extend({
    environmentVariable: secretEnvironmentInput.shape.environmentVariable,
  })
  .strict();
export async function supplyTransientSecretInput(
  configuration: ReturnType<typeof clientConfiguration>,
  selection: unknown,
  read: () => Promise<Uint8Array>,
) {
  try {
    return await supplyTransientSecret({
      selection,
      read,
      review: (input) => callCommand(configuration, "secrets_review", input),
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
      error instanceof SecretTransientInputError
        ? error.message
        : "Private execution input could not be supplied. Inspect the same destination receipt before continuing.",
      error instanceof SecretTransientInputError && !error.uncertain ? 2 : 1,
    );
  }
}
