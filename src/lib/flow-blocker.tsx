import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import {
  useBlocker,
  type Blocker,
  type BlockerFunction,
} from "react-router-dom";

const UNBLOCKED: Blocker = {
  state: "unblocked",
  proceed: undefined,
  reset: undefined,
  location: undefined,
};
const Context = createContext<{
  blockers: Map<string, BlockerFunction>;
  selected: string | null;
  blocker: Blocker;
} | null>(null);

export function FlowBlocker({ children }: { children: ReactNode }) {
  const blockers = useRef(new Map<string, BlockerFunction>());
  const selected = useRef<string | null>(null);
  const blocker = useBlocker((context) => {
    selected.current = null;
    for (const [id, predicate] of blockers.current)
      if (predicate(context)) selected.current = id;
    return selected.current !== null;
  });
  return (
    <Context.Provider
      value={{
        blockers: blockers.current,
        selected: selected.current,
        blocker,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useFlowBlocker(predicate: BlockerFunction): Blocker {
  const flow = useContext(Context);
  if (!flow)
    throw new Error("Navigation guards require the workspace flow provider");
  const id = useId();
  const latest = useRef(predicate);
  latest.current = predicate;
  useEffect(() => {
    flow.blockers.set(id, (input) => latest.current(input));
    return () => {
      flow.blockers.delete(id);
    };
  }, [flow.blockers, id]);
  return flow.selected === id ? flow.blocker : UNBLOCKED;
}
