-- Secrets resource metadata participates in the existing association topic
DROP TRIGGER push_secret_connections_insert;
DROP TRIGGER push_secret_connections_update;
DROP TRIGGER push_secret_connections_delete;

CREATE TRIGGER push_secret_connections_insert AFTER INSERT ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

CREATE TRIGGER push_secret_connections_update AFTER UPDATE ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

CREATE TRIGGER push_secret_connections_delete AFTER DELETE ON secret_connections
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;
