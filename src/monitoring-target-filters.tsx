import { useEffect, useId, useState } from "react";
import {
  MONITOR_LIMITS,
  MONITOR_TARGET_STATUS_LABELS,
  type MonitorTargetStatus,
  type MonitorTargetScan,
} from "../shared/monitoring";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

const SEARCH_DELAY_MS = 300;
export function useMonitorTargetSearch(search: string) {
  const [settled, setSettled] = useState(search.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);
  return settled === search.trim();
}

export function MonitorTargetFilters({
  search,
  status,
  onSearch,
  onStatus,
  linkedOnly,
  onLinkedOnly,
}: {
  search: string;
  status: MonitorTargetStatus;
  onSearch: (value: string) => void;
  onStatus: (value: MonitorTargetStatus) => void;
  linkedOnly?: boolean;
  onLinkedOnly?: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="monitor-target-filters">
      <label className="form-field" htmlFor={id + "search"}>
        Search monitor targets
        <Input
          id={id + "search"}
          value={search}
          maxLength={MONITOR_LIMITS.TARGET_SEARCH_LENGTH}
          placeholder="Target, URL, or repository"
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
      <label className="form-field" htmlFor={id + "status"}>
        Target evidence
        <Select
          value={status}
          onValueChange={(value: MonitorTargetStatus) => onStatus(value)}
        >
          <SelectTrigger id={id + "status"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(MONITOR_TARGET_STATUS_LABELS).map(
              ([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </label>
      {onLinkedOnly ? (
        <label className="monitor-linked-filter" htmlFor={id + "linked"}>
          <Checkbox
            id={id + "linked"}
            checked={linkedOnly}
            onCheckedChange={(value) => onLinkedOnly(value === true)}
          />
          Linked to this repository
        </label>
      ) : null}
    </div>
  );
}

export function MonitorTargetScanNote({
  scan,
  hasMore,
}: {
  scan?: MonitorTargetScan;
  hasMore: boolean;
}) {
  return (
    <p className="hook-muted" role="status">
      {scan
        ? `${scan.targets} targets checked in ${scan.pages} provider page${scan.pages === 1 ? "" : "s"} for this scan. `
        : ""}
      {hasMore
        ? "More targets remain. Use Next to continue the search."
        : "End of target inventory."}
      {scan?.stopReason === "time_limit"
        ? " The search reached its time limit."
        : ""}
      {scan?.stopReason === "page_limit"
        ? " The search reached its page limit."
        : ""}
    </p>
  );
}
