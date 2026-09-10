import { z } from "zod";
import {
  FLEET_DISCOVERY_LIMITS as LIMITS,
  discoveredRepositorySchema,
  fleetLookupSchema,
  fleetProviderResultSchema,
  githubOwnerName,
  type DiscoveredRepository,
  type FleetDiscoveryScope,
  type FleetLookup,
  type FleetProviderResult,
} from "../shared/fleet-discovery";
import { GITHUB_LIMITS } from "../shared/github-evidence";
import type { ContextRead } from "../shared/github-context";
import { GitHubReader, ProviderFailure } from "./github-client";

const FIELDS = "id nameWithOwner description isArchived isPrivate";
export const FLEET_CATALOG_QUERY = `query FleetCatalog($owner: String!, $after: String) {
  catalog: repositoryOwner(login: $owner) {
    login repositories(first: ${LIMITS.PAGE_SIZE}, after: $after, ownerAffiliations: [OWNER], orderBy: {field: NAME, direction: ASC}) {
      totalCount pageInfo {hasNextPage endCursor} nodes {${FIELDS}}
    }
  }
}`;
const apiRepository = z.object({
  id: discoveredRepositorySchema.shape.githubId,
  nameWithOwner: discoveredRepositorySchema.shape.fullName,
  description: discoveredRepositorySchema.shape.description.nullable(),
  isArchived: z.boolean(),
  isPrivate: z.boolean(),
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
    .max(100)
    .optional(),
});
const catalogSchema = z.object({
  login: githubOwnerName,
  repositories: z.object({
    totalCount: z.number().int().nonnegative().safe(),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: fleetProviderResultSchema.shape.nextCursor,
    }),
    nodes: z.array(apiRepository).max(LIMITS.PAGE_SIZE),
  }),
});
const OBSERVED: ContextRead = Object.freeze({
  state: "observed",
  reason: "complete",
});
const INVALID: ContextRead = Object.freeze({
  state: "error",
  reason: "response_invalid",
});
const UNAVAILABLE: ContextRead = Object.freeze({
  state: "unavailable",
  reason: "permission",
});

function normalize(input: unknown): DiscoveredRepository {
  const row = apiRepository.parse(input);
  return discoveredRepositorySchema.parse({
    githubId: row.id,
    fullName: row.nameWithOwner,
    description: row.description ?? "",
    archived: row.isArchived,
    private: row.isPrivate,
  });
}
function failure(error: unknown): ContextRead {
  return error instanceof ProviderFailure
    ? { state: error.state, reason: error.reason }
    : error instanceof z.ZodError
      ? { ...INVALID }
      : { state: "error", reason: "unexpected" };
}
function errorFor(
  errors: z.infer<typeof envelope>["errors"],
  alias: string,
): ContextRead | null {
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
    return { ...UNAVAILABLE };
  return { state: "error", reason: "provider_error" };
}
function lookupQuery(lookups: FleetLookup[]) {
  const declarations: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  lookups.forEach((lookup, index) => {
    const alias = "repository" + index;
    if (lookup.githubId) {
      declarations.push("$id" + index + ": ID!");
      variables["id" + index] = lookup.githubId;
      fields.push(
        alias +
          ": node(id: $id" +
          index +
          ") { ... on Repository { " +
          FIELDS +
          " } }",
      );
    } else {
      const [owner, name] = lookup.fullName.split("/");
      declarations.push(
        "$owner" + index + ": String!",
        "$name" + index + ": String!",
      );
      variables["owner" + index] = owner;
      variables["name" + index] = name;
      fields.push(
        alias +
          ": repository(owner: $owner" +
          index +
          ", name: $name" +
          index +
          ", followRenames: true) { " +
          FIELDS +
          " }",
      );
    }
  });
  return {
    query:
      "query FleetRepositories(" +
      declarations.join(", ") +
      ") { " +
      fields.join(" ") +
      " }",
    variables,
  };
}

export async function collectFleetDiscovery(
  scope: FleetDiscoveryScope,
  lookups: FleetLookup[],
  token: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  } = {},
): Promise<FleetProviderResult> {
  const now = options.now ?? Date.now;
  const reader = new GitHubReader(token, {
    ...options,
    maxRequests: LIMITS.REQUESTS,
  });
  const result: FleetProviderResult = {
    observedAt: new Date(now()).toISOString(),
    retryAt: null,
    requests: 0,
    read: { state: "unobserved", reason: "not_attempted" },
    owner: scope.kind === "owner" ? scope.owner : null,
    total: null,
    hasMore: false,
    nextCursor: null,
    records: [],
  };
  try {
    if (!/^[\x21-\x7e]{1,2048}$/.test(token))
      throw new ProviderFailure(
        "unavailable",
        "Configured GitHub credential is invalid",
        null,
        "configuration",
      );
    const selected = z
      .array(fleetLookupSchema)
      .max(LIMITS.PAGE_SIZE)
      .parse(lookups);
    if (
      new Set(selected.map((row) => row.repositoryId)).size !== selected.length
    )
      throw new z.ZodError([]);
    if (scope.kind === "owner" && selected.length) throw new z.ZodError([]);
    if (scope.kind === "enrolled" && !selected.length) {
      result.read = { ...OBSERVED };
      result.total = 0;
      return result;
    }
    const variables: Record<string, string> =
      scope.kind === "owner"
        ? { owner: githubOwnerName.parse(scope.owner) }
        : {};
    if (scope.kind === "owner" && scope.cursor)
      variables.after = scope.cursor.after;
    const request =
      scope.kind === "owner"
        ? { query: FLEET_CATALOG_QUERY, variables }
        : lookupQuery(selected);
    const response = await reader.request(
      "repository",
      new URL("/graphql", GITHUB_LIMITS.API_ORIGIN),
      request,
    );
    const body = envelope.parse(response.data);
    const aliases = new Set(
      scope.kind === "owner"
        ? ["catalog"]
        : selected.map((_, index) => "repository" + index),
    );
    if (
      (!body.data && !body.errors?.length) ||
      Object.keys(body.data ?? {}).some((alias) => !aliases.has(alias)) ||
      body.errors?.some(
        (error) => error.path?.length && !aliases.has(String(error.path[0])),
      )
    )
      throw new z.ZodError([]);
    if (scope.kind === "owner") {
      const problem = errorFor(body.errors, "catalog");
      if (problem) result.read = problem;
      else if (body.data?.catalog === null) result.read = { ...UNAVAILABLE };
      else {
        const catalog = catalogSchema.parse(body.data?.catalog);
        const page = catalog.repositories;
        if (
          page.pageInfo.hasNextPage &&
          (page.nodes.length === 0 ||
            page.pageInfo.endCursor === scope.cursor?.after)
        )
          throw new ProviderFailure(
            "limited",
            "GitHub discovery pagination did not advance",
            null,
            "pagination_invalid",
          );
        if (
          catalog.login.toLowerCase() !== scope.owner.toLowerCase() ||
          page.totalCount < page.nodes.length ||
          (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
          new Set(page.nodes.map((row) => row.id)).size !== page.nodes.length ||
          new Set(page.nodes.map((row) => row.nameWithOwner.toLowerCase()))
            .size !== page.nodes.length ||
          page.nodes.some(
            (row) =>
              row.nameWithOwner.split("/")[0].toLowerCase() !==
              scope.owner.toLowerCase(),
          )
        )
          throw new z.ZodError([]);
        result.owner = catalog.login;
        result.total = page.totalCount;
        result.hasMore = page.pageInfo.hasNextPage;
        result.nextCursor = page.pageInfo.hasNextPage
          ? page.pageInfo.endCursor
          : null;
        result.records = page.nodes.map((row) => ({
          repositoryId: null,
          lookupFullName: null,
          lookupGithubId: null,
          read: { ...OBSERVED },
          repository: normalize(row),
        }));
        result.read = { ...OBSERVED };
      }
    } else {
      result.records = selected.map((lookup, index) => {
        const alias = "repository" + index;
        let read = errorFor(body.errors, alias);
        let repository: DiscoveredRepository | null = null;
        if (!read) {
          const value = body.data?.[alias];
          if (value === null) read = { ...UNAVAILABLE };
          else {
            try {
              repository = normalize(value);
              if (lookup.githubId && repository.githubId !== lookup.githubId) {
                read = { ...INVALID };
                repository = null;
              }
            } catch {
              read = { ...INVALID };
            }
          }
        }
        return {
          repositoryId: lookup.repositoryId,
          lookupFullName: lookup.fullName,
          lookupGithubId: lookup.githubId,
          read: read ?? { ...OBSERVED },
          repository,
        };
      });
      result.read = result.records.every(
        (record) => record.read.state === "observed",
      )
        ? { ...OBSERVED }
        : result.records.some((record) => record.read.state === "rate_limited")
          ? { state: "rate_limited", reason: "rate_limit" }
          : { state: "error", reason: "provider_error" };
    }
  } catch (error) {
    result.read = failure(error);
    result.records = [];
    result.total = null;
    result.hasMore = false;
    result.nextCursor = null;
  }
  result.requests = reader.requests;
  const retryAt =
    reader.retryAt ??
    (result.read.state === "rate_limited"
      ? now() + GITHUB_LIMITS.MIN_BACKOFF_MS
      : null);
  result.retryAt = retryAt === null ? null : new Date(retryAt).toISOString();
  result.observedAt = new Date(now()).toISOString();
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    LIMITS.PROVIDER_BYTES
  ) {
    result.read = { state: "limited", reason: "response_size" };
    result.records = [];
    result.total = null;
    result.hasMore = false;
    result.nextCursor = null;
  }
  return fleetProviderResultSchema.parse(result);
}
