ALTER TABLE activity ADD COLUMN goal_id TEXT;

UPDATE activity SET goal_id = (
  SELECT g.id FROM goals g
  WHERE g.workspace_id = activity.workspace_id AND g.actor_subject = activity.actor_subject
    AND g.reporter_id IS activity.reporter_id AND g.objective = activity.summary
)
WHERE type IN ('goal.active', 'goal.complete', 'goal.blocked') AND (
  SELECT count(*) FROM goals g
  WHERE g.workspace_id = activity.workspace_id AND g.actor_subject = activity.actor_subject
    AND g.reporter_id IS activity.reporter_id AND g.objective = activity.summary
) = 1;

CREATE INDEX activity_workspace_goal ON activity (workspace_id, goal_id);

CREATE TABLE activity_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE REFERENCES activity(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX activity_order_workspace ON activity_order (workspace_id, sequence DESC);
INSERT INTO activity_order (event_id, workspace_id)
SELECT id, workspace_id FROM activity ORDER BY created_at, id;

CREATE TRIGGER activity_insert_order AFTER INSERT ON activity
BEGIN
  INSERT INTO activity_order (event_id, workspace_id) VALUES (NEW.id, NEW.workspace_id);
END;

DROP TRIGGER goal_created_journal;
DROP TRIGGER goal_status_journal;
CREATE TRIGGER goal_created_journal AFTER INSERT ON goals
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id, goal_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal started' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id, NEW.id);
END;
CREATE TRIGGER goal_status_journal AFTER UPDATE OF status ON goals
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id, goal_id)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal resumed' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at, NEW.reporter_id, NEW.id);
END;
