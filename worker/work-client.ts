import { z } from "zod";
import { repositoryFields } from "../shared/domain";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import { githubShaSchema, type ContextRead } from "../shared/github-context";
import {
  WORK_LIMITS,
  workEvidenceSchema,
  workItemSchema,
  workLoginSchema,
  reviewDecisionSchema,
  workCheckSchema,
  type WorkEvidence,
  type PullWork,
} from "../shared/repository-work";
import { GitHubReader, ProviderFailure } from "./github-client";

const PULL_FIELDS =
  "id number title state createdAt updatedAt isDraft headRefOid author { __typename login }";
export const WORK_QUERY = `query RepositoryWork($owner: String!, $name: String!) {
  pullRepository: repository(owner: $owner, name: $name) {
    nameWithOwner
    recent: pullRequests(first: ${WORK_LIMITS.RECENT_PULLS}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount pageInfo { hasNextPage } nodes { ${PULL_FIELDS} }
    }
    oldest: pullRequests(first: ${WORK_LIMITS.OLDEST_PULLS}, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount pageInfo { hasNextPage } nodes { ${PULL_FIELDS} }
    }
  }
  issueRepository: repository(owner: $owner, name: $name) {
    nameWithOwner hasIssuesEnabled
    issues(first: ${WORK_LIMITS.ISSUES}, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount pageInfo { hasNextPage } nodes { number title state createdAt updatedAt }
    }
  }
}`;
export const WORK_SIGNALS_QUERY = `query RepositoryWorkSignals($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id number state repository { nameWithOwner } headRefOid
      reviewDecision reviewRequests { totalCount }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
    }
  }
}`;
const count = z.number().int().nonnegative().safe();
const nodeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_+=/-]+$/);
const providerPull = workItemSchema
  .safeExtend({
    id: nodeId,
    state: z.literal("OPEN"),
    isDraft: z.boolean(),
    headRefOid: githubShaSchema,
    author: z
      .object({ __typename: z.string().min(1).max(80), login: workLoginSchema })
      .nullable(),
  })
  .strip();
const providerIssue = workItemSchema
  .safeExtend({ state: z.literal("OPEN") })
  .strip();
type ProviderPull = z.infer<typeof providerPull>;
function connection<T extends z.ZodType>(schema: T, limit: number) {
  return z.object({
    totalCount: count,
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(schema).max(limit),
  });
}
const pullRepository = z.object({
  nameWithOwner: repositoryFields.shape.fullName,
  recent: connection(providerPull, WORK_LIMITS.RECENT_PULLS),
  oldest: connection(providerPull, WORK_LIMITS.OLDEST_PULLS),
});
const issueRepository = z.object({
  nameWithOwner: repositoryFields.shape.fullName,
  hasIssuesEnabled: z.boolean(),
  issues: connection(providerIssue, WORK_LIMITS.ISSUES),
});
const envelope = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z
    .array(
      z.object({
        type: z.string().max(100).optional(),
        path: z
          .array(z.union([z.string().max(255), z.number().int().nonnegative()]))
          .max(12)
          .optional(),
      }),
    )
    .max(60)
    .optional(),
});
type GraphErrors = z.infer<typeof envelope>["errors"];
const signalIdentity = z.object({
  id: nodeId,
  number: count.min(1),
  state: z.literal("OPEN"),
  repository: z.object({ nameWithOwner: repositoryFields.shape.fullName }),
  headRefOid: githubShaSchema,
});
const providerReview = z.object({
  reviewDecision: reviewDecisionSchema.nullable(),
  reviewRequests: z.object({ totalCount: count }).nullable(),
});
const providerChecks = z.object({
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: githubShaSchema,
            statusCheckRollup: z.object({ state: workCheckSchema }).nullable(),
          }),
        }),
      )
      .max(1),
  }),
});
const OBSERVED: ContextRead = Object.freeze({
  state: "observed",
  reason: "complete",
});
const UNOBSERVED: ContextRead = Object.freeze({
  state: "unobserved",
  reason: "not_attempted",
});
const INVALID: ContextRead = Object.freeze({
  state: "error",
  reason: "response_invalid",
});
function failure(error: unknown): ContextRead {
  return error instanceof ProviderFailure
    ? { state: error.state, reason: error.reason }
    : error instanceof z.ZodError
      ? INVALID
      : { state: "error", reason: "unexpected" };
}
function problem(errors: GraphErrors): ContextRead | null {
  if (!errors?.length) return null;
  if (errors.some((e) => e.type === "RATE_LIMITED"))
    return { state: "rate_limited", reason: "rate_limit" };
  if (errors.every((e) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND"))
    return { state: "unavailable", reason: "permission" };
  return { state: "error", reason: "provider_error" };
}
function aliasProblem(errors: GraphErrors, alias: string) {
  return problem(errors?.filter((e) => !e.path?.length || e.path[0] === alias));
}
function signalProblem(
  errors: GraphErrors,
  index: number,
  area: "review" | "checks",
) {
  return problem(
    errors?.filter((e) => {
      const path = e.path;
      if (!path?.length || path.length === 1) return true;
      if (path[1] !== index) return false;
      if (path.length === 2) return true;
      const field = path[2];
      if (field === "commits") return area === "checks";
      if (field === "reviewDecision" || field === "reviewRequests")
        return area === "review";
      return true;
    }),
  );
}
function invalidUnless(value: unknown): asserts value {
  if (!value) throw new z.ZodError([]);
}
function matching(actual: string, expected: string) {
  invalidUnless(actual.toLowerCase() === expected.toLowerCase());
}
function verifySample<
  T extends { number: number; createdAt: string; updatedAt: string },
>(
  value: { totalCount: number; pageInfo: { hasNextPage: boolean }; nodes: T[] },
  limit: number,
  field: "createdAt" | "updatedAt",
  descending: boolean,
) {
  invalidUnless(
    new Set(value.nodes.map((n) => n.number)).size === value.nodes.length,
  );
  invalidUnless(
    value.pageInfo.hasNextPage
      ? value.nodes.length === limit && value.totalCount > value.nodes.length
      : value.totalCount === value.nodes.length,
  );
  invalidUnless(
    value.nodes.every(
      (n, i) =>
        i === 0 ||
        (descending
          ? Date.parse(n[field]) <= Date.parse(value.nodes[i - 1][field])
          : Date.parse(n[field]) >= Date.parse(value.nodes[i - 1][field])),
    ),
  );
}
export function emptyWorkEvidence(now: number): WorkEvidence {
  return {
    observedAt: new Date(now).toISOString(),
    retryAt: null,
    requests: 0,
    pulls: { ...UNOBSERVED, total: null, hasMore: false, records: [] },
    issues: {
      ...UNOBSERVED,
      enabled: null,
      total: null,
      hasMore: false,
      records: [],
    },
  };
}
function minimizedPull(item: ProviderPull): PullWork {
  const bot = item.author?.__typename === "Bot";
  const login = item.author?.login;
  return {
    number: item.number,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    draft: item.isDraft,
    headSha: item.headRefOid,
    author: item.author ? { login: item.author.login, bot } : null,
    dependencyBot:
      bot && (login === "dependabot" || login === "renovate") ? login : null,
    review: { ...UNOBSERVED, decision: null, requested: null },
    checks: { ...UNOBSERVED, status: null },
  };
}
function markSignals(item: PullWork, read: ContextRead) {
  item.review = { ...read, decision: null, requested: null };
  item.checks = { ...read, status: null };
}
export async function collectRepositoryWork(
  fullName: string,
  token: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  } = {},
): Promise<WorkEvidence> {
  const now = options.now ?? Date.now;
  const result = emptyWorkEvidence(now());
  const reader = new GitHubReader(token, {
    ...options,
    maxRequests: WORK_LIMITS.REQUESTS,
  });
  let selected: ProviderPull[] = [];
  try {
    const [owner, name] = repositoryFields.shape.fullName
      .parse(fullName)
      .split("/");
    if (!token || /[\s\u0000-\u001f\u007f]/.test(token))
      throw new ProviderFailure(
        "unavailable",
        "Invalid credential",
        null,
        "configuration",
      );
    const response = await reader.request(
      "repository",
      new URL("/graphql", GITHUB_LIMITS.API_ORIGIN),
      { query: WORK_QUERY, variables: { owner, name } },
    );
    const body = envelope.parse(response.data);
    invalidUnless(Boolean(body.data || body.errors?.length));
    invalidUnless(
      !body.errors?.some(
        (e) =>
          e.path?.length &&
          !["pullRepository", "issueRepository"].includes(String(e.path[0])),
      ),
    );
    if (body.errors?.some((e) => e.type === "RATE_LIMITED"))
      reader.retryAt = response.resetAt;
    try {
      const gap = aliasProblem(body.errors, "pullRepository");
      if (gap) result.pulls = { ...result.pulls, ...gap };
      else {
        const data = pullRepository.parse(body.data?.pullRepository);
        matching(data.nameWithOwner, fullName);
        verifySample(data.recent, WORK_LIMITS.RECENT_PULLS, "updatedAt", true);
        verifySample(data.oldest, WORK_LIMITS.OLDEST_PULLS, "createdAt", false);
        invalidUnless(data.recent.totalCount === data.oldest.totalCount);
        const items = new Map<string, ProviderPull>();
        for (const item of [...data.recent.nodes, ...data.oldest.nodes]) {
          const previous = items.get(item.id);
          invalidUnless(
            !previous || JSON.stringify(previous) === JSON.stringify(item),
          );
          items.set(item.id, item);
        }
        const merged = [...items.values()];
        invalidUnless(
          new Set(merged.map((item) => item.number)).size === merged.length &&
            merged.length <= data.recent.totalCount,
        );
        selected = merged.sort(
          (a, b) =>
            Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
            b.number - a.number,
        );
        result.pulls = {
          ...OBSERVED,
          total: data.recent.totalCount,
          hasMore: data.recent.totalCount > selected.length,
          records: selected.map(minimizedPull),
        };
      }
    } catch (error) {
      result.pulls = { ...result.pulls, ...failure(error) };
    }
    try {
      const gap = aliasProblem(body.errors, "issueRepository");
      if (gap) result.issues = { ...result.issues, ...gap };
      else {
        const data = issueRepository.parse(body.data?.issueRepository);
        matching(data.nameWithOwner, fullName);
        verifySample(data.issues, WORK_LIMITS.ISSUES, "createdAt", false);
        result.issues = {
          ...OBSERVED,
          enabled: data.hasIssuesEnabled,
          total: data.issues.totalCount,
          hasMore: data.issues.pageInfo.hasNextPage,
          records: data.issues.nodes.map(({ state: _state, ...item }) => item),
        };
      }
    } catch (error) {
      result.issues = { ...result.issues, ...failure(error) };
    }
  } catch (error) {
    const gap = failure(error);
    result.pulls = { ...result.pulls, ...gap };
    result.issues = { ...result.issues, ...gap };
  }
  if (selected.length && !reader.retryAt) {
    try {
      const response = await reader.request(
        "repository",
        new URL("/graphql", GITHUB_LIMITS.API_ORIGIN),
        {
          query: WORK_SIGNALS_QUERY,
          variables: { ids: selected.map((item) => item.id) },
        },
      );
      const body = envelope.parse(response.data);
      invalidUnless(Boolean(body.data || body.errors?.length));
      invalidUnless(
        !body.errors?.some(
          (e) =>
            e.path?.length &&
            (e.path[0] !== "nodes" ||
              (e.path.length > 1 &&
                (typeof e.path[1] !== "number" ||
                  e.path[1] >= selected.length))),
        ),
      );
      if (body.errors?.some((e) => e.type === "RATE_LIMITED"))
        reader.retryAt = response.resetAt;
      const rootGap = problem(
        body.errors?.filter((e) => !e.path?.length || e.path.length === 1),
      );
      if (rootGap)
        result.pulls.records.forEach((item) => markSignals(item, rootGap));
      else {
        const nodes = z
          .array(z.unknown())
          .length(selected.length)
          .parse(body.data?.nodes);
        result.pulls.records.forEach((item, index) => {
          const reviewGap = signalProblem(body.errors, index, "review");
          const checksGap = signalProblem(body.errors, index, "checks");
          try {
            const identity = signalIdentity.parse(nodes[index]);
            invalidUnless(
              identity.id === selected[index].id &&
                identity.number === item.number &&
                identity.headRefOid === item.headSha,
            );
            matching(identity.repository.nameWithOwner, fullName);
          } catch {
            item.review = {
              ...(reviewGap ?? INVALID),
              decision: null,
              requested: null,
            };
            item.checks = { ...(checksGap ?? INVALID), status: null };
            return;
          }
          if (reviewGap)
            item.review = { ...reviewGap, decision: null, requested: null };
          else
            try {
              const data = providerReview.parse(nodes[index]);
              item.review = {
                ...OBSERVED,
                decision: data.reviewDecision,
                requested: data.reviewRequests?.totalCount ?? null,
              };
            } catch (error) {
              item.review = {
                ...failure(error),
                decision: null,
                requested: null,
              };
            }
          if (checksGap) item.checks = { ...checksGap, status: null };
          else
            try {
              const commit = providerChecks.parse(nodes[index]).commits.nodes[0]
                ?.commit;
              invalidUnless(commit && commit.oid === item.headSha);
              item.checks = {
                ...OBSERVED,
                status: commit.statusCheckRollup?.state ?? null,
              };
            } catch (error) {
              item.checks = { ...failure(error), status: null };
            }
        });
      }
    } catch (error) {
      result.pulls.records.forEach((item) => markSignals(item, failure(error)));
    }
  } else if (selected.length && reader.retryAt) {
    result.pulls.records.forEach((item) =>
      markSignals(item, { state: "rate_limited", reason: "rate_limit" }),
    );
  }
  result.requests = reader.requests;
  result.retryAt =
    reader.retryAt === null ? null : new Date(reader.retryAt).toISOString();
  return workEvidenceSchema.parse(result);
}
