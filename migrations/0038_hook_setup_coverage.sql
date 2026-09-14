CREATE TRIGGER coverage_hook_setup_insert AFTER INSERT ON operations
WHEN NEW.kind='hookrelay.github.setup'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;

CREATE TRIGGER coverage_hook_setup_update AFTER UPDATE ON operations
WHEN NEW.kind='hookrelay.github.setup'
BEGIN
  INSERT INTO operational_coverage_epochs(workspace_id,connection_id,generation)
    SELECT NEW.workspace_id,json_extract(input_json,'$.connectionId'),1 FROM action_plans WHERE id=NEW.plan_id
    ON CONFLICT(workspace_id,connection_id) DO UPDATE SET generation=generation+1;
  UPDATE observations SET expires_at=MIN(expires_at,NEW.updated_at)
    WHERE workspace_id=NEW.workspace_id AND source_id=(SELECT json_extract(input_json,'$.connectionId')
      FROM action_plans WHERE id=NEW.plan_id) AND json_type(details_json,'$.coverage')='object';
END;
