import { useRef, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  HQ_GATE_LABELS,
  repositoryAccessSchema,
} from "../shared/repository-access";
import { expectationHref } from "../shared/expectation-resolution";
import { githubRepositoryUrl } from "../shared/github-context";
import { githubCoverageHref } from "../shared/github-coverage";
import { type Repository, type Snapshot } from "../shared/domain";
import { DOCUMENTATION_ORIGIN } from "../shared/documentation";
import { CLASSIFICATION_LABELS } from "../shared/presentation";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { useDateTime } from "./date-time";
import { repositoryHref } from "./resource-repositories";
import { withInventoryContext } from "./repository-inventory";
import "./repository-access.css";

export function RepositoryAccessDialog({
  snapshot,
  repository,
  onClose,
  returnFocus,
}: {
  snapshot: Snapshot;
  repository: Repository;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const dates = useDateTime();
  const heading = useRef<HTMLHeadingElement>(null);
  const [params] = useSearchParams();
  const workspaceId = snapshot.workspace.id;
  const sources = snapshot.connections.filter(
    (source) =>
      source.provider === "github" &&
      source.repositoryIds.includes(repository.id),
  );
  const query = useQuery({
    queryKey: [
      "repository-access",
      workspaceId,
      repository.id,
      repository.revision,
      snapshot.workspace.role,
      snapshot.capabilities,
      sources.map((source) => [
        source.id,
        source.revision,
        source.enabled,
        source.credentialConfigured,
      ]),
    ],
    queryFn: async ({ signal }) =>
      repositoryAccessSchema.parse(
        await command(
          "repository_access",
          { workspaceId, repositoryId: repository.id },
          signal,
        ),
      ),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const access = query.isError ? undefined : query.data;
  const upstream = access?.github.sources.length
    ? githubRepositoryUrl(access.repository.fullName)
    : null;
  const sectionHref = (section: "hooks" | "monitoring" | "secrets") =>
    withInventoryContext(
      repositoryHref(workspaceId, repository.id, section),
      params,
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="repository-access-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={heading} tabIndex={-1}>
            Access &amp; operations
          </DialogTitle>
          <DialogDescription>{repository.fullName}</DialogDescription>
        </DialogHeader>
        <div className="repository-access-body">
          {query.isError ? (
            <p role="alert">
              Access guidance is unavailable. Previous guidance is hidden. Check
              your workspace sign-in and retry.
            </p>
          ) : !access ? (
            <p role="status">Checking workspace access...</p>
          ) : (
            <>
              <section aria-label="HQ permission gates">
                <h3>
                  Your HQ role:{" "}
                  <span className="repository-access-role">
                    {access.hq.role}
                  </span>
                </h3>
                <p>
                  {access.hq.client === "credential"
                    ? "This client credential is also limited by its granted scopes."
                    : "Workspace permissions are separate from your GitHub account."}
                </p>
                <dl className="repository-access-gates">
                  {access.hq.gates.map((gate) => (
                    <div key={gate.id}>
                      <dt>{gate.label}</dt>
                      <dd>
                        <Badge variant="outline">
                          {HQ_GATE_LABELS[gate.state]}
                        </Badge>
                        {gate.state === "role_required" ? (
                          <span>Requires {gate.requiredRole}.</span>
                        ) : gate.state === "scope_required" ? (
                          <span>
                            Requires client scope <code>{gate.capability}</code>
                            .
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Provider operations still require an enabled, scoped
                  connection, provider permission and a reviewed action.
                </p>
              </section>
              <section aria-label="GitHub credential access">
                <h3>GitHub sources</h3>
                <p>
                  {CLASSIFICATION_LABELS[access.repository.classification]} is a
                  tracking choice. It neither grants nor proves GitHub
                  administration access.
                </p>
                {access.github.sources.length ? (
                  <ul className="repository-access-sources">
                    {access.github.sources.map((source) => (
                      <li key={source.id}>
                        <Link
                          onClick={onClose}
                          to={githubCoverageHref(
                            workspaceId,
                            repository.id,
                            source.id,
                          )}
                        >
                          {source.name}
                        </Link>
                        <div className="repository-access-badges">
                          <Badge variant="outline">
                            {source.credential === "configured"
                              ? "Credential configured"
                              : "Credential unavailable"}
                          </Badge>
                          {!source.enabled ? (
                            <Badge variant="outline">Collection disabled</Badge>
                          ) : null}
                          {!source.configurationValid ? (
                            <Badge variant="outline">
                              Configuration needs review
                            </Badge>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No GitHub source is enrolled for this repository. Open{" "}
                    <Link
                      onClick={onClose}
                      to={githubCoverageHref(workspaceId, repository.id)}
                    >
                      GitHub coverage
                    </Link>{" "}
                    to review setup.
                  </p>
                )}
                <p>
                  Configured is not a verified provider grant. Open a source for
                  check-by-check coverage. Unavailable evidence can mean missing
                  access or a missing feature; the cause needs review.
                </p>
              </section>
              <section aria-label="Provider ownership and support">
                <h3>GitHub webhooks and Hookrelay are separate</h3>
                <p>
                  GitHub owns repository webhooks. Reviewed installation is
                  available through Hookrelay setup. Administration permission
                  has not been verified here, even when observation succeeds.
                </p>
                {upstream ? (
                  <p>
                    <a
                      href={upstream + "/settings/hooks"}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open GitHub webhook settings
                    </a>
                    . GitHub checks your separate sign-in and repository
                    permissions.
                  </p>
                ) : null}
                <p>
                  <Link onClick={onClose} to={sectionHref("hooks")}>
                    Repository Hooks
                  </Link>{" "}
                  shows linked Hookrelay subscriptions and delivery retries.
                </p>
                <p>
                  <Link
                    onClick={onClose}
                    to={expectationHref(
                      snapshot.workspace.id,
                      repository.id,
                      "hooks",
                    )}
                  >
                    Set up hook coverage
                  </Link>{" "}
                  checks the connection and provider prerequisites before
                  preparing a review.
                </p>
                <p>
                  <Link onClick={onClose} to={sectionHref("monitoring")}>
                    Monitoring
                  </Link>{" "}
                  and{" "}
                  <Link onClick={onClose} to={sectionHref("secrets")}>
                    Secrets
                  </Link>{" "}
                  have their own connections, resource scopes and operation
                  reviews. A repository link supplies context, not ownership or
                  a permission grant.
                </p>
                <a
                  href={
                    DOCUMENTATION_ORIGIN +
                    "/access/#repository-and-provider-permissions"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Understand provider permissions
                </a>
              </section>
            </>
          )}
        </div>
        <DialogFooter>
          {access ? (
            <p className="repository-access-time">
              Checked{" "}
              <time
                dateTime={access.generatedAt}
                title={dates.tooltip(access.generatedAt)}
              >
                {dates.dateTime(access.generatedAt, true)}
              </time>
            </p>
          ) : null}
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Checking..." : "Check access again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
