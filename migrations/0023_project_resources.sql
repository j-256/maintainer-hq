ALTER TABLE hook_associations ADD COLUMN updated_at TEXT;

CREATE TABLE monitor_project_associations (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  project_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  write_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,connection_id,target_id),
  FOREIGN KEY (workspace_id,connection_id) REFERENCES connections(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
) STRICT;

CREATE TABLE secret_project_associations (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  project_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  write_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,connection_id,resource_id),
  FOREIGN KEY (workspace_id,connection_id) REFERENCES secret_connections(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
) STRICT;

CREATE INDEX hook_project_resources ON hook_associations(workspace_id,project_id,connection_id,subscription);
CREATE INDEX monitor_project_resources ON monitor_project_associations(workspace_id,project_id,connection_id,target_id);
CREATE INDEX secret_project_resources ON secret_project_associations(workspace_id,project_id,connection_id,resource_id);

CREATE VIEW project_resource_associations AS
  SELECT workspace_id,'hook' AS kind,connection_id,subscription AS resource_key,project_id,revision,updated_at FROM hook_associations
  UNION ALL SELECT workspace_id,'monitor',connection_id,target_id,project_id,revision,updated_at FROM monitor_project_associations
  UNION ALL SELECT workspace_id,'secret',connection_id,resource_id,project_id,revision,updated_at FROM secret_project_associations;

CREATE VIEW project_resource_repository_context AS
  SELECT workspace_id,kind,connection_id,resource_key,repository_id FROM repository_resource_links
  UNION ALL
  SELECT c.workspace_id,'secret',c.id,json_extract(resource.value,'$.id'),json_extract(repository.value,'$.id')
    FROM secret_connections c,json_each(c.resources_json) resource,json_each(resource.value,'$.repositories') repository;

CREATE TABLE activity_project_links (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY (workspace_id,event_id,project_id),
  FOREIGN KEY (workspace_id,event_id) REFERENCES activity(workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX activity_project_events ON activity_project_links(workspace_id,project_id,event_id);

CREATE TRIGGER activity_project_scope BEFORE INSERT ON activity_project_links
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id)
BEGIN
  SELECT RAISE(ABORT,'Project activity attribution must match the event workspace');
END;

CREATE TRIGGER activity_project_capture AFTER INSERT ON activity
BEGIN
  INSERT OR IGNORE INTO activity_project_links(workspace_id,event_id,project_id)
    SELECT NEW.workspace_id,NEW.id,id FROM projects
      WHERE workspace_id=NEW.workspace_id AND id=NEW.resource_id
    UNION SELECT NEW.workspace_id,NEW.id,project_id FROM repositories
      WHERE workspace_id=NEW.workspace_id AND id=NEW.resource_id AND project_id IS NOT NULL;
END;

CREATE TRIGGER push_activity_project_insert AFTER INSERT ON activity_project_links
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_monitor_project_insert AFTER INSERT ON monitor_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
CREATE TRIGGER push_monitor_project_update AFTER UPDATE ON monitor_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
CREATE TRIGGER push_monitor_project_delete AFTER DELETE ON monitor_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
CREATE TRIGGER push_secret_project_insert AFTER INSERT ON secret_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
CREATE TRIGGER push_secret_project_update AFTER UPDATE ON secret_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
CREATE TRIGGER push_secret_project_delete AFTER DELETE ON secret_project_associations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;
