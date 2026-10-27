import {
  cloneElement,
  useId,
  useLayoutEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";
import {
  dependabotScheduleLabel,
  type DependabotEntry,
  type DependabotInventoryRow,
  type DependabotSchedule,
} from "../shared/dependabot";
import {
  DEPENDABOT_NOTICE_LABELS,
  type DependabotNotice,
  type DependabotOccurrence,
} from "../shared/dependabot-projection";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { useDateTime } from "./date-time";
import { rowState } from "./lib/dependabot-view";

const PREVIEW = Object.freeze({
  MEMBERS: 3,
  DIRECTORIES: 3,
  EDGE_PADDING: 12,
});

export function DependabotAssignmentPreview({
  row,
  entry,
  schedule,
  occurrence,
  timestamp,
  draft,
  now,
  notices,
  disabled,
  open,
  onOpenChange,
  children,
}: {
  row: DependabotInventoryRow;
  entry: DependabotEntry;
  schedule: DependabotSchedule | null;
  occurrence: DependabotOccurrence;
  timestamp: string;
  draft: boolean;
  now: number;
  notices: DependabotNotice[];
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const id = useId();
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    if (!body) return;
    const measure = () => setTruncated(body.scrollHeight > body.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    measure();
    return () => observer.disconnect();
  }, [body]);
  const dates = useDateTime();
  const visible = open && !disabled;
  const description = [
    children.props["aria-describedby"],
    visible ? id : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip
      open={visible}
      onOpenChange={(value) => onOpenChange(value && !disabled)}
    >
      <TooltipTrigger
        asChild
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch" && !disabled) onOpenChange(true);
        }}
      >
        {cloneElement(children, {
          "aria-describedby": description || undefined,
        })}
      </TooltipTrigger>
      <TooltipContent
        id={id}
        aria-hidden={!visible || undefined}
        className="schedule-assignment-preview"
        side="right"
        sideOffset={8}
        collisionPadding={PREVIEW.EDGE_PADDING}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <strong>{row.repository.fullName}</strong>
        <div className="schedule-preview-body" ref={setBody}>
          <span>
            {draft ? "Local draft" : "Configured start"} / {timestamp}
          </span>
          {entry.group ? <span>Group: {entry.group}</span> : null}
          <div className="schedule-preview-members">
            {entry.members.slice(0, PREVIEW.MEMBERS).map((member, index) => (
              <dl key={index}>
                <div>
                  <dt>Ecosystem</dt>
                  <dd>{member.ecosystem}</dd>
                </div>
                <div>
                  <dt>Directory</dt>
                  <dd>
                    {member.directories
                      .slice(0, PREVIEW.DIRECTORIES)
                      .map((path, index) => (
                        <span key={index}>
                          {path === "/" ? "Repository root (/)" : path}
                        </span>
                      ))}
                    {member.directories.length > PREVIEW.DIRECTORIES ? (
                      <span>
                        {member.directories.length - PREVIEW.DIRECTORIES} more
                        directories in details
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Target branch</dt>
                  <dd>{member.targetBranch ?? "Default branch"}</dd>
                </div>
              </dl>
            ))}
            {entry.members.length > PREVIEW.MEMBERS ? (
              <span>
                {entry.members.length - PREVIEW.MEMBERS} more members in details
              </span>
            ) : null}
          </div>
          <span>Schedule: {dependabotScheduleLabel(schedule)}</span>
          <span>
            {rowState(row, now)}
            {row.result?.evidence
              ? " / " + dates.dateTime(row.result.evidence.observedAt)
              : ""}
          </span>
          {occurrence.overlap > 1 ? (
            <span>
              {occurrence.overlap} starts at the same UTC minute. Overlaps are
              allowed.
            </span>
          ) : null}
          {notices
            .filter((notice) => notice.code !== "outside_range")
            .map((notice) => (
              <span key={notice.code}>
                {DEPENDABOT_NOTICE_LABELS[notice.code]}
              </span>
            ))}
        </div>
        {truncated ? (
          <span className="schedule-preview-remainder">
            Preview shortened. Open assignment for full details.
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
