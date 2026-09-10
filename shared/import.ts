import { z } from "zod";
import {
  idSchema,
  projectFields,
  repositoryFields,
  workspaceInput,
} from "./domain";

export const IMPORT_LIMITS = Object.freeze({
  PROJECTS: 100,
  REPOSITORIES: 100,
  MANIFEST_BYTES: 60 * 1024,
  PENDING_PLANS: 10,
  REQUEST_TIMEOUT_MS: 15000,
});

export const importManifest = z
  .object({
    formatVersion: z.literal(2),
    sourceLabel: z.string().trim().min(1).max(120),
    projects: z
      .array(projectFields.extend({ key: idSchema }).strict())
      .min(1)
      .max(IMPORT_LIMITS.PROJECTS),
    repositories: z
      .array(
        repositoryFields
          .omit({ projectId: true })
          .extend({ projectKey: idSchema })
          .strict(),
      )
      .min(1)
      .max(IMPORT_LIMITS.REPOSITORIES),
  })
  .strict()
  .superRefine((manifest, context) => {
    const projectKeys = new Set<string>();
    const projectNames = new Set<string>();
    manifest.projects.forEach((project, index) => {
      if (projectKeys.has(project.key))
        context.addIssue({
          code: "custom",
          path: ["projects", index, "key"],
          message: "Project keys must be unique",
        });
      projectKeys.add(project.key);
      const name = project.name.toLowerCase();
      if (projectNames.has(name))
        context.addIssue({
          code: "custom",
          path: ["projects", index, "name"],
          message: "Project names must be unique, ignoring case",
        });
      projectNames.add(name);
    });
    const names = new Set<string>();
    manifest.repositories.forEach((repository, index) => {
      const name = repository.fullName.toLowerCase();
      if (names.has(name))
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "fullName"],
          message: "Repository names must be unique, ignoring case",
        });
      names.add(name);
      if (!projectKeys.has(repository.projectKey))
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "projectKey"],
          message: "Reference a project key declared in this file",
        });
    });
    if (
      new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
      IMPORT_LIMITS.MANIFEST_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "The metadata file exceeds the supported size",
      });
  });

export const importPlanInput = workspaceInput
  .extend({ manifest: importManifest })
  .strict();
export const importApplyInput = workspaceInput
  .extend({
    planId: idSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ImportManifest = z.infer<typeof importManifest>;
export type ImportPlan = z.infer<typeof importPlanInput> & {
  planId: string;
  fingerprint: string;
  workspaceName: string;
  actor: string;
  expiresAt: string;
};
export type ImportReceipt = {
  planId: string;
  fingerprint: string;
  sourceLabel: string;
  projectCount: number;
  repositoryCount: number;
  appliedAt: string;
};
export type ImportStatus = {
  projectCount: number;
  repositoryCount: number;
  receipt: ImportReceipt | null;
};
