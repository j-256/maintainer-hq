ALTER TABLE credentials ADD COLUMN automation_profile TEXT CHECK (automation_profile IN ('reader', 'reporter'));
ALTER TABLE credentials ADD COLUMN reporter_id TEXT;
ALTER TABLE activity ADD COLUMN reporter_id TEXT;
ALTER TABLE goals ADD COLUMN reporter_id TEXT;
CREATE INDEX credentials_automation_workspace ON credentials (workspace_id, automation_profile, created_at DESC);

DROP TRIGGER goal_created_journal;
DROP TRIGGER goal_status_journal;
CREATE TRIGGER goal_created_journal AFTER INSERT ON goals
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal started' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id);
END;
CREATE TRIGGER goal_status_journal AFTER UPDATE OF status ON goals
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal resumed' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id);
END;
