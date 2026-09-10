import { z } from "zod";
import { repositoryFields } from "./domain";
import { SECRET_LIMITS } from "./secrets";

export const GITHUB_SECRET_LIMITS = Object.freeze({
  REPOSITORIES: SECRET_LIMITS.RESOURCES,
  PAGE_SIZE: SECRET_LIMITS.PAGE_SIZE,
  MAX_PAGE: SECRET_LIMITS.MAX_PAGE,
  VALUE_BYTES: 48 * 1024,
  SEAL_BYTES: 48,
  RESPONSE_BYTES: 1024 * 1024,
  REQUEST_MS: SECRET_LIMITS.REQUEST_MS,
});
export const SECRET_PROVIDER = Object.freeze({
  ORIGIN: "https://api.github.com",
  API_VERSION: "2022-11-28",
});

export const secretNameSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(255)
  .regex(/^[A-Z_][A-Z0-9_]*$/)
  .refine((name) => !name.startsWith("GITHUB_"));
export const secretEnvironmentSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) => !/[\x00-\x1f\x7f]/.test(name) && name !== "." && name !== "..",
  );
export const secretMetadataSchema = z
  .object({
    name: secretNameSchema,
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .refine(
    (value) => Date.parse(value.updated_at) >= Date.parse(value.created_at),
  );
export const secretVariableMetadataSchema = secretMetadataSchema.safeExtend({
  value: z.string().refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <=
      GITHUB_SECRET_LIMITS.VALUE_BYTES,
  ),
});
export const secretPublicKeySchema = z.object({
  key_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export const secretRepositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: repositoryFields.shape.fullName,
  archived: z.boolean(),
  disabled: z.boolean(),
  owner: z.object({
    id: z.number().int().positive(),
    login: z.string().min(1).max(255),
    type: z.string().min(1).max(80),
  }),
});
export const secretEnvironmentMetadataSchema = z.object({
  id: z.number().int().positive(),
  name: secretEnvironmentSchema,
});
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;
export type SecretVariableMetadata = z.infer<
  typeof secretVariableMetadataSchema
>;
export type SecretPublicKey = z.infer<typeof secretPublicKeySchema>;
export type SecretRepository = z.infer<typeof secretRepositorySchema>;
export type SecretEnvironment = z.infer<typeof secretEnvironmentMetadataSchema>;
export type SecretProviderReference = {
  id: string;
  name: string;
  revision: number;
  repositoryNames: string[];
  writable: boolean;
  expiresAt: string;
  available: boolean;
};
export type SecretPage<T> = {
  items: T[];
  page: number;
  total: number;
  nextPage: number | null;
  truncated: boolean;
};
