import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { Repository, Snapshot } from "../shared/domain";
import { COVERAGE_LIMITS } from "../shared/coverage-evidence";
import type { RepositoryCoverage } from "../shared/repository-coverage";
import {
  EXPECTATION_RESOLUTION_LABELS,
  githubExpectationResolution,
  hookExpectationResolution,
  monitoringExpectationResolution,
  reviewExpectationResolution,
  type ExpectationResolutionKind,
} from "../shared/expectation-resolution";
import {
  coverageObservationVersion,
  invalidateSupersededCoverage,
} from "./lib/coverage-convergence";
import { restoreVisibleFocus } from "./lib/focus";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { StatusBadge } from "./components/ui/status";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import "./hook-resolution.css";
import "./expectation-resolution.css";

const CLOCK_MS = 10_000;
export function useExpectationClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function update() {
      clearInterval(timer);
      if (!document.hidden) {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
      }
    }
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return now;
}
export function useResolutionCoverage(
  repository: Repository,
  snapshot: Snapshot,
  enabled = true,
) {
  const query = useQuery({
    queryKey: [
      "repository-coverage-cache",
      snapshot.workspace.id,
      repository.id,
      repository.revision,
      snapshot.connections
        .filter(
          (item) =>
            item.provider === "hookrelay" ||
            item.provider === "endpoint-monitor",
        )
        .map((item) => [item.id, item.revision, item.enabled]),
      coverageObservationVersion(repository.id, snapshot.observations),
    ],
    queryFn: ({ signal }) =>
      command<RepositoryCoverage>(
        "repository_coverage_get",
        { workspaceId: snapshot.workspace.id, repositoryId: repository.id },
        signal,
      ),
    staleTime: COVERAGE_LIMITS.REFRESH_MS,
    enabled,
  });
  return {
    ...query,
    data: invalidateSupersededCoverage(query.data, snapshot.observations),
  };
}
export function ExpectationAction({
  kind,
  repository,
  snapshot,
  onOpen,
}: {
  kind: ExpectationResolutionKind;
  repository: Repository;
  snapshot: Snapshot;
  onOpen: () => void;
}) {
  const coverage = useResolutionCoverage(
    repository,
    snapshot,
    kind === "hooks" || kind === "monitoring",
  );
  const now = useExpectationClock();
  const state =
    kind === "hooks"
      ? hookExpectationResolution(coverage.data, now)
      : kind === "monitoring"
        ? monitoringExpectationResolution(coverage.data, now)
        : kind === "review"
          ? reviewExpectationResolution(repository, now)
          : githubExpectationResolution(repository, snapshot, kind, now);
  return (
    <div className="expectation-resolution-action">
      <StatusBadge
        tone={
          coverage.error && (kind === "hooks" || kind === "monitoring")
            ? "warning"
            : state.tone
        }
      >
        {coverage.error && (kind === "hooks" || kind === "monitoring")
          ? "Coverage unavailable"
          : state.label}
      </StatusBadge>
      <Button
        type="button"
        variant="outline"
        onClick={onOpen}
        aria-label={
          kind === "hooks"
            ? undefined
            : state.action + " for " + EXPECTATION_RESOLUTION_LABELS[kind]
        }
      >
        {state.action}
      </Button>
    </div>
  );
}
export function useResolutionNavigation() {
  const [params, setParams] = useSearchParams();
  const focus = useRef<HTMLElement | null>(null);
  function navigate(fields: Record<string, string | null>) {
    focus.current = document.activeElement as HTMLElement | null;
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  }
  return { params, navigate, focus };
}
export function ResolutionDialog({
  kind,
  repository,
  children,
  onBack,
  open = true,
  busy = false,
}: {
  kind: ExpectationResolutionKind | "all";
  repository: Repository;
  children: ReactNode;
  onBack: () => void;
  open?: boolean;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onBack();
      }}
    >
      <DialogContent
        className="hook-resolution expectation-resolution"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreVisibleFocus(
            document.querySelector<HTMLElement>('[role="dialog"] h2'),
          );
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {kind === "all"
              ? "Resolve expectations"
              : EXPECTATION_RESOLUTION_LABELS[kind]}
          </DialogTitle>
          <DialogDescription>{repository.fullName}</DialogDescription>
        </DialogHeader>
        <div className="hook-resolution-scroll">{children}</div>
        <div className="hook-resolution-actions">
          <Button variant="outline" disabled={busy} onClick={onBack}>
            Back to expectations
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
