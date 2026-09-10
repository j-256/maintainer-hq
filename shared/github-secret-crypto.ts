import { GITHUB_SECRET_LIMITS as SECRET_LIMITS } from "./github-secrets";

export const SECRET_CRYPTO_LIMITS = Object.freeze({
  VALUE_BYTES: SECRET_LIMITS.VALUE_BYTES,
  PUBLIC_KEY_BYTES: 32,
  SEAL_BYTES: SECRET_LIMITS.SEAL_BYTES,
  INITIALIZATION_MS: 10000,
});

export class SecretInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecretInputError";
  }
}

type Sodium = (typeof import("libsodium-wrappers"))["default"];
let initialized: Promise<Sodium> | undefined;

async function sodium(): Promise<Sodium> {
  initialized ??= import("libsodium-wrappers")
    .then(async ({ default: library }) => {
      await library.ready;
      return library;
    })
    .catch(() => {
      initialized = undefined;
      throw new SecretInputError(
        "secret_encryption_unavailable",
        "Secret encryption is unavailable. No provider write was attempted.",
      );
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      initialized,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SecretInputError(
                "secret_encryption_unavailable",
                "Secret encryption did not become ready. No provider write was attempted.",
              ),
            ),
          SECRET_CRYPTO_LIMITS.INITIALIZATION_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function sealGitHubSecret(
  value: Uint8Array,
  publicKey: string,
): Promise<string> {
  if (!value.byteLength || value.byteLength > SECRET_CRYPTO_LIMITS.VALUE_BYTES)
    throw new SecretInputError(
      "secret_input_invalid",
      "Supply a nonempty secret value within the supported byte limit.",
    );
  let key: Uint8Array;
  try {
    key = Uint8Array.from(atob(publicKey), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    key = new Uint8Array();
  }
  if (
    key.length !== SECRET_CRYPTO_LIMITS.PUBLIC_KEY_BYTES ||
    btoa(String.fromCharCode(...key)) !== publicKey
  )
    throw new SecretInputError(
      "secret_public_key_invalid",
      "GitHub returned an invalid encryption key. No secret was submitted.",
    );
  const owned = value.slice();
  try {
    const library = await sodium();
    const sealed = library.crypto_box_seal(owned, key);
    if (
      sealed.byteLength !==
      owned.byteLength + SECRET_CRYPTO_LIMITS.SEAL_BYTES
    )
      throw new Error("Unexpected sealed input size");
    return library.to_base64(sealed, library.base64_variants.ORIGINAL);
  } catch (error) {
    if (error instanceof SecretInputError) throw error;
    throw new SecretInputError(
      "secret_encryption_failed",
      "Secret encryption failed. No provider write was attempted.",
    );
  } finally {
    owned.fill(0);
  }
}
