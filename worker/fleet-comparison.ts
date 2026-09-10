import type {
  FleetCandidate,
  FleetProviderRecord,
  FleetRepository,
} from "../shared/fleet-discovery";

export type FleetInventoryRow = FleetRepository & { githubIds: string[] };
const sameName = (first: string, second: string) =>
  first.toLowerCase() === second.toLowerCase();

export function compareFleetRecords(
  records: FleetProviderRecord[],
  inventory: FleetInventoryRow[],
): FleetCandidate[] {
  return records.map((record, index) => {
    const provider = record.repository;
    const byName = provider
      ? inventory.filter((row) => sameName(row.fullName, provider.fullName))
      : [];
    const byIdentity = provider
      ? inventory.filter((row) => row.githubIds.includes(provider.githubId))
      : [];
    const target = record.repositoryId
      ? (inventory.find((row) => row.id === record.repositoryId) ?? null)
      : (byIdentity[0] ?? byName[0] ?? null);
    const repository = target
      ? {
          id: target.id,
          fullName: target.fullName,
          projectId: target.projectId,
          revision: target.revision,
          classification: target.classification,
          lifecycle: target.lifecycle,
          collected: target.collected,
        }
      : null;
    const candidate: FleetCandidate = {
      key: record.repositoryId ?? provider?.githubId ?? "unavailable-" + index,
      provider,
      repository,
      lookupFullName: record.lookupFullName,
      read: record.read,
      state: "unavailable",
      reason: "provider_unavailable",
      identity: record.repositoryId
        ? record.lookupGithubId ? "recorded" : "name_lookup"
        : "catalog",
    };
    if (!provider || record.read.state !== "observed") return candidate;
    const conflicts = records.filter(
      (other) => other.repository?.githubId === provider.githubId,
    );
    if (
      byIdentity.length > 1 ||
      (target && target.githubIds.length > 1) ||
      conflicts.length > 1
    ) {
      candidate.state = "conflict";
      candidate.reason = "ambiguous_identity";
    } else if (
      (target &&
        target.githubIds.length &&
        !target.githubIds.includes(provider.githubId)) ||
      (record.lookupGithubId && record.lookupGithubId !== provider.githubId)
    ) {
      candidate.state = "conflict";
      candidate.reason = "identity_conflict";
    } else if (
      byName.some((row) => row.id !== target?.id) ||
      byIdentity.some((row) => row.id !== target?.id)
    ) {
      candidate.state = "conflict";
      candidate.reason = "name_conflict";
    } else if (record.repositoryId && !target) {
      candidate.state = "conflict";
      candidate.reason = "identity_conflict";
    } else if (!target) {
      candidate.state = "new";
      candidate.reason = "new";
    } else if (
      target.fullName !== provider.fullName ||
      (target.lifecycle === "archived") !== provider.archived
    ) {
      candidate.state = "changed";
      candidate.reason = "metadata_changed";
    } else {
      candidate.state = "unchanged";
      candidate.reason = "unchanged";
    }
    return candidate;
  });
}
