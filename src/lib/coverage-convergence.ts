import type { Observation } from "../../shared/domain";
import type { RepositoryCoverage } from "../../shared/repository-coverage";

export function coverageObservationVersion(
  repositoryId: string,
  observations: readonly Observation[],
) {
  return observations
    .filter(
      (item) =>
        item.resourceType === "repository" &&
        item.resourceId === repositoryId &&
        item.details.coverage,
    )
    .map((item) => [
      item.sourceId,
      item.observedAt,
      item.receivedAt,
      item.expiresAt,
    ])
    .sort((first, second) => first[0]!.localeCompare(second[0]!));
}

export function latestCoverage(
  check: RepositoryCoverage | undefined,
  retained: RepositoryCoverage | undefined,
) {
  if (!check) return retained;
  if (!retained || retained.repositoryId !== check.repositoryId) return check;
  return Date.parse(retained.generatedAt) >= Date.parse(check.generatedAt)
    ? retained
    : check;
}

export function invalidateSupersededCoverage(
  result: RepositoryCoverage | undefined,
  observations: readonly Observation[],
) {
  if (!result) return result;
  const accepted = new Map(
    observations
      .filter(
        (item) =>
          item.resourceType === "repository" &&
          item.resourceId === result.repositoryId &&
          item.details.coverage,
      )
      .map((item) => [item.sourceId, item]),
  );
  return {
    ...result,
    evidence: result.evidence.map((group) => {
      const saved = group.observation;
      const pushed = accepted.get(saved.sourceId);
      if (
        !pushed ||
        Date.parse(pushed.receivedAt) < Date.parse(saved.receivedAt) ||
        (pushed.receivedAt === saved.receivedAt &&
          pushed.observedAt === saved.observedAt &&
          pushed.expiresAt === saved.expiresAt)
      )
        return group;
      return {
        ...group,
        observation: {
          ...saved,
          expiresAt: new Date(
            Math.min(
              Date.parse(saved.expiresAt),
              Date.parse(pushed.receivedAt),
              Date.parse(pushed.expiresAt),
            ),
          ).toISOString(),
        },
      };
    }),
  };
}
