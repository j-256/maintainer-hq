import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Temporal } from "@js-temporal/polyfill";
import {
  DEPENDABOT_TIME,
  type DependabotEntry,
  type DependabotInventoryRow,
  type DependabotSchedule,
} from "../shared/dependabot";
import {
  DEPENDABOT_DRAG as DRAG,
  canMoveDependabotSchedule,
  moveDependabotSchedule,
  snapDependabotMinute,
  type DependabotMoveResult,
  type DependabotMoveTarget,
} from "../shared/dependabot-movement";
import type { DependabotOccurrence } from "../shared/dependabot-projection";

export type DependabotMoveSelection = {
  key: string;
  row: DependabotInventoryRow;
  entry: DependabotEntry;
  schedule: DependabotSchedule | null;
  occurrence: DependabotOccurrence;
  draft: boolean;
};
type MovePreview = {
  selection: DependabotMoveSelection;
  target: DependabotMoveTarget;
  result: DependabotMoveResult;
  x: number;
  y: number;
  keyboard: boolean;
};
type ActiveMove = {
  selection: DependabotMoveSelection;
  element: HTMLButtonElement;
  pointerId: number | null;
  startX: number;
  startY: number;
  pickupOffsetX: number;
  moved: boolean;
  keyboard: boolean;
  target: DependabotMoveTarget;
  originalMinute: number;
  result: DependabotMoveResult | null;
  token: string;
};
type Options = {
  timeZone: string;
  context: object;
  onCommit: (
    selection: DependabotMoveSelection,
    result: Extract<DependabotMoveResult, { ok: true }>,
  ) => void;
  onOpen: (
    selection: DependabotMoveSelection,
    element: HTMLButtonElement,
  ) => void;
};
const OUTSIDE = "Drop on an hour lane or weekday. Your draft has not changed.";
const PREVIEW_SPACING = 8;
export function useDependabotDrag(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const active = useRef<ActiveMove | null>(null),
    suppressed = useRef<HTMLButtonElement | null>(null),
    suppressClick = useRef(false),
    ghost = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<MovePreview | null>(null),
    [announcement, setAnnouncement] = useState(""),
    [reveal, setReveal] = useState<{ key: string; instant: string } | null>(null);
  function position(x: number, y: number) {
    if (ghost.current) {
      const label = ghost.current.querySelector<HTMLElement>(
        ".schedule-drag-time",
      );
      const halfWidth =
        Math.max(ghost.current.offsetWidth, label?.offsetWidth ?? 0) / 2;
      const halfHeight = ghost.current.offsetHeight / 2;
      ghost.current.style.left =
        Math.max(
          halfWidth + PREVIEW_SPACING,
          Math.min(innerWidth - halfWidth - PREVIEW_SPACING, x),
        ) + "px";
      ghost.current.style.top =
        Math.max(
          halfHeight + (label?.offsetHeight ?? 0) + PREVIEW_SPACING * 2,
          Math.min(innerHeight - halfHeight - PREVIEW_SPACING, y),
        ) + "px";
    }
  }
  useLayoutEffect(() => {
    if (preview) position(preview.x, preview.y);
  }, [preview]);
  useLayoutEffect(() => {
    if (!reveal) return;
    const candidates = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-schedule-entry-key]"),
    ).filter(
      (node) =>
        node.dataset.scheduleEntryKey === reveal.key &&
        node.dataset.scheduleInstant === reveal.instant &&
        node.checkVisibility(),
    );
    const next =
      candidates.find((node) => node.dataset.scheduleDraft === "true") ??
      candidates[0];
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: "instant",
      });
      setReveal(null);
    }
  }, [reveal, options.context]);
  function publish(target: DependabotMoveTarget | null, x: number, y: number) {
    const a = active.current;
    if (!a) return;
    position(x, y);
    if (target) a.target = target;
    const result =
      target && a.selection.schedule
        ? moveDependabotSchedule(
            a.selection.schedule,
            a.selection.occurrence.instant,
            target,
          )
        : { ok: false as const, reason: OUTSIDE };
    const token = JSON.stringify([target?.date, target?.minute, result]);
    a.result = result;
    if (token !== a.token) {
      a.token = token;
      setPreview({
        selection: a.selection,
        target: a.target,
        result,
        x,
        y,
        keyboard: a.keyboard,
      });
    }
  }
  function begin(
    selection: DependabotMoveSelection,
    element: HTMLButtonElement,
    pointerId: number | null,
    x: number,
    y: number,
  ) {
    const box = element.getBoundingClientRect();
    const local = Temporal.Instant.from(
      selection.occurrence.instant,
    ).toZonedDateTimeISO(optionsRef.current.timeZone);
    active.current = {
      selection,
      element,
      pointerId,
      startX: x,
      startY: y,
      pickupOffsetX: element.closest("[data-schedule-hour-lane]")
        ? x - box.left - box.width / 2
        : 0,
      moved: pointerId === null,
      keyboard: pointerId === null,
      target: {
        date: local.toPlainDate().toString(),
        minute: local.hour * DRAG.MINUTES_PER_HOUR + local.minute,
        timeZone: optionsRef.current.timeZone,
        preserveTime: true,
      },
      originalMinute: local.hour * DRAG.MINUTES_PER_HOUR + local.minute,
      result: null,
      token: "",
    };
    setAnnouncement("");
    if (pointerId === null) publish(active.current.target, x, y);
  }
  function release(a: ActiveMove) {
    if (a.pointerId !== null && a.element.hasPointerCapture(a.pointerId))
      a.element.releasePointerCapture(a.pointerId);
  }
  function suppress(element: HTMLButtonElement) {
    suppressed.current = element;
    suppressClick.current = true;
  }
  function cancel() {
    const a = active.current;
    if (!a) return;
    active.current = null;
    if (a.moved && !a.keyboard) suppress(a.element);
    release(a);
    setPreview(null);
    setAnnouncement(a.moved ? "Move canceled. Your draft is unchanged." : "");
  }
  function commit() {
    const a = active.current;
    if (!a) return;
    active.current = null;
    if (a.moved) {
      if (!a.keyboard) suppress(a.element);
      if (a.result?.ok) {
        optionsRef.current.onCommit(a.selection, a.result);
        setAnnouncement(
          "Schedule moved in the local draft. Review changes to prepare a pull request.",
        );
      } else setAnnouncement(a.result?.reason ?? OUTSIDE);
    }
    release(a);
    setPreview(null);
    const result = a.result;
    if (a.moved && result?.ok)
      setReveal({ key: a.selection.key, instant: result.instant });
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const a = active.current;
    if (!a || a.pointerId !== event.pointerId) return;
    if (
      !a.moved &&
      Math.hypot(event.clientX - a.startX, event.clientY - a.startY) <
        DRAG.POINTER_THRESHOLD
    )
      return;
    a.moved = true;
    event.preventDefault();
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const lane = hit?.closest<HTMLElement>("[data-schedule-hour-lane]");
    const day = hit?.closest<HTMLElement>("[data-schedule-drop-date]");
    let target: DependabotMoveTarget | null = null;
    if (lane) {
      const bounds = lane.getBoundingClientRect();
      if (bounds.width > 0)
        target = {
          date: lane.dataset.scheduleHourLane!,
          minute: snapDependabotMinute(
            ((event.clientX - a.pickupOffsetX - bounds.left) / bounds.width) *
              DEPENDABOT_TIME.MINUTES_PER_DAY,
          ),
          timeZone: optionsRef.current.timeZone,
        };
    } else if (day)
      target = {
        date: day.dataset.scheduleDropDate!,
        minute: a.originalMinute,
        timeZone: optionsRef.current.timeZone,
        preserveTime: true,
      };
    publish(target, event.clientX - a.pickupOffsetX, event.clientY);
  }
  useEffect(() => cancel(), [options.context]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!active.current) suppressClick.current = false;
      if (event.key === "Escape" && active.current?.moved) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const pointer = () => {
      suppressClick.current = false;
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("click", click, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("blur", cancel);
      const a = active.current;
      active.current = null;
      if (a) release(a);
    };
  }, []);
  function handlers(
    selection: DependabotMoveSelection,
  ): ButtonHTMLAttributes<HTMLButtonElement> {
    const movable =
      selection.entry.editable && canMoveDependabotSchedule(selection.schedule);
    return {
      draggable: false,
      "aria-describedby": movable ? "schedule-move-instructions" : undefined,
      "data-schedule-entry-key": selection.key,
      "data-schedule-instant": selection.occurrence.instant,
      "data-schedule-draft": String(selection.draft),
      "data-schedule-movable": String(movable),
      "data-moving-source": String(
        preview?.selection.key === selection.key &&
          preview.selection.occurrence.instant ===
            selection.occurrence.instant &&
          preview.selection.draft === selection.draft,
      ),
      onPointerDown: (event) => {
        suppressed.current = null;
        if (!movable || event.button !== 0 || !event.isPrimary) return;
        if (active.current) cancel();
        begin(
          selection,
          event.currentTarget,
          event.pointerId,
          event.clientX,
          event.clientY,
        );
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: pointerMove,
      onPointerUp: (event) => {
        if (active.current?.pointerId !== event.pointerId) return;
        if (active.current.moved) pointerMove(event);
        commit();
      },
      onPointerCancel: (event) => {
        if (active.current?.pointerId === event.pointerId) cancel();
      },
      onLostPointerCapture: (event) => {
        if (active.current?.pointerId === event.pointerId) cancel();
      },
      onBlur: (event) => {
        if (
          active.current?.keyboard &&
          active.current.element === event.currentTarget
        )
          cancel();
      },
      onClick: (event) => {
        if (
          suppressed.current === event.currentTarget ||
          active.current?.keyboard
        ) {
          suppressed.current = null;
          event.preventDefault();
          return;
        }
        optionsRef.current.onOpen(selection, event.currentTarget);
      },
      onKeyDown: (event) => {
        if (!active.current) suppressed.current = null;
        if (!movable) return;
        let a = active.current;
        if (!a && event.key === " ") {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          begin(
            selection,
            event.currentTarget,
            null,
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          return;
        }
        if (!a?.keyboard || a.element !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === " ") {
          event.preventDefault();
          return;
        }
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const target = { ...a.target };
        if (event.altKey) {
          target.date = Temporal.PlainDate.from(target.date)
            .add({ days: direction })
            .toString();
          target.preserveTime = true;
        } else {
          target.minute = Math.max(
            0,
            Math.min(
              DEPENDABOT_TIME.MINUTES_PER_DAY - DRAG.STEP_MINUTES,
              (direction > 0
                ? Math.floor(target.minute / DRAG.STEP_MINUTES) + 1
                : Math.ceil(target.minute / DRAG.STEP_MINUTES) - 1) *
                DRAG.STEP_MINUTES,
            ),
          );
          target.preserveTime = false;
        }
        publish(target, a.startX, a.startY);
      },
    } as ButtonHTMLAttributes<HTMLButtonElement>;
  }
  return { preview, announcement, handlers, ghostRef: ghost, cancel };
}
export function DependabotDragPreview({
  drag,
  overlap,
  incomplete,
}: {
  drag: ReturnType<typeof useDependabotDrag>;
  overlap: number;
  incomplete: boolean;
}) {
  const preview = drag.preview;
  if (!preview) return null;
  const minute = preview.result.ok
    ? preview.result.minute
    : preview.target.minute;
  const date = Temporal.PlainDate.from(preview.target.date).toLocaleString(
    "en",
    { weekday: "short", month: "short", day: "numeric" },
  );
  const time =
    String(Math.floor(minute / DRAG.MINUTES_PER_HOUR)).padStart(2, "0") +
    ":" +
    String(minute % DRAG.MINUTES_PER_HOUR).padStart(2, "0");
  return createPortal(
    <div
      ref={drag.ghostRef}
      className={
        "schedule-drag-ghost" + (preview.result.ok ? "" : " is-invalid")
      }
      style={{
        left: preview.x,
        top: preview.y,
      }}
    >
      <div role="status" aria-live="polite" className="schedule-drag-time">
        <strong>
          {date} {time} {preview.target.timeZone}
        </strong>
        {preview.result.ok ? (
          <>
            {overlap > 1 ? (
              <span>{overlap} starts at the same minute; overlap allowed.</span>
            ) : null}
            {incomplete ? <span>Overlap coverage is incomplete.</span> : null}
          </>
        ) : (
          <span>{preview.result.reason}</span>
        )}
      </div>
      <div className="schedule-drag-block">
        {preview.selection.row.repository.fullName}
        <span>
          {preview.selection.entry.group ??
            preview.selection.entry.members
              .map((member) => member.ecosystem)
              .join(", ")}
        </span>
      </div>
    </div>,
    document.body,
  );
}
