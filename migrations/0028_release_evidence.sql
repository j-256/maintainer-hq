CREATE TABLE github_release_cache (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  lease_id TEXT,
  lease_until TEXT,
  next_read_at TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 32768),
  PRIMARY KEY (workspace_id, source_id, repository_id),
  FOREIGN KEY (workspace_id, source_id, repository_id)
    REFERENCES source_repositories(workspace_id, source_id, repository_id) ON DELETE CASCADE,
  CHECK (lease_until IS NULL OR lease_id IS NOT NULL)
) STRICT;

CREATE TABLE github_context_budgets (
  credential_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  reads INTEGER NOT NULL CHECK (reads BETWEEN 0 AND 10)
) STRICT;

CREATE TRIGGER push_release_evidence AFTER UPDATE OF result_json ON github_release_cache
WHEN NEW.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id, revision, pending_topics)
    VALUES (NEW.workspace_id, 1, 4)
    ON CONFLICT(workspace_id) DO UPDATE SET revision = revision + 1, pending_topics = pending_topics | 4;
END;
