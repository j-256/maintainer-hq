const FOCUS_VISIBILITY_WAIT_MS = 2_000;

export function restoreVisibleFocus(element: HTMLElement | null) {
  if (!element?.isConnected) return;
  const hidden = element.closest<HTMLElement>("[hidden]");
  if (!hidden) {
    element.focus();
    return;
  }
  const previous = document.activeElement;
  const observer = new MutationObserver(() => {
    if (
      !element.isConnected ||
      (document.activeElement !== previous &&
        document.activeElement !== document.body)
    ) {
      stop();
      return;
    }
    if (!element.closest("[hidden]")) {
      stop();
      element.focus();
    }
  });
  const timer = window.setTimeout(stop, FOCUS_VISIBILITY_WAIT_MS);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  for (
    let parent: HTMLElement | null = hidden;
    parent;
    parent = parent.parentElement
  ) {
    if (parent.hidden)
      observer.observe(parent, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
  }
}
