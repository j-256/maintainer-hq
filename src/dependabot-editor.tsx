import { useState, type FormEvent } from "react";
import {
  DEPENDABOT_DAYS,
  DEPENDABOT_INTERVALS,
  dependabotScheduleSchema,
  dependabotScheduleLabel,
  validDependabotTimezone,
  type DependabotEntry,
  type DependabotSchedule,
} from "../shared/dependabot";
import { supportedDependabotCron } from "../shared/dependabot-cron";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { DiscardDialog, useCloseGuard } from "./source-editor";

export function scheduleMembers(entry: DependabotEntry) {
  return entry.group
    ? entry.group +
        " (" +
        entry.members.map((m) => m.ecosystem).join(", ") +
        ")"
    : entry.members
        .map(
          (m) =>
            m.ecosystem +
            " " +
            m.directories.join(", ") +
            (m.targetBranch ? " on " + m.targetBranch : ""),
        )
        .join("; ");
}
export function DependabotEditor({
  entry,
  schedule,
  repository,
  onClose,
  onSave,
  returnFocus,
  hasDrafts,
}: {
  entry: DependabotEntry;
  schedule: DependabotSchedule | null;
  repository: string;
  onClose: () => void;
  onSave: (schedule: DependabotSchedule) => void;
  returnFocus: HTMLElement | null;
  hasDrafts: boolean;
}) {
  const [interval, setInterval] = useState(schedule?.interval ?? "weekly");
  const [day, setDay] = useState(schedule?.day ?? "");
  const [time, setTime] = useState(schedule?.time ?? "");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "");
  const [cronjob, setCronjob] = useState(schedule?.cronjob ?? "");
  const [error, setError] = useState("");
  const value = {
    interval,
    ...(interval === "weekly" && day ? { day } : {}),
    ...(interval !== "cron" && time ? { time } : {}),
    ...(timezone ? { timezone } : {}),
    ...(interval === "cron" ? { cronjob } : {}),
  };
  const dirty = JSON.stringify(value) !== JSON.stringify(schedule);
  const guard = useCloseGuard(dirty || hasDrafts, onClose);
  const close = () => (dirty ? guard.requestClose() : onClose());
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const parsed = dependabotScheduleSchema.safeParse(value);
    if (
      !parsed.success ||
      (timezone && !validDependabotTimezone(timezone)) ||
      (interval === "cron" && !supportedDependabotCron(cronjob))
    ) {
      setError(
        "Choose a valid schedule, IANA timezone, and five-field cron expression.",
      );
      return;
    }
    onSave(parsed.data);
    guard.saved();
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="schedule-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {entry.editable ? "Edit schedule" : "Schedule details"}
            </DialogTitle>
            <DialogDescription>
              {repository} / {scheduleMembers(entry)}
            </DialogDescription>
          </DialogHeader>
          <p className="dependency-meta">
            Observed: {dependabotScheduleLabel(entry.schedule)}
          </p>
          {entry.editable ? (
            <form className="schedule-form" onSubmit={save}>
              <label>
                Interval
                <select
                  value={interval}
                  onChange={(event) =>
                    setInterval(event.target.value as typeof interval)
                  }
                >
                  {DEPENDABOT_INTERVALS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              {interval === "weekly" ? (
                <label>
                  Day
                  <select
                    value={day}
                    onChange={(event) => setDay(event.target.value)}
                  >
                    <option value="">Default (Monday)</option>
                    {DEPENDABOT_DAYS.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {interval === "cron" ? (
                <label>
                  Cron expression
                  <Input
                    value={cronjob}
                    onChange={(event) => setCronjob(event.target.value)}
                    maxLength={200}
                    required
                    placeholder="0 8 * * 1"
                  />
                </label>
              ) : (
                <label>
                  Time
                  <Input
                    aria-label="Time"
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                  <span className="dependency-meta">
                    Leave empty to keep GitHub-assigned time.
                  </span>
                </label>
              )}
              <label>
                Schedule timezone
                <Input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  maxLength={100}
                  placeholder="Default (UTC)"
                />
              </label>
              <p className="dependency-meta">
                Save keeps a draft in this browser tab. A reviewed pull request
                changes the YAML. Overlaps are allowed.
              </p>
              {error ? <p role="alert">{error}</p> : null}
              <div className="dependency-change-actions">
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit">Save draft</Button>
              </div>
            </form>
          ) : (
            <>
              <p role="status">
                This representation cannot be edited safely here. Inspect its
                configuration on GitHub.
              </p>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={false} />
    </>
  );
}
