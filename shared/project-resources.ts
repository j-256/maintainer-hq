import { z } from "zod";
import { getProjectInput, idSchema, workspaceInput } from "./domain";

export const PROJECT_RESOURCE_LIMITS = Object.freeze({
  PAGE_SIZE: 25,
  ASSOCIATIONS: 1000,
});
export const PROJECT_RESOURCE_KINDS = ["hook", "monitor", "secret"] as const;
export const projectResourceKind = z.enum(PROJECT_RESOURCE_KINDS);
const resourceKey = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const resourceProjectInput = workspaceInput
  .extend({
    kind: projectResourceKind,
    connectionId: idSchema,
    resourceKey,
  })
  .strict();
export const resourceProjectSaveInput = resourceProjectInput
  .extend({
    revision,
    connectionRevision: revision.refine((value) => value > 0),
    projectId: idSchema,
    projectRevision: revision.refine((value) => value > 0),
  })
  .strict();
const cursorSchema = z
  .object({
    workspaceId: idSchema,
    projectId: idSchema,
    filter: projectResourceKind.nullable(),
    kind: projectResourceKind,
    connectionId: idSchema,
    resourceKey,
  })
  .strict();
export const projectResourcesInput = getProjectInput
  .extend({
    kind: projectResourceKind.nullable().default(null),
    cursor: cursorSchema.nullable().default(null),
  })
  .strict();
export type ProjectResourceKind = z.infer<typeof projectResourceKind>;
export type ResourceProjectReference = z.infer<typeof resourceProjectInput>;
export type ResourceProject = ResourceProjectReference & {
  projectId: string | null;
  revision: number;
  connectionRevision: number;
  updatedAt: string | null;
};
export type ProjectResource = {
  kind: ProjectResourceKind;
  connectionId: string;
  connectionName: string;
  connectionEnabled: boolean;
  connectionRevision: number;
  resourceKey: string;
  label: string;
  projectId: string | null;
  direct: boolean;
  repositoryCount: number;
  sharedRepositoryCount: number;
};
export type ProjectResources = {
  items: ProjectResource[];
  nextCursor: z.infer<typeof cursorSchema> | null;
};
