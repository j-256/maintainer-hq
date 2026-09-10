import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { z } from "zod";
import {
  DEPENDENCY_OPERATION_REASONS,
  dependencyOperationSchema,
  type DependencyOperation,
} from "../shared/dependency-operations";
import { githubRepositoryUrl } from "../shared/github-context";
import { command } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { useDateTime } from "./date-time";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";

const PHASES: Record<DependencyOperation["phase"], string> = {
  checking: "Preflight checks",
  tree: "Git tree",
  commit: "Commit",
  branch: "New branch",
  pull_request: "Pull request",
  finished: "Finished",
};
export function dependencyOutcome(
  operation: DependencyOperation,
  now = Date.now(),
) {
  return operation.status === "succeeded"
    ? operation.pullRequest?.merged
      ? "PR merged"
      : operation.pullRequest?.state === "closed"
        ? "PR closed"
        : "PR created"
    : operation.status === "running"
      ? Date.parse(operation.executionExpiresAt) > now
        ? "Submitting"
        : "Outcome uncertain"
      : operation.status === "failed"
        ? "Not submitted"
        : operation.status === "partial"
          ? "Partially completed"
          : "Outcome uncertain";
}
export function DependencyOperationView({
  operation,
  repository,
  now,
  busy,
  onReconcile,
}: {
  operation: DependencyOperation;
  repository: string;
  now: number;
  busy: boolean;
  onReconcile?: () => void;
}) {
  const dates = useDateTime();
  const active =
    operation.status === "running" &&
    Date.parse(operation.executionExpiresAt) > now;
  const cooldown = Boolean(
    operation.nextReconcileAt && Date.parse(operation.nextReconcileAt) > now,
  );
  const root = githubRepositoryUrl(repository);
  return (
    <section
      className="dependency-notice"
      aria-label="Dependency operation outcome"
    >
      <h3>{dependencyOutcome(operation, now)}</h3>
      <p role="status">
        {operation.reason === "complete" && operation.pullRequest?.merged
          ? "Merge verified. CI and deployment remain separate checks."
          : DEPENDENCY_OPERATION_REASONS[
              operation.status === "running" && !active
                ? "interrupted"
                : operation.reason
            ]}
      </p>
      <dl className="dependency-facts">
        <div>
          <dt>Last recorded step</dt>
          <dd>{PHASES[operation.phase]}</dd>
        </div>
        <div>
          <dt>Receipt updated</dt>
          <dd>{dates.dateTime(operation.updatedAt)}</dd>
        </div>
        <div>
          <dt>Operation reference</dt>
          <dd>
            <code>{operation.id}</code>
          </dd>
        </div>
        <div>
          <dt>Proposed branch</dt>
          <dd>
            <code>{operation.branch}</code>
          </dd>
        </div>
      </dl>
      {operation.files.length ? (
        <details>
          <summary>Reviewed file digests</summary>
          <ul>
            {operation.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <p className="dependency-meta">
                  Before {file.beforeDigest}
                  <br />
                  After {file.afterDigest}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="dependency-change-actions">
        {operation.pullRequest ? (
          <a
            className="quiet-link"
            href={root + "/pull/" + operation.pullRequest.number}
            target="_blank"
            rel="noreferrer"
          >
            Pull request #{operation.pullRequest.number}
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        ) : null}
        {operation.commitSha ? (
          <a
            className="quiet-link"
            href={root + "/commit/" + operation.commitSha}
            target="_blank"
            rel="noreferrer"
          >
            Inspect commit
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        ) : null}
        {operation.commitSha ? (
          <a
            className="quiet-link"
            href={root + "/tree/" + encodeURIComponent(operation.branch)}
            target="_blank"
            rel="noreferrer"
          >
            Check branch
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        ) : null}
        {onReconcile ? (
          <Button
            variant="outline"
            disabled={busy || active || cooldown}
            onClick={onReconcile}
          >
            {busy ? "Checking..." : "Check GitHub outcome"}
          </Button>
        ) : (
          <p className="dependency-meta">
            Only the original submitting identity can check GitHub through the
            captured credential. Retained receipts remain visible to workspace
            operators.
          </p>
        )}
      </div>
      {active ? (
        <p>
          Submission is running. Live notifications update its saved receipt.
        </p>
      ) : null}
      {cooldown ? (
        <p className="dependency-meta">
          Next provider check after {dates.dateTime(operation.nextReconcileAt!)}
          .
        </p>
      ) : null}
      <p className="dependency-meta">
        Checking the outcome sends bounded reads only. It never resubmits a
        write. A failed or partial attempt may leave Git objects or a branch;
        review them on GitHub before starting a new change.
      </p>
    </section>
  );
}
const historySchema = z
  .object({
    items: z.array(dependencyOperationSchema).max(20),
    nextBefore: z.string().nullable(),
  })
  .strict();
export function DependencyHistory({
  workspaceId,
  repositoryId,
}: {
  workspaceId: string;
  repositoryId: string;
}) {
  const dates = useDateTime();
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: ["dependency-history", workspaceId, repositoryId, before ?? null],
    queryFn: async ({ signal }) =>
      historySchema.parse(
        await command(
          "dependency_operations_list",
          { workspaceId, repositoryId, ...(before ? { before } : {}) },
          signal,
        ),
      ),
    enabled: open,
    retry: false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  return (
    <details
      className="dependency-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Dependency change history</summary>
      {query.isPending && open ? (
        <p role="status">Loading saved changes...</p>
      ) : null}
      {query.error ? (
        <p role="alert">Dependency history is unavailable. Reload this view.</p>
      ) : query.data ? (
        <>
          {!query.data.items.length ? (
            <p>No dependency changes have been submitted from HQ.</p>
          ) : (
            <ul className="dependency-history-list">
              {query.data.items.map((operation) => (
                <li key={operation.id}>
                  <Link
                    to={
                      "/repositories/" +
                      repositoryId +
                      "?" +
                      new URLSearchParams({
                        workspace: workspaceId,
                        section: "dependencies",
                        dependencyReview: operation.planId,
                      })
                    }
                  >
                    View saved change
                  </Link>
                  <Badge variant="outline">
                    {dependencyOutcome(operation)}
                  </Badge>
                  <span>{dates.dateTime(operation.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="dependency-pagination">
            <Button
              variant="outline"
              disabled={cursors.length <= 1 || query.isFetching}
              onClick={() => setCursors((items) => items.slice(0, -1))}
            >
              Previous changes
            </Button>
            <span>Page {cursors.length}</span>
            <Button
              variant="outline"
              disabled={!query.data.nextBefore || query.isFetching}
              onClick={() =>
                setCursors((items) => [...items, query.data!.nextBefore!])
              }
            >
              Older changes
            </Button>
          </div>
        </>
      ) : null}
    </details>
  );
}
