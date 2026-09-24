import { z } from "zod";
import type {
  GitHubDiagnostics,
  GitHubStopReason,
} from "../shared/github-diagnostics";
import {
  GITHUB_LIMITS,
  GITHUB_CHECK_KEYS,
  GITHUB_CHECK_LABELS,
  GITHUB_SECURITY_KEYS,
  githubBranchSchema,
  type GitHubCheck,
  type GitHubCheckKey,
} from "../shared/github-evidence";
import {
  observationSchema,
  repositoryFields,
  type Observation,
} from "../shared/domain";

type EvidenceDetails = Observation["details"];
export type GitHubCollection = {
  status: "succeeded" | "partial" | "failed";
  health: Observation["health"];
  summary: string;
  details: EvidenceDetails;
  observedAt: string;
  retryAt: string | null;
  diagnostics: GitHubDiagnostics;
};
type CollectorOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxRequests?: number;
};
type Page<T> = {
  items: T[];
  total?: number;
};
type Collection<T> = Page<T> & { complete: boolean; problem?: ProviderFailure };

const shaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const metadataSchema = z.object({
  full_name: repositoryFields.shape.fullName,
  private: z.boolean(),
  default_branch: githubBranchSchema,
});
const headSchema = z.object({
  name: githubBranchSchema,
  commit: z.object({ sha: shaSchema }),
});
const countSchema = z.number().int().nonnegative().max(100000);
const checkRunStateSchema = z.enum([
  "ACTION_REQUIRED",
  "CANCELLED",
  "COMPLETED",
  "FAILURE",
  "IN_PROGRESS",
  "NEUTRAL",
  "PENDING",
  "QUEUED",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
  "WAITING",
]);
const statusStateSchema = z.enum([
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
]);
const stateCount = <T extends z.ZodType>(state: T) =>
  z.object({ state, count: countSchema });
const rollupSchema = z.object({
  state: statusStateSchema,
  contexts: z.object({
    totalCount: countSchema,
    checkRunCount: countSchema,
    checkRunCountsByState: z.array(stateCount(checkRunStateSchema)).max(20),
    statusContextCount: countSchema,
    statusContextCountsByState: z.array(stateCount(statusStateSchema)).max(10),
  }),
});
const ciDataSchema = z.object({
  repository: z
    .object({
      nameWithOwner: repositoryFields.shape.fullName,
      object: z
        .object({
          oid: shaSchema,
          statusCheckRollup: rollupSchema.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
const graphQLEnvelopeSchema = z.object({
  data: z.unknown().optional(),
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
const alertsSchema = z
  .array(
    z.object({
      number: z.number().int().positive(),
      state: z.literal("open"),
    }),
  )
  .max(GITHUB_LIMITS.PAGE_SIZE);
const FAILING_CHECK_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const SAFE_CHECK_STATES = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);
const FAILING_STATUS_STATES = new Set(["ERROR", "FAILURE"]);
const PAGINATION_KEYS = new Set(["page", "after", "before"]);

export const CI_ROLLUP_QUERY = `query RepositoryCiRollup($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    object(expression: $expression) {
      ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 1) {
            totalCount
            checkRunCount
            checkRunCountsByState { state count }
            statusContextCount
            statusContextCountsByState { state count }
          }
        }
      }
    }
  }
}`;

export class ProviderFailure extends Error {
  constructor(
    readonly state: GitHubCheck["state"],
    message: string,
    readonly retryAt: number | null = null,
    readonly reason: GitHubStopReason = "pagination_invalid",
  ) {
    super(message);
  }
}
function malformed() {
  return new ProviderFailure(
    "error",
    "GitHub returned an unexpected response. No complete result was accepted.",
    null,
    "response_invalid",
  );
}
function providerFailure(error: unknown) {
  return error instanceof ProviderFailure
    ? error
    : new ProviderFailure(
        "error",
        "An unexpected runtime or network failure interrupted GitHub collection. Inspect the refresh diagnostics before retrying.",
        null,
        "unexpected",
      );
}

function graphQLProblem(
  errors: z.infer<typeof graphQLEnvelopeSchema>["errors"],
  resetAt: number,
) {
  if (errors?.some((error) => error.type === "RATE_LIMITED"))
    return new ProviderFailure(
      "rate_limited",
      "GitHub asked HQ to wait before collecting more evidence.",
      resetAt,
      "rate_limit",
    );
  if (
    errors?.length &&
    errors.every(
      (error) => error.type === "FORBIDDEN" || error.type === "NOT_FOUND",
    )
  )
    return new ProviderFailure(
      "unavailable",
      "GitHub did not grant access to this evidence. Check permissions, repository access, and feature availability.",
      null,
      "permission",
    );
  return new ProviderFailure(
    "error",
    "GitHub could not provide this evidence. Retry after the provider recovers.",
    null,
    "provider_error",
  );
}

function validatedCounts<T extends string>(
  entries: { state: T; count: number }[],
  expected: number,
) {
  const counts = new Map<T, number>();
  let total = 0;
  for (const entry of entries) {
    if (counts.has(entry.state)) throw malformed();
    counts.set(entry.state, entry.count);
    total += entry.count;
  }
  if (total !== expected) throw malformed();
  return counts;
}

function summarizeRollup(rollup: z.infer<typeof rollupSchema> | null) {
  if (!rollup)
    return {
      checks: 0,
      statuses: 0,
      failed: false,
      passed: false,
      pending: false,
    };
  const contexts = rollup.contexts;
  if (
    contexts.totalCount !==
    contexts.checkRunCount + contexts.statusContextCount
  )
    throw malformed();
  const checks = validatedCounts(
    contexts.checkRunCountsByState,
    contexts.checkRunCount,
  );
  const statuses = validatedCounts(
    contexts.statusContextCountsByState,
    contexts.statusContextCount,
  );
  const failed =
    FAILING_STATUS_STATES.has(rollup.state) ||
    [...checks].some(
      ([state, count]) => count > 0 && FAILING_CHECK_STATES.has(state),
    ) ||
    [...statuses].some(
      ([state, count]) => count > 0 && FAILING_STATUS_STATES.has(state),
    );
  const passed =
    (checks.get("SUCCESS") ?? 0) > 0 ||
    (statuses.get("SUCCESS") ?? 0) > 0;
  const pending =
    rollup.state !== "SUCCESS" ||
    [...checks].some(
      ([state, count]) => count > 0 && !SAFE_CHECK_STATES.has(state),
    ) ||
    [...statuses].some(
      ([state, count]) => count > 0 && state !== "SUCCESS",
    );
  return {
    checks: contexts.checkRunCount,
    statuses: contexts.statusContextCount,
    failed,
    passed,
    pending,
  };
}
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  reason: () => "timeout" | "interrupted",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(
        new ProviderFailure(
          "error",
          reason() === "timeout"
            ? "The GitHub request timed out."
            : "The GitHub collection was interrupted.",
          null,
          reason(),
        ),
      );
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

function rateLimitAt(response: Response, now: number) {
  const retry = response.headers.get("Retry-After");
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (
    response.status !== 429 &&
    !(response.status === 403 && (retry !== null || remaining === "0"))
  )
    return null;
  const retrySeconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
  const retryDate =
    retrySeconds !== null ? now + retrySeconds * 1000 : Date.parse(retry ?? "");
  const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
  const deadline = Math.max(
    now + GITHUB_LIMITS.MIN_BACKOFF_MS,
    Number.isFinite(retryDate) ? retryDate : 0,
    Number.isFinite(reset) ? reset : 0,
  );
  return Math.min(deadline, now + GITHUB_LIMITS.MAX_BACKOFF_MS);
}

export function githubNextPage(
  base: URL,
  link: string | null,
  cursorsOnly = false,
): URL | null {
  if (!link) return null;
  if (link.length > GITHUB_LIMITS.LINK_HEADER_BYTES)
    throw new ProviderFailure(
      "limited",
      "Pagination exceeded the safe collection boundary.",
    );
  const entries = link
    .split(/,\s*(?=<)/)
    .map((entry) => /^<([^>]+)>\s*;\s*rel="([^"]+)"$/.exec(entry.trim()));
  if (entries.some((entry) => !entry))
    throw new ProviderFailure(
      "limited",
      "GitHub pagination could not be verified.",
    );
  const matches = entries.filter((entry) =>
    entry![2].split(/\s+/).includes("next"),
  );
  if (!matches.length) return null;
  if (matches.length !== 1)
    throw new ProviderFailure(
      "limited",
      "GitHub pagination could not be verified.",
    );
  let next: URL;
  try {
    next = new URL(matches[0]![1]);
  } catch {
    throw new ProviderFailure(
      "limited",
      "GitHub pagination could not be verified.",
    );
  }
  if (
    next.origin !== base.origin ||
    next.pathname !== base.pathname ||
    next.username ||
    next.password ||
    next.hash
  )
    throw new ProviderFailure(
      "limited",
      "Pagination left the enrolled GitHub endpoint and was not followed.",
    );
  const result = new URL(base);
  for (const key of PAGINATION_KEYS) result.searchParams.delete(key);
  const seen = new Set<string>();
  let pagination = 0;
  for (const [key, value] of next.searchParams) {
    if (seen.has(key))
      throw new ProviderFailure(
        "limited",
        "GitHub pagination contained duplicate parameters.",
      );
    seen.add(key);
    if (!PAGINATION_KEYS.has(key)) {
      if (base.searchParams.get(key) !== value)
        throw new ProviderFailure(
          "limited",
          "Pagination changed the requested evidence filters.",
        );
      continue;
    }
    pagination++;
    if (
      !value ||
      value.length > GITHUB_LIMITS.CURSOR_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      (key === "page" && (cursorsOnly || !/^[1-9]\d{0,6}$/.test(value)))
    )
      throw new ProviderFailure(
        "limited",
        "GitHub returned an unsupported pagination cursor.",
      );
    result.searchParams.set(key, value);
  }
  if (pagination !== 1)
    throw new ProviderFailure(
      "limited",
      "GitHub pagination could not be verified.",
    );
  return result;
}

export class GitHubReader {
  requests = 0;
  readonly started = performance.now();
  readonly endpoints: GitHubDiagnostics["endpoints"] = GITHUB_CHECK_KEYS.map(
    (key) => ({ key, requests: 0, pages: 0, reason: "not_attempted" }),
  );
  retryAt: number | null = null;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly signal: AbortSignal;
  constructor(
    readonly token: string,
    readonly options: CollectorOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.signal = AbortSignal.any([
      AbortSignal.timeout(GITHUB_LIMITS.REPOSITORY_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
    ]);
  }
  endpoint(key: GitHubCheckKey) {
    return this.endpoints.find((item) => item.key === key)!;
  }
  completed(key: GitHubCheckKey, problem?: ProviderFailure) {
    this.endpoint(key).reason = problem?.reason ?? "complete";
  }
  diagnostics(): GitHubDiagnostics {
    return {
      elapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
      requests: this.requests,
      pages: this.endpoints.reduce((sum, item) => sum + item.pages, 0),
      endpoints: this.endpoints.map((item) => ({ ...item })),
    };
  }
  async request(
    key: GitHubCheckKey,
    url: URL,
    graphQL?: { query: string; variables: Record<string, string | string[]> },
  ): Promise<{ data: unknown; link: string | null; resetAt: number }> {
    if (
      url.origin !== GITHUB_LIMITS.API_ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      (graphQL &&
        (url.pathname !== "/graphql" ||
          url.search ||
          !graphQL.query.startsWith("query ")))
    )
      throw new ProviderFailure(
        "unavailable",
        "Only the configured GitHub API can be read.",
        null,
        "configuration",
      );
    if (this.signal.aborted)
      throw new ProviderFailure(
        "error",
        "The GitHub collection was interrupted before starting another request.",
        null,
        this.options.signal?.aborted ? "interrupted" : "timeout",
      );
    if (this.retryAt !== null && this.retryAt > this.now())
      throw new ProviderFailure(
        "rate_limited",
        "GitHub asked HQ to wait before collecting more evidence.",
        this.retryAt,
        "rate_limit",
      );
    if (
      this.requests >=
      Math.min(
        this.options.maxRequests ?? GITHUB_LIMITS.MAX_REQUESTS,
        GITHUB_LIMITS.MAX_REQUESTS,
      )
    )
      throw new ProviderFailure(
        "limited",
        "The bounded request budget was reached. Coverage is incomplete.",
        null,
        "request_limit",
      );
    this.requests++;
    this.endpoint(key).requests++;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? GITHUB_LIMITS.REQUEST_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([controller.signal, this.signal]);
    const abortReason = () =>
      this.options.signal?.aborted
        ? ("interrupted" as const)
        : ("timeout" as const);
    try {
      const response = await abortable(
        this.fetch(url.href, {
          method: graphQL ? "POST" : "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: "Bearer " + this.token,
            "X-GitHub-Api-Version": GITHUB_LIMITS.API_VERSION,
            "User-Agent": "maintainer-hq",
            ...(graphQL ? { "Content-Type": "application/json" } : {}),
          },
          ...(graphQL ? { body: JSON.stringify(graphQL) } : {}),
          redirect: "manual",
          signal,
        }),
        signal,
        abortReason,
      );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        const retryAt = rateLimitAt(response, this.now());
        if (retryAt !== null) {
          this.retryAt = Math.max(this.retryAt ?? 0, retryAt);
          throw new ProviderFailure(
            "rate_limited",
            "GitHub asked HQ to wait before collecting more evidence.",
            retryAt,
            "rate_limit",
          );
        }
        if (response.status >= 300 && response.status < 400)
          throw new ProviderFailure(
            "unavailable",
            "GitHub redirected this resource. Verify its enrolled name; no redirect was followed.",
            null,
            "redirect",
          );
        if (response.status === 401)
          throw new ProviderFailure(
            "unavailable",
            "GitHub rejected the configured credential. An owner must check its validity.",
            null,
            "credential",
          );
        if (response.status === 403 || response.status === 404)
          throw new ProviderFailure(
            "unavailable",
            "GitHub did not grant access to this evidence. Check permissions, repository access, and feature availability.",
            null,
            "permission",
          );
        throw new ProviderFailure(
          "error",
          "GitHub could not provide this evidence. Retry after the provider recovers.",
          null,
          "provider_error",
        );
      }
      if (
        !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(
          response.headers.get("Content-Type") ?? "",
        )
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw malformed();
      }
      if (
        Number(response.headers.get("Content-Length")) >
        GITHUB_LIMITS.RESPONSE_BYTES
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new ProviderFailure(
          "limited",
          "The GitHub response exceeded the collection size limit.",
          null,
          "response_size",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw malformed();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await abortable(
            reader.read(),
            signal,
            abortReason,
          );
          if (done) break;
          size += value.byteLength;
          if (size > GITHUB_LIMITS.RESPONSE_BYTES)
            throw new ProviderFailure(
              "limited",
              "The GitHub response exceeded the collection size limit.",
              null,
              "response_size",
            );
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw malformed();
      }
      const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
      return {
        data,
        link: response.headers.get("Link"),
        resetAt: Math.min(
          this.now() + GITHUB_LIMITS.MAX_BACKOFF_MS,
          Math.max(
            this.now() + GITHUB_LIMITS.MIN_BACKOFF_MS,
            Number.isFinite(reset) ? reset : 0,
          ),
        ),
      };
    } catch (error) {
      if (signal.aborted)
        throw new ProviderFailure(
          "error",
          abortReason() === "timeout"
            ? "The GitHub request timed out."
            : "The GitHub collection was interrupted.",
          null,
          abortReason(),
        );
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async list<T extends { id?: number; number?: number }>(
    key: GitHubCheckKey,
    path: string,
    parameters: Record<string, string>,
    parse: (data: unknown) => Page<T>,
    cursorsOnly = false,
    identity: (item: T) => number | string = (item) => item.id ?? item.number!,
  ): Promise<Collection<T>> {
    const base = new URL(path, GITHUB_LIMITS.API_ORIGIN);
    for (const [key, value] of Object.entries(parameters))
      base.searchParams.set(key, value);
    base.searchParams.set("per_page", String(GITHUB_LIMITS.PAGE_SIZE));
    let next = base;
    const visited = new Set<string>();
    const ids = new Set<number | string>();
    const result: Collection<T> = { items: [], complete: false };
    try {
      for (let page = 0; page < GITHUB_LIMITS.MAX_PAGES; page++) {
        if (visited.has(next.href))
          throw new ProviderFailure(
            "limited",
            "Pagination repeated a page. Coverage is incomplete.",
          );
        visited.add(next.href);
        const response = await this.request(key, next);
        let parsed: Page<T>;
        try {
          parsed = parse(response.data);
          this.endpoint(key).pages++;
        } catch {
          throw malformed();
        }
        if (
          parsed.total !== undefined &&
          result.total !== undefined &&
          parsed.total !== result.total
        )
          throw new ProviderFailure(
            "limited",
            "GitHub results changed during pagination. Refresh to collect a consistent view.",
          );
        result.total = parsed.total;
        for (const item of parsed.items) {
          const id = identity(item);
          if (ids.has(id))
            throw new ProviderFailure(
              "limited",
              "GitHub returned overlapping pages. Coverage is incomplete.",
            );
          ids.add(id);
          result.items.push(item);
        }
        const following = githubNextPage(base, response.link, cursorsOnly);
        if (!following) {
          if (
            result.total !== undefined &&
            result.total !== result.items.length
          )
            throw new ProviderFailure(
              "limited",
              "GitHub returned fewer results than its reported total.",
            );
          result.complete = true;
          this.completed(key);
          return result;
        }
        next = following;
      }
      throw new ProviderFailure(
        "limited",
        "More evidence exists than fits in a bounded refresh. Shown counts are lower bounds.",
        null,
        "page_limit",
      );
    } catch (error) {
      result.problem = providerFailure(error);
      this.completed(key, result.problem);
      return result;
    }
  }
}

function checkFor<T>(
  key: GitHubCheckKey,
  result: Collection<T>,
  summary: string,
): GitHubCheck {
  return {
    key,
    state: result.complete ? "observed" : (result.problem?.state ?? "error"),
    summary: result.complete
      ? summary
      : (result.problem?.message ?? "This evidence could not be collected."),
    ...(result.complete || result.items.length
      ? { count: result.items.length }
      : {}),
  };
}

export async function collectGitHub(
  fullName: string,
  token: string,
  options: CollectorOptions = {},
): Promise<GitHubCollection> {
  const now = options.now ?? Date.now;
  const observedAt = new Date(now()).toISOString();
  const checks: GitHubCheck[] = GITHUB_CHECK_KEYS.map((key) => ({
    key,
    state: "unobserved",
    summary: "This evidence has not been collected.",
  }));
  const put = (check: GitHubCheck) => {
    checks[checks.findIndex((item) => item.key === check.key)] = check;
  };
  const details: EvidenceDetails = { ci: "unknown", github: { checks } };
  const reader = new GitHubReader(token, options);
  let headSha: string | undefined;
  let securityCount = 0;
  let securityComplete = true;
  const invalidName =
    !repositoryFields.shape.fullName.safeParse(fullName).success ||
    [".", ".."].includes(fullName.split("/")[1]);
  if (invalidName || !/^[\x21-\x7e]{1,2048}$/.test(token)) {
    reader.endpoint("repository").reason = "configuration";
    put({
      key: "repository",
      state: "unavailable",
      summary:
        "The enrolled repository or credential configuration is invalid.",
    });
    return {
      status: "failed",
      health: "unknown",
      summary: "GitHub connection configuration needs attention.",
      details,
      observedAt,
      retryAt: null,
      diagnostics: reader.diagnostics(),
    };
  }
  const [owner, name] = fullName.split("/");
  const path =
    "/repos/" + [owner, name].map(encodeURIComponent).join("/");
  let branch: string;
  try {
    const response = await reader.request(
      "repository",
      new URL(path, GITHUB_LIMITS.API_ORIGIN),
    );
    const parsed = metadataSchema.safeParse(response.data);
    if (
      !parsed.success ||
      parsed.data.full_name.toLowerCase() !== fullName.toLowerCase()
    )
      throw malformed();
    branch = parsed.data.default_branch;
    reader.completed("repository");
    details.github!.defaultBranch = branch;
    details.visibility = parsed.data.private ? "private" : "public";
    details.url = GITHUB_LIMITS.WEB_ORIGIN + "/" + fullName;
    put({
      key: "repository",
      state: "observed",
      summary: "Repository metadata was read directly from GitHub.",
    });
  } catch (error) {
    const problem = providerFailure(error);
    reader.completed("repository", problem);
    put({ key: "repository", state: problem.state, summary: problem.message });
    return {
      status: "failed",
      health: "unknown",
      summary: problem.message,
      details,
      observedAt,
      retryAt:
        reader.retryAt === null ? null : new Date(reader.retryAt).toISOString(),
      diagnostics: reader.diagnostics(),
    };
  }
  try {
    const response = await reader.request(
      "head",
      new URL(
        path + "/branches/" + encodeURIComponent(branch),
        GITHUB_LIMITS.API_ORIGIN,
      ),
    );
    const parsed = headSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.name !== branch) throw malformed();
    headSha = parsed.data.commit.sha;
    reader.completed("head");
    details.github!.headSha = headSha;
    put({
      key: "head",
      state: "observed",
      summary: "CI is scoped to the observed default-branch commit.",
    });
  } catch (error) {
    const problem = providerFailure(error);
    reader.completed("head", problem);
    put({ key: "head", state: problem.state, summary: problem.message });
  }
  if (headSha) {
    try {
      const response = await reader.request(
        "checks",
        new URL("/graphql", GITHUB_LIMITS.API_ORIGIN),
        {
          query: CI_ROLLUP_QUERY,
          variables: { owner, name, expression: headSha },
        },
      );
      const envelope = graphQLEnvelopeSchema.safeParse(response.data);
      if (!envelope.success) throw malformed();
      if (envelope.data.errors?.length)
        throw graphQLProblem(envelope.data.errors, response.resetAt);
      const parsed = ciDataSchema.safeParse(envelope.data.data);
      if (
        !parsed.success ||
        !parsed.data.repository ||
        parsed.data.repository.nameWithOwner.toLowerCase() !==
          fullName.toLowerCase() ||
        !parsed.data.repository.object ||
        parsed.data.repository.object.oid !== headSha
      )
        throw malformed();
      const summary = summarizeRollup(
        parsed.data.repository.object.statusCheckRollup,
      );
      reader.completed("checks");
      reader.completed("statuses");
      put({
        key: "checks",
        state: "observed",
        summary: summary.checks
          ? "Check Run state counts were read for the observed commit."
          : "No Check Runs exist for the observed commit.",
        count: summary.checks,
      });
      put({
        key: "statuses",
        state: "observed",
        summary: summary.statuses
          ? "Commit-status state counts were read for the observed commit."
          : "No commit statuses exist for the observed commit.",
        count: summary.statuses,
      });
      details.ci = summary.failed
        ? "failing"
        : summary.passed && !summary.pending
          ? "passing"
          : "unknown";
    } catch (error) {
      const problem = providerFailure(error);
      if (problem.retryAt !== null)
        reader.retryAt = Math.max(reader.retryAt ?? 0, problem.retryAt);
      reader.completed("checks", problem);
      reader.completed("statuses", problem);
      put({ key: "checks", state: problem.state, summary: problem.message });
      put({ key: "statuses", state: problem.state, summary: problem.message });
    }
  }
  const security = await Promise.all([
    reader.list(
      "dependabot",
      path + "/dependabot/alerts",
      { state: "open" },
      (data) => ({ items: alertsSchema.parse(data) }),
      true,
    ),
    reader.list(
      "codeScanning",
      path + "/code-scanning/alerts",
      { state: "open", ref: "refs/heads/" + branch },
      (data) => ({ items: alertsSchema.parse(data) }),
    ),
    reader.list(
      "secretScanning",
      path + "/secret-scanning/alerts",
      { state: "open", hide_secret: "true" },
      (data) => ({ items: alertsSchema.parse(data) }),
    ),
  ]);
  security.forEach((result, index) => {
    const key = GITHUB_SECURITY_KEYS[index];
    put(
      checkFor(
        key,
        result,
        GITHUB_CHECK_LABELS[key] +
          ": " +
          result.items.length +
          " open findings observed.",
      ),
    );
    securityCount += result.items.length;
    securityComplete &&= result.complete;
  });
  if (securityComplete || securityCount > 0)
    details.openFindings = securityCount;
  const failures = checks.filter((check) => check.state !== "observed").length;
  const issues = [];
  if (details.ci === "failing") issues.push("CI is failing");
  if (securityCount)
    issues.push(
      (securityComplete ? "" : "At least ") +
        securityCount +
        " open security findings",
    );
  const unknown = details.ci === "unknown" || !securityComplete || failures > 0;
  const summary = issues.length
    ? issues.join(". ") + "."
    : unknown
      ? "GitHub evidence is incomplete or CI results are still unverified."
      : "Observed CI results pass and the supported security collections report no open findings.";
  return {
    status: failures ? "partial" : "succeeded",
    health: issues.length ? "warning" : unknown ? "unknown" : "healthy",
    summary,
    details: observationSchema.shape.details.parse(details),
    observedAt,
    retryAt:
      reader.retryAt === null ? null : new Date(reader.retryAt).toISOString(),
    diagnostics: reader.diagnostics(),
  };
}
