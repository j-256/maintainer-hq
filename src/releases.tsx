import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, GitCompareArrows, RefreshCw, Tag } from "lucide-react";
import type { Repository, Snapshot } from "../shared/domain";
import { isGitHubSource, githubCoverageHref } from "../shared/github-coverage";
import { GITHUB_STOP_LABELS } from "../shared/github-diagnostics";
import {
  DEPLOYMENT_STATUS_LABELS,
  RELEASE_LIMITS,
  RELEASE_READ_LABELS,
  githubRepositoryUrl,
  releaseProviderLinks,
  releaseResultSchema,
  type ReleaseRead,
  type ReleaseResult,
} from "../shared/releases";
import { StatusBadge } from "./components/ui/status";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { useDateTime } from "./date-time";
import { repositoryHref } from "./resource-repositories";
import "./releases.css";

const CLOCK_MS = 30 * 1000;
function useReleaseClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
      }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}
function ProviderLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="quiet-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  );
}
function EvidenceTime({ value }: { value: string }) {
  const dates = useDateTime();
  return (
    <time dateTime={value} title={dates.tooltip(value)}>
      {dates.dateTime(value)}
    </time>
  );
}
function ReadGap({
  read,
  area,
}: {
  read: ReleaseRead;
  area: "release" | "deployment" | "comparison";
}) {
  return (
    <div className="release-read-gap">
      <strong>{RELEASE_READ_LABELS[read.state]}</strong>
      <p>
        {read.reason === "permission"
          ? `Review repository access and ${area === "deployment" ? "Deployments" : "Contents"} read permission. The provider did not identify which access or feature is missing.`
          : GITHUB_STOP_LABELS[read.reason] +
            ". No complete " +
            area +
            " result was accepted."}
      </p>
    </div>
  );
}

export function RepositoryReleases({
  snapshot,
  repository,
}: {
  snapshot: Snapshot;
  repository: Repository;
}) {
  const [params, setParams] = useSearchParams();
  const dates = useDateTime();
  const now = useReleaseClock();
  const sources = snapshot.connections
    .filter(isGitHubSource)
    .filter((source) => source.repositoryIds.includes(repository.id));
  const source =
    sources.find((item) => item.id === params.get("releaseSource")) ??
    sources[0];
  const workspaceId = snapshot.workspace.id;
  const query = useQuery({
    queryKey: [
      "repository-releases",
      workspaceId,
      repository.id,
      repository.revision,
      source?.id,
      source?.revision,
      source?.credentialConfigured,
    ],
    queryFn: async ({ signal }) =>
      releaseResultSchema.parse(
        await command<ReleaseResult>(
          "repository_releases",
          { workspaceId, repositoryId: repository.id, sourceId: source!.id },
          signal,
        ),
      ),
    enabled: Boolean(source),
    staleTime: 0,
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const accessChanged =
    query.error instanceof RequestError &&
    [401, 403, 404, 409].includes(query.error.status);
  const result = accessChanged ? undefined : query.data;
  const evidence = result?.evidence;
  const links = releaseProviderLinks(repository.fullName, evidence ?? null);
  const base = githubRepositoryUrl(repository.fullName);
  const stale = Boolean(
    evidence &&
      now >= Date.parse(evidence.observedAt) + RELEASE_LIMITS.CACHE_MS,
  );
  const waiting = Boolean(
    result?.nextReadAt && now < Date.parse(result.nextReadAt),
  );
  const comparison = evidence?.comparison.record;
  const release = evidence?.release.record;
  const configure = (
    <Link
      className="quiet-link"
      to={githubCoverageHref(workspaceId, repository.id, source?.id)}
    >
      Review GitHub connection
    </Link>
  );
  return (
    <section
      className="release-workspace"
      aria-label="Release and deployment evidence"
    >
      <div className="release-toolbar">
        <div>
          <h2>Releases and deployments</h2>
          <p>
            Published versions, deployment records, and changes from the release
            to the default branch.
          </p>
        </div>
        {source ? (
          <Button
            variant="outline"
            disabled={query.isFetching || waiting}
            onClick={() => void query.refetch()}
            title={
              waiting && result?.nextReadAt
                ? "Next provider read after " +
                  dates.dateTime(result.nextReadAt)
                : undefined
            }
          >
            <RefreshCw size={16} aria-hidden="true" />
            {query.isFetching ? "Reading evidence..." : "Refresh evidence"}
          </Button>
        ) : null}
      </div>
      {sources.length > 1 ? (
        <label className="release-selector">
          GitHub source
          <Select
            value={source?.id}
            onValueChange={(value) => {
              const next = new URLSearchParams(params);
              next.set("releaseSource", value);
              setParams(next, { preventScrollReset: true });
            }}
          >
            <SelectTrigger aria-label="GitHub release source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((item) => (
                <SelectItem value={item.id} key={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {!source ? (
        <Card>
          <CardContent className="release-empty">
            <h3>No GitHub source for this repository</h3>
            <p>
              Connect a read-only source to inspect its releases and deployment
              records.
            </p>
            {configure}
          </CardContent>
        </Card>
      ) : null}
      {query.isPending && source ? (
        <p role="status">Reading release evidence...</p>
      ) : null}
      {query.error ? (
        <div className="release-notice" role="alert">
          <p>
            {query.error instanceof RequestError
              ? query.error.message
              : "Release evidence could not be verified. Retry the read."}
          </p>
          {result?.evidence ? (
            <p>Any evidence below belongs to the previous read.</p>
          ) : null}
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry release read
          </Button>
        </div>
      ) : null}
      {result ? (
        <div className="release-provenance">
          <span>{result.source.name}</span>
          {evidence ? (
            <span>
              Observed <EvidenceTime value={evidence.observedAt} />
            </span>
          ) : (
            <span>No accepted evidence</span>
          )}
          {stale ? (
            <StatusBadge tone="warning">Evidence needs refresh</StatusBadge>
          ) : null}
          {result.nextReadAt ? (
            <span>
              Next provider read after{" "}
              <EvidenceTime value={result.nextReadAt} />
            </span>
          ) : null}
          {configure}
        </div>
      ) : null}
      {result && result.state !== "ready" ? (
        <div className="release-notice" role="status">
          <p>
            {result.state === "disabled"
              ? "This GitHub source is disabled. Enable it only if this repository should be collected."
              : result.state === "not_configured"
                ? "A workspace owner needs to review this source's read-only credential and settings."
                : result.state === "collecting"
                  ? "Another window is reading this repository. Its result will arrive through live updates."
                  : "The bounded read budget or provider cooldown is active. Retry after the time above."}
          </p>
        </div>
      ) : null}
      {evidence ? (
        <>
          <div className="release-summary-grid">
            <Card>
              <CardHeader>
                <CardTitle>
                  <Tag size={17} aria-hidden="true" />
                  Latest published release
                </CardTitle>
              </CardHeader>
              <CardContent>
                {evidence.release.state !== "observed" ? (
                  <ReadGap read={evidence.release} area="release" />
                ) : release ? (
                  <>
                    <strong className="release-value">{release.tag}</strong>
                    <p>
                      Published <EvidenceTime value={release.publishedAt} />
                    </p>
                    {release.sha ? (
                      <ProviderLink href={base + "/commit/" + release.sha}>
                        Commit {release.sha.slice(0, 7)}
                      </ProviderLink>
                    ) : (
                      <p>The release tag's commit was unavailable.</p>
                    )}
                    <p>
                      <ProviderLink href={links.release!}>
                        Open release
                      </ProviderLink>
                    </p>
                  </>
                ) : (
                  <>
                    <strong>No published stable release</strong>
                    <p>
                      GitHub did not return a latest release. Drafts and
                      prereleases are not included here.
                    </p>
                    <ProviderLink href={links.releases}>
                      Open GitHub releases
                    </ProviderLink>
                  </>
                )}
                <p className="release-footnote">
                  A published release does not identify the version serving
                  traffic.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>
                  <GitCompareArrows size={17} aria-hidden="true" />
                  Changes since release
                </CardTitle>
              </CardHeader>
              <CardContent>
                {comparison ? (
                  <>
                    <strong className="release-value">
                      {comparison.status === "identical"
                        ? "Matches the release"
                        : comparison.status === "ahead"
                          ? comparison.aheadBy + " commits ahead"
                          : comparison.status === "behind"
                            ? comparison.behindBy + " commits behind"
                            : "Histories diverged"}
                    </strong>
                    {comparison.status === "diverged" ? (
                      <p>
                        {comparison.aheadBy} ahead and {comparison.behindBy}{" "}
                        behind the release commit.
                      </p>
                    ) : null}
                    <p>
                      <code>{evidence.head?.branch}</code> at{" "}
                      <code>{comparison.headSha.slice(0, 7)}</code> compared
                      with <code>{comparison.baseSha.slice(0, 7)}</code>.
                    </p>
                    <ProviderLink href={links.comparison!}>
                      Review commit comparison
                    </ProviderLink>
                  </>
                ) : evidence.comparison.state !== "unobserved" ? (
                  <ReadGap read={evidence.comparison} area="comparison" />
                ) : (
                  <>
                    <strong>Comparison unavailable</strong>
                    <p>
                      {!release
                        ? "A readable published release is needed for this comparison."
                        : !release.sha
                          ? "The release tag's commit could not be resolved."
                          : "The default branch commit could not be read."}
                    </p>
                  </>
                )}
                <p className="release-footnote">
                  Commits ahead of a release may already be deployed. This
                  compares immutable commits, not live environments.
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <div className="release-deployment-heading">
                <CardTitle>GitHub deployment records</CardTitle>
                <ProviderLink href={links.deployments}>
                  Deployment history
                </ProviderLink>
              </div>
            </CardHeader>
            <CardContent>
              {evidence.deployments.state !== "observed" ? (
                <ReadGap read={evidence.deployments} area="deployment" />
              ) : evidence.deployments.records.length ? (
                <>
                  <p className="release-sample">
                    {evidence.deployments.hasMore
                      ? `Newest ${evidence.deployments.records.length} of ${evidence.deployments.total} records. Older deployments and failures are outside this sample.`
                      : `${evidence.deployments.total} deployment ${evidence.deployments.total === 1 ? "record" : "records"} returned.`}
                  </p>
                  <div className="release-deployments">
                    {evidence.deployments.records.map((record) => (
                      <article
                        key={record.id}
                        aria-label={"Deployment " + record.id}
                      >
                        <div>
                          <strong>
                            {record.environment ?? "Environment not named"}
                          </strong>
                          <span
                            className={
                              record.status === "ERROR" ||
                              record.status === "FAILURE"
                                ? "release-failed"
                                : ""
                            }
                          >
                            {record.status
                              ? DEPLOYMENT_STATUS_LABELS[record.status]
                              : "No status recorded"}
                          </span>
                        </div>
                        <ProviderLink href={base + "/commit/" + record.sha}>
                          Commit {record.sha.slice(0, 7)}
                        </ProviderLink>
                        <p>
                          Created <EvidenceTime value={record.createdAt} />
                          {record.statusAt ? (
                            <>
                              {" "}
                              / Status <EvidenceTime value={record.statusAt} />
                            </>
                          ) : null}
                        </p>
                        <span className="release-record-id">
                          Record {record.id}
                        </span>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="release-empty">
                  <strong>No GitHub deployment records</strong>
                  <p>
                    Deployments made outside GitHub's deployment integration are
                    not represented here.
                  </p>
                </div>
              )}
              <p className="release-footnote">
                These are GitHub's recorded states, not live health checks.
                Cloudflare and other runtime versions require an explicitly
                linked provider resource. GitHub may require sign-in to open
                deployment history.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </section>
  );
}

export function ProjectReleases({
  snapshot,
  projectId,
}: {
  snapshot: Snapshot;
  projectId: string;
}) {
  const [params, setParams] = useSearchParams();
  const repositories = snapshot.repositories
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const selected =
    repositories.find((item) => item.id === params.get("releaseRepository")) ??
    repositories[0];
  return (
    <div className="project-release-workspace">
      {repositories.length > 1 ? (
        <label className="release-selector">
          Repository
          <Select
            value={selected?.id}
            onValueChange={(value) => {
              const next = new URLSearchParams(params);
              next.set("releaseRepository", value);
              next.delete("releaseSource");
              setParams(next, { preventScrollReset: true });
            }}
          >
            <SelectTrigger aria-label="Project release repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((item) => (
                <SelectItem value={item.id} key={item.id}>
                  {item.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {selected ? (
        <>
          <p className="release-project-context">
            <Link
              className="quiet-link"
              to={
                repositoryHref(snapshot.workspace.id, selected.id, "releases") +
                "&fromProject=" +
                encodeURIComponent(projectId)
              }
            >
              {selected.fullName}
            </Link>
            <span>Evidence is loaded for this repository only.</span>
          </p>
          <RepositoryReleases
            key={selected.id}
            snapshot={snapshot}
            repository={selected}
          />
        </>
      ) : (
        <Card>
          <CardContent className="release-empty">
            <h2>No repositories linked</h2>
            <p>
              Link a repository to this project to inspect its releases and
              deployments.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
