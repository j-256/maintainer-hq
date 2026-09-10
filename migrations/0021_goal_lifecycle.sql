-- Rebuild the status constraint while preserving every goal and journal record
-- Activity goal IDs are logical associations, not foreign keys to this table
CREATE TABLE goals_lifecycle (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'blocked', 'paused', 'cleared')),
  started_at TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  reporter_id TEXT,
  PRIMARY KEY (workspace_id, id)
) STRICT;

INSERT INTO goals_lifecycle (id,workspace_id,source_id,actor_subject,actor_name,objective,status,started_at,reported_at,received_at,write_id,reporter_id)
SELECT id,workspace_id,source_id,actor_subject,actor_name,objective,status,started_at,reported_at,received_at,write_id,reporter_id FROM goals;
DROP TABLE goals;
ALTER TABLE goals_lifecycle RENAME TO goals;
CREATE INDEX goals_workspace_time ON goals (workspace_id, started_at DESC);

CREATE TRIGGER goal_created_journal AFTER INSERT ON goals
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id, goal_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status
      WHEN 'active' THEN 'Goal started'
      WHEN 'complete' THEN 'Goal completed'
      WHEN 'blocked' THEN 'Goal blocked'
      WHEN 'paused' THEN 'Goal paused'
      WHEN 'cleared' THEN 'Goal cleared'
    END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id, NEW.id);
END;
CREATE TRIGGER goal_status_journal AFTER UPDATE OF status ON goals
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id, goal_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status
      WHEN 'active' THEN 'Goal resumed'
      WHEN 'complete' THEN 'Goal completed'
      WHEN 'blocked' THEN 'Goal blocked'
      WHEN 'paused' THEN 'Goal paused'
      WHEN 'cleared' THEN 'Goal cleared'
    END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id, NEW.id);
END;

CREATE TRIGGER push_goals_insert AFTER INSERT ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;
CREATE TRIGGER push_goals_update AFTER UPDATE ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;
CREATE TRIGGER push_goals_delete AFTER DELETE ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER sync_goals_insert AFTER INSERT ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;
CREATE TRIGGER sync_goals_update AFTER UPDATE ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;
CREATE TRIGGER sync_goals_delete AFTER DELETE ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;
