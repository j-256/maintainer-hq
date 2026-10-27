import { useEffect, useLayoutEffect, useRef, useState } from "react";

const WORKSPACE_GUTTER = 12;
const MIN_WORKSPACE_HEIGHT = 320;

export function useScheduleWorkspace(dialogOpen: boolean, moving: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = node.getBoundingClientRect().top + window.scrollY;
        const height = Math.max(
          MIN_WORKSPACE_HEIGHT,
          innerHeight - top - WORKSPACE_GUTTER,
        );
        node.style.setProperty("--schedule-workspace-height", height + "px");
      });
    };
    const observer = new ResizeObserver(measure);
    if (node.parentElement) observer.observe(node.parentElement);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [focused]);
  useEffect(() => {
    if (!focused || !ref.current) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const siblings = new Map<HTMLElement, boolean>();
    let current: HTMLElement | null = ref.current;
    while (current?.parentElement && current.parentElement !== document.body) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          siblings.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      current = current.parentElement;
    }
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const [node, inert] of siblings) node.inert = inert;
    };
  }, [focused]);
  useEffect(() => {
    if (!focused) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        dialogOpen ||
        moving
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          'input, select, textarea, [role="dialog"], [role="alertdialog"], details[open]',
        )
      )
        return;
      setFocused(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focused, dialogOpen, moving]);
  return { ref, focused, toggle: () => setFocused((value) => !value) };
}
