CREATE TRIGGER goal_created_journal AFTER INSERT ON goals
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal started' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at);
END;

CREATE TRIGGER goal_status_journal AFTER UPDATE OF status ON goals
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at)
  VALUES ('goal_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.actor_subject, NEW.actor_name, 'goal.' || NEW.status,
    CASE NEW.status WHEN 'active' THEN 'Goal resumed' WHEN 'complete' THEN 'Goal completed' ELSE 'Goal blocked' END,
    NEW.objective, NULL, NEW.received_at);
END;
