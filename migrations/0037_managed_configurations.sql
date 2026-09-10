CREATE TABLE managed_configurations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('secret','variable')),
  custody TEXT NOT NULL CHECK (custody = 'none'),
  desired_value TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','stopped')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  CHECK ((state='active' AND entry_kind='variable' AND desired_value IS NOT NULL)
    OR (state='active' AND entry_kind='secret' AND desired_value IS NULL)
    OR (state='stopped' AND desired_value IS NULL))
) STRICT;
CREATE INDEX managed_configurations_list ON managed_configurations(workspace_id,state,label,id);

CREATE TABLE managed_configuration_destinations (
  workspace_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  destination_index INTEGER NOT NULL CHECK (destination_index >= 0 AND destination_index < 10),
  destination_key TEXT NOT NULL,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('secret','variable')),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('github-actions','cloudflare-workers')),
  connection_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('organization','repository','environment','worker')),
  scope_name TEXT NOT NULL DEFAULT '',
  provider_name TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present','absent')),
  PRIMARY KEY (workspace_id,configuration_id,destination_index),
  UNIQUE (workspace_id,destination_key),
  FOREIGN KEY (workspace_id,configuration_id) REFERENCES managed_configurations(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,connection_id) REFERENCES secret_connections(workspace_id,id)
) STRICT;
CREATE INDEX managed_configuration_destinations_resource ON managed_configuration_destinations(workspace_id,resource_id,configuration_id);

CREATE TABLE managed_configuration_reviews (
  plan_id TEXT PRIMARY KEY REFERENCES action_plans(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  destination_index INTEGER NOT NULL CHECK (destination_index >= 0 AND destination_index < 10),
  destination_key TEXT NOT NULL,
  repository_id TEXT NOT NULL
) STRICT;
CREATE INDEX managed_configuration_reviews_target ON managed_configuration_reviews(workspace_id,destination_key,plan_id);

CREATE TRIGGER push_managed_configurations_insert AFTER INSERT ON managed_configurations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_managed_configurations_update AFTER UPDATE ON managed_configurations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_managed_configurations_delete AFTER DELETE ON managed_configurations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_managed_configuration_destinations_insert AFTER INSERT ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_managed_configuration_destinations_update AFTER UPDATE ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_managed_configuration_destinations_delete AFTER DELETE ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER transfer_clock_managed_configurations_insert AFTER INSERT ON managed_configurations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER transfer_clock_managed_configurations_update AFTER UPDATE ON managed_configurations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER transfer_clock_managed_configurations_delete AFTER DELETE ON managed_configurations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER transfer_clock_managed_configuration_destinations_insert AFTER INSERT ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER transfer_clock_managed_configuration_destinations_update AFTER UPDATE ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER transfer_clock_managed_configuration_destinations_delete AFTER DELETE ON managed_configuration_destinations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
