CREATE TABLE goals (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'blocked')),
  started_at TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;
CREATE INDEX goals_workspace_time ON goals (workspace_id, started_at DESC);
