import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  PROVIDER_CREDENTIAL_LIMITS as LIMITS,
  providerCredentialFieldsSchema,
  providerCredentialIdSchema,
} from "../shared/provider-credentials";
import { DomainError } from "./errors";

type KeyEnvironment = { PROVIDER_CREDENTIAL_KEYS?: string };
const keyringSchema = z
  .object({
    version: z.literal(1),
    activeKeyId: idSchema,
    keys: z
      .array(
        z
          .object({
            id: idSchema,
            key: z
              .string()
              .regex(/^[A-Za-z0-9+/]{43}=$/)
              .refine((value) => btoa(atob(value)) === value),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITS.KEYRING_KEYS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.keys.map((key) => key.id)).size === value.keys.length &&
      value.keys.some((key) => key.id === value.activeKeyId),
  );
export const credentialBindingSchema = z
  .object({
    workspaceId: idSchema,
    credentialId: providerCredentialIdSchema,
    revision: z.number().int().positive(),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    settings: providerCredentialFieldsSchema,
  })
  .strict();
export type CredentialBinding = z.infer<typeof credentialBindingSchema>;
export type EncryptedProviderCredential = {
  keyId: string;
  nonce: string;
  ciphertext: string;
};
const tokenSchema = z
  .string()
  .min(1)
  .max(LIMITS.TOKEN_BYTES)
  .regex(/^[\x21-\x7e]+$/);
const encoder = new TextEncoder();

function keyring(env: KeyEnvironment) {
  try {
    const value = env.PROVIDER_CREDENTIAL_KEYS;
    if (!value || value.length > LIMITS.KEYRING_BYTES) return null;
    const parsed = keyringSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function providerCredentialKeyStatus(
  env: KeyEnvironment,
  keyId?: string,
) {
  const ring = keyring(env);
  return Boolean(ring && (!keyId || ring.keys.some((key) => key.id === keyId)));
}
function unavailable(): never {
  throw new DomainError(
    "provider_credential_unavailable",
    "Protected credential storage is unavailable or could not verify this credential. Ask the deployment operator to check its recovery keys; no provider request was sent.",
    503,
  );
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string, limit: number) {
  if (value.length > Math.ceil(limit / 3) * 4) unavailable();
  try {
    const raw = atob(value);
    if (raw.length > limit || btoa(raw) !== value) unavailable();
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return unavailable();
  }
}
async function key(env: KeyEnvironment, keyId?: string) {
  const ring = keyring(env);
  if (!ring) unavailable();
  const selected = ring.keys.find(
    (item) => item.id === (keyId ?? ring.activeKeyId),
  );
  if (!selected) unavailable();
  const bytes = decode(selected.key, LIMITS.KEY_BYTES);
  try {
    if (bytes.byteLength !== LIMITS.KEY_BYTES) unavailable();
    return {
      id: selected.id,
      key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    };
  } finally {
    bytes.fill(0);
  }
}
function associatedData(binding: CredentialBinding, keyId: string) {
  return encoder.encode(
    JSON.stringify({
      purpose: "maintainer-hq-provider-credential-v1",
      keyId,
      binding: credentialBindingSchema.parse(binding),
    }),
  );
}
export async function sealProviderCredential(
  env: KeyEnvironment,
  binding: CredentialBinding,
  token: string,
): Promise<EncryptedProviderCredential> {
  if (!tokenSchema.safeParse(token).success) {
    throw new DomainError(
      "provider_credential_input_invalid",
      "Supply a bounded provider token through the dedicated private input.",
      400,
    );
  }
  const plaintext = encoder.encode(token);
  try {
    const selected = await key(env);
    const nonce = crypto.getRandomValues(new Uint8Array(LIMITS.NONCE_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: associatedData(binding, selected.id),
          tagLength: LIMITS.TAG_BITS,
        },
        selected.key,
        plaintext,
      ),
    );
    return {
      keyId: selected.id,
      nonce: encode(nonce),
      ciphertext: encode(ciphertext),
    };
  } catch {
    return unavailable();
  } finally {
    plaintext.fill(0);
  }
}
export async function openProviderCredential(
  env: KeyEnvironment,
  binding: CredentialBinding,
  encrypted: EncryptedProviderCredential,
): Promise<string> {
  let plaintext: Uint8Array | undefined;
  try {
    const selected = await key(env, encrypted.keyId);
    const nonce = decode(encrypted.nonce, LIMITS.NONCE_BYTES);
    if (nonce.byteLength !== LIMITS.NONCE_BYTES) unavailable();
    const ciphertext = decode(encrypted.ciphertext, LIMITS.CIPHERTEXT_BYTES);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: associatedData(binding, selected.id),
          tagLength: LIMITS.TAG_BITS,
        },
        selected.key,
        ciphertext,
      ),
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!tokenSchema.safeParse(token).success) unavailable();
    return token;
  } catch {
    return unavailable();
  } finally {
    plaintext?.fill(0);
  }
}
