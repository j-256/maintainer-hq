import { z } from "zod";
import { getRepositoryInput, idSchema, workspaceInput } from "./domain";

export const RESOURCE_LINK_LIMITS = Object.freeze({
  REPOSITORIES: 100,
  ASSOCIATIONS: 1000,
  PAGE_SIZE: 25,
});
export const RESOURCE_KIND = Object.freeze({
  HOOK: "hook",
  MONITOR: "monitor",
} as const);
export const resourceKindSchema = z.enum([
  RESOURCE_KIND.HOOK,
  RESOURCE_KIND.MONITOR,
]);
const resourceKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const resourceReferenceInput = workspaceInput
  .extend({
    kind: resourceKindSchema,
    connectionId: idSchema,
    resourceKey: resourceKeySchema,
  })
  .strict();
export const resourceLinksSaveInput = resourceReferenceInput
  .extend({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    connectionRevision: z.number().int().positive(),
    repositoryIds: z
      .array(idSchema)
      .max(RESOURCE_LINK_LIMITS.REPOSITORIES)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
const resourceCursor = z
  .object({
    workspaceId: idSchema,
    repositoryId: idSchema,
    filter: resourceKindSchema.nullable(),
    kind: resourceKindSchema,
    connectionId: idSchema,
    resourceKey: resourceKeySchema,
  })
  .strict();
export const repositoryResourcesInput = getRepositoryInput
  .extend({
    kind: resourceKindSchema.nullable().default(null),
    cursor: resourceCursor.nullable().default(null),
  })
  .strict();
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceReference = z.infer<typeof resourceReferenceInput>;
export type ResourceLinks = ResourceReference & {
  repositoryIds: string[];
  revision: number;
  connectionRevision: number;
  updatedAt: string | null;
};
export type RepositoryResource = {
  kind: ResourceKind;
  connectionId: string;
  connectionName: string;
  connectionEnabled: boolean;
  connectionRevision: number;
  resourceKey: string;
  revision: number;
  updatedAt: string;
  repositoryCount: number;
};
export type RepositoryResources = {
  items: RepositoryResource[];
  nextCursor: z.infer<typeof resourceCursor> | null;
};
