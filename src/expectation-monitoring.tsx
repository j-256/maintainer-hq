import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import { COVERAGE_LIMITS } from "../shared/coverage-evidence";
import type { MonitorConnection, MonitorResult } from "../shared/monitoring";
import type { ResourceLinks } from "../shared/resource-links";
import { monitoringExpectationResolution } from "../shared/expectation-resolution";
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
import { MonitoringConfigurationEditor } from "./monitoring-editor";
import { MonitoringConnectionEditor } from "./monitoring-connection";
import { MonitoringReview } from "./monitoring-review";
import {
  MonitoringEvidenceClock,
  MonitorEvidence,
  MonitorCheckTimes,
  MonitorExecution,
} from "./monitoring-evidence";
import { MonitorError } from "./monitoring-components";
import {
  ResolutionDialog,
  useResolutionNavigation,
  useResolutionCoverage,
  useExpectationClock,
} from "./expectation-flow";
import "./hooks.css";
import "./monitoring.css";

const CREATE_TARGET = ":create";
const DEFAULTS_TARGET = ":defaults";
export function MonitoringResolution({
  repository,
  snapshot,
  onBack,
}: {
  repository: Repository;
  snapshot: Snapshot;
  onBack: () => void;
}) {
  const { params, navigate, focus } = useResolutionNavigation();
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const owner = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const connections = useQuery({
    queryKey: ["monitoring", workspaceId, "connections"],
    queryFn: ({ signal }) =>
      command<MonitorConnection[]>(
        "monitoring_connections",
        { workspaceId },
        signal,
      ),
    retry: false,
  });
  const connectionId =
    params.get("connection") ??
    connections.data?.find((item) => item.enabled && item.available)?.id;
  const selected = connections.data?.find((item) => item.id === connectionId);
  const active = Boolean(selected?.enabled && selected.available);
  const targetId = params.get("monitorTarget");
  const reviewId = params.get("monitorReview");
  const connectionEditor = params.get("setup") === "connection";
  const runtime = useQuery({
    queryKey: [
      "monitoring",
      workspaceId,
      "resolution-runtime",
      connectionId,
      selected?.revision,
    ],
    queryFn: ({ signal }) =>
      command<{ result: MonitorResult<"snapshot">; capabilities: string[] }>(
        "monitoring_snapshot",
        { workspaceId, connectionId },
        signal,
      ),
    enabled: active && !targetId && !reviewId,
    retry: false,
  });
  const inventory = useQuery({
    queryKey: [
      "monitoring",
      workspaceId,
      "resolution-targets",
      connectionId,
      selected?.revision,
      cursors.at(-1),
    ],
    queryFn: ({ signal }) =>
      command<{
        result: MonitorResult<"targets">;
        repositoryLinks: ResourceLinks[];
        capabilities: string[];
      }>(
        "monitoring_targets",
        { workspaceId, connectionId, cursor: cursors.at(-1) },
        signal,
      ),
    enabled: active && !targetId && !reviewId,
    retry: false,
  });
  const coverage = useResolutionCoverage(repository, snapshot);
  const state = monitoringExpectationResolution(
    coverage.data,
    useExpectationClock(),
  );
  const configure =
    canOperate && Boolean(runtime.data?.capabilities.includes("configure"));
  async function refresh(check = false) {
    if (!check) setCursors([null]);
    setBusy(true);
    setError(null);
    try {
      if (check)
        await command(
          "repository_coverage",
          { workspaceId, repositoryId: repository.id },
          AbortSignal.timeout(COVERAGE_LIMITS.ELAPSED_MS + 5000),
        );
      await client.invalidateQueries({
        predicate: (query) =>
          [
            "workspace",
            "monitoring",
            "repository-resources",
            "repository-coverage",
            "repository-coverage-cache",
          ].includes(String(query.queryKey[0])),
      });
      if (check)
        setNotice(
          "Saved checks refreshed. A new or changed target needs a matching scheduled check before monitoring is verified.",
        );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function link(resourceKey: string) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reference = {
        workspaceId,
        connectionId: selected.id,
        kind: "monitor",
        resourceKey,
      };
      const saved = await command<ResourceLinks>(
        "resource_repositories",
        reference,
      );
      if (!saved.repositoryIds.includes(repository.id))
        await command("resource_repositories_save", {
          ...reference,
          revision: saved.revision,
          connectionRevision: selected.revision,
          repositoryIds: [...saved.repositoryIds, repository.id],
        });
      await refresh(true);
      setNotice(
        resourceKey +
          " linked to " +
          repository.fullName +
          ". Check the scheduled evidence below.",
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  function editorClosed() {
    navigate({ monitorTarget: null, monitorReview: null });
    void refresh();
  }
  return (
    <MonitoringEvidenceClock>
      <ResolutionDialog
        kind="monitoring"
        repository={repository}
        onBack={onBack}
        open={!targetId && !reviewId && !(connectionEditor && owner)}
        busy={busy}
      >
        <StatusBadge tone={coverage.error ? "warning" : state.tone}>
          {coverage.error ? "Coverage unavailable" : state.label}
        </StatusBadge>
        <p>
          Link a monitor or create one here. Coverage needs a passing check of
          the saved target and a fresh scheduled run.
        </p>
        {connections.error ? <MonitorError error={connections.error} /> : null}
        {connections.isPending ? (
          <p role="status">Reading monitoring connections...</p>
        ) : null}
        {connections.data?.length ? (
          <div className="resolution-field">
            <label htmlFor="resolution-monitor-connection">
              Monitoring connection
            </label>
            <Select
              value={selected?.id ?? ""}
              disabled={busy}
              onValueChange={(id) => {
                setCursors([null]);
                navigate({ connection: id });
              }}
            >
              <SelectTrigger id="resolution-monitor-connection">
                <SelectValue placeholder="Choose a connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.data.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                    {!item.enabled || !item.available ? " (unavailable)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {!active && connections.data ? (
          <p>
            {selected
              ? "This connection is disabled or unavailable. A workspace owner can review its settings."
              : "Add a monitoring connection to choose or create a target."}
          </p>
        ) : null}
        {owner ? (
          <div className="resolution-actions">
            <Button
              variant="outline"
              onClick={() => navigate({ setup: "connection" })}
            >
              {selected
                ? "Edit monitoring connection"
                : "Add monitoring connection"}
            </Button>
            {selected ? (
              <Button
                variant="outline"
                onClick={() =>
                  navigate({ setup: "connection", connection: CREATE_TARGET })
                }
              >
                Add another connection
              </Button>
            ) : null}
          </div>
        ) : !active ? (
          <p>A workspace owner needs to configure monitoring access.</p>
        ) : null}
        {active ? (
          <>
            <div className="resolution-actions">
              <Button
                disabled={!configure || busy}
                onClick={() =>
                  navigate({
                    connection: selected!.id,
                    monitorTarget: CREATE_TARGET,
                  })
                }
              >
                Create monitor
              </Button>
              <Button
                variant="outline"
                disabled={!configure || busy}
                onClick={() =>
                  navigate({
                    connection: selected!.id,
                    monitorTarget: DEFAULTS_TARGET,
                  })
                }
              >
                Configure schedule
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void refresh(true)}
              >
                Check monitoring coverage
              </Button>
            </div>
            {runtime.isPending ? (
              <p role="status">Reading scheduler and permissions...</p>
            ) : null}
            {runtime.error ? <MonitorError error={runtime.error} /> : null}
            {runtime.data && !configure ? (
              <p>
                {canOperate
                  ? "The provider credential permits reading but cannot change monitoring configuration."
                  : "Your workspace role can inspect monitoring but cannot change provider configuration."}
              </p>
            ) : null}
            {runtime.data ? (
              <MonitorExecution data={runtime.data.result} />
            ) : null}
            {inventory.error ? (
              <>
                <MonitorError error={inventory.error} />
                <Button
                  variant="outline"
                  onClick={() => void inventory.refetch()}
                >
                  Retry target read
                </Button>
              </>
            ) : null}
            {inventory.isPending ? (
              <p role="status">Reading monitor targets...</p>
            ) : null}
            {inventory.data?.result.items.map((item) => {
              const links =
                inventory.data.repositoryLinks.find(
                  (link) => link.resourceKey === item.id,
                )?.repositoryIds ?? [];
              const linked = links.includes(repository.id);
              return (
                <article className="resolution-card" key={item.id}>
                  <h3>{item.id}</h3>
                  <p>{item.url}</p>
                  <MonitorEvidence evidence={item.evidence} />
                  <MonitorCheckTimes evidence={item.evidence} />
                  {links.length > Number(linked) ? (
                    <p>
                      Shared with {links.length - Number(linked)} other
                      repositories. Target changes affect them too.
                    </p>
                  ) : null}
                  <div className="resolution-actions">
                    <Button
                      disabled={!canEdit || busy || linked}
                      onClick={() => void link(item.id)}
                    >
                      {linked ? "Linked to repository" : "Link monitor"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!configure || busy}
                      onClick={() =>
                        navigate({
                          connection: selected!.id,
                          monitorTarget: item.id,
                        })
                      }
                    >
                      Edit monitor
                    </Button>
                  </div>
                </article>
              );
            })}
            {inventory.data && !inventory.data.result.items.length ? (
              <p>
                {inventory.data.result.nextCursor
                  ? "No targets on this page. Continue to the next page."
                  : "No monitors configured. Create one to begin."}
              </p>
            ) : null}
            <div className="resolution-actions">
              <Button
                variant="outline"
                disabled={cursors.length < 2 || inventory.isFetching}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Previous monitors
              </Button>
              <Button
                variant="outline"
                disabled={
                  !inventory.data?.result.nextCursor || inventory.isFetching
                }
                onClick={() =>
                  setCursors([...cursors, inventory.data!.result.nextCursor])
                }
              >
                Next monitors
              </Button>
            </div>
          </>
        ) : null}
        {error ? <MonitorError error={error} /> : null}
        {notice ? <p role="status">{notice}</p> : null}
      </ResolutionDialog>
      {connectionEditor && owner ? (
        <MonitoringConnectionEditor
          key={selected?.id ?? "new"}
          initial={selected}
          snapshot={snapshot}
          returnFocus={focus.current}
          onClose={() => navigate({ setup: null })}
          onSaved={(connection) => {
            navigate({ setup: null, connection: connection.id });
            void refresh();
          }}
        />
      ) : null}
      {targetId && selected ? (
        <MonitoringConfigurationEditor
          key={selected.id + targetId}
          snapshot={snapshot}
          connection={selected}
          targetId={
            targetId === CREATE_TARGET || targetId === DEFAULTS_TARGET
              ? undefined
              : targetId
          }
          defaults={targetId === DEFAULTS_TARGET}
          reviewId={reviewId}
          onReview={(id) => navigate({ monitorReview: id })}
          onReceipt={(id) =>
            navigate({ monitorTarget: null, monitorReview: id })
          }
          onClose={editorClosed}
          returnFocus={focus.current}
        />
      ) : null}
      {reviewId && (!targetId || !selected) ? (
        <MonitoringReview
          snapshot={snapshot}
          planId={reviewId}
          returnFocus={focus.current}
          onClose={() => {
            navigate({ monitorReview: null });
            setNotice(
              "After creating a target, choose Link monitor below. Provider acceptance is separate from fresh check evidence.",
            );
            void refresh();
          }}
        />
      ) : null}
      {targetId && !selected && !reviewId ? (
        <ResolutionDialog
          kind="monitoring"
          repository={repository}
          onBack={editorClosed}
        >
          {connections.isPending ? (
            <p role="status">Reading monitoring connections...</p>
          ) : connections.error ? (
            <>
              <MonitorError error={connections.error} />
              <Button
                variant="outline"
                onClick={() => void connections.refetch()}
              >
                Retry connection read
              </Button>
            </>
          ) : (
            <p>
              This monitoring connection is unavailable. Choose an available
              connection to configure a target.
            </p>
          )}
        </ResolutionDialog>
      ) : null}
    </MonitoringEvidenceClock>
  );
}
