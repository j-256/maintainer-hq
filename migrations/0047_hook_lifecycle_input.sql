CREATE TABLE hook_lifecycle_inputs (
  plan_id TEXT PRIMARY KEY REFERENCES action_plans(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','indeterminate','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER coverage_hook_lifecycle_insert AFTER INSERT ON operations
WHEN NEW.kind='hookrelay.resource.lifecycle'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;

CREATE TRIGGER coverage_hook_lifecycle_update AFTER UPDATE ON operations
WHEN NEW.kind='hookrelay.resource.lifecycle'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;
