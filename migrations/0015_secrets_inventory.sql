CREATE TABLE secret_connections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  resources_json TEXT NOT NULL CHECK (json_valid(resources_json)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id)
) STRICT;

CREATE TRIGGER push_secret_connections_insert AFTER INSERT ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_secret_connections_update AFTER UPDATE ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_secret_connections_delete AFTER DELETE ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
