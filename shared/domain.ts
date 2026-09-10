import { z } from "zod";
import type { GitHubConnectionStatus } from "./github";
import { goalStatusSchema, type GoalStatus } from "./goals";
import {
  coverageAssessment,
  coverageEvidenceSchema,
} from "./coverage-evidence";
import {
  githubEvidenceSchema,
  githubSecurityComplete,
} from "./github-evidence";

export const ROLE = Object.freeze({
  OWNER: "owner",
  OPERATOR: "operator",
  VIEWER: "viewer",
} as const);
export const ROLES = [ROLE.OWNER, ROLE.OPERATOR, ROLE.VIEWER] as const;
export const CAPABILITY = Object.freeze({
  READ: "read",
  EDIT: "metadata:write",
  OPERATE: "providers:operate",
  ADMIN: "workspace:admin",
  SECRETS: "secrets:write",
  PUBLISH: "observations:publish",
  ACTIVITY: "activity:write",
  GOALS: "goals:write",
  PREFERENCES: "preferences:write",
} as const);
export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: [
    CAPABILITY.READ,
    CAPABILITY.EDIT,
    CAPABILITY.OPERATE,
    CAPABILITY.ADMIN,
    CAPABILITY.SECRETS,
    CAPABILITY.ACTIVITY,
    CAPABILITY.GOALS,
    CAPABILITY.PREFERENCES,
  ],
  operator: [
    CAPABILITY.READ,
    CAPABILITY.EDIT,
    CAPABILITY.OPERATE,
    CAPABILITY.ACTIVITY,
    CAPABILITY.GOALS,
    CAPABILITY.PREFERENCES,
  ],
  viewer: [CAPABILITY.READ, CAPABILITY.PREFERENCES],
};
export const LIMITS = Object.freeze({
  BODY_BYTES: 64 * 1024,
  PAGE_SIZE: 100,
  MAX_REPOSITORIES: 1000,
  MAX_PROJECTS: 1000,
  MAX_OBSERVATIONS: 2000,
  FUTURE_SKEW_MS: 5 * 60 * 1000,
  PLAN_TTL_MS: 5 * 60 * 1000,
  REFRESH_MS: 5 * 1000,
});
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const workspaceInput = z.object({ workspaceId: idSchema }).strict();
export const requirementSchema = z.enum(["required", "optional", "unmanaged"]);
export const classificationSchema = z.enum([
  "maintained",
  "watchlist",
  "reference",
]);
export const expectationSchema = z
  .object({
    ci: requirementSchema,
    security: requirementSchema,
    monitoring: requirementSchema,
    hooks: requirementSchema,
    visibility: z.enum(["public", "private", "any"]),
    reviewDate: z.iso.date().nullable(),
    note: z.string().max(1500),
  })
  .strict();
export const DEFAULT_EXPECTATIONS: Expectations = {
  ci: "required",
  security: "required",
  monitoring: "unmanaged",
  hooks: "unmanaged",
  visibility: "any",
  reviewDate: null,
  note: "",
};
export const repositoryFields = z
  .object({
    fullName: z
      .string()
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/),
    description: z.string().max(500),
    projectId: idSchema,
    classification: classificationSchema,
    lifecycle: z.enum(["active", "archived"]),
    expectations: expectationSchema,
  })
  .strict();
export const createRepositoryInput = workspaceInput
  .extend({ repository: repositoryFields })
  .strict();
export const getRepositoryInput = workspaceInput
  .extend({ repositoryId: idSchema })
  .strict();
export const updateRepositoryInput = getRepositoryInput
  .extend({
    revision: z.number().int().positive(),
    repository: repositoryFields,
  })
  .strict();
export const PROJECT_IMPORTANCE = ["standard", "high", "critical"] as const;
export const PORTFOLIO_STATES = [
  "undecided",
  "planned",
  "listed",
  "excluded",
] as const;
export const DEFAULT_PORTFOLIO = {
  status: "undecided" as const,
  reason: "",
  url: null,
  reviewDate: null,
};
export const portfolioSchema = z
  .object({
    status: z.enum(PORTFOLIO_STATES),
    reason: z.string().trim().max(1000),
    url: z
      .string()
      .max(500)
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      }, "Use an HTTPS listing URL without credentials")
      .nullable(),
    reviewDate: z.iso.date().nullable(),
  })
  .strict()
  .refine((value) => value.status !== "excluded" || value.reason.length > 0, {
    message: "Give a reason for excluding this project from the portfolio",
    path: ["reason"],
  });
export const projectFields = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(300),
    lifecycle: z.enum(["active", "archived"]).default("active"),
    importance: z.enum(PROJECT_IMPORTANCE).default("standard"),
    importanceNote: z.string().trim().max(1000).default(""),
    portfolio: portfolioSchema.default(DEFAULT_PORTFOLIO),
  })
  .strict();
export const projectSchema = projectFields
  .extend({
    id: idSchema,
    workspaceId: idSchema,
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const createProjectInput = workspaceInput
  .extend({
    ...projectFields.shape,
    firstRepository: repositoryFields
      .omit({ projectId: true })
      .nullable()
      .default(null),
  })
  .strict();
export const getProjectInput = workspaceInput
  .extend({ projectId: idSchema })
  .strict();
export const updateProjectInput = getProjectInput
  .extend({
    revision: z.number().int().positive(),
    project: projectFields,
  })
  .strict();
export const memberInput = workspaceInput
  .extend({
    subject: z.string().min(1).max(300),
    displayName: z.string().trim().min(1).max(100),
    role: z.enum(ROLES),
  })
  .strict();
export const healthSchema = z.enum([
  "healthy",
  "warning",
  "critical",
  "unknown",
]);
export const providerSchema = z.enum([
  "github",
  "hookrelay",
  "endpoint-monitor",
  "local",
]);
export const observationSchema = z
  .object({
    sourceId: idSchema,
    resourceType: z.enum(["repository", "hook", "monitor", "publisher"]),
    resourceId: idSchema,
    name: z.string().min(1).max(160),
    health: healthSchema,
    summary: z.string().max(400),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    details: z
      .object({
        ci: z.enum(["passing", "failing", "unknown"]).optional(),
        openFindings: z.number().int().min(0).max(100000).optional(),
        visibility: z.enum(["public", "private"]).optional(),
        branch: z.string().max(100).optional(),
        language: z.string().max(50).optional(),
        url: z.string().url().max(500).optional(),
        statusCode: z.number().int().min(100).max(599).optional(),
        intervalSeconds: z.number().int().min(1).optional(),
        openIncidents: z.number().int().min(0).optional(),
        deliveryFailures: z.number().int().min(0).optional(),
        deliveries: z.number().int().min(0).optional(),
        enabled: z.boolean().optional(),
        dirty: z.boolean().optional(),
        ahead: z.number().int().min(0).optional(),
        github: githubEvidenceSchema.optional(),
        coverage: coverageEvidenceSchema.optional(),
      })
      .strict(),
  })
  .strict();
export const publishInput = workspaceInput
  .extend({
    observations: z.array(observationSchema).min(1).max(100),
  })
  .strict();
export const ACTIVITY_KINDS = [
  "note",
  "progress",
  "checkpoint.started",
  "checkpoint.completed",
  "verification",
  "attention",
] as const;
export const addActivityInput = workspaceInput
  .extend({
    eventId: idSchema,
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().max(2000),
    resourceId: idSchema
      .nullable()
      .describe(
        "Optional workspace repository or project identity for this update",
      ),
    goalId: idSchema.nullable().default(null),
  })
  .strict();
export const syncGoalInput = workspaceInput
  .extend({
    goalId: idSchema,
    sourceId: idSchema,
    objective: z.string().min(1).max(8000),
    status: goalStatusSchema,
    startedAt: z.iso.datetime(),
    reportedAt: z.iso.datetime(),
  })
  .strict();

export type Role = (typeof ROLES)[number];
export type Expectations = z.infer<typeof expectationSchema>;
export type RepositoryFields = z.infer<typeof repositoryFields>;
export type Observation = z.infer<typeof observationSchema> & {
  receivedAt: string;
  provider: Provider;
};
export type Provider = z.infer<typeof providerSchema>;
export type Health = z.infer<typeof healthSchema>;
export type Principal = {
  subject: string;
  displayName: string;
  expiresAt?: number;
  access?: { issuer: string; audience: string; email?: string };
  tokenId?: string;
  workspaceId?: string;
  scopes?: Capability[];
  sourceId?: string;
  reporterId?: string;
};
export type Workspace = { id: string; name: string; role: Role };
export type Project = z.infer<typeof projectSchema>;
export type ProjectFields = z.infer<typeof projectFields>;
export type Repository = RepositoryFields & {
  id: string;
  workspaceId: string;
  revision: number;
  updatedAt: string;
};
export type Connection = {
  id: string;
  name: string;
  provider: Provider;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  credentialConfigured: boolean;
  revision: number;
  enabled: boolean;
  freshnessMinutes: number;
  repositoryIds: string[];
  github?: GitHubConnectionStatus;
};
export type Activity = {
  id: string;
  actor: string;
  type: string;
  title: string;
  summary: string;
  resourceId: string | null;
  goalId: string | null;
  createdAt: string;
  githubSourceId?: string | null;
  githubRefreshId?: string | null;
  githubSourceName?: string | null;
};
export type Goal = {
  id: string;
  sourceId: string;
  objective: string;
  status: GoalStatus;
  actor: string;
  startedAt: string;
  reportedAt: string;
  receivedAt: string;
};
export type Member = { subject: string; displayName: string; role: Role };
export type Snapshot = {
  workspace: Workspace;
  principal: { subject: string; displayName: string };
  capabilities: Capability[];
  projects: Project[];
  repositories: Repository[];
  observations: Observation[];
  connections: Connection[];
  activity: Activity[];
  goals: Goal[];
  generatedAt: string;
  development: boolean;
};
export type ApiError = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    reference?: string;
  };
};
export type Assessment = {
  health: Health;
  freshness: "fresh" | "stale" | "unknown";
  reasons: string[];
  observedAt: string | null;
};

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export function reviewIsDue(repository: Repository, now = Date.now()) {
  const date = repository.expectations.reviewDate;
  return (
    repository.lifecycle === "active" &&
    Boolean(date && now >= Date.parse(date + "T00:00:00Z") + UTC_DAY_MS)
  );
}

export function assessRepository(
  repository: Repository,
  observations: Observation[],
  now = Date.now(),
): Assessment {
  const ordered = observations
    .filter(
      (item) =>
        item.resourceType === "repository" && item.resourceId === repository.id,
    )
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const sources = new Set<string>();
  const evidence = ordered.filter((item) => {
    if (sources.has(item.sourceId)) return false;
    sources.add(item.sourceId);
    return true;
  });
  const latest = evidence[0];
  const fresh = evidence.filter((item) => Date.parse(item.expiresAt) > now);
  if (repository.lifecycle === "archived")
    return {
      health: "unknown",
      freshness: latest ? "stale" : "unknown",
      reasons: ["Archived repository"],
      observedAt: latest?.observedAt ?? null,
    };
  if (!evidence.length)
    return {
      health: "unknown",
      freshness: "unknown",
      reasons: ["No observations received"],
      observedAt: null,
    };
  if (!fresh.length)
    return {
      health: "unknown",
      freshness: "stale",
      reasons: ["Observations need a refresh"],
      observedAt: latest?.observedAt ?? null,
    };
  const issues: string[] = [];
  const unverified: string[] = [];
  const github = fresh.find((item) => item.provider === "github");
  if (
    repository.expectations.ci === "required" &&
    github?.details.ci !== "passing"
  ) {
    if (github?.details.ci === "failing") issues.push("CI is failing");
    else unverified.push("CI has not been verified");
  }
  if (
    repository.expectations.security === "required" &&
    github?.details.openFindings !== 0
  ) {
    if (github?.details.openFindings) issues.push("Open security findings");
    else unverified.push("Security has not been verified");
  }
  if (
    repository.expectations.security === "required" &&
    github?.details.github &&
    !githubSecurityComplete(github.details.github)
  )
    unverified.push("Security coverage is incomplete");
  const coverage = [
    {
      requirement: repository.expectations.monitoring,
      provider: "endpoint-monitor",
      label: "Monitoring",
    },
    {
      requirement: repository.expectations.hooks,
      provider: "hookrelay",
      label: "Hook",
    },
  ] as const;
  for (const check of coverage) {
    if (check.requirement !== "required") continue;
    const matched = evidence.filter((item) => item.provider === check.provider);
    if (
      matched.some(
        (item) =>
          Date.parse(item.expiresAt) > now &&
          (item.details.enabled === false ||
            (item.details.coverage &&
              coverageAssessment(item.details.coverage, now).disabled)),
      )
    )
      issues.push(check.label + " coverage is disabled");
    else if (
      !matched.length ||
      matched.some(
        (item) =>
          Date.parse(item.observedAt) > now ||
          Date.parse(item.expiresAt) <= now ||
          (item.details.coverage
            ? !coverageAssessment(item.details.coverage, now).satisfied
            : item.health === "unknown"),
      )
    )
      unverified.push(check.label + " coverage is unverified");
  }
  if (repository.expectations.visibility !== "any") {
    if (!github?.details.visibility)
      unverified.push("Visibility has not been verified");
    else if (github.details.visibility !== repository.expectations.visibility)
      issues.push("Visibility does not match the expectation");
  }
  for (const item of fresh)
    if (item.health === "critical" || item.health === "warning")
      issues.push(item.summary || "A source reported a problem");
  if (reviewIsDue(repository, now)) issues.push("Expectation review is due");
  if (fresh.every((item) => item.health === "unknown"))
    unverified.push("Fresh observations do not establish health");
  const health = fresh.some((item) => item.health === "critical")
    ? "critical"
    : issues.length
      ? "warning"
      : unverified.length
        ? "unknown"
        : "healthy";
  return {
    health,
    freshness: "fresh",
    reasons: [...new Set([...issues, ...unverified])],
    observedAt: latest?.observedAt ?? null,
  };
}
