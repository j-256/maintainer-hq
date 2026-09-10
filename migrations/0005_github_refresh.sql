ALTER TABLE connections ADD COLUMN next_refresh_at TEXT;
ALTER TABLE connections ADD COLUMN last_refresh_id TEXT;

CREATE TABLE github_refreshes (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  credential_ref TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_token_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  summary TEXT NOT NULL,
  changed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX github_refresh_active ON github_refreshes (workspace_id, source_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX github_refresh_history ON github_refreshes (workspace_id, source_id, created_at DESC);

CREATE TABLE github_refresh_items (
  workspace_id TEXT NOT NULL,
  refresh_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until TEXT,
  observed_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, refresh_id, repository_id),
  FOREIGN KEY (workspace_id, refresh_id) REFERENCES github_refreshes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX github_refresh_work ON github_refresh_items (status, updated_at, lease_until);

CREATE TABLE github_cooldowns (
  credential_hash TEXT PRIMARY KEY,
  retry_at TEXT NOT NULL
) STRICT;
