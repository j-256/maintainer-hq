import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import {
  isGitHubSource,
  COVERAGE_LABELS,
  COVERAGE_GUIDANCE,
  type GitHubCoverage,
} from "../shared/github-coverage";
import { githubRepositoryUrl } from "../shared/github-context";
import { GITHUB_REFRESH_LIMITS, type GitHubRefresh } from "../shared/github";
import {
  GITHUB_EXPECTATION_CHECKS,
  githubExpectationResolution,
} from "../shared/expectation-resolution";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { StatusBadge } from "./components/ui/status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { GitHubEditor } from "./github-editor";
import { GitHubRefreshDialog } from "./github-sources";
import { GitHubEvidenceList } from "./github-evidence";
import { HookError, HookTime } from "./hook-components";
import { SOURCE_REQUEST_TIMEOUT_MS } from "./source-editor";
import {
  ResolutionDialog,
  useExpectationClock,
  useResolutionNavigation,
} from "./expectation-flow";
import "./github.css";

const NEW_SOURCE = ":new";
export function GitHubExpectationResolution({
  kind,
  repository,
  snapshot,
  onBack,
}: {
  kind: "ci" | "security" | "visibility";
  repository: Repository;
  snapshot: Snapshot;
  onBack: () => void;
}) {
  const { params, navigate, focus } = useResolutionNavigation();
  const workspaceId = snapshot.workspace.id;
  const sources = snapshot.connections.filter(isGitHubSource);
  const sourceId =
    params.get("githubSource") ??
    sources.find((source) => source.repositoryIds.includes(repository.id))?.id;
  const source = sources.find((source) => source.id === sourceId);
  const linked = Boolean(source?.repositoryIds.includes(repository.id));
  const editing = params.get("githubEdit") === "true";
  const refreshId = params.get("githubRefresh");
  const owner = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const operator = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<{
    sourceId: string;
    revision: number;
    id: string;
  } | null>(null);
  const now = useExpectationClock();
  const coverage = useQuery({
    queryKey: [
      "github-coverage",
      workspaceId,
      "expectation",
      repository.id,
      repository.revision,
    ],
    queryFn: ({ signal }) =>
      command<GitHubCoverage>(
        "github_coverage",
        { workspaceId, repositoryIds: [repository.id], sourceId: null },
        signal,
      ),
    retry: false,
  });
  const sourceCoverage = coverage.data?.repositories[0]?.sources.find(
    (item) => item.id === sourceId,
  );
  const observation = linked
    ? snapshot.observations
        .filter(
          (item) =>
            item.provider === "github" &&
            item.resourceType === "repository" &&
            item.resourceId === repository.id &&
            item.sourceId === sourceId &&
            item.name.toLowerCase() === repository.fullName.toLowerCase(),
        )
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
    : undefined;
  const fresh = Boolean(
    observation &&
    source?.enabled &&
    source.credentialConfigured &&
    source.github.configurationValid &&
    Date.parse(observation.observedAt) <= now &&
    Date.parse(observation.expiresAt) > now,
  );
  const state = githubExpectationResolution(repository, snapshot, kind, now);
  const upstream = linked ? githubRepositoryUrl(repository.fullName) : null;
  const queued = Boolean(
    source?.github.activeRefreshId || sourceCoverage?.activeRefreshId,
  );
  const cooldown = Boolean(
    (sourceCoverage?.retryAt && Date.parse(sourceCoverage.retryAt) > now) ||
    (source?.github.retryAt && Date.parse(source.github.retryAt) > now),
  );
  const tooSoon = Boolean(
    source?.lastAttemptAt &&
    now - Date.parse(source.lastAttemptAt) <
      GITHUB_REFRESH_LIMITS.MANUAL_INTERVAL_MS,
  );
  async function refresh() {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    if (
      attempt.current?.sourceId !== source.id ||
      attempt.current.revision !== source.revision
    )
      attempt.current = {
        sourceId: source.id,
        revision: source.revision,
        id: crypto.randomUUID(),
      };
    try {
      const result = await command<GitHubRefresh>(
        "github_refresh",
        {
          workspaceId,
          sourceId: source.id,
          revision: source.revision,
          refreshId: attempt.current.id,
        },
        AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
      );
      navigate({ githubSource: source.id, githubRefresh: result.id });
      attempt.current = null;
      void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      void coverage.refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const openExternal = (path: string, label: string) =>
    upstream ? (
      <Button variant="outline" asChild>
        <a href={upstream + path} target="_blank" rel="noreferrer">
          {label}
        </a>
      </Button>
    ) : null;
  return (
    <>
      <ResolutionDialog
        kind={kind}
        repository={repository}
        onBack={onBack}
        open={!(editing && owner) && !(refreshId && source)}
        busy={busy}
      >
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
        <p>
          {kind === "ci"
            ? "Require a passing result for the default branch. Connect GitHub evidence, inspect the failing checks, or open workflow setup."
            : kind === "security"
              ? "Inspect each security category and its findings. Unavailable or incomplete reads leave coverage unverified."
              : "Compare the expected visibility with GitHub's observed visibility, then review any mismatch."}
        </p>
        <p>
          Expected:{" "}
          <strong>
            {kind === "visibility"
              ? repository.expectations.visibility === "any"
                ? "Any visibility"
                : repository.expectations.visibility
              : repository.expectations[kind] === "required"
                ? "Required"
                : repository.expectations[kind] === "optional"
                  ? "Optional"
                  : "Not managed here"}
          </strong>
        </p>
        <div className="resolution-field">
          <label htmlFor="expectation-github-source">GitHub connection</label>
          <Select
            value={source?.id ?? NEW_SOURCE}
            disabled={busy}
            onValueChange={(id) =>
              navigate({ githubSource: id, githubRefresh: null })
            }
          >
            <SelectTrigger id="expectation-github-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_SOURCE}>
                Choose or add a connection
              </SelectItem>
              {sources.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                  {item.repositoryIds.includes(repository.id)
                    ? ""
                    : " (repository not included)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!linked ? (
          <p>
            {source
              ? "This connection does not collect this repository. Add it through the connection form; the other selected repositories remain included."
              : "Choose a connection or add one for this repository."}
          </p>
        ) : null}
        {owner ? (
          <div className="resolution-actions">
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  githubEdit: "true",
                  githubSource: source?.id ?? NEW_SOURCE,
                })
              }
            >
              {source
                ? linked
                  ? "Edit GitHub connection"
                  : "Add repository to connection"
                : "Connect GitHub"}
            </Button>
            {source ? (
              <Button
                variant="outline"
                onClick={() =>
                  navigate({ githubEdit: "true", githubSource: NEW_SOURCE })
                }
              >
                Add another GitHub connection
              </Button>
            ) : null}
          </div>
        ) : (
          <p>
            A workspace owner can configure GitHub collection. Operators can
            refresh configured evidence.
          </p>
        )}
        {coverage.error ? (
          <>
            <HookError error={coverage.error} />
            <Button variant="outline" onClick={() => void coverage.refetch()}>
              Retry saved evidence read
            </Button>
          </>
        ) : null}
        {sourceCoverage ? (
          <section className="resolution-card">
            <h3>{COVERAGE_LABELS[sourceCoverage.state]}</h3>
            <p>{COVERAGE_GUIDANCE[sourceCoverage.state]}</p>
            {sourceCoverage.evidence ? (
              <p>
                Observed <HookTime value={sourceCoverage.evidence.observedAt} />
                . Expires <HookTime value={sourceCoverage.evidence.expiresAt} />
                .
              </p>
            ) : null}
          </section>
        ) : null}
        {linked && source ? (
          <div className="resolution-actions">
            <Button
              disabled={
                !operator ||
                busy ||
                !source.enabled ||
                !source.credentialConfigured ||
                !source.github.configurationValid ||
                queued ||
                cooldown ||
                tooSoon
              }
              onClick={() => void refresh()}
            >
              {busy ? "Queuing collection..." : "Refresh GitHub evidence"}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  githubSource: source.id,
                  githubRefresh:
                    source.github.activeRefreshId ??
                    sourceCoverage?.latestRefresh?.refreshId ??
                    source.github.lastRefreshId ??
                    "history",
                })
              }
            >
              Inspect refresh history
            </Button>
          </div>
        ) : null}
        {queued ? (
          <p role="status">
            Collection is active. Inspect its receipt for progress.
          </p>
        ) : cooldown || tooSoon ? (
          <p>
            GitHub collection is waiting for its next allowed refresh. Inspect
            the saved evidence or refresh history in the meantime.
          </p>
        ) : null}
        {observation ? (
          <section className="resolution-card">
            <h3>{fresh ? "Observed result" : "Historical result"}</h3>
            {!fresh ? (
              <p>
                This result cannot establish the expectation until fresh,
                matching evidence is collected.
              </p>
            ) : null}
            <p>
              {kind === "ci"
                ? "CI: " + (observation.details.ci ?? "unknown")
                : kind === "security"
                  ? "Open findings: " +
                    (observation.details.openFindings ?? "unknown")
                  : "Observed visibility: " +
                    (observation.details.visibility ?? "unknown")}
            </p>
            {observation.details.github ? (
              <GitHubEvidenceList
                evidence={{
                  ...observation.details.github,
                  checks: observation.details.github.checks.filter((check) =>
                    GITHUB_EXPECTATION_CHECKS[kind].includes(check.key),
                  ),
                }}
              />
            ) : (
              <p>No detailed category evidence has been accepted.</p>
            )}
          </section>
        ) : null}
        {upstream ? (
          <section className="resolution-card">
            <h3>
              {kind === "ci"
                ? "Resolve CI on GitHub"
                : kind === "security"
                  ? "Resolve security on GitHub"
                  : "Review visibility on GitHub"}
            </h3>
            <div className="resolution-actions">
              {kind === "ci" ? (
                <>
                  {observation?.details.github?.headSha
                    ? openExternal(
                        "/commit/" +
                          observation.details.github.headSha +
                          "/checks",
                        "Open default-branch checks",
                      )
                    : null}
                  {openExternal("/actions", "Inspect workflows and runs")}
                  {openExternal("/actions/new", "Set up a workflow")}
                </>
              ) : kind === "security" ? (
                <>
                  {openExternal(
                    "/security/dependabot",
                    "Open dependency findings",
                  )}
                  {openExternal(
                    "/security/code-scanning",
                    "Open code scanning findings",
                  )}
                  {openExternal(
                    "/security/secret-scanning",
                    "Open secret findings",
                  )}
                  {openExternal(
                    "/settings/security_analysis",
                    "Configure security checks",
                  )}
                </>
              ) : (
                openExternal(
                  "/settings#danger-zone",
                  "Review repository visibility",
                )
              )}
            </div>
            <p>
              {kind === "ci"
                ? "A missing check result does not prove that no workflow exists. Inspect the workflows before adding one."
                : kind === "security"
                  ? "GitHub checks your access for each action. A denied read does not establish whether permissions or a security feature are missing."
                  : "Changing visibility affects repository access. Review the consequences and confirm the change on GitHub."}{" "}
              These links open another tab so your expectation draft stays here.
              Refresh evidence after completing the change.
            </p>
          </section>
        ) : null}
        {error ? <HookError error={error} /> : null}
      </ResolutionDialog>
      {editing && owner ? (
        <GitHubEditor
          key={source?.id ?? NEW_SOURCE}
          initial={source}
          includeRepositoryId={repository.id}
          snapshot={snapshot}
          returnFocus={focus.current}
          onClose={() => navigate({ githubEdit: null })}
          onSaved={(saved) => {
            navigate({ githubEdit: null, githubSource: saved.id });
            void coverage.refetch();
          }}
        />
      ) : null}
      {refreshId && source ? (
        <GitHubRefreshDialog
          key={source.id}
          source={source}
          snapshot={snapshot}
          initialId={refreshId === "history" ? undefined : refreshId}
          onSelect={(id) =>
            navigate({ githubSource: source.id, githubRefresh: id })
          }
          returnFocus={focus.current}
          onClose={() => {
            navigate({ githubRefresh: null });
            void coverage.refetch();
          }}
        />
      ) : null}
      {refreshId && !source ? (
        <p role="status">
          Choose the original GitHub connection to inspect this refresh.
        </p>
      ) : null}
    </>
  );
}
