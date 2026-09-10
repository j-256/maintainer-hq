import { z } from "zod";
import {
  DEFAULT_PORTFOLIO,
  PROJECT_IMPORTANCE,
  idSchema,
  portfolioSchema,
  projectFields,
  workspaceInput,
  type Project,
  type ProjectFields,
  type Repository,
} from "./domain";

export const PROJECT_ORGANIZATION_LIMITS = Object.freeze({
  REPOSITORIES: 50,
  TARGETS: 50,
  PAGE_SIZE: 25,
  PREVIEW_PAGE_SIZE: 10,
  INPUT_BYTES: 60 * 1024,
  REVIEW_BYTES: 256 * 1024,
  PENDING_PLANS: 10,
  CLEANUP_ROWS: 100,
  REQUEST_TIMEOUT_MS: 15000,
});
export const PROJECT_ORGANIZATION_PARAM = "organizationReview";
export const PROJECT_PRESENTATION_KEYS = [
  "importance",
  "importanceNote",
  "portfolio",
] as const;
export type ProjectPresentationKey = (typeof PROJECT_PRESENTATION_KEYS)[number];
export const projectPresentationFields = projectFields.pick({
  importance: true,
  importanceNote: true,
  portfolio: true,
});
export type ProjectPresentation = z.infer<typeof projectPresentationFields>;
const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      key: idSchema,
      kind: z.literal("existing"),
      projectId: idSchema,
      revision: z.number().int().positive(),
      patch: z
        .object({
          importance: z.enum(PROJECT_IMPORTANCE).optional(),
          importanceNote: z.string().trim().max(1000).optional(),
          portfolio: portfolioSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      key: idSchema,
      kind: z.literal("new"),
      project: projectFields.pick({
        name: true,
        importance: true,
        importanceNote: true,
        portfolio: true,
      }),
    })
    .strict(),
]);
export const projectOrganizationPlanInput = workspaceInput
  .extend({
    repositories: z
      .array(
        z
          .object({
            repositoryId: idSchema,
            revision: z.number().int().positive(),
            targetKey: idSchema,
          })
          .strict(),
      )
      .min(1)
      .max(PROJECT_ORGANIZATION_LIMITS.REPOSITORIES),
    targets: z
      .array(targetSchema)
      .min(1)
      .max(PROJECT_ORGANIZATION_LIMITS.TARGETS),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = new Set(input.targets.map((target) => target.key));
    const used = new Set(input.repositories.map((row) => row.targetKey));
    const existing = input.targets.filter(
      (target) => target.kind === "existing",
    );
    const created = input.targets.filter((target) => target.kind === "new");
    if (
      new Set(input.repositories.map((row) => row.repositoryId)).size !==
        input.repositories.length ||
      keys.size !== input.targets.length ||
      new Set(existing.map((target) => target.projectId)).size !==
        existing.length ||
      new Set(created.map((target) => target.project.name)).size !==
        created.length ||
      [...keys].some((key) => !used.has(key)) ||
      [...used].some((key) => !keys.has(key))
    )
      context.addIssue({
        code: "custom",
        message:
          "Use unique repositories and projects, and assign every selected repository to one used target",
      });
    if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      PROJECT_ORGANIZATION_LIMITS.INPUT_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Select fewer repositories or shorten the project notes",
      });
  });
export const projectOrganizationReviewInput = workspaceInput
  .extend({ planId: idSchema })
  .strict();
export const projectOrganizationApplyInput = projectOrganizationReviewInput
  .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type ProjectOrganizationFields = z.infer<
  typeof projectOrganizationPlanInput
>;
export type OrganizationTarget = ProjectOrganizationFields["targets"][number];
export type OrganizationRepository = {
  repositoryId: string;
  fullName: string;
  revision: number;
  before: { id: string; name: string } | null;
  after: { id: string; name: string };
};
export type OrganizationProject = {
  key: string;
  projectId: string;
  before: Project | null;
  after: ProjectFields;
  changed: ProjectPresentationKey[];
  linkedRepositoryCount: number;
};
export type ProjectOrganizationReceipt = {
  workspaceId: string;
  planId: string;
  fingerprint: string;
  appliedAt: string;
  createdProjectIds: string[];
  updatedProjectIds: string[];
  assignedRepositoryIds: string[];
  unchangedRepositoryIds: string[];
};
export type ProjectOrganizationReview = {
  workspaceId: string;
  workspaceName: string;
  planId: string;
  fingerprint: string;
  actor: string;
  expiresAt: string;
  fields: ProjectOrganizationFields;
  repositories: OrganizationRepository[];
  projects: OrganizationProject[];
  state: "ready" | "stale" | "expired" | "applied";
  receipt: ProjectOrganizationReceipt | null;
};

export function newOrganizationProject(
  name: string,
): Extract<OrganizationTarget, { kind: "new" }>["project"] {
  return {
    name,
    importance: "standard",
    importanceNote: "",
    portfolio: { ...DEFAULT_PORTFOLIO },
  };
}
export function changedProjectPresentation(
  before: ProjectFields,
  after: ProjectFields,
) {
  return PROJECT_PRESENTATION_KEYS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
export function suggestProject(repo: Repository, projects: Project[]) {
  const name = repo.fullName.split("/")[1]!;
  const assigned = projects.find((project) => project.id === repo.projectId);
  return {
    projectId: assigned?.id ?? null,
    name: assigned?.name ?? name,
    reason: assigned
      ? "Keep saved project"
      : "Saved project unavailable; choose a project",
  };
}
