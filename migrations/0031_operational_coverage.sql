CREATE TABLE operational_coverage_reads (
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  read_id TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  next_read_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(workspace_id,repository_id),
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER coverage_repository_move BEFORE UPDATE OF workspace_id ON repositories
WHEN OLD.workspace_id<>NEW.workspace_id
BEGIN
  DELETE FROM operational_coverage_reads WHERE workspace_id=OLD.workspace_id AND repository_id=OLD.id;
END;

CREATE TABLE operational_coverage_budgets (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  window_at TEXT NOT NULL,
  used INTEGER NOT NULL CHECK(used>0)
) STRICT;

CREATE TABLE operational_coverage_epochs (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0),
  PRIMARY KEY(workspace_id,connection_id),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER coverage_link_insert AFTER INSERT ON repository_resource_links
BEGIN
  UPDATE observations SET expires_at=MIN(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE workspace_id=NEW.workspace_id AND source_id IN
      (SELECT id FROM connections WHERE workspace_id=NEW.workspace_id
        AND provider=CASE NEW.kind WHEN 'hook' THEN 'hookrelay' ELSE 'endpoint-monitor' END) AND resource_type='repository'
      AND resource_id=NEW.repository_id AND json_type(details_json,'$.coverage')='object';
END;
CREATE TRIGGER coverage_link_delete AFTER DELETE ON repository_resource_links
BEGIN
  UPDATE observations SET expires_at=MIN(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE workspace_id=OLD.workspace_id AND source_id=OLD.connection_id AND resource_type='repository'
      AND resource_id=OLD.repository_id AND json_type(details_json,'$.coverage')='object';
  DELETE FROM observations WHERE workspace_id=OLD.workspace_id AND source_id=OLD.connection_id
    AND resource_type='repository' AND resource_id=OLD.repository_id AND json_type(details_json,'$.coverage')='object'
    AND NOT EXISTS (SELECT 1 FROM repository_resource_links l WHERE l.workspace_id=OLD.workspace_id
      AND l.connection_id=OLD.connection_id AND l.repository_id=OLD.repository_id);
END;
CREATE TRIGGER coverage_association_update AFTER UPDATE ON repository_resource_associations
BEGIN
  UPDATE observations SET expires_at=MIN(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.connection_id AND resource_type='repository'
      AND json_type(details_json,'$.coverage')='object' AND resource_id IN
        (SELECT repository_id FROM repository_resource_links WHERE workspace_id=NEW.workspace_id
          AND kind=NEW.kind AND connection_id=NEW.connection_id AND resource_key=NEW.resource_key);
END;
CREATE TRIGGER coverage_connection_update AFTER UPDATE ON connections
WHEN NEW.revision<>OLD.revision OR NEW.enabled<>OLD.enabled OR NEW.credential_ref IS NOT OLD.credential_ref
BEGIN
  UPDATE observations SET expires_at=MIN(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id AND json_type(details_json,'$.coverage')='object';
END;

CREATE TRIGGER coverage_monitor_operation_insert AFTER INSERT ON operations
WHEN NEW.kind='endpoint-monitor.operation'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.request.input.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.request.input.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;
CREATE TRIGGER coverage_monitor_operation_update AFTER UPDATE ON operations
WHEN NEW.kind='endpoint-monitor.operation'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.request.input.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.request.input.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;
