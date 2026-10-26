import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { DEPENDABOT_DRAG } from "../shared/dependabot-movement";
import {
  DEPENDABOT_TIME,
  dependabotScheduleLabel,
  type DependabotEntry,
  type DependabotInventoryRow,
} from "../shared/dependabot";
import {
  DEPENDABOT_NOTICE_LABELS,
  type DependabotNotice,
  type DependabotOccurrence,
} from "../shared/dependabot-projection";
import { githubRepositoryUrl } from "../shared/github-context";
import {
  draftMatches,
  entryKey,
  rowState,
  stale,
  type DependabotDraft,
} from "./lib/dependabot-view";
import { Button } from "./components/ui/button";
import { useDateTime } from "./date-time";
import { DependabotHistory } from "./dependabot-review";
import { scheduleMembers } from "./dependabot-editor";

type TimelineProps = {
  workspaceId: string;
  rows: DependabotInventoryRow[];
  drafts: Record<string, DependabotDraft>;
  now: number;
  operator: boolean;
  date: string;
  timeZone: string;
  activeDate?: string;
  observed: Map<string, DependabotOccurrence[]>;
  preview: Map<string, DependabotOccurrence[]>;
  notices: Map<string, DependabotNotice[]>;
  onDay: (date: string) => void;
  onPrepare: (row: DependabotInventoryRow) => void;
  onDiscard: (id: string) => void;
  onShow: (
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    target: HTMLElement,
  ) => void;
  block: (
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    occurrence: DependabotOccurrence,
    draft: boolean,
    card?: boolean,
  ) => ReactNode;
};
export function scheduleDayLabel(date: string) {
  return Temporal.PlainDate.from(date).toLocaleString("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function RepositoryHeader({
  row,
  props,
  compact = false,
}: {
  row: DependabotInventoryRow;
  props: TimelineProps;
  compact?: boolean;
}) {
  const dates = useDateTime(),
    draft = props.drafts[row.repository.id],
    valid = draftMatches(row, draft);
  return (
    <div className="schedule-repository-heading">
      <strong>{row.repository.fullName}</strong>
      <span
        className={stale(row, props.now) ? "schedule-stale" : "dependency-meta"}
        title={
          row.result?.evidence
            ? "Read " + dates.dateTime(row.result.evidence.observedAt)
            : undefined
        }
      >
        {rowState(row, props.now)}
      </span>
      {!compact && row.result?.evidence ? (
        <time
          className="dependency-meta"
          dateTime={row.result.evidence.observedAt}
        >
          Read {dates.dateTime(row.result.evidence.observedAt)}
        </time>
      ) : null}
      {row.result?.nextReadAt &&
      Date.parse(row.result.nextReadAt) > props.now ? (
        <span className="dependency-meta">
          Next read {dates.dateTime(row.result.nextReadAt)}
        </span>
      ) : null}
      {draft ? (
        <div className="dependency-change-actions">
          <span>{valid ? "Local draft" : "Draft evidence changed"}</span>
          <Button
            size="sm"
            disabled={!valid || !props.operator || stale(row, props.now)}
            onClick={() => props.onPrepare(row)}
          >
            Review changes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onDiscard(row.repository.id)}
          >
            Discard draft
          </Button>
        </div>
      ) : null}
    </div>
  );
}
function History({
  row,
  props,
}: {
  row: DependabotInventoryRow;
  props: TimelineProps;
}) {
  return props.operator ? (
    <DependabotHistory
      workspaceId={props.workspaceId}
      repositoryId={row.repository.id}
    />
  ) : (
    <p className="dependency-meta">
      A workspace operator can prepare a pull request.
    </p>
  );
}
function EntryDetails({
  row,
  entry,
  props,
}: {
  row: DependabotInventoryRow;
  entry: DependabotEntry;
  props: TimelineProps;
}) {
  return (
    <div className="schedule-entry-label">
      <Button
        variant="link"
        onClick={(event) => props.onShow(row, entry, event.currentTarget)}
      >
        {scheduleMembers(entry)}
      </Button>
      <span className="dependency-meta">
        {dependabotScheduleLabel(entry.schedule)}
      </span>
      {props.notices.get(entryKey(row, entry))?.map((notice) => (
        <span className="dependency-meta" key={notice.code}>
          {DEPENDABOT_NOTICE_LABELS[notice.code]}
        </span>
      ))}
    </div>
  );
}
function EmptyRepository({
  row,
  props,
}: {
  row: DependabotInventoryRow;
  props: TimelineProps;
}) {
  return (
    <p className="dependency-meta schedule-empty">
      {row.result?.evidence?.configuration === "missing" ? (
        <>
          Create Dependabot configuration in this repository to add a schedule.{" "}
          <a
            className="quiet-link"
            href={githubRepositoryUrl(row.repository.fullName)}
            target="_blank"
            rel="noreferrer"
          >
            Open repository on GitHub
          </a>
        </>
      ) : (
        <>
          {rowState(row, props.now)}. Refresh to inspect through an enrolled
          GitHub source.
        </>
      )}
    </p>
  );
}
export function DependabotWeekOverview(props: TimelineProps) {
  const entries = props.rows.flatMap((row) =>
    (row.result?.evidence?.entries ?? []).flatMap((entry) => [
      ...(props.observed.get(entryKey(row, entry)) ?? []).map((occurrence) => ({
        row,
        entry,
        occurrence,
        draft: false,
      })),
      ...(draftMatches(row, props.drafts[row.repository.id]) &&
      props.drafts[row.repository.id]?.edits.some(
        (edit) => edit.entryId === entry.id,
      )
        ? (props.preview.get(entryKey(row, entry)) ?? []).map((occurrence) => ({
            row,
            entry,
            occurrence,
            draft: true,
          }))
        : []),
    ]),
  );
  const placed = new Set(entries.map((item) => entryKey(item.row, item.entry)));
  const unplaced = props.rows.filter(
    (row) =>
      !row.result?.evidence?.entries.length ||
      row.result.evidence.entries.some(
        (entry) => !placed.has(entryKey(row, entry)),
      ),
  );
  return (
    <>
      <div
        className="schedule-week-grid"
        role="region"
        aria-label="Schedules grouped by weekday"
      >
        {Array.from({ length: DEPENDABOT_TIME.DAYS_PER_WEEK }, (_, index) => {
          const date = Temporal.PlainDate.from(props.date)
            .add({ days: index })
            .toString();
          const items = entries
            .filter((item) => item.occurrence.day === index)
            .sort(
              (a, b) =>
                a.occurrence.instant.localeCompare(b.occurrence.instant) ||
                a.row.repository.fullName.localeCompare(
                  b.row.repository.fullName,
                ) ||
                Number(a.draft) - Number(b.draft),
            );
          const rows = Array.from(
            new Map(
              items.map((item) => [item.row.repository.id, item.row]),
            ).values(),
          );
          return (
            <section
              key={date}
              className={
                "schedule-week-day" +
                (props.activeDate === date ? " is-drop-target" : "")
              }
              aria-label={scheduleDayLabel(date)}
              data-schedule-drop-date={date}
            >
              <header>
                <Button
                  variant="ghost"
                  className="schedule-day-heading"
                  aria-label={"View " + scheduleDayLabel(date)}
                  onClick={() => props.onDay(date)}
                >
                  {Temporal.PlainDate.from(date).toLocaleString("en", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </Button>
                <span className="dependency-meta">
                  {
                    new Set(items.map((item) => entryKey(item.row, item.entry)))
                      .size
                  }{" "}
                  schedules
                </span>
              </header>
              {rows.map((row) => (
                <article
                  key={row.repository.id}
                  className="schedule-week-repository"
                  data-schedule-repository={row.repository.id}
                >
                  <RepositoryHeader row={row} props={props} compact />
                  <div className="schedule-week-blocks">
                    {items
                      .filter(
                        (item) => item.row.repository.id === row.repository.id,
                      )
                      .map((item) => (
                        <div
                          key={
                            item.entry.id + item.occurrence.instant + item.draft
                          }
                        >
                          {props.block(
                            row,
                            item.entry,
                            item.occurrence,
                            item.draft,
                            true,
                          )}
                        </div>
                      ))}
                  </div>
                  <History row={row} props={props} />
                </article>
              ))}
              {!items.length ? (
                <p className="dependency-meta schedule-empty">
                  No projected starts
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
      {unplaced.length ? (
        <section className="schedule-unplaced" aria-label="Unplaced schedules">
          <h2>Other repositories</h2>
          <p className="dependency-meta">
            Unknown times and starts outside this week stay visible here.
          </p>
          {unplaced.map((row) => (
            <article
              key={row.repository.id}
              className="schedule-repository"
              data-schedule-repository={row.repository.id}
            >
              <RepositoryHeader row={row} props={props} />
              {(row.result?.evidence?.entries ?? [])
                .filter((entry) => !placed.has(entryKey(row, entry)))
                .map((entry) => (
                  <EntryDetails
                    key={entry.id}
                    row={row}
                    entry={entry}
                    props={props}
                  />
                ))}
              {!row.result?.evidence?.entries.length ? (
                <EmptyRepository row={row} props={props} />
              ) : null}
              <History row={row} props={props} />
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}
export function DependabotDayTimeline(props: TimelineProps) {
  const scroll = useRef<HTMLDivElement | null>(null),
    initialized = useRef(false);
  useLayoutEffect(() => {
    if (initialized.current || !scroll.current) return;
    const starts = Array.from(props.observed.values()).flat();
    if (!starts.length) return;
    initialized.current = true;
    scroll.current.scrollLeft = Math.max(
      0,
      (Math.min(...starts.map((item) => item.minute)) /
        DEPENDABOT_DRAG.MINUTES_PER_HOUR -
        1) *
        DEPENDABOT_DRAG.MIN_HOUR_WIDTH,
    );
  }, [props.observed]);
  const week = Temporal.PlainDate.from(props.date).subtract({
    days: Temporal.PlainDate.from(props.date).dayOfWeek - 1,
  });
  return (
    <>
      <nav className="schedule-day-strip" aria-label="Weekdays">
        <span className="dependency-meta">
          View a day or drop a weekly schedule
        </span>
        <div>
          {Array.from({ length: DEPENDABOT_TIME.DAYS_PER_WEEK }, (_, index) => {
            const date = week.add({ days: index }).toString();
            return (
              <Button
                variant={date === props.date ? "secondary" : "outline"}
                key={date}
                aria-label={"View " + scheduleDayLabel(date)}
                aria-current={date === props.date ? "date" : undefined}
                data-schedule-drop-date={date}
                className={
                  props.activeDate === date ? "is-drop-target" : undefined
                }
                onClick={() => props.onDay(date)}
              >
                {Temporal.PlainDate.from(date).toLocaleString("en", {
                  weekday: "short",
                  day: "numeric",
                })}
              </Button>
            );
          })}
        </div>
      </nav>
      <div
        className="schedule-day-scroll"
        ref={scroll}
        role="region"
        aria-label="Hourly repository schedule timeline"
        tabIndex={0}
        style={
          {
            "--schedule-hour-track":
              DEPENDABOT_DRAG.HOURS_PER_DAY * DEPENDABOT_DRAG.MIN_HOUR_WIDTH +
              "px",
          } as CSSProperties
        }
      >
        <div className="schedule-timeline is-detailed-day">
          <div className="schedule-axis">
            <span>Repository / ecosystem</span>
            <div className="schedule-hour-axis">
              <ol aria-label={"Hours in " + props.timeZone}>
                {Array.from(
                  { length: DEPENDABOT_DRAG.HOURS_PER_DAY },
                  (_, hour) => (
                    <li key={hour}>
                      <span>{String(hour).padStart(2, "0")}:00</span>
                    </li>
                  ),
                )}
              </ol>
            </div>
          </div>
          {props.rows.map((row) => {
            const draft = props.drafts[row.repository.id],
              valid = draftMatches(row, draft),
              entries = row.result?.evidence?.entries ?? [];
            return (
              <article
                key={row.repository.id}
                className="schedule-repository"
                data-schedule-repository={row.repository.id}
              >
                <RepositoryHeader row={row} props={props} />
                {entries.map((entry) => {
                  const key = entryKey(row, entry),
                    edit = valid
                      ? draft?.edits.find((edit) => edit.entryId === entry.id)
                      : undefined;
                  return (
                    <div className="schedule-entry" key={entry.id}>
                      <EntryDetails row={row} entry={entry} props={props} />
                      <div className="schedule-lane is-day">
                        <div
                          className="schedule-hour-track"
                          data-schedule-hour-lane={props.date}
                        >
                          {(props.observed.get(key) ?? []).map((item) =>
                            props.block(row, entry, item, false),
                          )}
                          {edit
                            ? (props.preview.get(key) ?? []).map((item) =>
                                props.block(row, entry, item, true),
                              )
                            : null}
                          {edit && !props.preview.get(key)?.length ? (
                            <span className="schedule-draft-note">
                              Draft: {dependabotScheduleLabel(edit.schedule)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!entries.length ? (
                  <EmptyRepository row={row} props={props} />
                ) : null}
                <History row={row} props={props} />
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}
