CREATE TABLE github_repository_identities (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  github_id TEXT NOT NULL CHECK (length(github_id) BETWEEN 1 AND 128),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 140),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id, repository_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX github_identity_repository ON github_repository_identities(workspace_id, github_id);

CREATE TRIGGER clear_departed_github_identity BEFORE UPDATE OF workspace_id ON repositories
WHEN NEW.workspace_id <> OLD.workspace_id
BEGIN
  DELETE FROM github_repository_identities WHERE workspace_id = OLD.workspace_id AND repository_id = OLD.id;
END;

CREATE TABLE github_discovery_cache (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (length(CAST(identity AS BLOB)) <= 32768),
  lease_id TEXT,
  lease_until TEXT,
  next_read_at TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 65536),
  PRIMARY KEY (workspace_id, source_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  CHECK (lease_until IS NULL OR lease_id IS NOT NULL)
) STRICT;
