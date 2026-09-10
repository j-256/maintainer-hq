import { z } from "zod";
import { repositoryFields } from "../shared/domain";
import { GITHUB_LIMITS, githubBranchSchema } from "../shared/github-evidence";
import {
  RELEASE_LIMITS,
  deploymentStatusSchema,
  releaseComparisonSchema,
  releaseEvidenceSchema,
  releaseShaSchema,
  type ReleaseEvidence,
  type ReleaseRead,
} from "../shared/releases";
import { GitHubReader, ProviderFailure } from "./github-client";

export const RELEASE_QUERY = `query ReleaseEvidence($owner: String!, $name: String!) {
  releaseRepository: repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name target { oid } }
    latestRelease { databaseId tagName publishedAt isDraft isPrerelease tagCommit { oid } }
  }
  deploymentRepository: repository(owner: $owner, name: $name) {
    nameWithOwner
    deployments(first: ${RELEASE_LIMITS.DEPLOYMENTS}, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage }
      nodes { databaseId commitOid createdAt environment latestStatus { state createdAt } }
    }
  }
}`;
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
const providerRelease = z.object({
  nameWithOwner: repositoryFields.shape.fullName,
  defaultBranchRef: z
    .object({
      name: githubBranchSchema,
      target: z.object({ oid: releaseShaSchema }),
    })
    .nullable(),
  latestRelease: z
    .object({
      databaseId: count.min(1),
      tagName: githubBranchSchema,
      publishedAt: timestamp,
      isDraft: z.literal(false),
      isPrerelease: z.literal(false),
      tagCommit: z.object({ oid: releaseShaSchema }).nullable(),
    })
    .nullable(),
});
const providerDeployments = z.object({
  nameWithOwner: repositoryFields.shape.fullName,
  deployments: z.object({
    totalCount: count,
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z
      .array(
        z.object({
          databaseId: count.min(1),
          commitOid: releaseShaSchema,
          createdAt: timestamp,
          environment: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[^\u0000-\u001f\u007f]+$/)
            .nullable(),
          latestStatus: z
            .object({ state: deploymentStatusSchema, createdAt: timestamp })
            .nullable(),
        }),
      )
      .max(RELEASE_LIMITS.DEPLOYMENTS),
  }),
});
const envelope = z.object({
  data: z
    .object({
      releaseRepository: z.unknown(),
      deploymentRepository: z.unknown(),
    })
    .nullable()
    .optional(),
  errors: z
    .array(
      z.object({
        type: z.string().max(100).optional(),
        path: z
          .array(z.union([z.string().max(255), z.number().int()]))
          .max(12)
          .optional(),
      }),
    )
    .max(20)
    .optional(),
});
const comparison = z.object({
  status: releaseComparisonSchema.shape.status,
  ahead_by: count,
  behind_by: count,
  total_commits: count,
  base_commit: z.object({ sha: releaseShaSchema }),
});
const OBSERVED: ReleaseRead = Object.freeze({
  state: "observed",
  reason: "complete",
});
const UNOBSERVED: ReleaseRead = Object.freeze({
  state: "unobserved",
  reason: "not_attempted",
});
const INVALID: ReleaseRead = Object.freeze({
  state: "error",
  reason: "response_invalid",
});
const UNAVAILABLE: ReleaseRead = Object.freeze({
  state: "unavailable",
  reason: "permission",
});

export function emptyReleaseEvidence(now: number): ReleaseEvidence {
  return {
    observedAt: new Date(now).toISOString(),
    retryAt: null,
    requests: 0,
    head: null,
    release: { ...UNOBSERVED, record: null },
    deployments: { ...UNOBSERVED, total: null, hasMore: false, records: [] },
    comparison: { ...UNOBSERVED, record: null },
  };
}
function failure(error: unknown): ReleaseRead {
  return error instanceof ProviderFailure
    ? { state: error.state, reason: error.reason }
    : error instanceof z.ZodError
      ? INVALID
      : { state: "error", reason: "unexpected" };
}
function graphError(
  errors: z.infer<typeof envelope>["errors"],
  alias: string,
): ReleaseRead | null {
  const selected =
    errors?.filter((error) => !error.path?.length || error.path[0] === alias) ??
    [];
  if (!selected.length) return null;
  if (selected.some((error) => error.type === "RATE_LIMITED"))
    return { state: "rate_limited", reason: "rate_limit" };
  if (
    selected.every(
      (error) => error.type === "FORBIDDEN" || error.type === "NOT_FOUND",
    )
  )
    return UNAVAILABLE;
  return { state: "error", reason: "provider_error" };
}
function matching(actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new z.ZodError([]);
}

export async function collectReleases(
  fullName: string,
  token: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  } = {},
): Promise<ReleaseEvidence> {
  const now = options.now ?? Date.now;
  const result = emptyReleaseEvidence(now());
  const reader = new GitHubReader(token, {
    ...options,
    maxRequests: RELEASE_LIMITS.REQUESTS,
  });
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
      { query: RELEASE_QUERY, variables: { owner, name } },
    );
    const body = envelope.parse(response.data);
    if (!body.data && !body.errors?.length) throw new z.ZodError([]);
    if (
      body.errors?.some(
        (error) =>
          error.path?.length &&
          error.path[0] !== "releaseRepository" &&
          error.path[0] !== "deploymentRepository",
      )
    )
      throw new z.ZodError([]);
    const rateLimited = body.errors?.some(
      (error) => error.type === "RATE_LIMITED",
    );
    if (rateLimited) reader.retryAt = response.resetAt;
    try {
      const problem = graphError(body.errors, "releaseRepository");
      if (problem) result.release = { ...problem, record: null };
      else {
        const data = providerRelease.parse(body.data?.releaseRepository);
        matching(data.nameWithOwner, fullName);
        result.head = data.defaultBranchRef
          ? {
              branch: data.defaultBranchRef.name,
              sha: data.defaultBranchRef.target.oid,
            }
          : null;
        result.release = {
          ...OBSERVED,
          record: data.latestRelease
            ? {
                id: data.latestRelease.databaseId,
                tag: data.latestRelease.tagName,
                sha: data.latestRelease.tagCommit?.oid ?? null,
                publishedAt: data.latestRelease.publishedAt,
              }
            : null,
        };
      }
    } catch (error) {
      result.release = { ...failure(error), record: null };
    }
    try {
      const problem = graphError(body.errors, "deploymentRepository");
      if (problem) result.deployments = { ...result.deployments, ...problem };
      else {
        const data = providerDeployments.parse(body.data?.deploymentRepository);
        matching(data.nameWithOwner, fullName);
        const values = data.deployments;
        const ids = new Set(values.nodes.map((item) => item.databaseId));
        if (
          ids.size !== values.nodes.length ||
          values.totalCount < values.nodes.length ||
          (values.pageInfo.hasNextPage
            ? values.nodes.length !== RELEASE_LIMITS.DEPLOYMENTS ||
              values.totalCount <= values.nodes.length
            : values.totalCount !== values.nodes.length) ||
          values.nodes.some(
            (item, i) =>
              i > 0 &&
              Date.parse(item.createdAt) >
                Date.parse(values.nodes[i - 1].createdAt),
          )
        )
          throw new z.ZodError([]);
        result.deployments = {
          ...OBSERVED,
          total: values.totalCount,
          hasMore: values.pageInfo.hasNextPage,
          records: values.nodes.map((item) => ({
            id: item.databaseId,
            sha: item.commitOid,
            createdAt: item.createdAt,
            environment: item.environment,
            status: item.latestStatus?.state ?? null,
            statusAt: item.latestStatus?.createdAt ?? null,
          })),
        };
      }
    } catch (error) {
      result.deployments = { ...result.deployments, ...failure(error) };
    }
    const baseSha = result.release.record?.sha;
    const headSha = result.head?.sha;
    if (baseSha && headSha) {
      try {
        if (baseSha === headSha)
          result.comparison = {
            ...OBSERVED,
            record: {
              baseSha,
              headSha,
              status: "identical",
              aheadBy: 0,
              behindBy: 0,
            },
          };
        else {
          const url = new URL(
            `/repos/${owner}/${name}/compare/${baseSha}...${headSha}`,
            GITHUB_LIMITS.API_ORIGIN,
          );
          url.searchParams.set("per_page", "1");
          const raw = comparison.parse(
            (await reader.request("head", url)).data,
          );
          if (
            raw.base_commit.sha !== baseSha ||
            raw.total_commits !== raw.ahead_by
          )
            throw new z.ZodError([]);
          result.comparison = {
            ...OBSERVED,
            record: releaseComparisonSchema.parse({
              baseSha,
              headSha,
              status: raw.status,
              aheadBy: raw.ahead_by,
              behindBy: raw.behind_by,
            }),
          };
        }
      } catch (error) {
        result.comparison = { ...failure(error), record: null };
      }
    }
  } catch (error) {
    const problem = failure(error);
    result.release = { ...problem, record: null };
    result.deployments = { ...result.deployments, ...problem };
  }
  result.requests = reader.requests;
  result.retryAt =
    reader.retryAt === null ? null : new Date(reader.retryAt).toISOString();
  return releaseEvidenceSchema.parse(result);
}
