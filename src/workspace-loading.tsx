import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import { Skeleton } from "./components/ui/skeleton";

const LOADING_DELAY_MS = 150;
const LOADING_MINIMUM_MS = 300;

function SuspendedView({ onChange }: { onChange: (pending: boolean) => void }) {
  useLayoutEffect(() => {
    onChange(true);
    return () => onChange(false);
  }, [onChange]);
  return null;
}

export function WorkspaceLoading({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}) {
  const [suspended, setSuspended] = useState(false);
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  const loading = pending || suspended;

  useEffect(() => {
    if (loading && visible) return;
    if (!loading && !visible) return;
    const delay = loading
      ? LOADING_DELAY_MS
      : Math.max(0, LOADING_MINIMUM_MS - (performance.now() - shownAt.current));
    const timer = window.setTimeout(() => {
      if (loading) shownAt.current = performance.now();
      setVisible(loading);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [loading, visible]);

  const waiting = loading || visible;
  return (
    <>
      {waiting ? (
        <div className="loading-state" role="status">
          <span className="sr-only">Opening your workspace...</span>
          <div
            className="workspace-loading-placeholder"
            aria-hidden="true"
            style={{ visibility: visible ? "visible" : "hidden" }}
          >
            <div className="workspace-loading-label">
              <LoaderCircle className="motion-safe:animate-spin" size={20} />
              <span>Opening your workspace...</span>
            </div>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : null}
      <div hidden={waiting}>
        <Suspense fallback={<SuspendedView onChange={setSuspended} />}>
          {pending ? null : children}
        </Suspense>
      </div>
    </>
  );
}
