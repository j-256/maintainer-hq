import { z } from "zod";
import { SECRET_LIMITS, secretTargetSnapshotSchema } from "./secrets";
import { cloudflareWorkerNameSchema } from "./provider-credentials";

export const CLOUDFLARE_SECRET_LIMITS = Object.freeze({
  VALUE_BYTES: 5 * 1024,
  BINDINGS: 128,
  DEPLOYMENTS: 100,
  RESPONSE_BYTES: 1024 * 1024,
  REQUEST_MS: SECRET_LIMITS.REQUEST_MS,
  TRANSIENT_INPUT_BYTES: 5 * 1024 * 6 + 64,
});
export const CLOUDFLARE_SECRETS_API = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_SECRET_TYPE = "secret_text";
export const CLOUDFLARE_VARIABLE_TYPE = Object.freeze({
  JSON: "json",
  TEXT: "plain_text",
} as const);
export const cloudflareSecretNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) => !/[\x00-\x1f\x7f]/.test(name) && name !== "." && name !== "..",
  );
export const cloudflareWorkerMetadataSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  name: cloudflareWorkerNameSchema,
});
export const cloudflareDeploymentSchema = z.object({
  id: z.uuid(),
  strategy: z.literal("percentage"),
  versions: z
    .array(
      z.object({
        version_id: z.uuid(),
        percentage: z.number().positive().max(100),
      }),
    )
    .min(1)
    .max(2),
});
export type CloudflareDeployment = z.infer<typeof cloudflareDeploymentSchema>;
export const cloudflareBindingMetadataSchema = z.object({
  name: cloudflareSecretNameSchema,
  type: z.string().min(1).max(100),
});
export const cloudflareVariableBindingSchema = z.discriminatedUnion("type", [
  z.object({
    name: cloudflareSecretNameSchema,
    type: z.literal(CLOUDFLARE_VARIABLE_TYPE.TEXT),
    text: z.string().refine(
      (value) =>
        new TextEncoder().encode(value).byteLength <=
        CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES,
    ),
  }),
  z.object({
    name: cloudflareSecretNameSchema,
    type: z.literal(CLOUDFLARE_VARIABLE_TYPE.JSON),
    json: z.json().refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        CLOUDFLARE_SECRET_LIMITS.VALUE_BYTES,
    ),
  }),
]);
export const cloudflareSettingsBindingSchema = z.union([
  cloudflareVariableBindingSchema,
  cloudflareBindingMetadataSchema.refine(
    (binding) =>
      binding.type !== CLOUDFLARE_VARIABLE_TYPE.TEXT &&
      binding.type !== CLOUDFLARE_VARIABLE_TYPE.JSON,
  ),
]);
export type CloudflareVariableBinding = z.infer<
  typeof cloudflareVariableBindingSchema
>;
export const cloudflareActivationSchema =
  secretTargetSnapshotSchema.shape.workerDeployment.unwrap();
export type CloudflareActivation = z.infer<typeof cloudflareActivationSchema>;
