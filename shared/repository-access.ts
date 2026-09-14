import { z } from "zod";
import {
  CAPABILITY,
  ROLE_CAPABILITIES,
  ROLES,
  idSchema,
  repositoryFields,
  type Capability,
  type Role,
} from "./domain";
import { SOURCE_LIMITS } from "./sources";

export const REPOSITORY_ACCESS_LIMITS = Object.freeze({
  RESPONSE_BYTES: 32 * 1024,
});
export const HQ_OPERATION_RULES = Object.freeze([
  {
    id: "observe",
    label: "Read workspace evidence",
    capability: CAPABILITY.READ,
    requiredRole: "Viewer, Operator or Owner",
  },
  {
    id: "metadata",
    label: "Edit HQ expectations and links",
    capability: CAPABILITY.EDIT,
    requiredRole: "Operator or Owner",
  },
  {
    id: "operate",
    label: "Review hook retries and monitoring changes",
    capability: CAPABILITY.OPERATE,
    requiredRole: "Operator or Owner",
  },
  {
    id: "connections",
    label: "Manage HQ connections and access",
    capability: CAPABILITY.ADMIN,
    requiredRole: "Owner",
  },
  {
    id: "secrets",
    label: "Review secret writes",
    capability: CAPABILITY.SECRETS,
    requiredRole: "Owner",
  },
] as const);
export const HQ_GATE_LABELS = Object.freeze({
  allowed: "Allowed in HQ",
  role_required: "HQ role required",
  scope_required: "Client scope required",
});
export function hqOperationGates(role: Role, scopes: readonly Capability[]) {
  return HQ_OPERATION_RULES.map((rule) => ({
    ...rule,
    state: !ROLE_CAPABILITIES[role].includes(rule.capability)
      ? ("role_required" as const)
      : !scopes.includes(rule.capability)
        ? ("scope_required" as const)
        : ("allowed" as const),
  }));
}
const revision = z.number().int().positive().safe();
export const repositoryAccessSchema = z
  .object({
    repository: z
      .object({
        id: idSchema,
        fullName: repositoryFields.shape.fullName,
        classification: repositoryFields.shape.classification,
        revision,
      })
      .strict(),
    hq: z
      .object({
        role: z.enum(ROLES),
        client: z.enum(["session", "credential"]),
        gates: z
          .array(
            z
              .object({
                id: z.enum([
                  "observe",
                  "metadata",
                  "operate",
                  "connections",
                  "secrets",
                ]),
                label: z.string().max(80),
                capability: z.enum(CAPABILITY),
                requiredRole: z.string().max(80),
                state: z.enum(["allowed", "role_required", "scope_required"]),
              })
              .strict(),
          )
          .length(HQ_OPERATION_RULES.length),
      })
      .strict(),
    github: z
      .object({
        webhookAdapter: z.literal("hookrelay_setup"),
        administration: z.literal("not_verified"),
        sources: z
          .array(
            z
              .object({
                id: idSchema,
                name: z.string().max(120),
                revision,
                enabled: z.boolean(),
                configurationValid: z.boolean(),
                credential: z.enum(["configured", "unavailable"]),
                grant: z.literal("not_verified"),
              })
              .strict(),
          )
          .max(SOURCE_LIMITS.SOURCES),
      })
      .strict(),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type RepositoryAccess = z.infer<typeof repositoryAccessSchema>;
