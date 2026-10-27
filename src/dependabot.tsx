import {
  useDependabotDrag,
  DependabotDragPreview,
  type DependabotMoveSelection,
} from "./dependabot-drag";
import {
  DependabotWeekOverview,
  DependabotDayTimeline,
  DependabotDraftSummary,
} from "./dependabot-timeline";
import {
  type DependabotDraft as Draft,
  entryKey,
  stale,
  draftMatches,
  withinDependabotSchedules,
  rowState,
} from "./lib/dependabot-view";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Temporal } from "@js-temporal/polyfill";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  DEPENDABOT_LIMITS as LIMITS,
  dependabotPageSchema,
  dependabotResultSchema,
  validDependabotTimezone,
  type DependabotEntry,
  type DependabotInventoryRow,
} from "../shared/dependabot";
import {
  projectDependabotSchedules,
  DEPENDABOT_NOTICE_LABELS,
  type DependabotOccurrence,
} from "../shared/dependabot-projection";
import type { DependabotChangeReview } from "../shared/dependabot-changes";
import { command, RequestError } from "./lib/api";
import { COORDINATED_QUERY_OPTIONS } from "./lib/workspace-query-refresh";
import { useDateTime } from "./date-time";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { DependabotEditor, scheduleMembers } from "./dependabot-editor";
import {
  DependabotPrepare,
  DependabotSavedReview,
  DependabotHistory,
} from "./dependabot-review";
import "./dependabot.css";
import { useScheduleWorkspace } from "./lib/use-schedule-workspace";
import { dependabotTimeColor } from "./lib/dependabot-colors";

type Inventory = {
  rows: DependabotInventoryRow[];
  total: number;
  complete: boolean;
  issue: string;
};
const EMPTY_ROWS: DependabotInventoryRow[] = [];
const ISOLATED_REVIEW_MODE = "e2e";
function byKey<T extends { key: string }>(items: T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(item.key);
    if (bucket) bucket.push(item);
    else grouped.set(item.key, [item]);
  }
  return grouped;
}
function DraftNavigationGuard({
  dirty,
  onDiscard,
  busy,
}: {
  dirty: boolean;
  onDiscard: () => void;
  busy: boolean;
}) {
  const guard = useCloseGuard(
    dirty,
    onDiscard,
    withinDependabotSchedules,
  );
  return <DiscardDialog guard={guard} busy={busy} />;
}
export function DependabotView({
  snapshot,
  projectId,
}: {
  snapshot: Snapshot;
  projectId?: string;
}) {
  const workspaceId = snapshot.workspace.id,
    dates = useDateTime(),
    cache = useQueryClient();
  const [params, setParams] = useSearchParams(),
    [now, setNow] = useState(Date.now),
    [limit, setLimit] = useState<number>(LIMITS.INVENTORY_REPOSITORIES);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [search, setSearch] = useState(""),
    [onlyOverlaps, setOnlyOverlaps] = useState(false);
  const [editing, setEditing] = useState<{
      row: DependabotInventoryRow;
      entry: DependabotEntry;
      focus: HTMLElement | null;
    } | null>(null),
    [preparing, setPreparing] = useState<DependabotInventoryRow | null>(null);
  const [refreshing, setRefreshing] = useState(false),
    [progress, setProgress] = useState("");
  const cancelled = useRef(false),
    mounted = useRef(true);
  const operator = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), LIMITS.CLOCK_MS);
      }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      cancelled.current = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const zone = validDependabotTimezone(params.get("scheduleZone") ?? "")
    ? params.get("scheduleZone")!
    : dates.timeZone;
  const mode = params.get("scheduleMode") === "day" ? "day" : "week";
  let selectedDate: Temporal.PlainDate;
  try {
    selectedDate = Temporal.PlainDate.from(
      params.get("scheduleDate") ?? Temporal.Now.plainDateISO(zone).toString(),
    );
  } catch {
    selectedDate = Temporal.Now.plainDateISO(zone);
  }
  const date = (
    mode === "week"
      ? selectedDate.subtract({ days: selectedDate.dayOfWeek - 1 })
      : selectedDate
  ).toString();
  const window = useMemo<{
    date: string;
    mode: "week" | "day";
    timeZone: string;
  }>(() => ({ date, mode, timeZone: zone }), [date, mode, zone]);
  const zones = useMemo(
    () =>
      Array.from(
        new Set([
          "UTC",
          dates.timeZone,
          zone,
          ...Intl.supportedValuesOf("timeZone"),
        ]),
      ).sort(),
    [zone, dates.timeZone],
  );
  const queryKey = [
    "dependabot-schedules",
    workspaceId,
    projectId ?? null,
    limit,
  ];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<Inventory> => {
      const rows: DependabotInventoryRow[] = [];
      let total = 0,
        revision: number | undefined;
      for (let page = 1; rows.length < limit; page++) {
        let result;
        try {
          result = dependabotPageSchema.parse(
            await command(
              "dependabot_schedules",
              { workspaceId, ...(projectId ? { projectId } : {}), page },
              signal,
            ),
          );
        } catch (error) {
          if (
            !rows.length ||
            (error instanceof RequestError &&
              [401, 403, 404, 409].includes(error.status))
          )
            throw error;
          return {
            rows,
            total,
            complete: false,
            issue:
              "Some inventory pages could not be loaded. Reload to compare the full scope.",
          };
        }
        if (
          revision !== undefined &&
          (revision !== result.revision || total !== result.total)
        )
          return {
            rows,
            total,
            complete: false,
            issue:
              "Repository inventory changed while loading. Reload the list.",
          };
        revision = result.revision;
        total = result.total;
        if (!result.rows.length && rows.length < total)
          return {
            rows,
            total,
            complete: false,
            issue: "An inventory page is incomplete. Reload the list.",
          };
        rows.push(...result.rows);
        if (new Set(rows.map((row) => row.repository.id)).size !== rows.length)
          return {
            rows: [],
            total,
            complete: false,
            issue: "Inventory pages overlap. Reload the list.",
          };
        if (rows.length >= total)
          return { rows, total, complete: true, issue: "" };
      }
      return {
        rows,
        total,
        complete: false,
        issue:
          "More repositories are available. Load more to extend the comparison.",
      };
    },
    retry: false,
    refetchInterval:
      import.meta.env.MODE === ISOLATED_REVIEW_MODE ? LIMITS.CLOCK_MS : false,
    ...COORDINATED_QUERY_OPTIONS,
  });
  const data = query.error ? undefined : query.data,
    rows = data?.rows ?? EMPTY_ROWS;
  const inputs = useMemo(
    () =>
      rows.flatMap((row) =>
        (row.result?.evidence?.entries ?? []).map((entry) => ({
          key: entryKey(row, entry),
          schedule: entry.schedule,
          stale: stale(row, now),
        })),
      ),
    [rows, now],
  );
  const observed = useMemo(
    () => projectDependabotSchedules(inputs, window),
    [inputs, window],
  );
  const draftInputs = useMemo(
    () =>
      rows.flatMap((row) =>
        (row.result?.evidence?.entries ?? []).map((entry) => ({
          key: entryKey(row, entry),
          schedule:
            (draftMatches(row, drafts[row.repository.id])
              ? drafts[row.repository.id]?.edits.find(
                  (edit) => edit.entryId === entry.id,
                )?.schedule
              : undefined) ?? entry.schedule,
          stale: stale(row, now),
        })),
      ),
    [rows, drafts, now],
  );
  const preview = useMemo(
    () => projectDependabotSchedules(draftInputs, window),
    [draftInputs, window],
  );
  const observedByKey = useMemo(() => byKey(observed.occurrences), [observed]);
  const previewByKey = useMemo(() => byKey(preview.occurrences), [preview]);
  const noticeByKey = useMemo(() => byKey(Array.from(new Map(
    [...observed.notices, ...preview.notices].map(notice => [notice.key + ":" + notice.code, notice]),
  ).values())), [observed, preview]);
  const ambiguous = observed.notices.some(
    (notice) => notice.code !== "outside_range",
  );
  const present = rows.filter(
    (row) =>
      row.result?.evidence?.configuration === "present" && !stale(row, now),
  ).length;
  const coverage = Boolean(
    data?.complete &&
    !observed.limited &&
    !ambiguous &&
    rows.every(
      (row) =>
        row.result?.evidence?.read.state === "observed" &&
        !stale(row, now) &&
        ["present", "missing"].includes(row.result.evidence.configuration),
    ),
  );
  const overlapMinutes = new Set(
    observed.occurrences
      .filter((item) => item.overlap > 1)
      .map((item) => Math.floor(Date.parse(item.instant) / 60000)),
  ).size;
  const planId = params.get("scheduleReview");
  function change(name: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(name, value);
    setParams(next, { preventScrollReset: true });
  }
  function saveSchedule(
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    schedule: NonNullable<DependabotEntry["schedule"]>,
  ) {
    setDrafts((old) => {
      const edits = (
        draftMatches(row, old[row.repository.id])
          ? old[row.repository.id]!.edits
          : []
      ).filter((edit) => edit.entryId !== entry.id);
      if (JSON.stringify(schedule) !== JSON.stringify(entry.schedule))
        edits.push({ entryId: entry.id, schedule });
      const next = { ...old };
      if (edits.length)
        next[row.repository.id] = {
          head: row.result!.evidence!.headSha!,
          digest: row.result!.evidence!.file!.digest,
          edits,
        };
      else delete next[row.repository.id];
      return next;
    });
  }
  const dragContext = useMemo(
    () => ({ window, data, search, onlyOverlaps, planId }),
    [window, data, search, onlyOverlaps, planId],
  );
  const drag = useDependabotDrag({
    timeZone: zone,
    context: dragContext,
    onCommit: (selection, result) => {
      saveSchedule(selection.row, selection.entry, result.schedule);
      if (mode === "day" && result.date !== date)
        change("scheduleDate", result.date);
    },
    onOpen: (selection, target) => show(selection.row, selection.entry, target),
  });
  const workspace = useScheduleWorkspace(
    Boolean(editing || preparing),
    Boolean(drag.preview),
  );
  const Heading = projectId && !workspace.focused ? "h2" : "h1";
  const liveInputs = useMemo(() => {
    const candidate = drag.preview;
    if (!candidate?.result.ok) return draftInputs;
    const { schedule } = candidate.result;
    return draftInputs.map((input) =>
      input.key === candidate.selection.key ? { ...input, schedule } : input,
    );
  }, [draftInputs, drag.preview]);
  const live = useMemo(
    () =>
      drag.preview?.result.ok
        ? projectDependabotSchedules(liveInputs, {
            date: drag.preview.result.date,
            mode: "day",
            timeZone: zone,
          })
        : null,
    [liveInputs, drag.preview?.result, zone],
  );
  const liveOverlap =
    live?.occurrences.find(
      (item) =>
        item.key === drag.preview?.selection.key &&
        item.instant ===
          (drag.preview?.result.ok ? drag.preview.result.instant : null),
    )?.overlap ?? 0;
  function show(
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    target: HTMLElement,
  ) {
    setEditing({ row, entry, focus: target });
  }
  function removeDraft(repositoryId: string) {
    setDrafts((value) => {
      const next = { ...value };
      delete next[repositoryId];
      return next;
    });
  }
  async function refreshSchedules() {
    if (refreshing) return;
    cancelled.current = false;
    setRefreshing(true);
    setProgress("Starting schedule refresh...");
    const queue = rows.filter(
      (row) =>
        row.source &&
        !["disabled", "not_configured"].includes(row.result?.state ?? "") &&
        (!row.result?.nextReadAt ||
          Date.parse(row.result.nextReadAt) <= Date.now()),
    );
    let cursor = 0,
      completed = 0,
      waiting = rows.length - queue.length,
      failed = 0;
    const run = async () => {
      while (!cancelled.current && cursor < queue.length) {
        const row = queue[cursor++]!;
        try {
          const result = dependabotResultSchema.parse(
            await command("repository_dependabot", {
              workspaceId,
              sourceId: row.source!.id,
              repositoryId: row.repository.id,
              refresh: true,
            }),
          );
          if (result.state === "waiting" || result.state === "collecting")
            waiting++;
          if (result.evidence && result.evidence.read.state !== "observed")
            failed++;
          if (mounted.current)
            cache.setQueryData<Inventory>(queryKey, (old) =>
              old
                ? {
                    ...old,
                    rows: old.rows.map((item) =>
                      item.repository.id === row.repository.id
                        ? { ...item, result }
                        : item,
                    ),
                  }
                : old,
            );
        } catch {
          failed++;
        }
        completed++;
        if (mounted.current)
          setProgress(
            `${completed} checked, ${waiting} waiting or unavailable, ${failed} failed. ${queue.length - cursor} unsent.`,
          );
      }
    };
    await Promise.all(Array.from({ length: LIMITS.REFRESH_CONCURRENCY }, run));
    if (mounted.current) {
      setRefreshing(false);
      setProgress(
        `${cancelled.current ? "Refresh stopped" : "Refresh finished"}: ${completed} checked, ${waiting} waiting or unavailable, ${failed} failed, ${queue.length - cursor} unsent. Retry after the displayed read deadlines.`,
      );
      void query.refetch();
    }
  }
  const visible = rows.filter(
    (row) =>
      row.repository.fullName
        .toLowerCase()
        .includes(search.trim().toLowerCase()) &&
      (!onlyOverlaps ||
        (row.result?.evidence?.entries ?? []).some((entry) =>
          [
            ...(observedByKey.get(entryKey(row, entry)) ?? []),
            ...(previewByKey.get(entryKey(row, entry)) ?? []),
          ].some((item) => item.overlap > 1),
        )),
  );
  function reviewOverlap(review: DependabotChangeReview) {
    const currentKeys = new Set(inputs.map((input) => input.key));
    const repository = rows.find(
      (row) => row.repository.id === review.basis.repository.id,
    );
    if (
      !repository ||
      repository.result?.evidence?.file?.digest !== review.basis.file.digest ||
      review.edits.some(
        (edit) =>
          !currentKeys.has(review.basis.repository.id + ":" + edit.entryId),
      )
    )
      return "Proposed overlap comparison is undetermined. The reviewed schedules do not match the loaded observation. Refresh and prepare a fresh review.";
    const projected = projectDependabotSchedules(
      inputs.map((input) => {
        const edit = review.edits.find(
          (edit) =>
            input.key === review.basis.repository.id + ":" + edit.entryId,
        );
        return edit ? { ...input, schedule: edit.schedule } : input;
      }),
      window,
    );
    const count = new Set(
      projected.occurrences
        .filter(
          (item) =>
            item.key.startsWith(review.basis.repository.id + ":") &&
            item.overlap > 1,
        )
        .map((item) => Math.floor(Date.parse(item.instant) / 60000)),
    ).size;
    const incomplete =
      projected.limited ||
      projected.notices.some((notice) => notice.code !== "outside_range");
    return `${count} proposed overlapping start minutes in this view against observed schedules. Overlaps are allowed.${incomplete ? " Proposed overlap comparison is incomplete; unknown times or projection limits may conceal additional overlaps." : coverage ? "" : " Coverage is incomplete; additional overlaps may exist."}`;
  }
  const clock = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    [zone],
  );
  const repositoryNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const name = row.repository.fullName.split("/").at(-1)!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Map(rows.map(row => {
      const fullName = row.repository.fullName;
      const name = fullName.split("/").at(-1)!;
      return [fullName, counts.get(name)! > 1 ? fullName : name];
    }));
  }, [rows]);
  function marker(
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    item: DependabotOccurrence,
    draft = false,
    card = false,
  ) {
    const local = Temporal.Instant.from(item.instant).toZonedDateTimeISO(zone);
    const day = local.toPlainDate().toString();
    const label = `${draft ? "Draft" : "Observed"} ${row.repository.fullName} ${scheduleMembers(entry)} ${day} ${clock.format(new Date(item.instant))} ${zone}${item.overlap > 1 ? `, ${item.overlap} starts at the same UTC minute` : ""}${item.stale ? ", stale observation" : ""}`;
    const schedule =
      (draft
        ? drafts[row.repository.id]?.edits.find(
            (edit) => edit.entryId === entry.id,
          )?.schedule
        : undefined) ?? entry.schedule;
    const selection: DependabotMoveSelection = {
      key: entryKey(row, entry),
      row,
      entry,
      occurrence: item,
      schedule,
      draft,
    };
    return (
      <button
        key={item.instant}
        type="button"
        className={`schedule-marker${card ? " schedule-week-marker" : " schedule-time-block"}${draft ? " is-draft" : ""}${item.overlap > 1 ? " has-overlap" : ""}${item.stale ? " is-stale" : ""}`}
        style={{
          ...(!card ? { left: `${item.position * 100}%` } : {}),
          "--schedule-time-color": dependabotTimeColor(day, item.minute),
        } as CSSProperties}
        aria-label={label}
        title={label + (row.result?.evidence ? ", read " + dates.dateTime(row.result.evidence.observedAt) : "")}
        {...drag.handlers(selection)}
      >
        <span className="schedule-block-time">
          {clock.format(new Date(item.instant))}
        </span>
        {card ? (
          <span className="schedule-block-repository">
            {repositoryNames.get(row.repository.fullName)}
          </span>
        ) : null}
        {!card ? <span className="schedule-block-kind">
          {draft ? "Draft" : "Observed"}
        </span> : null}
        {!card && item.overlap > 1 ? (
          <span className="schedule-block-overlap">{item.overlap} starts</span>
        ) : null}
      </button>
    );
  }
  function selectDay(value: string) {
    const next = new URLSearchParams(params);
    next.set("scheduleDate", value);
    next.set("scheduleMode", "day");
    setParams(next, { preventScrollReset: true });
  }
  const timelineProps = {
    workspaceId,
    rows: visible,
    drafts,
    now,
    operator,
    date,
    timeZone: zone,
    observed: observedByKey,
    activeDate: drag.preview?.result.ok ? drag.preview.result.date : undefined,
    preview: previewByKey,
    notices: noticeByKey,
    repositoryName: (row: DependabotInventoryRow) =>
      repositoryNames.get(row.repository.fullName) ?? row.repository.fullName,
    onDay: selectDay,
    onPrepare: setPreparing,
    onDiscard: removeDraft,
    onShow: show,
    block: marker,
  };
  return (
    <section
      ref={workspace.ref}
      className={
        "dependencies-view schedule-view" +
        (workspace.focused ? " is-focused" : "")
      }
      aria-label="Dependabot schedules"
    >
      <header className="schedule-toolbar">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to dependencies"
          title="Back to dependencies"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("view");
            next.delete("scheduleReview");
            setParams(next);
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <Heading className="schedule-title" aria-label="Dependabot schedules">Schedules</Heading>
        {workspace.focused ? (
          <span className="schedule-context">
            {snapshot.workspace.name}
            {projectId
              ? " / " +
                (snapshot.projects.find((project) => project.id === projectId)
                  ?.name ?? "Project")
              : ""}
          </span>
        ) : null}
        <div className="schedule-controls">
          <label>
            <span className="sr-only">View</span>
            <select
              aria-label="View"
              value={mode}
              onChange={(event) => change("scheduleMode", event.target.value)}
            >
              <option value="week">Week</option>
              <option value="day">Day</option>
            </select>
          </label>
          <div className="schedule-date-controls">
            <Button
              variant="outline"
              aria-label="Previous date range"
              onClick={() =>
                change(
                  "scheduleDate",
                  Temporal.PlainDate.from(date)
                    .subtract({ days: mode === "week" ? 7 : 1 })
                    .toString(),
                )
              }
            >
              <ChevronLeft size={16} />
            </Button>
            <label>
              <span className="sr-only">Starting date</span>
              <Input
                type="date"
                value={date}
                onChange={(event) => {
                  if (event.target.value)
                    change("scheduleDate", event.target.value);
                }}
              />
            </label>
            <Button
              variant="outline"
              aria-label="Next date range"
              onClick={() =>
                change(
                  "scheduleDate",
                  Temporal.PlainDate.from(date)
                    .add({ days: mode === "week" ? 7 : 1 })
                    .toString(),
                )
              }
            >
              <ChevronRight size={16} />
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                change(
                  "scheduleDate",
                  Temporal.Now.plainDateISO(zone).toString(),
                )
              }
            >
              Today
            </Button>
          </div>
          <label>
            <span className="sr-only">Display timezone</span>
            <select
              aria-label="Display timezone"
              value={zone}
              onChange={(event) => change("scheduleZone", event.target.value)}
            >
              {zones.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <details className="schedule-options">
          <summary aria-label="Schedule options" title="Schedule options">
            <SlidersHorizontal size={16} aria-hidden="true" />
            <span className="sr-only">Schedule options</span>
          </summary>
          <div className="schedule-options-panel">
            <Button
              variant="outline"
              disabled={query.isFetching || refreshing}
              onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void query.refetch(); }}
            >
              Reload list
            </Button>
            <Button
              variant="outline"
              disabled={refreshing || !rows.length}
              onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void refreshSchedules(); }}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh schedules
            </Button>
            <div className="schedule-legend">
              <span>
                <i className="schedule-dot schedule-time-swatch" />
                Time color
              </span>
              <span>
                <i className="schedule-dot has-overlap" />
                Same UTC minute
              </span>
              <span>
                <i className="schedule-dot is-draft" />
                Draft outline
              </span>
            </div>
            <p>
              Nominal starts; execution may vary. Overlaps are allowed. Drafts
              stay in this tab.
            </p>
            <p>
              Drag in 15-minute steps. Drop weekly schedules on another weekday.
              Changes apply to the recurring schedule.
            </p>
            <p>
              Keyboard: Space to pick up, Left/Right to change time,
              Alt+Left/Right to change day, Enter to save, Escape to cancel.
            </p>
          </div>
        </details>
        <Button
          variant="outline"
          size="icon"
          aria-label={
            workspace.focused ? "Exit focus view" : "Enter focus view"
          }
          title={workspace.focused ? "Exit focus view" : "Enter focus view"}
          onClick={() => {
            drag.cancel();
            workspace.toggle();
          }}
        >
          {workspace.focused ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </Button>
      </header>
      <div className="schedule-filter-controls">
        <label>
          <span className="sr-only">Find a repository</span>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={160}
            placeholder="Owner or repository"
          />
        </label>
        <label className="schedule-check">
          <input
            type="checkbox"
            checked={onlyOverlaps}
            onChange={(event) => setOnlyOverlaps(event.target.checked)}
          />
          Overlaps only
        </label>
        {refreshing ? (
          <Button
            variant="outline"
            onClick={() => {
              cancelled.current = true;
              setProgress(
                "Stopping unsent refreshes. In-flight reads will finish.",
              );
            }}
          >
            Stop refresh
          </Button>
        ) : null}
        {query.isPending ? (
          <p role="status">Loading schedule inventory...</p>
        ) : query.error ? (
          <p role="alert">{query.error.message}</p>
        ) : (
          <p role="status">
            {rows.length} of {data?.total ?? 0} repositories. {present} fresh.{" "}
            {overlapMinutes} overlapping start minutes.
            {observed.limited || preview.limited ? " Display limit reached; some starts are not shown." : ""}
            {coverage
              ? ""
              : " Incomplete comparison: unknown or stale schedules may add overlaps."}
          </p>
        )}
      </div>
      {data?.issue ? <p role="status">{data.issue}</p> : null}
      {data && rows.length < data.total ? (
        <Button
          variant="outline"
          onClick={() =>
            setLimit((value) => value + LIMITS.INVENTORY_REPOSITORIES)
          }
          disabled={query.isFetching}
        >
          Load more repositories
        </Button>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {planId ? (
        operator ? (
          <DependabotSavedReview
            key={planId}
            workspaceId={workspaceId}
            planId={planId}
            now={now}
            overlaps={reviewOverlap}
            onSubmitted={removeDraft}
            repositoryName={(id) =>
              rows.find((row) => row.repository.id === id)?.repository.fullName
            }
          />
        ) : (
          <p role="status">
            A workspace operator can open saved schedule reviews.
          </p>
        )
      ) : (
        <>
          <DependabotDraftSummary {...timelineProps} rows={rows} />
          <span className="sr-only" id="schedule-move-instructions">
            Click to edit. Space picks up a block; Left and Right change time;
            Alt with Left or Right changes the day of a weekly schedule. Enter
            saves the local draft; Escape cancels. You can also use the form.
          </span>
          <div className="schedule-canvas">
            {mode === "week" ? (
              <DependabotWeekOverview {...timelineProps} />
            ) : (
              <DependabotDayTimeline key={date + zone} {...timelineProps} />
            )}
          </div>
          {!query.isPending && data && !visible.length ? (
            <p role="status">No repositories match this view.</p>
          ) : null}
        </>
      )}
      {editing ? (
        <DependabotEditor
          key={editing.row.repository.id + editing.entry.id}
          entry={editing.entry}
          hasDrafts={Object.keys(drafts).length > 0}
          schedule={
            (draftMatches(editing.row, drafts[editing.row.repository.id])
              ? drafts[editing.row.repository.id]?.edits.find(
                  (edit) => edit.entryId === editing.entry.id,
                )?.schedule
              : undefined) ?? editing.entry.schedule
          }
          repository={editing.row.repository.fullName}
          returnFocus={editing.focus}
          onClose={() => setEditing(null)}
          onSave={(schedule) =>
            saveSchedule(editing.row, editing.entry, schedule)
          }
        >
          <div className="dependency-meta">
            <span>{rowState(editing.row, now)}</span>
            {editing.row.result?.evidence ? (
              <time dateTime={editing.row.result.evidence.observedAt}>Read {dates.dateTime(editing.row.result.evidence.observedAt)}</time>
            ) : null}
            {editing.row.result?.nextReadAt && Date.parse(editing.row.result.nextReadAt) > now ? (
              <span>Next read {dates.dateTime(editing.row.result.nextReadAt)}</span>
            ) : null}
          </div>
          {noticeByKey.get(entryKey(editing.row, editing.entry))?.filter(notice => notice.code !== "outside_range").map(notice => (
            <p role="status" key={notice.code}>{DEPENDABOT_NOTICE_LABELS[notice.code]}</p>
          ))}
          {operator ? (
            <DependabotHistory
              workspaceId={workspaceId}
              repositoryId={editing.row.repository.id}
              onSelect={() => setEditing(null)}
            />
          ) : null}
        </DependabotEditor>
      ) : null}
      {preparing ? (
        <DependabotPrepare
          workspaceId={workspaceId}
          row={preparing}
          edits={drafts[preparing.repository.id]!.edits}
          onClose={() => setPreparing(null)}
          onPrepared={(review) => {
            cache.setQueryData(
              ["dependabot-review", workspaceId, review.planId],
              review,
            );
            setPreparing(null);
            change("scheduleReview", review.planId);
          }}
        />
      ) : null}
      <DependabotDragPreview
        drag={drag}
        overlap={liveOverlap}
        incomplete={
          !coverage ||
          Boolean(live?.limited) ||
          Boolean(
            live?.notices.some((notice) => notice.code !== "outside_range"),
          )
        }
      />
      {drag.announcement ? <p role="status">{drag.announcement}</p> : null}
      {!editing ? (
        <DraftNavigationGuard
          dirty={Object.keys(drafts).length > 0}
          onDiscard={() => setDrafts({})}
          busy={refreshing}
        />
      ) : null}
    </section>
  );
}
