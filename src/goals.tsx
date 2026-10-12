import { CheckCheck, Flag, Pause, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { Goal } from "../shared/domain";
import {
  GOAL_STATUS,
  GOAL_STATUS_LABELS,
  isGoalReportStale,
  isOpenGoal,
} from "../shared/goals";
import { Badge } from "./components/ui/badge";
import { useDateTime } from "./date-time";

const GOAL_CLOCK_MS = 60 * 1000;

export function GoalsPanel({ goals }: { goals: Goal[] }) {
  const dates = useDateTime();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, GOAL_CLOCK_MS);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const openGoals = goals.filter((goal) => isOpenGoal(goal.status));
  return (
    <section className="goals-panel" aria-label="Agent goals">
      {openGoals.length ? (
        openGoals.map((goal) => {
          const stale = isGoalReportStale(goal, now);
          const paused = goal.status === GOAL_STATUS.PAUSED;
          const Icon = paused
            ? Pause
            : goal.status === GOAL_STATUS.BLOCKED
              ? TriangleAlert
              : Flag;
          return (
            <article className="checkpoint-card" key={goal.id}>
              <div className="checkpoint-symbol">
                <Icon size={21} aria-hidden="true" />
              </div>
              <div className="goal-content">
                <div className="checkpoint-label">
                  <span>
                    {stale ? "LAST REPORTED " : ""}
                    {goal.status.toUpperCase()} /GOAL
                  </span>
                  <Badge variant="outline">
                    {GOAL_STATUS_LABELS[goal.status]}
                  </Badge>
                  {stale ? (
                    <Badge variant="outline" className="stale-badge">
                      Awaiting goal sync
                    </Badge>
                  ) : null}
                </div>
                <h2 className="goal-objective">{goal.objective}</h2>
                <div className="goal-meta">
                  <span>Verbatim from the goal source</span>
                  <span>
                    Synced{" "}
                    <time
                      dateTime={goal.receivedAt}
                      title={dates.tooltip(goal.receivedAt)}
                    >
                      {dates.dateTime(goal.receivedAt)}
                    </time>
                  </span>
                </div>
                {paused ? (
                  <p>
                    Paused at the source. This goal remains open; HQ cannot
                    resume it.
                  </p>
                ) : null}
                {stale ? (
                  <p>
                    Source report is over five minutes old. Refreshing HQ does
                    not confirm ongoing work.
                  </p>
                ) : null}
              </div>
            </article>
          );
        })
      ) : (
        <div className="no-active-goal">
          <CheckCheck size={18} />
          <span>
            {goals.length
              ? "No open goals reported. Completed and cleared goals remain in activity."
              : "No goals reported yet."}
          </span>
        </div>
      )}
    </section>
  );
}
