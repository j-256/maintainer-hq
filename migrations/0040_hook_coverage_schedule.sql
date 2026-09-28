CREATE TABLE hook_coverage_refreshes (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  read_id TEXT NOT NULL,
  next_read_at TEXT NOT NULL,
  completed_at TEXT,
  repository_cursor TEXT,
  PRIMARY KEY (workspace_id, connection_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
);
