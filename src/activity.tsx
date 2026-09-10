import { useDeferredValue, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, CircleDot, Plus, Search, X } from "lucide-react";
import { CAPABILITY, type Activity, type Snapshot } from "../shared/domain";
import { command } from "./lib/api";
import { ACTIVITY_LIMITS, type ActivityFilters } from "../shared/activity";
import { PaginatedActivity } from "./activity-feed";
import { Button } from "./components/ui/button";
import { GoalsPanel } from "./goals";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

const FILTERS = [
  { id: "all", label: "All activity" },
  { id: "goal", label: "Goals" },
  { id: "verification", label: "Checks" },
  { id: "note", label: "Notes" },
] as const;
function NoteComposer({
  snapshot,
  scopedRepositoryId,
  scopedProjectId,
}: {
  snapshot: Snapshot;
  scopedRepositoryId?: string;
  scopedProjectId?: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [repositoryId, setRepositoryId] = useState(
    scopedRepositoryId ?? scopedProjectId ?? "workspace",
  );
  const [goalId, setGoalId] = useState("none");
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: () =>
      command<Activity>("activity_add", {
        workspaceId: snapshot.workspace.id,
        eventId,
        kind: "note",
        title,
        summary,
        resourceId: repositoryId === "workspace" ? null : repositoryId,
        goalId: goalId === "none" ? null : goalId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["workspace", snapshot.workspace.id],
      });
      setTitle("");
      setSummary("");
      setGoalId("none");
      setEventId(crypto.randomUUID());
      setOpen(false);
    },
  });
  const editable = snapshot.capabilities.includes(CAPABILITY.ACTIVITY);
  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!mutation.isPending) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button
          disabled={!editable}
          title={
            editable
              ? "Add an update to the workspace"
              : "An owner or operator can post updates"
          }
        >
          <Plus size={16} />
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent className="note-dialog">
        <DialogHeader>
          <DialogTitle>Add a note</DialogTitle>
          <DialogDescription>
            Capture a decision, question, or update. Notes are visible to
            workspace members. Do not include secrets or private endpoint URLs.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="note-form">
          <label htmlFor="note-title">
            Title
            <Input
              id="note-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setEventId(crypto.randomUUID());
              }}
              maxLength={160}
              required
              placeholder="What should we know?"
              disabled={mutation.isPending}
            />
          </label>
          <label htmlFor="note-body">
            Details
            <Textarea
              id="note-body"
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
                setEventId(crypto.randomUUID());
              }}
              maxLength={2000}
              rows={5}
              placeholder="A little context goes a long way."
              disabled={mutation.isPending}
            />
          </label>
          <div>
            <label id="note-repo-label">Related to</label>
            <Select
              value={repositoryId}
              onValueChange={(value) => {
                setRepositoryId(value);
                setEventId(crypto.randomUUID());
              }}
              disabled={
                mutation.isPending ||
                Boolean(scopedRepositoryId || scopedProjectId)
              }
            >
              <SelectTrigger
                aria-labelledby="note-repo-label"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">Entire workspace</SelectItem>
                {snapshot.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    Project: {project.name}
                  </SelectItem>
                ))}
                {snapshot.repositories.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label id="note-goal-label">Goal (optional)</label>
            <Select
              value={goalId}
              onValueChange={(value) => {
                setGoalId(value);
                setEventId(crypto.randomUUID());
              }}
              disabled={mutation.isPending}
            >
              <SelectTrigger
                aria-labelledby="note-goal-label"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No goal association</SelectItem>
                {snapshot.goals.map((goal) => (
                  <SelectItem key={goal.id} value={goal.id}>
                    {goal.objective}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mutation.error ? (
            <p role="alert" className="form-error">
              {mutation.error.message}
            </p>
          ) : null}
          <div className="form-actions">
            <Button
              variant="outline"
              type="button"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || mutation.isPending}
            >
              {mutation.isPending ? "Posting..." : "Post note"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ActivityView({
  snapshot,
  scopedRepositoryId,
  scopedProjectId,
  readOnly = false,
}: {
  snapshot: Snapshot;
  scopedRepositoryId?: string;
  scopedProjectId?: string;
  readOnly?: boolean;
}) {
  const [filter, setFilter] = useState<ActivityFilters["filter"]>("all");
  const [search, setSearch] = useState("");
  const [repositoryId, setRepositoryId] = useState("all");
  const deferredSearch = useDeferredValue(search.trim());
  const filters: ActivityFilters = {
    workspaceId: snapshot.workspace.id,
    filter,
    search: deferredSearch,
    projectId: scopedProjectId ?? null,
    repositoryId:
      scopedRepositoryId ?? (repositoryId === "all" ? null : repositoryId),
  };
  function clearFilters() {
    setFilter("all");
    setSearch("");
    setRepositoryId("all");
  }
  return (
    <>
      <div className="page-heading">
        <div>
          {scopedRepositoryId || scopedProjectId ? (
            <h2>Activity</h2>
          ) : (
            <>
              <div className="eyebrow">WORKSPACE JOURNAL</div>
              <h1>Activity</h1>
            </>
          )}
          <p>
            {scopedProjectId
              ? "Related goals, project notes, and operations captured for this project. Regrouping repositories does not rewrite historical activity."
              : scopedRepositoryId
                ? "Related goals, reported updates, and operations affecting this repository. Historical operations retain their original repository links."
                : "The work, the decisions, and what happens next."}
          </p>
        </div>
        {!readOnly ? (
          <NoteComposer
            snapshot={snapshot}
            scopedRepositoryId={scopedRepositoryId}
            scopedProjectId={scopedProjectId}
          />
        ) : null}
      </div>
      {!scopedRepositoryId && !scopedProjectId ? (
        <GoalsPanel goals={snapshot.goals} />
      ) : null}
      <div className="activity-layout">
        <section
          className="journal"
          aria-label={
            scopedProjectId
              ? "Project activity"
              : scopedRepositoryId
                ? "Repository activity"
                : "Workspace activity"
          }
        >
          <div className="journal-toolbar">
            <div
              className="filter-tabs"
              role="group"
              aria-label="Activity type"
            >
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="search-row">
            <div className="search-input">
              <Search size={15} aria-hidden="true" />
              <Input
                aria-label="Search activity"
                value={search}
                maxLength={ACTIVITY_LIMITS.SEARCH_LENGTH}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search updates, decisions, checks..."
              />
              {search ? (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
            {!scopedRepositoryId && !readOnly ? (
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger aria-label="Filter by repository">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top">
                  <SelectItem value="all">All repositories</SelectItem>
                  {snapshot.repositories
                    .filter(
                      (repo) =>
                        !scopedProjectId || repo.projectId === scopedProjectId,
                    )
                    .map((repo) => (
                      <SelectItem key={repo.id} value={repo.id}>
                        {repo.fullName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <PaginatedActivity
            key={JSON.stringify(filters)}
            filters={filters}
            snapshot={snapshot}
            clearFilters={clearFilters}
          />
        </section>
        {!scopedRepositoryId && !scopedProjectId ? (
          <aside className="context-rail" aria-label="Activity context">
            <section>
              <div className="eyebrow">IN THIS WORKSPACE</div>
              <h2>The work behind your projects.</h2>
              <p>
                This journal combines reported work updates with recorded
                workspace changes.
              </p>
              <div className="context-stat">
                <span>Repositories</span>
                <strong>{snapshot.repositories.length}</strong>
              </div>
              <div className="context-stat">
                <span>Reported goals</span>
                <strong>{snapshot.goals.length}</strong>
              </div>
            </section>
            <section>
              <div className="eyebrow">HOW TO READ THIS</div>
              <div className="legend-item">
                <CircleDot size={16} />
                <div>
                  <strong>Reported updates</strong>
                  <p>
                    Notes, checkpoints, and check results posted by a workspace
                    member or client.
                  </p>
                </div>
              </div>
              <div className="legend-item">
                <CheckCheck size={16} />
                <div>
                  <strong>Recorded changes</strong>
                  <p>Repository edits recorded by HQ when the save succeeds.</p>
                </div>
              </div>
              <p className="context-footnote">
                A reported check is not an independent provider health check.
              </p>
            </section>
          </aside>
        ) : null}
      </div>
    </>
  );
}
