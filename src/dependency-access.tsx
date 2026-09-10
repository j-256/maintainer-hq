import type { Snapshot } from "../shared/domain";
import { ProviderAccessView } from "./provider-access";
import "./sources.css";
import "./hooks.css";
import "./secrets.css";

export function DependencyAccess({
  snapshot,
  onClose,
}: {
  snapshot: Snapshot;
  onClose: () => void;
}) {
  return (
    <ProviderAccessView
      snapshot={snapshot}
      purpose="repositories"
      onConnect={onClose}
    />
  );
}
