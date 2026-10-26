import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Temporal } from "@js-temporal/polyfill";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  RefreshCw,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  DEPENDABOT_LIMITS as LIMITS,
  dependabotPageSchema,
  dependabotResultSchema,
  dependabotScheduleLabel,
  validDependabotTimezone,
  type DependabotEdit,
  type DependabotEntry,
  type DependabotInventoryRow,
} from "../shared/dependabot";
import {
  DEPENDABOT_NOTICE_LABELS,
  projectDependabotSchedules,
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

type Inventory = {
  rows: DependabotInventoryRow[];
  total: number;
  complete: boolean;
  issue: string;
};
const EMPTY_ROWS: DependabotInventoryRow[] = [];
type Draft = { head: string; digest: string; edits: DependabotEdit[] };
const entryKey = (row: DependabotInventoryRow, entry: DependabotEntry) =>
  row.repository.id + ":" + entry.id;
function stale(row: DependabotInventoryRow, now: number) {
  const observed = row.result?.evidence?.observedAt;
  return (
    !observed ||
    Date.parse(observed) > now ||
    now - Date.parse(observed) >= LIMITS.CACHE_MS
  );
}
function draftMatches(row: DependabotInventoryRow, draft: Draft | undefined) {
  return Boolean(
    draft &&
    row.result?.evidence?.headSha === draft.head &&
    row.result?.evidence?.file?.digest === draft.digest,
  );
}
function rowState(row: DependabotInventoryRow, now: number) {
  if (!row.source) return "No GitHub source";
  const result = row.result,
    e = result?.evidence;
  if (!e)
    return result?.state === "disabled"
      ? "Source disabled"
      : result?.state === "not_configured"
        ? "Read access unavailable"
        : "Not inspected";
  if (e.read.state !== "observed")
    return "Read unavailable: " + e.read.reason.replaceAll("_", " ");
  if (e.configuration !== "present")
    return {
      missing: "No Dependabot file",
      ambiguous: "Both YAML filenames exist",
      malformed: "Malformed YAML",
      unsupported: "Unsupported configuration",
      limited: "Inspection limit reached",
      unknown: "Configuration unknown",
    }[e.configuration];
  return stale(row, now) ? "Stale observation" : "Observed";
}
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
    (current, next) =>
      current.pathname === next.pathname &&
      new URLSearchParams(current.search).get("workspace") ===
        new URLSearchParams(next.search).get("workspace") &&
      new URLSearchParams(next.search).get("view") === "schedules",
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
  const Heading = projectId ? "h2" : "h1";
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
  const noticeByKey = useMemo(() => byKey(observed.notices), [observed]);
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
    if (
      !inputs.some((input) =>
        input.key.startsWith(review.basis.repository.id + ":"),
      )
    )
      return "The reviewed repository is outside the loaded comparison. Overlaps have not been determined.";
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
    return `${count} proposed overlapping start minutes in this view against observed schedules. Overlaps are allowed.${coverage ? "" : " Coverage is incomplete; additional overlaps may exist."}`;
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
  function marker(
    row: DependabotInventoryRow,
    entry: DependabotEntry,
    item: DependabotOccurrence,
    draft = false,
  ) {
    const label = `${draft ? "Draft" : "Observed"} ${scheduleMembers(entry)} ${Temporal.Instant.from(item.instant).toZonedDateTimeISO(zone).toPlainDate().toString()} ${clock.format(new Date(item.instant))} ${zone}${item.overlap > 1 ? `, ${item.overlap} starts at the same UTC minute` : ""}${item.stale ? ", stale observation" : ""}`;
    return (
      <button
        key={item.instant}
        type="button"
        className={`schedule-marker${draft ? " is-draft" : ""}${item.overlap > 1 ? " has-overlap" : ""}${item.stale ? " is-stale" : ""}`}
        style={{ left: `${item.position * 100}%` }}
        aria-label={label}
        title={label}
        onClick={(event) => show(row, entry, event.currentTarget)}
      >
        <span className="schedule-desktop-symbol" aria-hidden="true">
          {draft ? "D" : item.overlap > 1 ? item.overlap : ""}
        </span>
        <span className="schedule-mobile-label">
          {mode === "week"
            ? Temporal.PlainDate.from(date)
                .add({ days: item.day })
                .toLocaleString("en", { weekday: "short", day: "numeric" }) +
              " "
            : ""}
          {clock.format(new Date(item.instant))} {draft ? "Draft" : "Observed"}
          {item.overlap > 1 ? ` / ${item.overlap} starts` : ""}
        </span>
      </button>
    );
  }
  return (
    <section
      className="dependencies-view schedule-view"
      aria-label="Dependabot schedules"
    >
      <header className="dependency-toolbar">
        <div>
          <Heading className="page-title">
            <CalendarClock size={24} aria-hidden="true" />
            Dependabot schedules
          </Heading>
          <p className="dependency-meta">
            Configured start times. Overlaps are allowed.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("view");
            next.delete("scheduleReview");
            setParams(next);
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Dependencies
        </Button>
      </header>
      <div className="schedule-controls">
        <label>
          View
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
            Starting date
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
              change("scheduleDate", Temporal.Now.plainDateISO(zone).toString())
            }
          >
            Today
          </Button>
        </div>
        <label>
          Display timezone
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
      <div className="schedule-filter-controls">
        <label>
          Find a repository
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
        <Button
          variant="outline"
          disabled={query.isFetching || refreshing}
          onClick={() => void query.refetch()}
        >
          Reload list
        </Button>
        <Button
          variant="outline"
          disabled={refreshing || !rows.length}
          onClick={() => void refreshSchedules()}
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh schedules
        </Button>
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
      </div>
      {query.isPending ? (
        <p role="status">Loading schedule inventory...</p>
      ) : query.error ? (
        <p role="alert">{query.error.message}</p>
      ) : (
        <p role="status">
          {rows.length} of {data?.total ?? 0} repositories. {present} fresh.{" "}
          {overlapMinutes} overlapping start minutes.
          {coverage
            ? ""
            : " Incomplete comparison: unknown or stale schedules may add overlaps."}
        </p>
      )}
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
          />
        ) : (
          <p role="status">
            A workspace operator can open saved schedule reviews.
          </p>
        )
      ) : (
        <>
          <div className="schedule-legend">
            <span>
              <i className="schedule-dot" />
              Observed
            </span>
            <span>
              <i className="schedule-dot has-overlap" />
              Same UTC minute
            </span>
            <span>
              <i className="schedule-dot is-draft" />
              Local draft
            </span>
            <span className="dependency-meta">
              Nominal starts; execution may vary. Drafts stay in this tab.
            </span>
          </div>
          <div
            className="schedule-timeline"
            role="region"
            aria-label="Repository schedule timeline"
          >
            <div className="schedule-axis">
              <span>Repository / ecosystem</span>
              <div>
                {Array.from({ length: mode === "week" ? 7 : 4 }, (_, index) => (
                  <span key={index}>
                    {mode === "week"
                      ? Temporal.PlainDate.from(date)
                          .add({ days: index })
                          .toLocaleString("en", {
                            weekday: "short",
                            day: "numeric",
                          })
                      : String(index * 6).padStart(2, "0") + ":00"}
                  </span>
                ))}
              </div>
            </div>
            {visible.map((row) => {
              const draft = drafts[row.repository.id],
                valid = draftMatches(row, draft),
                entries = row.result?.evidence?.entries ?? [];
              return (
                <article
                  key={row.repository.id}
                  className="schedule-repository"
                  data-schedule-repository={row.repository.id}
                >
                  <div className="schedule-repository-heading">
                    <strong>{row.repository.fullName}</strong>
                    <span
                      className={
                        stale(row, now) ? "schedule-stale" : "dependency-meta"
                      }
                    >
                      {rowState(row, now)}
                    </span>
                    {row.result?.evidence ? (
                      <time
                        className="dependency-meta"
                        dateTime={row.result.evidence.observedAt}
                      >
                        Read {dates.dateTime(row.result.evidence.observedAt)}
                      </time>
                    ) : null}
                    {row.result?.nextReadAt &&
                    Date.parse(row.result.nextReadAt) > now ? (
                      <span className="dependency-meta">
                        Next read {dates.dateTime(row.result.nextReadAt)}
                      </span>
                    ) : null}
                    {draft ? (
                      <div className="dependency-change-actions">
                        <span>
                          {valid ? "Local draft" : "Draft evidence changed"}
                        </span>
                        <Button
                          size="sm"
                          disabled={!valid || !operator || stale(row, now)}
                          onClick={() => setPreparing(row)}
                        >
                          Review changes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => removeDraft(row.repository.id)}
                        >
                          Discard draft
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {entries.map((entry) => {
                    const key = entryKey(row, entry),
                      edit = valid
                        ? draft?.edits.find((edit) => edit.entryId === entry.id)
                        : undefined;
                    return (
                      <div key={entry.id} className="schedule-entry">
                        <div className="schedule-entry-label">
                          <Button
                            variant="link"
                            onClick={(event) =>
                              show(row, entry, event.currentTarget)
                            }
                          >
                            {scheduleMembers(entry)}
                          </Button>
                          <span className="dependency-meta">
                            {dependabotScheduleLabel(entry.schedule)}
                          </span>
                          {noticeByKey.get(key)?.map((notice) => (
                            <span key={notice.code} className="dependency-meta">
                              {DEPENDABOT_NOTICE_LABELS[notice.code]}
                            </span>
                          ))}
                        </div>
                        <div
                          className={`schedule-lane ${mode === "day" ? "is-day" : ""}`}
                        >
                          {(observedByKey.get(key) ?? []).map((item) =>
                            marker(row, entry, item),
                          )}
                          {edit
                            ? (previewByKey.get(key) ?? []).map((item) =>
                                marker(row, entry, item, true),
                              )
                            : null}
                          {edit && !previewByKey.get(key)?.length ? (
                            <span className="schedule-draft-note">
                              Draft: {dependabotScheduleLabel(edit.schedule)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  <ul
                    className="schedule-mobile-starts"
                    aria-label={row.repository.fullName + " starts"}
                  >
                    {entries
                      .flatMap((entry) => [
                        ...(observedByKey.get(entryKey(row, entry)) ?? []).map(
                          (item) => ({ entry, item, draft: false }),
                        ),
                        ...(valid &&
                        draft?.edits.some((edit) => edit.entryId === entry.id)
                          ? (previewByKey.get(entryKey(row, entry)) ?? []).map(
                              (item) => ({ entry, item, draft: true }),
                            )
                          : []),
                      ])
                      .sort(
                        (a, b) =>
                          a.item.instant.localeCompare(b.item.instant) ||
                          Number(a.draft) - Number(b.draft),
                      )
                      .map(({ entry, item, draft }) => (
                        <li key={entry.id + item.instant + draft}>
                          <span>{scheduleMembers(entry)}</span>
                          {marker(row, entry, item, draft)}
                        </li>
                      ))}
                  </ul>
                  {!entries.length ? (
                    <p className="dependency-meta schedule-empty">
                      {rowState(row, now)}. Refresh to inspect through an
                      enrolled GitHub source.
                    </p>
                  ) : null}
                  {!operator ? (
                    <p className="dependency-meta">
                      A workspace operator can prepare a pull request.
                    </p>
                  ) : (
                    <DependabotHistory
                      workspaceId={workspaceId}
                      repositoryId={row.repository.id}
                    />
                  )}
                </article>
              );
            })}
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
          onSave={(schedule) => {
            const { row, entry } = editing;
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
          }}
        />
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
