CREATE TABLE metadata_imports (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL UNIQUE REFERENCES action_plans(id),
  fingerprint TEXT NOT NULL,
  source_label TEXT NOT NULL,
  repository_count INTEGER NOT NULL CHECK (repository_count > 0),
  applied_at TEXT NOT NULL,
  write_id TEXT NOT NULL UNIQUE
) STRICT;
