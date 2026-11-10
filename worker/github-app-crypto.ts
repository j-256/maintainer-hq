import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import { idSchema } from "../shared/domain";
import {
  GITHUB_APP_LIMITS as LIMITS,
  githubProviderIdSchema,
} from "../shared/github-apps";
import { DomainError } from "./errors";
import { providerCredentialEncryptionKey } from "./provider-credential-crypto";

const RSA_ALGORITHM = "RS256";
const RSA_IMPORT_ALGORITHM = Object.freeze({
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
});
const ENCRYPTION_ALGORITHM = "AES-GCM";
const NONCE_BYTES = 12;
const TAG_BITS = 128;
const ENCODED_MATERIAL_BYTES =
  Math.ceil((LIMITS.PRIVATE_INPUT_BYTES + TAG_BITS / 8) / 3) * 4;
const bindingSchema = z
  .object({
    deploymentId: idSchema,
    administrativeWorkspaceId: idSchema,
    registrationId: idSchema,
    kind: z.enum(["private-key", "webhook-secret"]),
    materialId: idSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export type GitHubMaterialContext = z.infer<typeof bindingSchema> & {
  env: { PROVIDER_CREDENTIAL_KEYS?: string };
};
export type EncryptedGitHubAppMaterial = {
  keyId: string;
  nonce: string;
  ciphertext: string;
};
const envelopeSchema = z
  .object({
    keyId: idSchema,
    nonce: z.string().max(24),
    ciphertext: z.string().max(ENCODED_MATERIAL_BYTES),
  })
  .strict();
function invalid(): never {
  throw new DomainError(
    "github_app_input_invalid",
    "Supply a supported, bounded RSA private key through protected App input.",
  );
}
function unavailable(): never {
  throw new DomainError(
    "github_app_material_unavailable",
    "Protected App material is unavailable or does not match its recorded identity. Retain the review and check the recovery material.",
    503,
  );
}
export async function normalizeGitHubAppKey(
  input: string,
): Promise<{ pkcs8: string; fingerprint: string }> {
  try {
    if (
      typeof input !== "string" ||
      Buffer.byteLength(input) > LIMITS.PRIVATE_INPUT_BYTES ||
      !/^\s*-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----\s*$/.test(
        input,
      )
    )
      invalid();
    const key = createPrivateKey(input);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < LIMITS.MIN_RSA_BITS
    )
      invalid();
    const publicDer = createPublicKey(key).export({
      format: "der",
      type: "spki",
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", publicDer),
    );
    return {
      pkcs8: key.export({ type: "pkcs8", format: "pem" }).toString(),
      fingerprint: [...digest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  } catch {
    return invalid();
  }
}
export async function signGitHubAppJwt(
  key: string,
  appId: number,
  now: number,
): Promise<string> {
  if (
    !githubProviderIdSchema.safeParse(appId).success ||
    !Number.isFinite(now) ||
    now < 0
  )
    invalid();
  const normalized = await normalizeGitHubAppKey(key);
  const der = createPrivateKey(normalized.pkcs8).export({
    type: "pkcs8",
    format: "der",
  });
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(der).buffer,
    RSA_IMPORT_ALGORITHM,
    false,
    ["sign"],
  );
  const seconds = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: RSA_ALGORITHM })
    .setIssuer(String(appId))
    .setIssuedAt(seconds - LIMITS.JWT_SKEW_SECONDS)
    .setExpirationTime(seconds + LIMITS.JWT_LIFETIME_SECONDS)
    .sign(signingKey);
}
function associatedData(context: GitHubMaterialContext, keyId: string) {
  const { env: _env, ...binding } = context;
  return new TextEncoder().encode(
    JSON.stringify({
      purpose: "maintainer-hq-github-app-v1",
      keyId,
      binding: bindingSchema.parse(binding),
    }),
  );
}
function decode(value: string, max: number) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max || bytes.toString("base64") !== value) unavailable();
  return bytes;
}
export async function sealGitHubAppMaterial(
  context: GitHubMaterialContext,
  plaintext: Uint8Array,
): Promise<EncryptedGitHubAppMaterial> {
  if (
    !plaintext.byteLength ||
    plaintext.byteLength > LIMITS.PRIVATE_INPUT_BYTES
  )
    invalid();
  const copy = new Uint8Array(plaintext);
  try {
    const selected = await providerCredentialEncryptionKey(context.env);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: ENCRYPTION_ALGORITHM,
        iv: nonce,
        additionalData: associatedData(context, selected.id),
        tagLength: TAG_BITS,
      },
      selected.key,
      copy,
    );
    return {
      keyId: selected.id,
      nonce: Buffer.from(nonce).toString("base64"),
      ciphertext: Buffer.from(encrypted).toString("base64"),
    };
  } catch {
    return unavailable();
  } finally {
    copy.fill(0);
  }
}
export async function openGitHubAppMaterial(
  context: GitHubMaterialContext,
  envelope: EncryptedGitHubAppMaterial,
): Promise<Uint8Array> {
  try {
    const value = envelopeSchema.parse(envelope);
    const selected = await providerCredentialEncryptionKey(
      context.env,
      value.keyId,
    );
    const nonce = decode(value.nonce, NONCE_BYTES);
    if (nonce.length !== NONCE_BYTES) unavailable();
    const ciphertext = decode(
      value.ciphertext,
      LIMITS.PRIVATE_INPUT_BYTES + TAG_BITS / 8,
    );
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ENCRYPTION_ALGORITHM,
          iv: nonce,
          additionalData: associatedData(context, selected.id),
          tagLength: TAG_BITS,
        },
        selected.key,
        ciphertext,
      ),
    );
  } catch {
    return unavailable();
  }
}
