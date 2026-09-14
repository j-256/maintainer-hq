import { lazy, Suspense } from "react";
import type { Expectations, Repository, Snapshot } from "../shared/domain";
import {
  EXPECTATION_RESOLUTIONS,
  EXPECTATION_RESOLUTION_LABELS,
  EXPECTATION_RESOLUTION_PARAMS,
  type ExpectationResolutionKind,
} from "../shared/expectation-resolution";
import type { ExpectationReviewReceipt } from "../shared/expectation-review";
import {
  ExpectationAction,
  ResolutionDialog,
  useResolutionNavigation,
} from "./expectation-flow";
const Hooks = lazy(() =>
  import("./hook-resolution").then((module) => ({
    default: module.HookResolution,
  })),
);
const Monitoring = lazy(() =>
  import("./expectation-monitoring").then((module) => ({
    default: module.MonitoringResolution,
  })),
);
const GitHub = lazy(() =>
  import("./expectation-github").then((module) => ({
    default: module.GitHubExpectationResolution,
  })),
);
const Review = lazy(() =>
  import("./expectation-review").then((module) => ({
    default: module.RepositoryReviewResolution,
  })),
);
export function ExpectationResolution({
  kind,
  repository,
  snapshot,
  onBack,
  onCompleted,
  expectations,
}: {
  kind: ExpectationResolutionKind | "all";
  repository: Repository;
  snapshot: Snapshot;
  onBack: () => void;
  onCompleted?: (receipt: ExpectationReviewReceipt) => void;
  expectations?: Expectations;
}) {
  const { navigate } = useResolutionNavigation();
  const display = {
    ...repository,
    expectations: expectations ?? repository.expectations,
  };
  const fallback = (
    <ResolutionDialog kind={kind} repository={repository} onBack={onBack}>
      <p role="status">Loading expectation actions...</p>
    </ResolutionDialog>
  );
  if (kind === "all")
    return (
      <ResolutionDialog kind="all" repository={repository} onBack={onBack}>
        {EXPECTATION_RESOLUTIONS.map((item) => (
          <section className="resolution-card" key={item}>
            <h3>{EXPECTATION_RESOLUTION_LABELS[item]}</h3>
            <ExpectationAction
              kind={item}
              repository={display}
              snapshot={snapshot}
              onOpen={() => {
                navigate({
                  ...Object.fromEntries(
                    EXPECTATION_RESOLUTION_PARAMS.map((key) => [key, null]),
                  ),
                  resolve: item,
                  resolveRepository: repository.id,
                });
              }}
            />
          </section>
        ))}
      </ResolutionDialog>
    );
  return (
    <Suspense fallback={fallback}>
      {kind === "hooks" ? (
        <Hooks repository={repository} snapshot={snapshot} onBack={onBack} />
      ) : kind === "monitoring" ? (
        <Monitoring
          repository={repository}
          snapshot={snapshot}
          onBack={onBack}
        />
      ) : kind === "review" ? (
        <Review
          repository={repository}
          snapshot={snapshot}
          onBack={onBack}
          onCompleted={onCompleted}
        />
      ) : (
        <GitHub
          kind={kind}
          repository={display}
          snapshot={snapshot}
          onBack={onBack}
        />
      )}
    </Suspense>
  );
}
